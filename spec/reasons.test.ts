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
  yourSlides: {
    deck: string | null;
    slide: number;
    live: boolean;
    resolved: boolean;
    answeredReason: boolean;
    answeredHelped: boolean;
  }[];
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

// On a lecture of its own: the demo's 20 s window means other spec files'
// demo taps can age out mid-test, and a drop of one person resolving would
// then read as two. A fresh lecture has no other taps, so the drop it sees
// is exactly this browser's "I get it now".
it("I get it now drops live by one within a second, and youAreCounted flips false", async () => {
  const lecture = await createLectureAndLogIn("I get it now drop test");
  // A created lecture's min_present is 5: four watchers plus the tapper.
  const cookie = await newBrowserCookie(lecture.id);
  const others = await Promise.all(Array.from({ length: 4 }, () => newBrowserCookie(lecture.id)));
  const stream = await SseStream.open(`/l/${lecture.id}/events`, cookie);
  const otherStreams = await Promise.all(others.map((c) => SseStream.open(`/l/${lecture.id}/events`, c)));
  try {
    await stream.waitFor((s) => s.shown && s.present === 5);
    // Another browser lost too, so live is 2 and the drop is to 1, not 0.
    await tap(lecture.id, others[0]);
    await tap(lecture.id, cookie);
    const afterTap = await stream.waitFor((s) => s.shown && s.youAreCounted && s.live === 2, 1000);
    expect(afterTap.live).toBe(2);

    await fetch(new URL(`/l/${lecture.id}/resolve`, baseUrl), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: "slide=1",
    });
    const afterResolve = await stream.waitFor((s) => s.shown && !s.youAreCounted, 1000);
    expect(afterResolve.live).toBe(afterTap.live! - 1);
    expect(afterResolve.youAreCounted).toBe(false);
  } finally {
    await stream.close();
    for (const s of otherStreams) await s.close();
  }
});

// One "I'm lost" per slide, ever: "I get it now" ends the tap's live status
// but doesn't free the slide. This replaces the C10-era test that a fresh
// tap inside the 60s window was accepted after resolving, which was right
// for one live tap per browser and is the opposite of the rule now
// (README: "One "I'm lost" per browser per slide").
it("after I get it now, the same slide can't be tapped again, but another slide can", async () => {
  const cookie = await newBrowserCookie("demo");
  const post = (path: string, body: string) =>
    fetch(new URL(path, baseUrl), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body,
      redirect: "manual",
    });
  await post("/l/demo/tap", "deck=week-4&slide=2");
  const resolveRes = await post("/l/demo/resolve", "deck=week-4&slide=2");
  expect(resolveRes.status).toBe(303);

  const retapRes = await post("/l/demo/tap", "deck=week-4&slide=2");
  expect(retapRes.status).toBe(303);
  const afterRetap = await SseStream.open("/l/demo/events", cookie);
  try {
    const state = await afterRetap.next();
    expect(state.youAreCounted).toBe(false);
    expect(state.yourTapCount).toBe(1);
  } finally {
    await afterRetap.close();
  }

  await post("/l/demo/tap", "deck=week-4&slide=5");
  const afterOther = await SseStream.open("/l/demo/events", cookie);
  try {
    const state = await afterOther.next();
    expect(state.youAreCounted).toBe(true);
    expect(state.yourTapCount).toBe(2);
  } finally {
    await afterOther.close();
  }
});

// A browser's own slides are its own: another browser's stream never lists
// them, the same discipline the old per-browser countdown had.
it("yourSlides lists only this browser's own taps, never another browser's", async () => {
  const cookieA = await newBrowserCookie("demo");
  const cookieB = await newBrowserCookie("demo");
  await fetch(new URL("/l/demo/tap", baseUrl), {
    method: "POST",
    headers: { cookie: cookieA, "content-type": "application/x-www-form-urlencoded" },
    body: "deck=week-6&slide=7",
  });

  const streamB = await SseStream.open("/l/demo/events", cookieB);
  try {
    const state = await streamB.next();
    expect(state.yourSlides).toEqual([]);
    expect(state.yourTapCount).toBe(0);
  } finally {
    await streamB.close();
  }
  const streamA = await SseStream.open("/l/demo/events", cookieA);
  try {
    const state = await streamA.next();
    expect(state.yourSlides).toEqual([
      { deck: "week-6", slide: 7, live: true, resolved: false, answeredReason: false, answeredHelped: false },
    ]);
  } finally {
    await streamA.close();
  }
});

