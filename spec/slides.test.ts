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
  deck?: string;
  slide: number;
  bars: Bar[];
  live?: number;
  totalTaps?: number;
  yourTapCount: number;
  youAreCounted: boolean;
}

// A small SSE client over fetch's streaming body, mirroring spec/events.test.ts
// and spec/identity.test.ts's own copies — trimmed to what this file needs.
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

// Creates a fresh lecture and logs into its lecturer view in one go, since
// every slide-control test needs a lecturer session on a non-demo lecture
// (the demo's slide is clock-driven, not lecturer-editable).
async function createLectureAndLogIn(title: string): Promise<NewLecture> {
  const createRes = await fetch(new URL("/new", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `title=${encodeURIComponent(title)}`,
  });
  const createHtml = await createRes.text();
  const id = createHtml.match(/Student link: <a href="\/l\/([a-f0-9]+)"/)?.[1];
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

it("two streams on the same lecture see the same slide index", async () => {
  const cookieA = await newBrowserCookie("demo");
  const cookieB = await newBrowserCookie("demo");
  const a = await SseStream.open("/l/demo/events", cookieA);
  const b = await SseStream.open("/l/demo/events", cookieB);
  try {
    const stateA = await a.next();
    const stateB = await b.next();
    expect(stateA.slide).toBe(stateB.slide);
    expect(typeof stateA.slide).toBe("number");
  } finally {
    await a.close();
    await b.close();
  }
});

it("lecturer Next/Prev on a created lecture reaches open streams within a second", async () => {
  const lecture = await createLectureAndLogIn("Slide control test");
  const stream = await SseStream.open(`/l/${lecture.id}/events`, lecture.cookie);
  try {
    const before = await stream.next();
    expect(before.slide).toBe(1);

    const nextRes = await fetch(new URL(`/l/${lecture.id}/lecturer/slide/next`, baseUrl), {
      method: "POST",
      headers: { cookie: lecture.lecturerCookie },
      redirect: "manual",
    });
    expect(nextRes.status).toBe(303);

    const afterNext = await stream.waitFor((s) => s.slide === 2, 1000);
    expect(afterNext.slide).toBe(2);

    const prevRes = await fetch(new URL(`/l/${lecture.id}/lecturer/slide/prev`, baseUrl), {
      method: "POST",
      headers: { cookie: lecture.lecturerCookie },
      redirect: "manual",
    });
    expect(prevRes.status).toBe(303);

    const afterPrev = await stream.waitFor((s) => s.slide === 1, 1000);
    expect(afterPrev.slide).toBe(1);
  } finally {
    await stream.close();
  }
});

it("slide change without a lecturer session is rejected", async () => {
  const lecture = await createLectureAndLogIn("Slide control auth test");
  const res = await fetch(new URL(`/l/${lecture.id}/lecturer/slide/next`, baseUrl), {
    method: "POST",
    headers: { cookie: lecture.cookie }, // no lsess cookie
  });
  expect(res.status).toBe(403);
});

it("slide change on the demo lecture is rejected even with a valid lecturer session", async () => {
  const cookie = await newBrowserCookie("demo");
  const loginRes = await fetch(new URL("/l/demo/lecturer", baseUrl), {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: "code=DEMO",
    redirect: "manual",
  });
  const lsessCookie = loginRes.headers
    .getSetCookie()
    .find((c) => c.startsWith("lsess="))
    ?.split(";")[0];
  expect(lsessCookie).toBeDefined();

  const res = await fetch(new URL("/l/demo/lecturer/slide/next", baseUrl), {
    method: "POST",
    headers: { cookie: `${cookie}; ${lsessCookie}` },
  });
  expect(res.status).toBe(403);
});

// ADR 004's amendment dropped the 5-second grace window: a tap now always
// records whatever slide the viewer's own page says it's showing, with no
// reconciliation against the lecture's "current" slide. Browsing to an
// earlier slide and tapping there is a normal, expected use of the deck now
// — not a race to be lenient about.
it("a tap records the slide the request named, even if it differs from the live slide", async () => {
  const lecture = await createLectureAndLogIn("Viewed-slide test");
  const tapCookie = await newBrowserCookie(lecture.id);

  // Move the live slide to 2, then tap while still viewing slide 1 — a
  // perfectly normal "I was on an earlier slide" tap under the new design.
  await fetch(new URL(`/l/${lecture.id}/lecturer/slide/next`, baseUrl), {
    method: "POST",
    headers: { cookie: lecture.lecturerCookie },
  });

  const tapRes = await fetch(new URL(`/l/${lecture.id}/tap`, baseUrl), {
    method: "POST",
    headers: { cookie: tapCookie, "content-type": "application/x-www-form-urlencoded" },
    body: "slide=1",
    redirect: "manual",
  });
  expect(tapRes.status).toBe(303);
  expect(tapRes.headers.get("location")).toContain("slide=1");

  const stream = await SseStream.open(`/l/${lecture.id}/events`, lecture.cookie);
  try {
    const state = await stream.next();
    expect(state.slide).toBe(2); // the live slide moved on regardless of the tap
  } finally {
    await stream.close();
  }
});

it("a tap with an out-of-range slide is rejected, not silently reattributed", async () => {
  const lecture = await createLectureAndLogIn("Out-of-range slide test");
  const tapCookie = await newBrowserCookie(lecture.id);

  // The demo's deck has a fixed size; a created lecture doesn't, so this
  // checks the demo specifically, where a ceiling actually applies.
  const res = await fetch(new URL("/l/demo/tap", baseUrl), {
    method: "POST",
    headers: { cookie: await newBrowserCookie("demo"), "content-type": "application/x-www-form-urlencoded" },
    body: "slide=999",
  });
  expect(res.status).toBe(400);

  // A non-numeric slide is rejected the same way.
  const res2 = await fetch(new URL(`/l/${lecture.id}/tap`, baseUrl), {
    method: "POST",
    headers: { cookie: tapCookie, "content-type": "application/x-www-form-urlencoded" },
    body: "slide=not-a-number",
  });
  expect(res2.status).toBe(400);
});

it("browsing to a different slide doesn't change the live slide for anyone else", async () => {
  const otherCookie = await newBrowserCookie("demo");
  const stream = await SseStream.open("/l/demo/events", otherCookie);
  try {
    const before = await stream.next();

    // A GET with ?slide=N is pure browsing — it must never mutate shared
    // state, only change what this one request's page shows.
    const browseSlide = before.slide === 1 ? 2 : 1;
    await fetch(new URL(`/l/demo?slide=${browseSlide}`, baseUrl), {
      headers: { cookie: await newBrowserCookie("demo") },
    });

    // Give any (incorrect) broadcast a moment to arrive, then confirm the
    // live slide this other stream sees is unchanged.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const after = await stream.next(300).catch(() => before); // no new frame is the expected, correct outcome
    expect(after.slide).toBe(before.slide);
  } finally {
    await stream.close();
  }
});

// Two decks, switched between via a menu/?deck= query param, each with its
// own shared clock. Both decks' markup is always present in the page
// (toggled via `hidden`, so switching is a pure visibility change with no
// fetch) — so "which deck is showing" is read from the deck wrapper's
// `hidden` attribute, not from whether its text appears anywhere in the HTML
// at all.
function deckIsVisible(html: string, deckId: string): boolean {
  const match = html.match(new RegExp(`<div class="deck" data-deck="${deckId}"( hidden)?>`));
  if (!match) throw new Error(`no deck wrapper found for ${deckId}`);
  return match[1] === undefined;
}

// The one slide section in `deckId`'s wrapper without `hidden`.
function visibleSlide(html: string, deckId: string): number {
  const start = html.indexOf(`<div class="deck" data-deck="${deckId}"`);
  if (start === -1) throw new Error(`no deck wrapper found for ${deckId}`);
  const end = html.indexOf('<footer class="slide-credit">', start);
  const shown = [...html.slice(start, end).matchAll(/<section class="slide" data-slide="(\d+)"( hidden)?>/g)].filter(
    (m) => m[2] === undefined,
  );
  if (shown.length !== 1) throw new Error(`expected exactly one visible slide in ${deckId}, found ${shown.length}`);
  return Number(shown[0][1]);
}

function liveMarker(html: string): string | undefined {
  return html.match(/<p id="live-marker">([^<]*)<\/p>/)?.[1].replace(/&#39;/g, "'");
}

async function demoPage(path: string, cookie: string): Promise<string> {
  return (await fetch(new URL(path, baseUrl), { headers: { cookie } })).text();
}

async function demoLecturerCookie(): Promise<string> {
  const cookie = await newBrowserCookie("demo");
  const loginRes = await fetch(new URL("/l/demo/lecturer", baseUrl), {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: "code=DEMO",
    redirect: "manual",
  });
  const lsessCookie = loginRes.headers
    .getSetCookie()
    .find((c) => c.startsWith("lsess="))
    ?.split(";")[0];
  if (!lsessCookie) throw new Error("demo lecturer login failed");
  return `${cookie}; ${lsessCookie}`;
}

// "Slide 1 on entry" (docs/prompts/finish.md): each demo deck's shared clock
// starts when its first student stream opens, so nobody lands mid-lecture in
// an empty room. Real timing — SLIDE_DURATION_MS is 40s, so one wait for
// the first advance covers every scenario below in a single run:
// - the first viewer of an empty deck gets slide 1;
// - the slide change reaches an open stream on its own, with no tap or
//   reload (the bug this once guarded alone: slides only updated when
//   something else happened to cause a broadcast);
// - a second viewer who joins after 40s gets the same slide as the first;
// - watching one deck doesn't restart the other;
// - a lecturer stream never counts as watching;
// - after every viewer closes, the next one gets slide 1.
it(
  "each demo deck's clock starts with its first viewer, is shared by later ones, and restarts once all leave",
  async () => {
    const lecturer = await SseStream.open("/l/demo/lecturer/events", await demoLecturerCookie());
    const cookieA = await newBrowserCookie("demo");
    const cookieB = await newBrowserCookie("demo");
    const cookieC = await newBrowserCookie("demo");
    const open: SseStream[] = [lecturer];
    try {
      // A lecturer watching alone starts no clock: week-4 is still on 1.
      expect(visibleSlide(await demoPage("/l/demo", cookieA), "week-4")).toBe(1);

      const a = await SseStream.open("/l/demo/events?deck=week-4", cookieA);
      open.push(a);
      const first = await a.next();
      expect(first.deck).toBe("week-4");
      expect(first.slide).toBe(1);

      const advanced = await a.waitFor((s) => s.slide !== 1, 41_000);
      expect(advanced.slide).toBe(2);

      // Joining a running deck lands on its current slide, not slide 1 —
      // on the stream and on a page render alike.
      const b = await SseStream.open("/l/demo/events?deck=week-4", cookieB);
      open.push(b);
      const joined = await b.next();
      expect(joined.deck).toBe("week-4");
      expect(joined.slide).toBe(2);
      const week4Html = await demoPage("/l/demo?deck=week-4", cookieB);
      expect(visibleSlide(week4Html, "week-4")).toBe(2);
      expect(liveMarker(week4Html)).toBe("Live");
      expect(liveMarker(await demoPage("/l/demo?deck=week-4&slide=1", cookieB))).toBe(
        "You're on Week 4, slide 1. The lecture is on Week 4, slide 2.",
      );

      // Nobody is watching week-6 yet: a page render shows its slide 1, and
      // the first stream on it starts its own clock there — while week-4's
      // viewers, who get a frame from that same connect, stay on 2.
      expect(visibleSlide(await demoPage("/l/demo?deck=week-6", cookieC), "week-6")).toBe(1);
      const c = await SseStream.open("/l/demo/events?deck=week-6", cookieC);
      open.push(c);
      const week6First = await c.next();
      expect(week6First.deck).toBe("week-6");
      expect(week6First.slide).toBe(1);
      // present counts distinct browsers on any deck (A, B, C), so 3 picks
      // out the frame C's connect pushed to A.
      const aAfterWeek6 = await a.waitFor((s) => s.present === 3);
      expect(aAfterWeek6.deck).toBe("week-4");
      expect(aAfterWeek6.slide).toBe(2);

      // Everyone leaves (the lecturer stays): the next arrival, including
      // a returning browser, starts week-4 from slide 1 again.
      for (const stream of [a, b, c]) await stream.close();
      open.splice(1);
      expect(visibleSlide(await demoPage("/l/demo", cookieA), "week-4")).toBe(1);
      const again = await SseStream.open("/l/demo/events", cookieA);
      open.push(again);
      const restarted = await again.next();
      expect(restarted.deck).toBe("week-4"); // no ?deck= means the default deck
      expect(restarted.slide).toBe(1);
    } finally {
      for (const stream of open) await stream.close();
    }
  },
  50_000,
);

it("a stream with an invalid deck watches the default deck", async () => {
  const cookie = await newBrowserCookie("demo");
  const stream = await SseStream.open("/l/demo/events?deck=not-a-real-deck", cookie);
  try {
    const state = await stream.next();
    expect(state.deck).toBe("week-4");
    expect(state.slide).toBe(1);
  } finally {
    await stream.close();
  }
});

it("the live marker says Live on an unwatched deck's slide 1, and where the lecture is when browsing", async () => {
  const cookie = await newBrowserCookie("demo");
  expect(liveMarker(await demoPage("/l/demo?deck=week-6", cookie))).toBe("Live");
  expect(liveMarker(await demoPage("/l/demo?deck=week-6&slide=3", cookie))).toBe(
    "You're on Week 6, slide 3. The lecture is on Week 6, slide 1.",
  );
  // A created lecture has no clock of its own to be off, so no marker.
  const lecture = await createLectureAndLogIn("Live marker test");
  expect(liveMarker(await demoPage(`/l/${lecture.id}`, lecture.cookie))).toBeUndefined();
});

it("switching to week-6 shows its own content, not week-4's", async () => {
  const cookie = await newBrowserCookie("demo");
  const html = await (await fetch(new URL("/l/demo?deck=week-6", baseUrl), { headers: { cookie } })).text();
  expect(deckIsVisible(html, "week-6")).toBe(true);
  expect(deckIsVisible(html, "week-4")).toBe(false);

  // No-JS path: a plain GET with the query param behaves identically, since
  // the server renders every deck's content and toggles visibility —
  // there's no separate "JS" rendering path to diverge from this.
  const noJsHtml = await (await fetch(new URL("/l/demo?deck=week-6", baseUrl))).text();
  expect(deckIsVisible(noJsHtml, "week-6")).toBe(true);
});

it("a tap while viewing week-6 records that deck; a tap on the live week-4 slide records week-4", async () => {
  const cookieA = await newBrowserCookie("demo");
  const cookieB = await newBrowserCookie("demo");

  const week6Res = await fetch(new URL("/l/demo/tap", baseUrl), {
    method: "POST",
    headers: { cookie: cookieA, "content-type": "application/x-www-form-urlencoded" },
    body: "deck=week-6&slide=1",
    redirect: "manual",
  });
  expect(week6Res.status).toBe(303);
  expect(week6Res.headers.get("location")).toContain("deck=week-6");

  const week4Res = await fetch(new URL("/l/demo/tap", baseUrl), {
    method: "POST",
    headers: { cookie: cookieB, "content-type": "application/x-www-form-urlencoded" },
    body: "deck=week-4&slide=1",
    redirect: "manual",
  });
  expect(week4Res.status).toBe(303);
  expect(week4Res.headers.get("location")).toContain("deck=week-4");
});

it("an invalid deck id is rejected on a tap, and falls back to the live deck on a page view", async () => {
  const cookie = await newBrowserCookie("demo");

  const tapRes = await fetch(new URL("/l/demo/tap", baseUrl), {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: "deck=not-a-real-deck&slide=1",
  });
  expect(tapRes.status).toBe(400);

  // A page view with an unrecognized deck id falls back to the live deck
  // (week-4) rather than erroring, same discipline as an invalid slide
  // number already falls back rather than 404ing a whole page.
  const html = await (await fetch(new URL("/l/demo?deck=not-a-real-deck", baseUrl), { headers: { cookie } })).text();
  expect(deckIsVisible(html, "week-4")).toBe(true);
});

// Each deck runs its own clock now, so "Back to live" stays on the deck
// being viewed and returns to that deck's live slide — not to week-4's, as
// when week-4 was the only deck with a clock.
it("Back to live from a browsed week-6 slide returns to week-6's live slide", async () => {
  const cookie = await newBrowserCookie("demo");
  const html = await demoPage("/l/demo?deck=week-6&slide=4", cookie);
  const link = html.match(/<a href="([^"]*)" id="back-to-live-link"( hidden)?>/);
  expect(link).not.toBeNull();
  expect(link![2]).toBeUndefined(); // shown: slide 4 isn't live
  expect(link![1]).toBe("/l/demo?deck=week-6");

  const backHtml = await demoPage(link![1], cookie);
  expect(deckIsVisible(backHtml, "week-6")).toBe(true);
  expect(deckIsVisible(backHtml, "week-4")).toBe(false);
  expect(visibleSlide(backHtml, "week-6")).toBe(1); // nobody is watching week-6
  expect(liveMarker(backHtml)).toBe("Live");
  // On the live slide, the link is still in the markup (so the script can
  // reveal it when the clock moves on), just hidden.
  expect(backHtml).toMatch(/<a href="\/l\/demo\?deck=week-6" id="back-to-live-link" hidden>/);
});

it("both real diagrams render as accessible inline SVG", async () => {
  const cookie = await newBrowserCookie("demo");
  const week4Html = await (
    await fetch(new URL("/l/demo?deck=week-4&slide=10", baseUrl), { headers: { cookie } })
  ).text();
  expect(week4Html).toContain("<svg");
  expect(week4Html).toContain('role="img"');
  expect(week4Html).toMatch(/<title id="skill-loading-title">/);
  expect(week4Html).toMatch(/<desc id="skill-loading-desc">/);

  const week6Html = await (
    await fetch(new URL("/l/demo?deck=week-6&slide=9", baseUrl), { headers: { cookie } })
  ).text();
  expect(week6Html).toContain("<svg");
  expect(week6Html).toContain('role="img"');
  expect(week6Html).toMatch(/<title id="actions-run-title">/);
  expect(week6Html).toMatch(/<desc id="actions-run-desc">/);
});

// Phase 2: bars per slide — distinct browsers who've ever tapped a slide,
// gated independently of present/shown (ADR 004's refined privacy rule).
it("tapping, undoing, and tapping the same slide again counts once toward its bar", async () => {
  const lecture = await createLectureAndLogIn("Bars dedup test");
  const tapCookie = await newBrowserCookie(lecture.id);
  // Enough other browsers present+tapping the same slide to clear this
  // lecture's min_present (5), so the bar actually surfaces to check.
  const otherCookies = await Promise.all(
    Array.from({ length: 4 }, () => newBrowserCookie(lecture.id)),
  );

  async function tapSlide1(cookie: string) {
    await fetch(new URL(`/l/${lecture.id}/tap`, baseUrl), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: "slide=1",
    });
  }

  await tapSlide1(tapCookie);
  // A second tap from the same browser within 60s is deduped by the
  // existing tapIfNotRecentlyTapped logic — shouldn't change the bar either
  // way, but exercising it here confirms the dedup and the bar count agree.
  await tapSlide1(tapCookie);
  for (const cookie of otherCookies) await tapSlide1(cookie);

  const stream = await SseStream.open(`/l/${lecture.id}/events`, lecture.cookie);
  try {
    const state = await stream.waitFor((s) => s.bars.length > 0, 2000);
    const slide1Bar = state.bars.find((b) => b.slide === 1);
    expect(slide1Bar).toBeDefined();
    expect(slide1Bar!.distinctBrowsers).toBe(5); // tapCookie + 4 others, not 6
  } finally {
    await stream.close();
  }
});

