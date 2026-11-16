import { expect, inject, it } from "vitest";
import { newBrowserCookie } from "./test-helpers.ts";

const baseUrl = inject("baseUrl");

interface MeterState {
  present: number;
  shown: boolean;
  live?: number;
  totalTaps?: number;
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

// demo's min_present is 2: live/totalTaps are only sent once present reaches
// that threshold (below it, the server sends neither at all — see the
// privacy test in spec/identity.test.ts), so these tests open a second,
// otherwise-unused stream just to cross the threshold before asserting on
// either field.
it("a tap shows up on an open /events stream within 1 second", async () => {
  const cookie = await newBrowserCookie("demo");
  const otherCookie = await newBrowserCookie("demo");
  const stream = await SseStream.open("/l/demo/events", cookie);
  const other = await SseStream.open("/l/demo/events", otherCookie);
  try {
    const before = await stream.waitFor((s) => s.shown);
    await fetch(new URL("/l/demo/tap", baseUrl), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: "deck=week-4&slide=1",
    });
    const after = await stream.waitFor((s) => s.shown && s.live! >= before.live! + 1, 1000);
    expect(after.live).toBeGreaterThanOrEqual(before.live! + 1);
  } finally {
    await stream.close();
    await other.close();
  }
});

it("the total taps count goes up on an open stream after a tap", async () => {
  const streamCookie = await newBrowserCookie("demo");
  const tapCookie = await newBrowserCookie("demo");
  const otherCookie = await newBrowserCookie("demo");
  const stream = await SseStream.open("/l/demo/events", streamCookie);
  const other = await SseStream.open("/l/demo/events", otherCookie);
  try {
    const before = await stream.waitFor((s) => s.shown);
    await fetch(new URL("/l/demo/tap", baseUrl), {
      method: "POST",
      headers: { cookie: tapCookie, "content-type": "application/x-www-form-urlencoded" },
      body: "deck=week-4&slide=1",
    });
    const after = await stream.waitFor((s) => s.shown && s.totalTaps! > before.totalTaps!, 1000);
    expect(after.totalTaps).toBe(before.totalTaps! + 1);
  } finally {
    await stream.close();
    await other.close();
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

// The real fade, both windows: a demo tap stops counting as live after 20
// seconds (ADR 006: a 60-minute lecture condensed 12x), a created
// lecture's after 60. The server must push that update on its own (no new
// tap needed). README.md calls this enforced by tests, so both run for real
// in every pnpm check. Each is bounded on both sides: no earlier than just
// under its window, no later than 5 s past it.
async function fadeAfterMs(lectureId: string, watchers: number, tapBody: string): Promise<number> {
  const cookies = await Promise.all(Array.from({ length: watchers }, () => newBrowserCookie(lectureId)));
  const streams = await Promise.all(cookies.map((c) => SseStream.open(`/l/${lectureId}/events`, c)));
  const stream = streams[0];
  try {
    await stream.waitFor((s) => s.shown && s.present === watchers);
    await fetch(new URL(`/l/${lectureId}/tap`, baseUrl), {
      method: "POST",
      headers: { cookie: cookies[0], "content-type": "application/x-www-form-urlencoded" },
      body: tapBody,
    });
    const tappedAt = Date.now();
    const afterTap = await stream.waitFor((s) => s.shown && s.youAreCounted, 1000);
    expect(afterTap.live).toBeGreaterThanOrEqual(1);
    // This browser's own tap stops counting: youAreCounted is about this
    // tap alone, so another test's leftover tap fading can't stand in.
    const faded = await stream.waitFor((s) => s.shown && !s.youAreCounted, 70_000);
    const ms = Date.now() - tappedAt;
    expect(faded.live).toBeLessThan(afterTap.live!);
    return ms;
  } finally {
    for (const s of streams) await s.close();
  }
}

// The fade timer used to fire at the exact last millisecond of a tap's
// window, when the live check (created_at >= now - window) still counted
// the tap. That fade frame said the tap was still live, and the timer
// re-armed with zero delay; under load the throttle's trailing send that
// should carry the faded state could be lost, so the fade never arrived
// (measured: 27 zero-delay re-arms in one full run; CI failed on it). This
// records every frame after the window ends: none may still count the tap.
it(
  "once a tap's window has ended, no frame still counts it as live",
  async () => {
    const createHtml = await (
      await fetch(new URL("/new", baseUrl), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: await newBrowserCookie("demo") },
        body: "title=Fade+boundary+test&slides=10&minutes=60",
      })
    ).text();
    const lectureId = createHtml.match(/Student link: <a href="\/l\/([a-f0-9]+)"/)?.[1];
    if (!lectureId) throw new Error("couldn't parse the new lecture's id");
    const cookies = await Promise.all(Array.from({ length: 5 }, () => newBrowserCookie(lectureId)));
    const streams = await Promise.all(cookies.map((c) => SseStream.open(`/l/${lectureId}/events`, c)));
    const stream = streams[0];
    try {
      await stream.waitFor((s) => s.shown && s.present === 5, 3000);
      const tapRes = await fetch(new URL(`/l/${lectureId}/tap`, baseUrl), {
        method: "POST",
        headers: { cookie: cookies[0], "content-type": "application/x-www-form-urlencoded" },
        body: "slide=1",
        redirect: "manual",
      });
      expect(tapRes.status).toBe(303);
      const tappedAt = Date.now();
      await stream.waitFor((s) => s.youAreCounted, 2000);

      // Record every frame with its arrival time until 64 s after the tap.
      const frames: { at: number; youAreCounted: boolean; live?: number }[] = [];
      while (Date.now() - tappedAt < 64_000) {
        const left = 64_000 - (Date.now() - tappedAt);
        try {
          const f = await stream.waitFor(() => true, Math.max(1, left));
          frames.push({ at: Date.now() - tappedAt, youAreCounted: f.youAreCounted, live: f.live });
        } catch {
          break;
        }
      }
      const fadeFrames = frames.filter((f) => !f.youAreCounted);
      expect(fadeFrames.length, `frames around the fade: ${JSON.stringify(frames)}`).toBeGreaterThan(0);
      // Every frame after the first faded one must also be faded, and no
      // frame after the window may still count the tap.
      const firstFade = frames.findIndex((f) => !f.youAreCounted);
      expect(frames.slice(firstFade).every((f) => !f.youAreCounted), JSON.stringify(frames)).toBe(true);
      // The frame the fade timer sends is the faded one: no frame within the
      // last second of the window says "live" and is then followed by a
      // second, faded frame a moment later (the zero-delay re-arm).
      const liveAfter59 = frames.filter((f) => f.youAreCounted && f.at >= 59_500);
      expect(liveAfter59, `a frame still counted the tap at the window's end: ${JSON.stringify(frames)}`).toEqual([]);
    } finally {
      for (const s of streams) await s.close();
    }
  },
  90_000,
);

it(
  "a demo tap fades out of `live` 20 seconds after it was made",
  async () => {
    // demo's min_present is 2.
    const ms = await fadeAfterMs("demo", 2, "deck=week-4&slide=1");
    expect(ms).toBeGreaterThanOrEqual(19_000);
    expect(ms).toBeLessThanOrEqual(25_000);
  },
  35_000,
);

it(
  "a created lecture's tap fades out of `live` 60 seconds after it was made",
  async () => {
    const createHtml = await (
      await fetch(new URL("/new", baseUrl), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "title=Fade+window+test&slides=60&minutes=60",
      })
    ).text();
    const lectureId = createHtml.match(/Student link: <a href="\/l\/([a-f0-9]+)"/)?.[1];
    if (!lectureId) throw new Error("couldn't parse the new lecture's id");
    // A created lecture's min_present is 5.
    const ms = await fadeAfterMs(lectureId, 5, "slide=1");
    expect(ms).toBeGreaterThanOrEqual(59_000);
    expect(ms).toBeLessThanOrEqual(65_000);
  },
  80_000,
);
