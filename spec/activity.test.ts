import { createHash } from "node:crypto";
import { expect, inject, it } from "vitest";
import { newBrowserCookie } from "./test-helpers.ts";

// The lecturer's activity log (ADR 006, CLAUDE.md: "Every activity log line
// covers at least min_present actions"). Created lectures have
// min_present 5, so every line here is about 5, 10, ... people.
const baseUrl = inject("baseUrl");
const MIN_PRESENT = 5;

interface NewLecture {
  id: string;
  lecturerCookie: string;
}

// Each lecture gets a fresh creator cookie: /new allows 3 per browser per hour.
async function createLectureAndLogIn(title: string): Promise<NewLecture> {
  const creator = await newBrowserCookie("demo");
  const createHtml = await (
    await fetch(new URL("/new", baseUrl), {
      method: "POST",
      headers: { cookie: creator, "content-type": "application/x-www-form-urlencoded" },
      body: `title=${encodeURIComponent(title)}`,
    })
  ).text();
  const id = createHtml.match(/Student link: <a href="\/l\/([a-f0-9]+)"/)?.[1];
  const code = createHtml.match(/<strong>([A-Z0-9]+)<\/strong>/)?.[1];
  if (!id || !code) throw new Error("couldn't parse the new lecture's id/code");
  return { id, lecturerCookie: await logIn(id, code) };
}

async function logIn(id: string, code: string): Promise<string> {
  const cookie = await newBrowserCookie(id);
  const res = await fetch(new URL(`/l/${id}/lecturer`, baseUrl), {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: `code=${code}`,
    redirect: "manual",
  });
  const lsess = res.headers.getSetCookie().find((c) => c.startsWith("lsess="))?.split(";")[0];
  if (!lsess) throw new Error("lecturer login failed");
  return `${cookie}; ${lsess}`;
}

function post(path: string, cookie: string, body: Record<string, string>): Promise<Response> {
  return fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    redirect: "manual",
  });
}

async function browsers(lectureId: string, n: number): Promise<string[]> {
  return Promise.all(Array.from({ length: n }, () => newBrowserCookie(lectureId)));
}

// Each browser says it's lost on the slide, one after another so row ids
// follow the order given.
async function tapAll(lectureId: string, cookies: string[], slide: number, deck?: string): Promise<void> {
  for (const cookie of cookies) {
    await post(`/l/${lectureId}/tap`, cookie, { slide: String(slide), ...(deck ? { deck } : {}) });
  }
}

async function lecturerPage(lecture: NewLecture, query = ""): Promise<string> {
  const res = await fetch(new URL(`/l/${lecture.id}/lecturer${query}`, baseUrl), {
    headers: { cookie: lecture.lecturerCookie },
  });
  return res.text();
}

// The <section id="activity-log"> element's HTML, or "" when absent.
function activitySection(html: string): string {
  return html.match(/<section id="activity-log"[\s\S]*?<\/section>/)?.[0] ?? "";
}

function lines(html: string): string[] {
  return [...activitySection(html).matchAll(/<li class="activity-line">([\s\S]*?)<\/li>/g)].map((m) => m[1].trim());
}

// Reads the first SSE data frame that satisfies `want` (any frame if none).
async function frameFrom(path: string, cookie: string, want?: (data: string) => boolean): Promise<string> {
  const controller = new AbortController();
  const res = await fetch(new URL(path, baseUrl), { headers: { cookie }, signal: controller.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + 3000;
  try {
    for (;;) {
      const sep = buffer.indexOf("\n\n");
      if (sep !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const data = frame.split("\n").find((l) => l.startsWith("data: "))?.slice(6);
        if (data !== undefined && (!want || want(data))) return data;
        continue;
      }
      if (Date.now() > deadline) throw new Error("no matching SSE frame");
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no SSE frame in time")), 3000)),
      ]);
      if (done) throw new Error("stream closed");
      buffer += decoder.decode(value, { stream: true });
    }
  } finally {
    controller.abort();
  }
}

it("min_present taps on one slide give exactly one 'lost' line; one fewer gives none", async () => {
  const short = await createLectureAndLogIn("Activity below threshold");
  await tapAll(short.id, await browsers(short.id, MIN_PRESENT - 1), 1);
  const shortHtml = await lecturerPage(short);
  expect(activitySection(shortHtml)).toContain("<h2");
  expect(lines(shortHtml)).toEqual([]);
  expect(activitySection(shortHtml)).toContain(
    `Lines appear each time ${MIN_PRESENT} more people do something on a slide.`,
  );

  const enough = await createLectureAndLogIn("Activity at threshold");
  await tapAll(enough.id, await browsers(enough.id, MIN_PRESENT), 1);
  expect(lines(await lecturerPage(enough))).toEqual([`Slide 1: ${MIN_PRESENT} more people lost`]);
});