it("a slide below min_present distinct browsers sends no bar for it", async () => {
  const lecture = await createLectureAndLogIn("Bars threshold test");
  const tapCookie = await newBrowserCookie(lecture.id);

  await fetch(new URL(`/l/${lecture.id}/tap`, baseUrl), {
    method: "POST",
    headers: { cookie: tapCookie, "content-type": "application/x-www-form-urlencoded" },
    body: "slide=1",
  });

  const stream = await SseStream.open(`/l/${lecture.id}/events`, lecture.cookie);
  try {
    const state = await stream.next();
    // Only one distinct browser has tapped slide 1, well below this
    // lecture's default min_present (5) — no bar for it at all.
    expect(state.bars.find((b) => b.slide === 1)).toBeUndefined();
  } finally {
    await stream.close();
  }
});

it("a lone returning browser still receives bars for slides that independently qualify", async () => {
  const lecture = await createLectureAndLogIn("Bars independent-of-presence test");
  const otherCookies = await Promise.all(
    Array.from({ length: 5 }, () => newBrowserCookie(lecture.id)),
  );
  for (const cookie of otherCookies) {
    await fetch(new URL(`/l/${lecture.id}/tap`, baseUrl), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: "slide=1",
    });
  }

  // A single, otherwise-unused browser opens the stream alone — present is
  // 1, well below min_present, so shown is false — but the bar still
  // cleared its own threshold independently, and this browser's own tap
  // bookkeeping is still there regardless.
  const loneCookie = await newBrowserCookie(lecture.id);
  const stream = await SseStream.open(`/l/${lecture.id}/events`, loneCookie);
  try {
    const state = await stream.next();
    expect(state.shown).toBe(false);
    expect(state.bars.find((b) => b.slide === 1)?.distinctBrowsers).toBe(5);
    expect(state).toHaveProperty("yourTapCount");
  } finally {
    await stream.close();
  }
});

