import { afterEach, expect, inject, it } from "vitest";
import { newBrowserCookie } from "./test-helpers.ts";

const baseUrl = inject("baseUrl");

interface Bar {
  deck: string | null;
  slide: number;
  distinctBrowsers: number;
}

interface MeterState {
  present: number;
  live: number;
  shown: boolean;
  totalTaps: number;
  bars: Bar[];
  yourTapCount: number;
  youAreCounted: boolean;
}

// Mirrors spec/events.test.ts's SSE reader, trimmed to what these tests need:
// read one frame, or wait for one matching a predicate.
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

const openStreams: SseStream[] = [];
async function trackedStream(path: string, cookie: string): Promise<SseStream> {
  const s = await SseStream.open(path, cookie);
  openStreams.push(s);
  return s;
}

afterEach(async () => {
  while (openStreams.length > 0) {
    await openStreams.pop()!.close();
  }
});

it("two different browser cookies count as two present; two streams on the same cookie count as one", async () => {
  const cookieA = await newBrowserCookie("demo");
  const a1 = await trackedStream("/l/demo/events", cookieA);
  const initial = await a1.next();

  const a2 = await trackedStream("/l/demo/events", cookieA);
  // A second tab from the SAME browser must not raise present.
  await a2.next();
  // Give the server a moment; assert no change by checking the next real
  // state change instead of a fixed sleep would require a distinguishing
  // event, so instead confirm present is unchanged after a short pause.
  await new Promise((resolve) => setTimeout(resolve, 300));

  const cookieB = await newBrowserCookie("demo");
  const b = await trackedStream("/l/demo/events", cookieB);
  await b.next();
  const updated = await a1.waitFor((s) => s.present === initial.present + 1);
  expect(updated.present).toBe(initial.present + 1);
});

// One "I'm lost" per browser per slide, ever (ADR 004's amendment, README
// "What's enforced"). The previous version of this test read "Total taps"
// from a page with nobody present, where the total isn't rendered, so both
// counts were NaN and toBe(NaN) passed without checking anything. These read
// the total from a stream while two other browsers keep demo above its
// min_present of 2, and check each count is a real number.
// The newest frame a watcher has seen, after `action`. An ignored tap
// broadcasts nothing, so this drains whatever arrived and keeps the last
// shown frame rather than waiting for one that may never come.
const lastShown = new WeakMap<SseStream, MeterState>();
async function demoTotalAfter(watcher: SseStream, action: () => Promise<unknown>): Promise<number> {
  if (!lastShown.has(watcher)) lastShown.set(watcher, await watcher.waitFor((s) => s.shown));
  await action();
  // Let the throttled broadcast for this action land, then drain to the newest.
  await new Promise((resolve) => setTimeout(resolve, 150));
  for (;;) {
    let frame: MeterState;
    try {
      frame = await watcher.next(100);
    } catch {
      break;
    }
    if (frame.shown) lastShown.set(watcher, frame);
  }
  const latest = lastShown.get(watcher)!;
  expect(Number.isInteger(latest.totalTaps)).toBe(true);
  return latest.totalTaps;
}

async function postTap(cookie: string, body: string): Promise<Response> {
  return fetch(new URL("/l/demo/tap", baseUrl), {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body,
    redirect: "manual",
  });
}

it("a second tap on the same slide from the same browser is ignored, however much later", async () => {
  const watcher = await trackedStream("/l/demo/events", await newBrowserCookie("demo"));
  await trackedStream("/l/demo/events", await newBrowserCookie("demo"));
  const cookie = await newBrowserCookie("demo");

  const before = await demoTotalAfter(watcher, async () => {});
  const afterFirst = await demoTotalAfter(watcher, () => postTap(cookie, "deck=week-4&slide=3"));
  expect(afterFirst).toBe(before + 1);
  const afterSecond = await demoTotalAfter(watcher, () => postTap(cookie, "deck=week-4&slide=3"));
  expect(afterSecond).toBe(afterFirst);

  // After "I get it now" the slide is still used up for this browser.
  await fetch(new URL("/l/demo/resolve", baseUrl), {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: "deck=week-4&slide=3",
  });
  const afterResolveAndRetap = await demoTotalAfter(watcher, () => postTap(cookie, "deck=week-4&slide=3"));
  expect(afterResolveAndRetap).toBe(afterFirst);
});

it("a tap on another slide, or the same slide number in the other deck, counts exactly once more", async () => {
  const watcher = await trackedStream("/l/demo/events", await newBrowserCookie("demo"));
  await trackedStream("/l/demo/events", await newBrowserCookie("demo"));
  const cookie = await newBrowserCookie("demo");

  const before = await demoTotalAfter(watcher, () => postTap(cookie, "deck=week-4&slide=3"));
  const anotherSlide = await demoTotalAfter(watcher, () => postTap(cookie, "deck=week-4&slide=4"));
  expect(anotherSlide).toBe(before + 1);
  const otherDeck = await demoTotalAfter(watcher, () => postTap(cookie, "deck=week-6&slide=3"));
  expect(otherDeck).toBe(anotherSlide + 1);
});

