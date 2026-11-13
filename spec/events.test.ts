import { expect, inject, it } from "vitest";

const baseUrl = inject("baseUrl");

interface MeterState {
  present: number;
  live: number;
  shown: boolean;
}

// A small SSE client over fetch's streaming body: reads "data: {...}\n\n"
// frames one at a time, decoupled from any global EventSource (not available
// in the Node test runner).
class SseStream {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private decoder = new TextDecoder();
  private buffer = "";
  private controller = new AbortController();

  private constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.reader = reader;
  }

  static async open(path: string): Promise<SseStream> {
    const stream = new SseStream(null as never);
    const res = await fetch(new URL(path, baseUrl), { signal: stream.controller.signal });
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

  close(): void {
    this.controller.abort();
  }
}

it("a tap shows up on an open /events stream within 1 second", async () => {
  const stream = await SseStream.open("/l/demo/events");
  try {
    const before = await stream.next();
    await fetch(new URL("/l/demo/tap", baseUrl), { method: "POST" });
    const after = await stream.next(1000);
    expect(after.live).toBeGreaterThanOrEqual(before.live + 1);
  } finally {
    stream.close();
  }
});

it("present goes up when a second stream connects", async () => {
  const a = await SseStream.open("/l/demo/events");
  try {
    const initial = await a.next();
    const b = await SseStream.open("/l/demo/events");
    try {
      const updated = await a.next();
      expect(updated.present).toBe(initial.present + 1);
    } finally {
      b.close();
    }
  } finally {
    a.close();
  }
});

it("shown is false below min_present, true once enough people are present", async () => {
  const a = await SseStream.open("/l/demo/events");
  try {
    const initial = await a.next();
    expect(initial.shown).toBe(false); // demo's min_present is 2

    const b = await SseStream.open("/l/demo/events");
    try {
      const updated = await a.next();
      expect(updated.shown).toBe(true);
    } finally {
      b.close();
    }
  } finally {
    a.close();
  }
});

// The real 60-second fade, left skipped in the normal run since it's slow by
// nature: a tap posted now must stop counting as "live" once it passes 60s
// old, and the server must push that update on its own (no new tap needed).
// Run deliberately with: RUN_SLOW_TESTS=1 pnpm check
it.skipIf(!process.env.RUN_SLOW_TESTS)(
  "a tap fades out of `live` 60 seconds after it was made",
  async () => {
    const stream = await SseStream.open("/l/demo/events");
    try {
      await fetch(new URL("/l/demo/tap", baseUrl), { method: "POST" });
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
      stream.close();
    }
  },
  70_000,
);