// With one tap per slide a browser can be live on two slides at once, so a
// reason and "I get it now" act on the slide they name, not just the latest.
it("a reason and I get it now act on the slide they name", async () => {
  const lecture = await createLectureAndLogIn("Targeted reason test");
  const cookies = await Promise.all(Array.from({ length: 5 }, () => newBrowserCookie(lecture.id)));
  const post = (cookie: string, path: string, body: string) =>
    fetch(new URL(`/l/${lecture.id}/${path}`, baseUrl), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body,
      redirect: "manual",
    });
  for (const cookie of cookies) {
    await post(cookie, "tap", "slide=1");
    await post(cookie, "tap", "slide=2");
    // Slide 1 named, though slide 2 is the most recent tap.
    const reasonRes = await post(cookie, "reason", "slide=1&reason=Notation");
    expect(reasonRes.headers.get("location")).toBe(`/l/${lecture.id}?slide=1`);
  }
  const resolveRes = await post(cookies[0], "resolve", "slide=1");
  expect(resolveRes.headers.get("location")).toBe(`/l/${lecture.id}?slide=1`);

  const lecturerStream = await SseStream.open(`/l/${lecture.id}/lecturer/events`, lecture.lecturerCookie);
  try {
    const state = (await lecturerStream.next()) as unknown as { reasonCounts: { slide: number; reason: string; count: number }[] };
    expect(state.reasonCounts).toEqual([{ deck: null, slide: 1, reason: "Notation", count: 5 }]);
  } finally {
    await lecturerStream.close();
  }
  const own = await SseStream.open(`/l/${lecture.id}/events`, cookies[0]);
  try {
    const state = await own.next();
    expect(state.yourSlides).toEqual([
      { deck: null, slide: 1, live: false, resolved: true, answeredReason: true, answeredHelped: false },
      { deck: null, slide: 2, live: true, resolved: false, answeredReason: false, answeredHelped: false },
    ]);
  } finally {
    await own.close();
  }
});

// Without JS, each reason button and "I get it now" is a full page POST, and
// the redirect decides which slide the next page shows. Redirecting to a
// bare /l/demo lands on week-4's live slide, so the note form there carries
// that deck and slide, not the ones the student tapped. Their note is then
// gated with a different slide's notes, and the lecturer sees reasons on one
// slide and the note on another.
it("without JS, choosing a reason or I get it now returns to the deck and slide that was tapped", async () => {
  const cookie = await newBrowserCookie("demo");
  const tapRes = await fetch(new URL("/l/demo/tap", baseUrl), {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: "deck=week-6&slide=4",
    redirect: "manual",
  });
  expect(tapRes.headers.get("location")).toBe("/l/demo?deck=week-6&slide=4");

  const reasonRes = await fetch(new URL("/l/demo/reason", baseUrl), {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: "reason=Notation",
    redirect: "manual",
  });
  expect(reasonRes.status).toBe(303);
  expect(reasonRes.headers.get("location")).toBe("/l/demo?deck=week-6&slide=4");

  const resolveRes = await fetch(new URL("/l/demo/resolve", baseUrl), {
    method: "POST",
    headers: { cookie },
    redirect: "manual",
  });
  expect(resolveRes.status).toBe(303);
  expect(resolveRes.headers.get("location")).toBe("/l/demo?deck=week-6&slide=4");
});

// Answers lock once sent (ADR 006). A reason can't be changed after it's
// chosen: a second one for the same (browser, deck, slide) is refused, and
// the first stays counted. Before ADR 006 a reason could be changed while
// the tap was live (src/server.ts said so); this is that behaviour turned
// round, held on the server so no script can change an answer either.
async function postForm(lectureId: string, cookie: string, path: string, body: Record<string, string>): Promise<Response> {
  return fetch(new URL(`/l/${lectureId}/${path}`, baseUrl), {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    redirect: "manual",
  });
}

