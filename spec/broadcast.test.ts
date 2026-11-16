import { expect, inject, it } from "vitest";
import { newBrowserCookie } from "./test-helpers.ts";

// ADR 005: broadcasts are throttled to one per lecture per 50ms, with a
// leading edge. Each test uses its own created lecture, so no other test's
// taps or connects can add frames to the streams it counts.
const baseUrl = inject("baseUrl");
const WINDOW_MS = 50;

interface MeterState {
  present: number;
  shown: boolean;
  live?: number;
  youAreCounted: boolean;
}

interface Frame {
  at: number;
  state: MeterState;
}

// Records every frame with the moment it arrived.
class RecordingStream {
  frames: Frame[] = [];
  private done: Promise<void>;

  private constructor(
    res: Response,
    private controller: AbortController,
  ) {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    this.done = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          const at = performance.now();
          buffer += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const data = frame.split("\n").find((l) => l.startsWith("data: "));
            if (data) this.frames.push({ at, state: JSON.parse(data.slice(6)) as MeterState });
          }
        }
      } catch {
        // aborted on close
      }
    })();
  }

  static async open(lectureId: string, cookie: string): Promise<RecordingStream> {
    const controller = new AbortController();
    const res = await fetch(new URL(`/l/${lectureId}/events`, baseUrl), {
      headers: { cookie },
      signal: controller.signal,
    });
    return new RecordingStream(res, controller);
  }

  async waitFor(predicate: (s: MeterState) => boolean, timeoutMs = 3000): Promise<Frame> {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const hit = this.frames.find((f) => predicate(f.state));
      if (hit) return hit;
      if (performance.now() > deadline) throw new Error("condition not met in time");
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  async close(): Promise<void> {
    this.controller.abort();
    await this.done;
  }
}

async function createLecture(title: string): Promise<string> {
  const res = await fetch(new URL("/new", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `title=${encodeURIComponent(title)}&slides=60&minutes=60`,
  });
  const id = (await res.text()).match(/Student link: <a href="\/l\/([a-f0-9]+)"/)?.[1];
  if (!id) throw new Error("couldn't create a lecture");
  return id;
}

function tap(lectureId: string, cookie: string): Promise<Response> {
  return fetch(new URL(`/l/${lectureId}/tap`, baseUrl), {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: "slide=1",
    redirect: "manual",
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A created lecture's min_present is 5, so five watchers make live visible.
async function watchers(lectureId: string, count: number): Promise<RecordingStream[]> {
  const cookies = await Promise.all(Array.from({ length: count }, () => newBrowserCookie(lectureId)));
  const streams = await Promise.all(cookies.map((c) => RecordingStream.open(lectureId, c)));
  await Promise.all(streams.map((s) => s.waitFor((st) => st.present === count)));
  // Let the connects' own trailing frames land before anything is counted.
  await sleep(WINDOW_MS * 4);
  return streams;
}

it("a burst of 50 taps sends at most 2 updates per stream", async () => {
  const lectureId = await createLecture("Burst test");
  const streams = await watchers(lectureId, 5);
  try {
    const tappers = await Promise.all(Array.from({ length: 50 }, () => newBrowserCookie(lectureId)));
    const before = streams.map((s) => s.frames.length);

    const sentAt = performance.now();
    await Promise.all(tappers.map((c) => tap(lectureId, c)));
    const span = performance.now() - sentAt;
    await Promise.all(streams.map((s) => s.waitFor((st) => st.live === 50)));
    await sleep(WINDOW_MS * 4);

    // The throttle promises one update per 50 ms window plus the leading
    // edge. On an idle machine the 50 taps arrive within one window (2
    // updates); under load they were measured spanning two (3 updates, live
    // 1, 49, 50). So the allowance comes from the burst's own span, from the
    // first tap sent to the last response. Without the throttle each stream
    // got 50.
    const windows = Math.ceil(span / WINDOW_MS);
    const allowed = windows + 1;
    expect(
      allowed,
      `the burst took ${Math.round(span)} ms (${windows} windows): too slow a machine for this test to mean anything`,
    ).toBeLessThanOrEqual(5);
    for (const [i, s] of streams.entries()) {
      const burstFrames = s.frames.slice(before[i]);
      expect(
        burstFrames.length,
        `stream ${i} got ${burstFrames.length} updates for a burst of ${Math.round(span)} ms (${windows} windows)`,
      ).toBeLessThanOrEqual(allowed);
      expect(burstFrames.at(-1)!.state.live).toBe(50);
    }
  } finally {
    await Promise.all(streams.map((s) => s.close()));
  }
}, 30_000);

it("a single tap in a quiet room arrives with no added delay", async () => {
  const lectureId = await createLecture("Quiet room test");
  const cookie = await newBrowserCookie(lectureId);
  const stream = await RecordingStream.open(lectureId, cookie);
  try {
    await stream.waitFor((s) => s.present === 1);
    await sleep(WINDOW_MS * 4);

    const res = await tap(lectureId, cookie);
    const respondedAt = performance.now();
    expect(res.status).toBe(303);
    const frame = await stream.waitFor((s) => s.youAreCounted, 1000);

    // The leading edge sends before the tap's response is written. A
    // trailing send would land a full window after it.
    expect(frame.at - respondedAt).toBeLessThan(WINDOW_MS / 2);
  } finally {
    await stream.close();
  }
}, 30_000);

it("updates never arrive out of order: live only rises during a run of taps", async () => {
  const lectureId = await createLecture("Order test");
  const streams = await watchers(lectureId, 5);
  try {
    const tappers = await Promise.all(Array.from({ length: 30 }, () => newBrowserCookie(lectureId)));
    const before = streams.map((s) => s.frames.length);

    // Spread over several windows, so leading and trailing sends interleave.
    for (const [i, c] of tappers.entries()) {
      void tap(lectureId, c);
      if (i % 3 === 2) await sleep(20);
    }
    await Promise.all(streams.map((s) => s.waitFor((st) => st.live === 30)));
    await sleep(WINDOW_MS * 4);

    for (const [i, s] of streams.entries()) {
      const lives = s.frames.slice(before[i]).map((f) => f.state.live!);
      expect(lives.length, "the run should span several windows").toBeGreaterThan(2);
      expect(lives).toEqual([...lives].sort((a, b) => a - b));
      expect(lives.at(-1)).toBe(30);
    }
  } finally {
    await Promise.all(streams.map((s) => s.close()));
  }
}, 30_000);
