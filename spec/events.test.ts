import { expect, inject, it } from "vitest";
import { newBrowserCookie } from "./test-helpers.ts";

const baseUrl = inject("baseUrl");

interface MeterState {
  present: number;
  live: number;
  shown: boolean;
  totalTaps: number;
  yourTapCount: number;
  youAreCounted: boolean;
}

// A small SSE client over fetch's streaming body: reads "data: {...}\n\n"
// frames one at a time, decoupled from any global EventSource (not available
// in the Node test runner). C10 requires a valid browser cookie to open a
// stream at all, so every open() call needs one.
class SseStream {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private decoder = new TextDecoder();
  private buffer = "";
  private controller = new AbortController();

  private constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.reader = reader;
  }

  static async open(path: string, cookie: string): Promise<SseStream> {
    const stream = new SseStream(null as never);
    const res = await fetch(new URL(path, baseUrl), {
      signal: stream.controller.signal,
      headers: { cookie },
    });
    if (!res.body) throw new Error("no response body for SSE stream");
    stream.reader = res.body.getReader();
    return stream;
  }

  private async readMore(): Promise<void> {
    const { value, done } = await this.reader.read();
    if (done) throw new Error("SSE stream closed unexpectedly");
    this.buffer += this.decoder.decode(value, { stream: true });
  }

  // Resolves with the next frame's parsed `data:` payload, ignoring
  // heartbeat comment frames, or rejects if none arrives within timeoutMs.
  async next(timeoutMs = 1000): Promise<MeterState> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const sepIndex = this.buffer.indexOf("\n\n");
      if (sepIndex === -1) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`no SSE frame within ${timeoutMs}ms`);
        await Promise.race([
          this.readMore(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), remaining)),
        ]);
        continue;
      }
      const frame = this.buffer.slice(0, sepIndex);
      this.buffer = this.buffer.slice(sepIndex + 2);
      const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
      if (!dataLine) continue; // comment-only (heartbeat) frame, keep reading
      return JSON.parse(dataLine.slice("data: ".length)) as MeterState;
    }
  }

  // Waits for a frame matching predicate, skipping any that don't (a stray
  // broadcast from another connection — e.g. a previous test's stream still
  // being torn down server-side — can otherwise land as "the next frame").
  async waitFor(predicate: (state: MeterState) => boolean, timeoutMs = 2000): Promise<MeterState> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`condition not met within ${timeoutMs}ms`);
      const state = await this.next(remaining);
      if (predicate(state)) return state;
    }
  }

  async close(): Promise<void> {
    try {
      await this.reader.cancel();
    } catch {
      // already closed
    }
    this.controller.abort();
    // Give the server a moment to notice the socket closed, so the next
    // test's present count isn't racing this connection's teardown.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

it("a tap shows up on an open /events stream within 1 second", async () => {
  const cookie = await newBrowserCookie("demo");
  const stream = await SseStream.open("/l/demo/events", cookie);
  try {
    const before = await stream.next();
    await fetch(new URL("/l/demo/tap", baseUrl), { method: "POST", headers: { cookie } });
    const after = await stream.waitFor((s) => s.live >= before.live + 1, 1000);
    expect(after.live).toBeGreaterThanOrEqual(before.live + 1);
  } finally {
    await stream.close();
  }
});

it("the total taps count goes up on an open stream after a tap", async () => {
  const streamCookie = await newBrowserCookie("demo");
  const tapCookie = await newBrowserCookie("demo");
  const stream = await SseStream.open("/l/demo/events", streamCookie);
  try {
    const before = await stream.next();
    await fetch(new URL("/l/demo/tap", baseUrl), { method: "POST", headers: { cookie: tapCookie } });
    // >= rather than an exact +1: other spec files tap this same shared
    // demo lecture concurrently, so a second, unrelated tap can land in the
    // same window. What this test needs to prove is that the total updates
    // live on an already-open stream at all, which >= still establishes.
    const after = await stream.waitFor((s) => s.totalTaps > before.totalTaps, 1000);
    expect(after.totalTaps).toBeGreaterThanOrEqual(before.totalTaps + 1);
  } finally {
    await stream.close();
  }
});

it("present goes up when a second stream connects", async () => {
  const cookieA = await newBrowserCookie("demo");
  const cookieB = await newBrowserCookie("demo");
  const a = await SseStream.open("/l/demo/events", cookieA);
  try {
    const initial = await a.next();
    const b = await SseStream.open("/l/demo/events", cookieB);
    try {
      const updated = await a.waitFor((s) => s.present === initial.present + 1);
      expect(updated.present).toBe(initial.present + 1);
    } finally {
      await b.close();
    }
  } finally {
    await a.close();
  }
});

it("shown is false below min_present, true once enough people are present", async () => {
  const cookieA = await newBrowserCookie("demo");
  const cookieB = await newBrowserCookie("demo");
  const a = await SseStream.open("/l/demo/events", cookieA);
  try {
    const initial = await a.next();
    expect(initial.shown).toBe(false); // demo's min_present is 2

    const b = await SseStream.open("/l/demo/events", cookieB);
    try {
      const updated = await a.waitFor((s) => s.shown);
      expect(updated.shown).toBe(true);
    } finally {
      await b.close();
    }
  } finally {
    await a.close();
  }
});

// The real 60-second fade: a tap posted now must stop counting as "live"
// once it passes 60s old, and the server must push that update on its own
// (no new tap needed). README.md calls this enforced by tests, so it runs
// for real in every pnpm check — slow (~65s), but that's the actual claim.
it(
  "a tap fades out of `live` 60 seconds after it was made",
  async () => {
    const cookie = await newBrowserCookie("demo");
    const stream = await SseStream.open("/l/demo/events", cookie);
    try {
      await fetch(new URL("/l/demo/tap", baseUrl), { method: "POST", headers: { cookie } });
      const afterTap = await stream.next(1000);
      expect(afterTap.live).toBeGreaterThanOrEqual(1);

      const deadline = Date.now() + 65_000;
      let sawFade = false;
      while (Date.now() < deadline) {
        const state = await stream.next(65_000);
        if (state.live < afterTap.live) {
          sawFade = true;
          break;
        }
      }
      expect(sawFade).toBe(true);
    } finally {
      await stream.close();
    }
  },
  70_000,
);