async function lecturerFrame(lecture: NewLecture): Promise<any> {
  const stream = await SseStream.open(`/l/${lecture.id}/lecturer/events`, lecture.lecturerCookie);
  try {
    return await stream.next();
  } finally {
    await stream.close();
  }
}

it("a reason locks once sent: a second reason for the same slide is refused and the first stays counted", async () => {
  const lecture = await createLectureAndLogIn("Reason locks test");
  const cookies = await Promise.all(Array.from({ length: 5 }, () => newBrowserCookie(lecture.id)));
  for (const cookie of cookies) {
    await postForm(lecture.id, cookie, "tap", { slide: "1" });
    const first = await postForm(lecture.id, cookie, "reason", { slide: "1", reason: "Too fast" });
    expect(first.status).toBe(303);
    const second = await postForm(lecture.id, cookie, "reason", { slide: "1", reason: "Notation" });
    expect(second.status).toBe(409);
  }
  const state = await lecturerFrame(lecture);
  expect(state.reasonCounts).toEqual([{ deck: null, slide: 1, reason: "Too fast", count: 5 }]);

  // Another slide takes its own reason.
  await postForm(lecture.id, cookies[0], "tap", { slide: "2" });
  const otherSlide = await postForm(lecture.id, cookies[0], "reason", { slide: "2", reason: "Notation" });
  expect(otherSlide.status).toBe(303);
});

