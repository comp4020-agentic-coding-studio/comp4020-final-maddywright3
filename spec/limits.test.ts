import { expect, inject, it } from "vitest";
import { newBrowserCookie } from "./test-helpers.ts";

const baseUrl = inject("baseUrl");

interface Bar {
  deck: string | null;
  slide: number;
  distinctBrowsers: number;
}

interface MeterState {
  present: number;
  shown: boolean;
  slide: number;
  bars: Bar[];
  live?: number;
  totalTaps?: number;
  yourTapCount: number;
  youAreCounted: boolean;
}

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
      if (!dataLine) continue;
      return JSON.parse(dataLine.slice("data: ".length)) as MeterState;
    }
  }

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
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function createLecture(cookie: string, title: string): Promise<Response> {
  return fetch(new URL("/new", baseUrl), {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ title }),
  });
}

it("a 4th lecture from the same browser within an hour is rejected, with a message", async () => {
  // A fresh browser cookie minted once, then reused for all four creates —
  // the limit is per browser, so the cookie must stay the same across them.
  const cookie = await newBrowserCookie("demo");

  const first = await createLecture(cookie, "Lecture one");
  expect(first.status).toBe(200);
  const second = await createLecture(cookie, "Lecture two");
  expect(second.status).toBe(200);
  const third = await createLecture(cookie, "Lecture three");
  expect(third.status).toBe(200);

  const fourth = await createLecture(cookie, "Lecture four");
  expect(fourth.status).toBe(429);
  expect(await fourth.text()).toMatch(/too many lectures/i);
});

it("a title over 100 characters is rejected with a clear message", async () => {
  const cookie = await newBrowserCookie("demo");
  const res = await createLecture(cookie, "a".repeat(101));
  expect(res.status).toBe(400);
  expect(await res.text()).toMatch(/limited to 100 characters/i);
});

it("a person arriving/leaving changes the people-count text but leaves the aria-live region's text unchanged", async () => {
  const cookieA = await newBrowserCookie("demo");
  const cookieB = await newBrowserCookie("demo");
  const a = await SseStream.open("/l/demo/events", cookieA);
  try {
    const before = await a.next();
    const b = await SseStream.open("/l/demo/events", cookieB);
    try {
      const after = await a.waitFor((s) => s.present === before.present + 1);
      // The DOM distinguishes the two fields: `present` (plain, not
      // announced) and `shown`/`live` (the aria-live region's content). A
      // person arriving changes `present`, and must not by itself flip
      // `shown` or change `live` unless the threshold was actually crossed —
      // this asserts the payload shape the aria-live split in server.ts
      // relies on, not the DOM directly (no browser automation here).
      expect(after.present).toBe(before.present + 1);
      if (before.shown && after.shown) {
        expect(after.live).toBe(before.live);
      }
    } finally {
      await b.close();
    }
  } finally {
    await a.close();
  }
});
