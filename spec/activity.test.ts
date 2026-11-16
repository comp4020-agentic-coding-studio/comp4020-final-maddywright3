import { createHash } from "node:crypto";
import { expect, inject, it } from "vitest";
import { newBrowserCookie } from "./test-helpers.ts";

// The lecturer's activity log (CLAUDE.md, changed by the user in b35eaa3):
// one line per press, newest first, labelled only "Person N" (numbered per
// run, in order of first press) with an AEST time. The label is never a
// browser ID or derived from one, never reaches a student, and note text
// never appears in it.
const baseUrl = inject("baseUrl");

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
      body: `title=${encodeURIComponent(title)}&slides=60&minutes=60`,
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

function tap(lectureId: string, cookie: string, slide: number, deck?: string): Promise<Response> {
  return post(`/l/${lectureId}/tap`, cookie, { slide: String(slide), ...(deck ? { deck } : {}) });
}

// The lecturer page with nobody present, as a lecturer would see it below
// the threshold. Most tests read the log through lecturerPage instead, which
// holds enough people present first (the log is sent only at min_present).
async function lecturerPageAlone(lecture: NewLecture, query = ""): Promise<string> {
  const res = await fetch(new URL(`/l/${lecture.id}/lecturer${query}`, baseUrl), {
    headers: { cookie: lecture.lecturerCookie },
  });
  return res.text();
}

// The demo's min_present is 2; a created lecture's is 5.
const thresholdFor = (lectureId: string): number => (lectureId === "demo" ? 2 : 5);

async function lecturerPage(lecture: NewLecture, query = ""): Promise<string> {
  const close = await present(lecture.id, thresholdFor(lecture.id));
  try {
    return await lecturerPageAlone(lecture, query);
  } finally {
    await close();
  }
}

// The <section id="activity-log"> element's HTML, or "" when absent.
function activitySection(html: string): string {
  return html.match(/<section id="activity-log"[\s\S]*?<\/section>/)?.[0] ?? "";
}

function lineItems(html: string): string[] {
  return [...activitySection(html).matchAll(/<li class="activity-line">([\s\S]*?)<\/li>/g)].map((m) => m[1]);
}

const decode = (s: string): string =>
  s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// Each line's words, without its leading <time>, as a reader sees them.
function lines(html: string): string[] {
  return lineItems(html).map((item) => decode(item.replace(/<time[^>]*>[\s\S]*?<\/time>/, "").trim()));
}

// Each line's <time>: its datetime attribute and its text.
function times(html: string): { iso: string; text: string }[] {
  return lineItems(html).map((item) => {
    const m = item.match(/<time datetime="([^"]*)">([\s\S]*?)<\/time>/);
    if (!m) throw new Error(`line has no <time>: ${item}`);
    return { iso: m[1], text: m[2] };
  });
}