it("the student page marks the chosen reason pressed, the rest not, and disables them all once sent", async () => {
  const cookie = await newBrowserCookie("demo");
  await postForm("demo", cookie, "tap", { deck: "week-6", slide: "5" });
  const before = await (await fetch(new URL("/l/demo?deck=week-6&slide=5", baseUrl), { headers: { cookie } })).text();
  const buttonsBefore = [...before.matchAll(/<form method="post" action="\/l\/demo\/reason" class="reason-form">[\s\S]*?<button([^>]*)>([^<]*)<\/button>/g)];
  expect(buttonsBefore.map((m) => m[2].replace(/&#39;/g, "'"))).toEqual(["Too fast", "Missed a step", "Notation", "Can't see or hear"]);
  for (const [, attrs] of buttonsBefore) {
    expect(attrs).toContain('aria-pressed="false"');
    expect(attrs).not.toContain("disabled");
  }

  await postForm("demo", cookie, "reason", { deck: "week-6", slide: "5", reason: "Notation" });
  const after = await (await fetch(new URL("/l/demo?deck=week-6&slide=5", baseUrl), { headers: { cookie } })).text();
  const buttonsAfter = [...after.matchAll(/<form method="post" action="\/l\/demo\/reason" class="reason-form">[\s\S]*?<button([^>]*)>([^<]*)<\/button>/g)];
  expect(buttonsAfter).toHaveLength(4);
  for (const [, attrs, label] of buttonsAfter) {
    expect(attrs).toContain(label === "Notation" ? 'aria-pressed="true"' : 'aria-pressed="false"');
    expect(attrs).toContain(label === "Notation" ? 'class="answer answer-chosen"' : 'class="answer answer-other"');
    expect(attrs).toMatch(/\sdisabled(\s|$)/);
  }
});

const HELPED = ["The next slide", "Re-reading it", "The example", "Someone explained it", "Worked it out myself"];

it("after I get it now the page says so and asks what helped, with exactly the five answers", async () => {
  const cookie = await newBrowserCookie("demo");
  await postForm("demo", cookie, "tap", { deck: "week-6", slide: "6" });
  const resolve = await postForm("demo", cookie, "resolve", { deck: "week-6", slide: "6" });
  expect(resolve.headers.get("location")).toBe("/l/demo?deck=week-6&slide=6");
  const html = await (await fetch(new URL("/l/demo?deck=week-6&slide=6", baseUrl), { headers: { cookie } })).text();
  expect(html).toContain("Glad you've got it now.");
  expect(html).toContain("<legend>What helped your understanding?</legend>");
  const answers = [...html.matchAll(/<form method="post" action="\/l\/demo\/helped" class="helped-form">[\s\S]*?<button[^>]*>([^<]*)<\/button>/g)].map(
    (m) => m[1],
  );
  expect(answers).toEqual(HELPED);
  // The reasons are gone once it's clicked.
  expect(html).not.toContain('id="reasons"');
});

it("what helped is accepted once, only after that slide's tap is resolved, and unknown answers get 400", async () => {
  const lecture = await createLectureAndLogIn("What helped test");
  const cookies = await Promise.all(Array.from({ length: 5 }, () => newBrowserCookie(lecture.id)));
  for (const cookie of cookies) {
    await postForm(lecture.id, cookie, "tap", { slide: "1" });
    // Not yet resolved: refused.
    expect((await postForm(lecture.id, cookie, "helped", { slide: "1", helped: "The example" })).status).toBe(409);
    await postForm(lecture.id, cookie, "resolve", { slide: "1" });
    expect((await postForm(lecture.id, cookie, "helped", { slide: "1", helped: "Made up" })).status).toBe(400);
    expect((await postForm(lecture.id, cookie, "helped", { slide: "1", helped: "The example" })).status).toBe(303);
    // Locked: a second answer is refused.
    expect((await postForm(lecture.id, cookie, "helped", { slide: "1", helped: "Re-reading it" })).status).toBe(409);
  }
  // A slide this browser never tapped has nothing to say what helped.
  expect((await postForm(lecture.id, cookies[0], "helped", { slide: "2", helped: "The example" })).status).toBe(409);

  const state = await lecturerFrame(lecture);
  expect(state.helpedCounts).toEqual([{ deck: null, slide: 1, helped: "The example", count: 5 }]);
});

it("what helped is gated per (slide, answer), and no answer ever reaches a student payload", async () => {
  const lecture = await createLectureAndLogIn("What helped privacy test");
  const cookies = await Promise.all(Array.from({ length: 5 }, () => newBrowserCookie(lecture.id)));
  for (const [i, cookie] of cookies.entries()) {
    await postForm(lecture.id, cookie, "tap", { slide: "1" });
    // Four and one: no reason reaches 5, so the room's gated "most people
    // say" stays absent and any reason text below would be a real leak.
    await postForm(lecture.id, cookie, "reason", { slide: "1", reason: i === 0 ? "Notation" : "Missed a step" });
    await postForm(lecture.id, cookie, "resolve", { slide: "1" });
    // Four say one thing, one says another: only the four-person answer is
    // below 5 too, so neither qualifies yet.
    await postForm(lecture.id, cookie, "helped", { slide: "1", helped: i === 0 ? "Someone explained it" : "The next slide" });
  }
  const below = await lecturerFrame(lecture);
  expect(below.helpedCounts).toEqual([]);

  // A fifth "The next slide" (a sixth browser) clears that answer only.
  const sixth = await newBrowserCookie(lecture.id);
  await postForm(lecture.id, sixth, "tap", { slide: "1" });
  await postForm(lecture.id, sixth, "resolve", { slide: "1" });
  await postForm(lecture.id, sixth, "helped", { slide: "1", helped: "The next slide" });
  const above = await lecturerFrame(lecture);
  expect(above.helpedCounts).toEqual([{ deck: null, slide: 1, helped: "The next slide", count: 5 }]);

  // Students: neither answer's text appears in the stream or the page, for
  // the browser that gave it or anyone else.
  for (const cookie of [cookies[0], cookies[1], await newBrowserCookie(lecture.id)]) {
    const stream = await SseStream.open(`/l/${lecture.id}/events`, cookie);
    try {
      const payload = JSON.stringify(await stream.next());
      for (const text of ["Missed a step", "Notation", ...HELPED]) expect(payload).not.toContain(text);
    } finally {
      await stream.close();
    }
  }
});