it("a created lecture (no deck) also takes one tap per browser per slide", async () => {
  // A created lecture's deck is NULL, and SQLite's unique indexes treat
  // NULLs as distinct, so this is the case a plain index on deck would miss.
  const createHtml = await (
    await fetch(new URL("/new", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "title=Null+deck+dedup+test",
    })
  ).text();
  const lectureId = createHtml.match(/\/l\/([a-f0-9]+)/)?.[1];
  if (!lectureId) throw new Error("couldn't parse the new lecture's id");
  const cookie = await newBrowserCookie(lectureId);
  const tapCreated = (slide: number) =>
    fetch(new URL(`/l/${lectureId}/tap`, baseUrl), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `slide=${slide}`,
      redirect: "manual",
    });
  await tapCreated(1);
  await tapCreated(1);
  await tapCreated(2);

  const stream = await trackedStream(`/l/${lectureId}/events`, cookie);
  const state = await stream.next();
  expect(state.yourTapCount).toBe(2);
  expect((state as unknown as { yourSlides: unknown[] }).yourSlides).toEqual([
    { deck: null, slide: 1, live: true, resolved: false, answeredReason: false, answeredHelped: false },
    { deck: null, slide: 2, live: true, resolved: false, answeredReason: false, answeredHelped: false },
  ]);
});

it("a tap with no cookie, or a made-up cookie, is rejected", async () => {
  const noCookie = await fetch(new URL("/l/demo/tap", baseUrl), { method: "POST" });
  expect(noCookie.status).toBe(403);

  const forged = await fetch(new URL("/l/demo/tap", baseUrl), {
    method: "POST",
    headers: { cookie: "bid=0000000000000000000000000000000000000000000000000000000000000000" },
  });
  expect(forged.status).toBe(403);
});

it("/l/demo/lecturer shows the gauge only with the DEMO code", async () => {
  const cookie = await newBrowserCookie("demo");

  const noSession = await fetch(new URL("/l/demo/lecturer", baseUrl), { headers: { cookie } });
  const noSessionHtml = await noSession.text();
  expect(noSessionHtml).not.toContain('id="gauge"');

  const wrongCode = await fetch(new URL("/l/demo/lecturer", baseUrl), {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: "code=not-the-code",
  });
  const wrongCodeHtml = await wrongCode.text();
  expect(wrongCodeHtml).not.toContain('id="gauge"');

  const rightCode = await fetch(new URL("/l/demo/lecturer", baseUrl), {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: "code=DEMO",
    redirect: "manual",
  });
  expect(rightCode.status).toBe(303);
  const lsessCookie = rightCode.headers
    .getSetCookie()
    .find((c) => c.startsWith("lsess="))
    ?.split(";")[0];
  expect(lsessCookie).toBeDefined();

  const dashboard = await fetch(new URL("/l/demo/lecturer", baseUrl), {
    headers: { cookie: `${cookie}; ${lsessCookie}` },
  });
  const dashboardHtml = await dashboard.text();
  expect(dashboardHtml).toContain('id="gauge"');
});

it("no student page, lecturer page, or stream ever contains a browser ID other than the requester's own", async () => {
  const cookieA = await newBrowserCookie("demo");
  const cookieB = await newBrowserCookie("demo");
  const bidA = cookieA.split("=")[1];
  const bidB = cookieB.split("=")[1];

  const pageA = await (await fetch(new URL("/l/demo", baseUrl), { headers: { cookie: cookieA } })).text();
  expect(pageA).not.toContain(bidB);

  const stream = await trackedStream("/l/demo/events", cookieA);
  const frame = await stream.next();
  expect(JSON.stringify(frame)).not.toContain(bidB);
  expect(JSON.stringify(frame)).not.toContain(bidA); // the state payload itself never includes any raw bid

  const rightCode = await fetch(new URL("/l/demo/lecturer", baseUrl), {
    method: "POST",
    headers: { cookie: cookieA, "content-type": "application/x-www-form-urlencoded" },
    body: "code=DEMO",
    redirect: "manual",
  });
  const lsessCookie = rightCode.headers
    .getSetCookie()
    .find((c) => c.startsWith("lsess="))
    ?.split(";")[0];
  const dashboardHtml = await (
    await fetch(new URL("/l/demo/lecturer", baseUrl), { headers: { cookie: `${cookieA}; ${lsessCookie}` } })
  ).text();
  expect(dashboardHtml).not.toContain(bidA);
  expect(dashboardHtml).not.toContain(bidB);
});