it("no gated field (live, total, or any bar below its own threshold) appears below the thresholds", async () => {
  const lecture = await createLectureAndLogIn("Bars privacy test");
  const tapCookie = await newBrowserCookie(lecture.id);

  await fetch(new URL(`/l/${lecture.id}/tap`, baseUrl), {
    method: "POST",
    headers: { cookie: tapCookie, "content-type": "application/x-www-form-urlencoded" },
    body: "slide=1",
  });

  const stream = await SseStream.open(`/l/${lecture.id}/events`, lecture.cookie);
  try {
    const state = await stream.next();
    const payload = JSON.stringify(state);
    expect(payload).not.toContain('"live"');
    expect(payload).not.toContain('"totalTaps"');
    expect(state.bars).toEqual([]); // no slide here has cleared its own threshold
  } finally {
    await stream.close();
  }
});

// "Slide 6" alone didn't say which of the demo's two decks the lecturer
// view meant (docs/feedback/finish.md). Every place a demo slide is named
// to a person names its deck, and "(live)" marks the live slide; a created
// lecture has no deck, so it stays "Slide N".
// The page minus its inline scripts: what the server rendered for a person
// to read. The scripts carry the deck names for live updates, so a raw
// search of the HTML would find them on every page.
function renderedMarkup(html: string): string {
  return html.replace(/<script>[\s\S]*?<\/script>/g, "");
}