it("2 * min_present taps on a slide give two lines, newest first, each a multiple of min_present", async () => {
  const lecture = await createLectureAndLogIn("Activity two lines");
  await tapAll(lecture.id, await browsers(lecture.id, 2 * MIN_PRESENT), 3);
  await tapAll(lecture.id, await browsers(lecture.id, MIN_PRESENT), 4);
  const found = lines(await lecturerPage(lecture));
  expect(found).toEqual([
    `Slide 4: ${MIN_PRESENT} more people lost`,
    `Slide 3: ${MIN_PRESENT} more people lost`,
    `Slide 3: ${MIN_PRESENT} more people lost`,
  ]);
  for (const line of found) {
    const n = Number(line.match(/(\d+) (?:more|new|people)/)?.[1]);
    expect(n % MIN_PRESENT).toBe(0);
    expect(n).toBeGreaterThanOrEqual(MIN_PRESENT);
  }
});

it("'mostly X' appears only once X itself was chosen by min_present people on that slide", async () => {
  const qualifies = await createLectureAndLogIn("Activity mostly qualifies");
  const cookies = await browsers(qualifies.id, MIN_PRESENT);
  await tapAll(qualifies.id, cookies, 2);
  for (const cookie of cookies) {
    await post(`/l/${qualifies.id}/reason`, cookie, { reason: "Missed a step", slide: "2" });
  }
  expect(lines(await lecturerPage(qualifies))).toEqual([
    `Slide 2: ${MIN_PRESENT} more people lost, mostly Missed a step`,
  ]);

  const short = await createLectureAndLogIn("Activity mostly too few");
  const shortCookies = await browsers(short.id, MIN_PRESENT);
  await tapAll(short.id, shortCookies, 2);
  for (const cookie of shortCookies.slice(1)) {
    await post(`/l/${short.id}/reason`, cookie, { reason: "Missed a step", slide: "2" });
  }
  const shortLines = lines(await lecturerPage(short));
  expect(shortLines).toEqual([`Slide 2: ${MIN_PRESENT} more people lost`]);
  expect(activitySection(await lecturerPage(short))).not.toContain("mostly");
});

it("visible notes make a line; hiding one takes its contribution back out", async () => {
  const lecture = await createLectureAndLogIn("Activity notes");
  const cookies = await browsers(lecture.id, MIN_PRESENT);
  await tapAll(lecture.id, cookies, 5);
  for (const [i, cookie] of cookies.entries()) {
    await post(`/l/${lecture.id}/note`, cookie, { slide: "5", text: `activity note number ${"abcde"[i]}` });
  }
  const before = await lecturerPage(lecture);
  expect(lines(before)).toContain(`${MIN_PRESENT} new notes on slide 5`);
  // Note text is never part of the log itself.
  expect(activitySection(before)).not.toContain("activity note number");

  const noteId = before.match(/data-note-id="(\d+)"/)?.[1];
  expect(noteId).toBeDefined();
  const hide = await post(`/l/${lecture.id}/lecturer/note/${noteId}/hide`, lecture.lecturerCookie, {});
  expect(hide.status).toBe(303);

  const after = lines(await lecturerPage(lecture));
  expect(after.some((l) => l.includes("new notes"))).toBe(false);
  expect(after).toContain(`Slide 5: ${MIN_PRESENT} more people lost`);
});

it("the lecturer page and stream carry the log; the student page and stream never do", async () => {
  const lecture = await createLectureAndLogIn("Activity routes");
  const cookies = await browsers(lecture.id, MIN_PRESENT);
  const lineText = `Slide 1: ${MIN_PRESENT} more people lost`;

  // An already-open lecturer stream gets the line on a later broadcast.
  const live = frameFrom(`/l/${lecture.id}/lecturer/events`, lecture.lecturerCookie, (d) => d.includes(lineText));
  await new Promise((r) => setTimeout(r, 100));
  await tapAll(lecture.id, cookies, 1);
  const lecturerFrame = await live;
  const lecturerState = JSON.parse(lecturerFrame);
  expect(lecturerState.activityLog).toEqual([{ deck: null, slide: 1, kind: "lost", text: lineText }]);

  expect(activitySection(await lecturerPage(lecture))).toContain(lineText);

  const studentHtml = await (
    await fetch(new URL(`/l/${lecture.id}`, baseUrl), { headers: { cookie: cookies[0] } })
  ).text();
  expect(studentHtml).not.toContain('id="activity-log"');
  expect(studentHtml).not.toContain(">Activity<");
  expect(studentHtml).not.toContain(lineText);

  const studentFrame = await frameFrom(`/l/${lecture.id}/events`, cookies[0]);
  expect(studentFrame).not.toContain("activity");
  expect(studentFrame).not.toContain(lineText);
});