async function freshRun(lecture: NewLecture): Promise<void> {
  const confirm = await (
    await fetch(new URL(`/l/${lecture.id}/lecturer/runs/new`, baseUrl), { headers: { cookie: lecture.lecturerCookie } })
  ).text();
  const run = confirm.match(/name="run" value="(\d+)"/)?.[1];
  if (!run) throw new Error("no run field on the confirmation page");
  const res = await post(`/l/${lecture.id}/lecturer/runs`, lecture.lecturerCookie, { run });
  if (res.status !== 303) throw new Error(`fresh run failed: ${res.status}`);
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

// Holds n student streams open on a lecture, so present >= n, and returns a
// function that closes them. Below min_present the log isn't sent at all.
async function present(lectureId: string, n: number): Promise<() => Promise<void>> {
  const cookies = await browsers(lectureId, n);
  const controllers = cookies.map(() => new AbortController());
  await Promise.all(
    cookies.map(async (cookie, i) => {
      const res = await fetch(new URL(`/l/${lectureId}/events`, baseUrl), { headers: { cookie }, signal: controllers[i].signal });
      void res.body!.getReader().read().catch(() => {});
    }),
  );
  await new Promise((r) => setTimeout(r, 200));
  return async () => {
    for (const c of controllers) c.abort();
    await new Promise((r) => setTimeout(r, 200));
  };
}

// A lecturer stream frame with enough people present for the log to be sent.
async function lecturerFrame(lecture: NewLecture, want?: (data: string) => boolean): Promise<string> {
  const close = await present(lecture.id, thresholdFor(lecture.id));
  try {
    return await frameFrom(`/l/${lecture.id}/lecturer/events`, lecture.lecturerCookie, want);
  } finally {
    await close();
  }
}

const MIN_PRESENT = 5;

// README "Safety in numbers": below the threshold no tap data reaches the
// lecturer, the activity log included. It leaves the server only once
// min_present people are here, like live and totalTaps (CLAUDE.md).
it("below min_present people here, the log isn't in the lecturer's page or stream at all", async () => {
  const lecture = await createLectureAndLogIn("Activity below threshold");
  const cookies = await browsers(lecture.id, 1);
  await tap(lecture.id, cookies[0], 1);

  const html = await lecturerPageAlone(lecture);
  expect(lines(html)).toEqual([]);
  expect(activitySection(html)).not.toMatch(/Person \d/);
  expect(activitySection(html)).toContain(`The activity log shows once ${MIN_PRESENT} people are here.`);
  const frame = JSON.parse(await frameFrom(`/l/${lecture.id}/lecturer/events`, lecture.lecturerCookie));
  expect(frame).not.toHaveProperty("activityLog");
  // No press anywhere in the frame: log lines are the only text that names
  // "Person N" (the ranking's own description says "said they", so match the
  // label, not that phrase).
  expect(JSON.stringify(frame)).not.toMatch(/Person \d/);

  expect(lines(await lecturerPage(lecture))).toEqual(["Person 1 said they're lost on Slide 1"]);
});

it("with no presses the log says so", async () => {
  const lecture = await createLectureAndLogIn("Activity empty");
  const html = await lecturerPage(lecture);
  expect(activitySection(html)).toContain("<h3");
  expect(lines(html)).toEqual([]);
  expect(activitySection(html)).toContain("No presses yet in this run.");
});

it("one tap gives one line, Person 1, with an AEST time in a <time datetime>", async () => {
  const lecture = await createLectureAndLogIn("Activity one tap");
  const [cookie] = await browsers(lecture.id, 1);
  await tap(lecture.id, cookie, 1);
  const html = await lecturerPage(lecture);
  expect(lines(html)).toEqual(["Person 1 said they're lost on Slide 1"]);
  const [time] = times(html);
  expect(Number.isNaN(Date.parse(time.iso))).toBe(false);
  expect(time.text).toMatch(/^(\d{1,2} [A-Z][a-z]{2}, )?\d{2}:\d{2}:\d{2} AEST$/);
});

it("a row written at a known instant renders its AEST clock time", async () => {
  const lecture = await createLectureAndLogIn("Activity AEST");
  const [cookie] = await browsers(lecture.id, 1);
  const before = Date.now();
  await tap(lecture.id, cookie, 4);
  const after = Date.now();
  const [time] = times(await lecturerPage(lecture));
  // The datetime is the row's created_at, written during the request.
  const at = Date.parse(time.iso);
  expect(at).toBeGreaterThanOrEqual(before - 1000);
  expect(at).toBeLessThanOrEqual(after + 1000);
  // AEST is UTC+10 all year (Brisbane has no daylight saving), so the clock
  // time is the stored instant shifted ten hours, worked out here from it.
  const aestClock = new Date(at + 10 * 60 * 60 * 1000).toISOString().slice(11, 19);
  expect(time.text.endsWith(`${aestClock} AEST`)).toBe(true);
});

it("two browsers are Person 1 and Person 2 in order of first press; a later press by the first is still Person 1", async () => {
  const lecture = await createLectureAndLogIn("Activity two people");
  const [a, b] = await browsers(lecture.id, 2);
  await tap(lecture.id, a, 1);
  await tap(lecture.id, b, 1);
  await tap(lecture.id, a, 2);
  expect(lines(await lecturerPage(lecture))).toEqual([
    "Person 1 said they're lost on Slide 2",
    "Person 2 said they're lost on Slide 1",
    "Person 1 said they're lost on Slide 1",
  ]);
});

it("a reason, I get it now, what helped and a note each give their own line; the note's text never appears", async () => {
  const lecture = await createLectureAndLogIn("Activity each kind");
  const [cookie] = await browsers(lecture.id, 1);
  await tap(lecture.id, cookie, 2);
  expect((await post(`/l/${lecture.id}/reason`, cookie, { reason: "Too fast", slide: "2" })).status).toBe(303);
  expect((await post(`/l/${lecture.id}/resolve`, cookie, { slide: "2" })).status).toBe(303);
  expect((await post(`/l/${lecture.id}/helped`, cookie, { slide: "2", helped: "The example" })).status).toBe(303);
  expect((await post(`/l/${lecture.id}/note`, cookie, { slide: "2", text: "secret activity note text" })).status).toBe(303);

  const html = await lecturerPage(lecture);
  expect(lines(html)).toEqual([
    "Person 1 wrote a note on Slide 2",
    "Person 1 said what helped on Slide 2: The example",
    "Person 1 said they get it now on Slide 2",
    "Person 1 chose a reason on Slide 2: Too fast",
    "Person 1 said they're lost on Slide 2",
  ]);
  for (const time of times(html)) expect(time.text).toMatch(/\d{2}:\d{2}:\d{2} AEST$/);
  expect(activitySection(html)).not.toContain("secret activity note text");

  const frame = await lecturerFrame(lecture);
  const log = JSON.stringify(JSON.parse(frame).activityLog);
  expect(log).toContain("Person 1 wrote a note on Slide 2");
  expect(log).not.toContain("secret activity note text");
});

it("labels are per run: a fresh run starts again at Person 1", async () => {
  const lecture = await createLectureAndLogIn("Activity per run");
  // Five people in run 1: a past run's trail shows only once min_present
  // took part in it (like its total), since nobody is present in a past run.
  const run1 = await browsers(lecture.id, MIN_PRESENT);
  for (const cookie of run1) await tap(lecture.id, cookie, 1);
  await freshRun(lecture);
  expect(lines(await lecturerPage(lecture))).toEqual([]);
  await tap(lecture.id, run1[1], 3);
  expect(lines(await lecturerPage(lecture))).toEqual(["Person 1 said they're lost on Slide 3"]);

  // Run 1, viewed read-only, keeps its own trail and its own numbering.
  expect(lines(await lecturerPage(lecture, "?run=1"))).toEqual(
    [5, 4, 3, 2, 1].map((n) => `Person ${n} said they're lost on Slide 1`),
  );
});

it("the lecturer page and stream carry the log live; the student page and stream never do", async () => {
  const lecture = await createLectureAndLogIn("Activity routes");
  const [cookie] = await browsers(lecture.id, 1);
  const lineText = "Person 1 said they're lost on Slide 1";

  // An already-open lecturer stream gets the line on a later broadcast.
  const live = lecturerFrame(lecture, (d) => d.includes(lineText));
  await new Promise((r) => setTimeout(r, 100));
  await tap(lecture.id, cookie, 1);
  const state = JSON.parse(await live);
  expect(state.activityLog).toHaveLength(1);
  expect(state.activityLog[0]).toMatchObject({ deck: null, slide: 1, kind: "lost", text: lineText });
  expect(state.activityLogCapped).toBe(false);

  expect(lines(await lecturerPage(lecture))).toEqual([lineText]);

  const studentHtml = await (await fetch(new URL(`/l/${lecture.id}`, baseUrl), { headers: { cookie } })).text();
  expect(studentHtml).not.toContain('id="activity-log"');
  expect(studentHtml).not.toContain("Person ");

  const studentFrame = await frameFrom(`/l/${lecture.id}/events`, cookie);
  expect(studentFrame).not.toContain("activity");
  expect(studentFrame).not.toContain("Person ");
});

it("no log line or payload holds a browser id, its sha256, or the first 8 hex of it", async () => {
  const lecture = await createLectureAndLogIn("Activity privacy");
  const cookies = await browsers(lecture.id, 3);
  for (const cookie of cookies) {
    await tap(lecture.id, cookie, 1);
    await post(`/l/${lecture.id}/reason`, cookie, { reason: "Too fast", slide: "1" });
    await post(`/l/${lecture.id}/note`, cookie, { slide: "1", text: "privacy check note" });
  }
  const html = await lecturerPage(lecture);
  const section = activitySection(html);
  const frame = await lecturerFrame(lecture);
  const log = JSON.stringify(JSON.parse(frame).activityLog);
  expect(log).toContain("Person 3 chose a reason on Slide 1: Too fast");

  for (const cookie of cookies) {
    const bid = cookie.replace(/^bid=/, "");
    const hash = createHash("sha256").update(bid).digest("hex");
    for (const payload of [html, frame]) {
      expect(payload).not.toContain(bid);
      expect(payload).not.toContain(hash);
      expect(payload).not.toContain(hash.slice(0, 8));
    }
  }
  for (const payload of [section, log]) {
    expect(payload).not.toMatch(/student/i);
    expect(payload).not.toContain("privacy check note");
  }
});

it("the log holds the latest 500 presses and says so", async () => {
  const lecture = await createLectureAndLogIn("Activity cap");
  const cookies = await browsers(lecture.id, 9);
  // 9 browsers x 56 slides = 504 presses.
  await Promise.all(
    cookies.map(async (cookie) => {
      for (let slide = 1; slide <= 56; slide++) await tap(lecture.id, cookie, slide);
    }),
  );
  const html = await lecturerPage(lecture);
  expect(lines(html)).toHaveLength(500);
  expect(activitySection(html)).toContain("Showing the latest 500");
  const frame = await lecturerFrame(lecture);
  const state = JSON.parse(frame);
  expect(state.activityLog).toHaveLength(500);
  expect(state.activityLogCapped).toBe(true);
  // Numbering covers the whole run, not just the lines shown.
  const people = new Set(lines(html).map((l) => l.match(/^Person (\d+) /)?.[1]));
  expect([...people].every((n) => Number(n) >= 1 && Number(n) <= 9)).toBe(true);
});

it("a created lecture's log has no filter", async () => {
  const lecture = await createLectureAndLogIn("Activity filter");
  const [a, b] = await browsers(lecture.id, 2);
  await tap(lecture.id, a, 1);
  await tap(lecture.id, b, 2);

  const all = await lecturerPage(lecture);
  expect(lines(all)).toEqual(["Person 2 said they're lost on Slide 2", "Person 1 said they're lost on Slide 1"]);
  expect(activitySection(all)).not.toContain("<form");

  // A filter in the URL is ignored, not applied (read with enough people
  // here for the log to be sent at all).
  const close = await present(lecture.id, MIN_PRESENT);
  try {
    const asked = await fetch(new URL(`/l/${lecture.id}/lecturer?logSlide=1&logDeck=%3Cscript%3E`, baseUrl), {
      headers: { cookie: lecture.lecturerCookie },
    });
    expect(asked.status).toBe(200);
    expect(lines(await asked.text())).toHaveLength(2);
  } finally {
    await close();
  }
});

it("the demo's deck filter keeps one deck's lines and drops the other's", async () => {
  const lecturerCookie = await logIn("demo", "DEMO");
  const demo = { id: "demo", lecturerCookie };
  const [cookie] = await browsers("demo", 1);
  await tap("demo", cookie, 7, "week-6");

  // The demo filters by deck only, as a plain GET form with no script.
  const page = await lecturerPage(demo);
  expect(activitySection(page)).toMatch(/<form method="get" action="\/l\/demo\/lecturer"/);
  expect(activitySection(page)).toContain('name="logDeck"');
  expect(activitySection(page)).not.toContain("logSlide");

  const week6 = lines(await lecturerPage(demo, "?logDeck=week-6"));
  expect(week6[0]).toMatch(/^Person \d+ said they're lost on Week 6 · slide 7$/);
  expect(week6.every((l) => l.includes("Week 6 · slide"))).toBe(true);

  const week4 = lines(await lecturerPage(demo, "?logDeck=week-4"));
  expect(week4.some((l) => l.includes("Week 6"))).toBe(false);
});