function slideLabel(html: string): string | undefined {
  return html.match(/<p id="slide-label">([^<]*)<\/p>/)?.[1];
}

async function tapReasonNote(lectureId: string, cookie: string, deck: string | null, slide: number, text: string) {
  const deckField: Record<string, string> = deck !== null ? { deck } : {};
  const post = (path: string, body: Record<string, string>) =>
    fetch(new URL(`/l/${lectureId}/${path}`, baseUrl), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
      redirect: "manual",
    });
  await post("tap", { ...deckField, slide: String(slide) });
  await post("reason", { reason: "Notation" });
  await post("note", { ...deckField, slide: String(slide), text });
}

it("the demo's student page names the deck and slide, with (live) only on the live slide", async () => {
  const cookie = await newBrowserCookie("demo");
  // Nobody is watching week-6, so its live slide is 1.
  expect(slideLabel(await demoPage("/l/demo?deck=week-6", cookie))).toBe("Week 6, slide 1 of 9 (live)");
  expect(slideLabel(await demoPage("/l/demo?deck=week-6&slide=3", cookie))).toBe("Week 6, slide 3 of 9");
});

it("the demo's lecturer view names the deck on its current slide, bars, reasons and notes", async () => {
  const cookies = [await newBrowserCookie("demo"), await newBrowserCookie("demo")];
  for (const [i, cookie] of cookies.entries()) {
    await tapReasonNote("demo", cookie, "week-6", 9, `deck naming note ${i}`);
  }
  const html = await demoPage("/l/demo/lecturer", await demoLecturerCookie());
  expect(slideLabel(html)).toMatch(/^Week 4, slide \d+ \(live\)$/);
  expect(html).toContain("<tr><td>Week 6, slide 9</td><td>");
  expect(html).toContain("<tr><td>Week 6, slide 9</td><td>Notation</td><td>");
  expect(html).toContain('<p class="note-slide">Week 6, slide 9</p>');
  expect(html).not.toContain("week-6 / slide");

  // The student page's bars name the deck too.
  const studentHtml = await demoPage("/l/demo", cookies[0]);
  expect(studentHtml).toContain("<tr><td>Week 6, slide 9</td><td>");
});