it("no log line or payload holds a browser id, a hash of one, or a student label", async () => {
  const lecture = await createLectureAndLogIn("Activity privacy");
  const cookies = await browsers(lecture.id, MIN_PRESENT);
  await tapAll(lecture.id, cookies, 1);
  for (const cookie of cookies) {
    await post(`/l/${lecture.id}/reason`, cookie, { reason: "Too fast", slide: "1" });
    await post(`/l/${lecture.id}/note`, cookie, { slide: "1", text: "privacy check note" });
  }
  const html = activitySection(await lecturerPage(lecture));
  const frame = await frameFrom(`/l/${lecture.id}/lecturer/events`, lecture.lecturerCookie);
  const log = JSON.stringify(JSON.parse(frame).activityLog);
  expect(log).toContain("more people lost, mostly Too fast");
  expect(log).toContain("new notes");

  for (const cookie of cookies) {
    const bid = cookie.replace(/^bid=/, "");
    const hash = createHash("sha256").update(bid).digest("hex");
    for (const payload of [html, log]) {
      expect(payload).not.toContain(bid);
      expect(payload).not.toContain(hash.slice(0, 8));
    }
  }
  for (const payload of [html, log]) {
    expect(payload).not.toMatch(/student/i);
    expect(payload).not.toContain("privacy check note");
  }
});

it("a created lecture's log has no filter: it has no decks, and each line names its slide", async () => {
  const lecture = await createLectureAndLogIn("Activity filter");
  await tapAll(lecture.id, await browsers(lecture.id, MIN_PRESENT), 1);
  await tapAll(lecture.id, await browsers(lecture.id, MIN_PRESENT), 2);

  const all = await lecturerPage(lecture);
  expect(lines(all)).toEqual([`Slide 2: ${MIN_PRESENT} more people lost`, `Slide 1: ${MIN_PRESENT} more people lost`]);
  expect(activitySection(all)).not.toContain("<form");
  expect(activitySection(all)).not.toContain("logSlide");

  // A slide filter in the URL is ignored, not applied.
  const asked = await fetch(new URL(`/l/${lecture.id}/lecturer?logSlide=1&logDeck=%3Cscript%3E`, baseUrl), {
    headers: { cookie: lecture.lecturerCookie },
  });
  expect(asked.status).toBe(200);
  expect(lines(await asked.text())).toHaveLength(2);
});

it("the demo's deck filter keeps one deck's lines and drops the other's", async () => {
  // The demo's min_present is 2, so 2 fresh browsers on a week-6 slide make
  // sure a week-6 line exists whatever else has tapped the demo.
  const lecturerCookie = await logIn("demo", "DEMO");
  const demo = { id: "demo", lecturerCookie };
  const cookies = await browsers("demo", 2);
  await tapAll("demo", cookies, 7, "week-6");

  // The demo filters by deck only, as a plain GET form with no script.
  const page = await lecturerPage(demo);
  expect(activitySection(page)).toMatch(/<form method="get" action="\/l\/demo\/lecturer"/);
  expect(activitySection(page)).toContain('name="logDeck"');
  expect(activitySection(page)).not.toContain("logSlide");

  const week6 = lines(await lecturerPage(demo, "?logDeck=week-6"));
  expect(week6.some((l) => l.includes("Week 6 \u00b7 slide 7"))).toBe(true);
  expect(week6.every((l) => l.startsWith("Week 6"))).toBe(true);

  const week4 = lines(await lecturerPage(demo, "?logDeck=week-4"));
  expect(week4.some((l) => l.includes("Week 6"))).toBe(false);
});

// Legacy duplicates (legacy_duplicate = 1) can't be made over HTTP: the
// taps_one_per_slide index turns a second tap into a no-op, and only the
// one-time migration in src/db.ts ever sets the flag. This checks the part
// HTTP can reach: a browser tapping the same slide again adds nothing.
it("tapping the same slide again never counts twice towards a line", async () => {
  const lecture = await createLectureAndLogIn("Activity repeat taps");
  const cookies = await browsers(lecture.id, MIN_PRESENT - 1);
  await tapAll(lecture.id, cookies, 1);
  await tapAll(lecture.id, cookies, 1);
  expect(lines(await lecturerPage(lecture))).toEqual([]);
});
