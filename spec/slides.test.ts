import { expect, inject, it } from "vitest";
import { newBrowserCookie } from "./test-helpers.ts";

const baseUrl = inject("baseUrl");

interface MeterState {
  present: number;
  shown: boolean;
  slide: number;
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

// The demo's slide is driven entirely by the shared clock, with no request
// (tap, connect, lecturer action) to trigger the change — so an open stream
// must see it pushed on its own, the same way a live tap's 60s fade pushes
// without a new tap. Bug this guards against: slides only updated when
// something else happened to cause a broadcast (e.g. a page reload).
it(
  "the demo's slide change reaches an open stream on its own, with no tap or reload",
  async () => {
    const cookie = await newBrowserCookie("demo");
    const stream = await SseStream.open("/l/demo/events", cookie);
    try {
      const before = await stream.next();
      const after = await stream.waitFor((s) => s.slide !== before.slide, 41_000);
      expect(after.slide).not.toBe(before.slide);
    } finally {
      await stream.close();
    }
  },
  45_000,
);

// Two decks, added after the first slide-navigation design: week-4 is the
// one with a shared clock (the demo's "live" slide), week-6 is a second deck
// that's only ever browsed, switched between via a menu/?deck= query param.
// Both decks' markup is always present in the page (toggled via `hidden`, so
// switching is a pure visibility change with no fetch) — so "which deck is
// showing" is read from the deck wrapper's `hidden` attribute, not from
// whether its text appears anywhere in the HTML at all.
function deckIsVisible(html: string, deckId: string): boolean {
  const match = html.match(new RegExp(`<div class="deck" data-deck="${deckId}"( hidden)?>`));
  if (!match) throw new Error(`no deck wrapper found for ${deckId}`);
  return match[1] === undefined;
}

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

it("Back to live from week-6 returns to week-4's live slide", async () => {
  const cookie = await newBrowserCookie("demo");
  const html = await (await fetch(new URL("/l/demo?deck=week-6", baseUrl), { headers: { cookie } })).text();
  const href = html.match(/<a href="([^"]*)" id="back-to-live-link"/)?.[1];
  expect(href).toBeDefined();
  expect(href).not.toContain("deck="); // bare /l/demo, no deck param at all — means "the live deck"

  const backHtml = await (await fetch(new URL(href!, baseUrl), { headers: { cookie } })).text();
  expect(deckIsVisible(backHtml, "week-4")).toBe(true);
  expect(deckIsVisible(backHtml, "week-6")).toBe(false);
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