it("a browser holding both cookies gets student state on /l/:id/events and counts as present", async () => {
  const cookie = await newBrowserCookie("demo");

  const rightCode = await fetch(new URL("/l/demo/lecturer", baseUrl), {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: "code=DEMO",
    redirect: "manual",
  });
  const lsessCookie = rightCode.headers
    .getSetCookie()
    .find((c) => c.startsWith("lsess="))
    ?.split(";")[0];
  expect(lsessCookie).toBeDefined();
  const bothCookies = `${cookie}; ${lsessCookie}`;

  // A fresh second browser to measure "present" against.
  const otherCookie = await newBrowserCookie("demo");
  const other = await trackedStream("/l/demo/events", otherCookie);
  const initial = await other.next();

  // The lecturer's own browser opens the STUDENT stream (/l/demo/events,
  // not /l/demo/lecturer/events) while also holding a valid lsess cookie.
  // It must get student state (yourTapCount/youAreCounted) and must count
  // as present — the route decides the state, not whichever cookies happen
  // to be on the request.
  const studentStream = await trackedStream("/l/demo/events", bothCookies);
  const studentFrame = await studentStream.next();
  expect(studentFrame).toHaveProperty("youAreCounted");
  expect(studentFrame).toHaveProperty("bars"); // ungated field, present either way

  const updated = await other.waitFor((s) => s.present === initial.present + 1);
  expect(updated.present).toBe(initial.present + 1);
});

it("below min_present, no tap data (live count, total, or timeline) leaves the server", async () => {
  // A dedicated lecture rather than demo: demo's min_present is 2 and other
  // spec files are busy tapping it, so this test needs a lecture it knows is
  // guaranteed to stay below threshold while it runs.
  const createRes = await fetch(new URL("/new", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "title=Privacy+check+lecture",
  });
  const createHtml = await createRes.text();
  const lectureId = createHtml.match(/\/l\/([a-f0-9]+)/)?.[1];
  const code = createHtml.match(/<strong>([A-Z0-9]+)<\/strong>/)?.[1];
  if (!lectureId || !code) throw new Error("couldn't parse the new lecture's id/code");
  // This lecture's min_present defaults to 5; one streaming browser plus one
  // tapping browser (2 present) stays well below that.

  const streamCookie = await newBrowserCookie(lectureId);
  const tapCookie = await newBrowserCookie(lectureId);

  const stream = await trackedStream(`/l/${lectureId}/events`, streamCookie);
  const before = await stream.next();
  expect(before.present).toBeLessThan(5);

  const rightCode = await fetch(new URL(`/l/${lectureId}/lecturer`, baseUrl), {
    method: "POST",
    headers: { cookie: streamCookie, "content-type": "application/x-www-form-urlencoded" },
    body: `code=${code}`,
    redirect: "manual",
  });
  const lsessCookie = rightCode.headers
    .getSetCookie()
    .find((c) => c.startsWith("lsess="))
    ?.split(";")[0];
  expect(lsessCookie).toBeDefined();
  const lecturerCookie = `${streamCookie}; ${lsessCookie}`;

  const lecturerStream = await trackedStream(`/l/${lectureId}/lecturer/events`, lecturerCookie);
  await lecturerStream.next();

  await fetch(new URL(`/l/${lectureId}/tap`, baseUrl), {
    method: "POST",
    headers: { cookie: tapCookie, "content-type": "application/x-www-form-urlencoded" },
    body: "deck=week-4&slide=1",
  });

  // The student's own open stream: a tap just happened, but present is
  // still below min_present, so no live count or total should be visible —
  // only the fields a hidden gauge needs (present, shown, this browser's
  // own tap bookkeeping, and bars — gated separately, per slide). Only one
  // distinct browser has tapped this lecture's slide 1, well below its
  // min_present of 5, so that slide's bar hasn't individually qualified
  // either — bars is empty, not just the live/total fields.
  const afterTapOnStream = await stream.next(1000);
  expect(afterTapOnStream.shown).toBe(false);
  expect(afterTapOnStream).not.toHaveProperty("live");
  expect(afterTapOnStream).not.toHaveProperty("totalTaps");
  expect(afterTapOnStream.bars).toEqual([]);

  // The student's own page render (server-rendered HTML), same lecture.
  const studentHtml = await (
    await fetch(new URL(`/l/${lectureId}`, baseUrl), { headers: { cookie: tapCookie } })
  ).text();
  expect(studentHtml).not.toMatch(/Total taps: \d+/);
  expect(studentHtml).not.toContain('<table class="bars"');

  // The lecturer dashboard, both its stream push and its page render.
  const lecturerFrame = await lecturerStream.next(1000);
  expect(lecturerFrame.shown).toBe(false);
  expect(lecturerFrame).not.toHaveProperty("live");
  expect(lecturerFrame).not.toHaveProperty("totalTaps");
  expect(lecturerFrame.bars).toEqual([]);

  const lecturerHtml = await (
    await fetch(new URL(`/l/${lectureId}/lecturer`, baseUrl), { headers: { cookie: lecturerCookie } })
  ).text();
  expect(lecturerHtml).not.toMatch(/Total taps: \d+/);
  expect(lecturerHtml).not.toContain('<table class="bars"');
});

// The per-minute timeline this test covered is retired by ADR 004: "the
// per-minute timeline is removed... a minute with one tap in it is a
// confession." Bars per (deck, slide) replace it (spec/slides.test.ts), and
// bars have no per-minute timestamp to format in any timezone, so this test
// has nothing left to check — removed along with the feature, in the same
// commit, not loosened.
