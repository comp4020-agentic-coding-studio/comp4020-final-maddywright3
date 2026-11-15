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
  liveForMs?: number;
  topReason?: string;
}

// Mirrors spec/slides.test.ts's SSE reader.
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

interface NewLecture {
  id: string;
  code: string;
  cookie: string;
  lecturerCookie: string;
}

async function createLectureAndLogIn(title: string): Promise<NewLecture> {
  const createRes = await fetch(new URL("/new", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `title=${encodeURIComponent(title)}`,
  });
  const createHtml = await createRes.text();
  const id = createHtml.match(/\/l\/([a-f0-9]+)/)?.[1];
  const code = createHtml.match(/<strong>([A-Z0-9]+)<\/strong>/)?.[1];
  if (!id || !code) throw new Error("couldn't parse the new lecture's id/code");

  const cookie = await newBrowserCookie(id);
  const loginRes = await fetch(new URL(`/l/${id}/lecturer`, baseUrl), {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: `code=${code}`,
    redirect: "manual",
  });
  const lsessCookie = loginRes.headers
    .getSetCookie()
    .find((c) => c.startsWith("lsess="))
    ?.split(";")[0];
  if (!lsessCookie) throw new Error("lecturer login failed");

  return { id, code, cookie, lecturerCookie: `${cookie}; ${lsessCookie}` };
}

async function tap(lectureId: string, cookie: string, slide = 1): Promise<Response> {
  return fetch(new URL(`/l/${lectureId}/tap`, baseUrl), {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: `slide=${slide}`,
    redirect: "manual",
  });
}

it("a reason not on the fixed list is rejected", async () => {
  const lecture = await createLectureAndLogIn("Reason validation test");
  const tapCookie = await newBrowserCookie(lecture.id);
  await tap(lecture.id, tapCookie);

  const res = await fetch(new URL(`/l/${lecture.id}/reason`, baseUrl), {
    method: "POST",
    headers: { cookie: tapCookie, "content-type": "application/x-www-form-urlencoded" },
    body: "reason=Made up reason",
  });
  expect(res.status).toBe(400);
});

it("a reason change is visible in the lecturer's stream within a second", async () => {
  const lecture = await createLectureAndLogIn("Reason visibility test");
  // Enough distinct browsers tapping+reasoning the same slide to clear this
  // lecture's min_present (5) for the reason-count gate.
  const cookies = await Promise.all(Array.from({ length: 5 }, () => newBrowserCookie(lecture.id)));
  for (const cookie of cookies) await tap(lecture.id, cookie);

  const lecturerStream = await SseStream.open(`/l/${lecture.id}/lecturer/events`, lecture.lecturerCookie);
  try {
    await lecturerStream.next();
    for (const cookie of cookies) {
      await fetch(new URL(`/l/${lecture.id}/reason`, baseUrl), {
        method: "POST",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: "reason=Too fast",
      });
    }
    const updated = await lecturerStream.waitFor(
      (s: any) => s.reasonCounts?.some((r: any) => r.reason === "Too fast" && r.count === 5),
      2000,
    );
    expect((updated as any).reasonCounts.some((r: any) => r.reason === "Too fast")).toBe(true);
  } finally {
    await lecturerStream.close();
  }
});

it("I get it now drops live by one within a second, and youAreCounted flips false", async () => {
  const cookie = await newBrowserCookie("demo");
  const otherCookie = await newBrowserCookie("demo"); // crosses demo's min_present of 2
  const stream = await SseStream.open("/l/demo/events", cookie);
  const other = await SseStream.open("/l/demo/events", otherCookie);
  try {
    await stream.waitFor((s) => s.shown);
    await fetch(new URL("/l/demo/tap", baseUrl), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: "deck=week-4&slide=1",
    });
    const afterTap = await stream.waitFor((s) => s.shown && s.youAreCounted, 1000);
    expect(afterTap.live).toBeGreaterThanOrEqual(1);

    await fetch(new URL("/l/demo/resolve", baseUrl), { method: "POST", headers: { cookie } });
    const afterResolve = await stream.waitFor((s) => s.shown && !s.youAreCounted, 1000);
    expect(afterResolve.live).toBe(afterTap.live! - 1);
    expect(afterResolve.youAreCounted).toBe(false);
  } finally {
    await stream.close();
    await other.close();
  }
});

it("after I get it now, a fresh tap inside the original 60s window is accepted", async () => {
  const cookie = await newBrowserCookie("demo");
  await fetch(new URL("/l/demo/tap", baseUrl), {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: "deck=week-4&slide=1",
  });
  const resolveRes = await fetch(new URL("/l/demo/resolve", baseUrl), {
    method: "POST",
    headers: { cookie },
    redirect: "manual",
  });
  expect(resolveRes.status).toBe(303);

  // This must land a fresh row, not be silently ignored by the dedup clause
  // — the regression this test guards against is "I get it now" leaving a
  // resolved tap that still blocks a real re-tap inside the same 60s window.
  const retapRes = await fetch(new URL("/l/demo/tap", baseUrl), {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: "deck=week-4&slide=1",
    redirect: "manual",
  });
  expect(retapRes.status).toBe(303);

  const stream = await SseStream.open("/l/demo/events", cookie);
  try {
    const state = await stream.next();
    expect(state.youAreCounted).toBe(true); // the fresh tap is live again
  } finally {
    await stream.close();
  }
});

it("liveForMs never appears in another browser's payload", async () => {
  const cookieA = await newBrowserCookie("demo");
  const cookieB = await newBrowserCookie("demo");
  await fetch(new URL("/l/demo/tap", baseUrl), {
    method: "POST",
    headers: { cookie: cookieA, "content-type": "application/x-www-form-urlencoded" },
    body: "deck=week-4&slide=1",
  });

  const streamB = await SseStream.open("/l/demo/events", cookieB);
  try {
    const state = await streamB.next();
    const payload = JSON.stringify(state);
    expect(payload).not.toContain("liveForMs"); // B has no live tap of its own
  } finally {
    await streamB.close();
  }
});