it("a created lecture has no deck: its pages say Slide N, with (live) on the current slide", async () => {
  const lecture = await createLectureAndLogIn("Slide naming test");
  const cookies = await Promise.all(Array.from({ length: 5 }, () => newBrowserCookie(lecture.id)));
  for (const [i, cookie] of cookies.entries()) {
    await tapReasonNote(lecture.id, cookie, null, 1, `created lecture note ${i}`);
  }

  const lecturerHtml = await demoPage(`/l/${lecture.id}/lecturer`, lecture.lecturerCookie);
  expect(slideLabel(lecturerHtml)).toBe("Slide 1 (live)");
  expect(lecturerHtml).toContain("<tr><td>Slide 1</td><td>5</td></tr>");
  expect(lecturerHtml).toContain("<tr><td>Slide 1</td><td>Notation</td><td>5</td></tr>");
  expect(renderedMarkup(lecturerHtml)).not.toMatch(/Week \d/);

  const studentHtml = await demoPage(`/l/${lecture.id}`, cookies[0]);
  expect(slideLabel(studentHtml)).toBe("Slide 1 (live)");
  expect(studentHtml).toContain("<tr><td>Slide 1</td><td>5</td></tr>");
  expect(renderedMarkup(studentHtml)).not.toMatch(/Week \d/);
});
