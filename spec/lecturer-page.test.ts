import { JSDOM } from "jsdom";
import { expect, inject, it } from "vitest";
import { newBrowserCookie } from "./test-helpers.ts";

// The lecturer page's shape: a Live now block at the top, the Runs box near
// it, then two headed groups, "Live slide" and "Whole lecture", and the
// "Lectures, most confusing first" ranking. Each test makes its own lecture,
// except the demo checks, which only read.
const baseUrl = inject("baseUrl");
const MIN_PRESENT = 5;

interface NewLecture {
  id: string;
  lecturerCookie: string;
}

const doc = (html: string): Document => new JSDOM(html).window.document;

async function logIn(id: string, code: string): Promise<string> {
  const cookie = await newBrowserCookie(id);
  const res = await fetch(new URL(`/l/${id}/lecturer`, baseUrl), {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: `code=${code}`,
    redirect: "manual",
  });
  const lsess = res.headers
    .getSetCookie()
    .find((c) => c.startsWith("lsess="))
    ?.split(";")[0];
  if (!lsess) throw new Error("lecturer login failed");
  return `${cookie}; ${lsess}`;
}

async function createLectureAndLogIn(title: string): Promise<NewLecture> {
  const res = await fetch(new URL("/new", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `title=${encodeURIComponent(title)}&slides=60&minutes=60`,
  });
  const html = await res.text();
  const id = html.match(/Student link: <a href="\/l\/([a-f0-9]+)"/)?.[1];
  const code = html.match(/<strong>([A-Z0-9]+)<\/strong>/)?.[1];
  if (!id || !code) throw new Error("couldn't parse the new lecture's id/code");
  return { id, lecturerCookie: await logIn(id, code) };
}

function post(path: string, cookie: string, body: Record<string, string>): Promise<Response> {
  return fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    redirect: "manual",
  });
}

async function text(path: string, cookie: string): Promise<string> {
  return (await fetch(new URL(path, baseUrl), { headers: { cookie }, redirect: "manual" })).text();
}

const lecturerDoc = async (lecture: NewLecture, query = ""): Promise<Document> =>
  doc(await text(`/l/${lecture.id}/lecturer${query}`, lecture.lecturerCookie));

// The run number the confirmation page offers to replace, submitted the way
// a person's browser would.
async function freshRun(lecture: NewLecture): Promise<void> {
  const confirm = await text(`/l/${lecture.id}/lecturer/runs/new`, lecture.lecturerCookie);
  const run = confirm.match(/name="run" value="(\d+)"/)?.[1];
  if (!run) throw new Error("no run field on the confirmation page");
  expect((await post(`/l/${lecture.id}/lecturer/runs`, lecture.lecturerCookie, { run })).status).toBe(303);
}

// n different people say they're lost on slide 1 of the current run.
async function lostOnSlide1(lecture: NewLecture, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const cookie = await newBrowserCookie(lecture.id);
    expect((await post(`/l/${lecture.id}/tap`, cookie, { slide: "1" })).status).toBe(303);
  }
}

// The first frame of the lecturer stream.
async function lecturerFrame(lecture: NewLecture): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const res = await fetch(new URL(`/l/${lecture.id}/lecturer/events`, baseUrl), {
    headers: { cookie: lecture.lecturerCookie },
    signal: controller.signal,
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const sep = buffer.indexOf("\n\n");
      if (sep !== -1) {
        const data = buffer.slice(0, sep).split("\n").find((l) => l.startsWith("data: "));
        buffer = buffer.slice(sep + 2);
        if (data) return JSON.parse(data.slice(6)) as Record<string, unknown>;
        continue;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("stream closed");
      buffer += decoder.decode(value, { stream: true });
    }
  } finally {
    controller.abort();
  }
}

const rankingRows = (scope: ParentNode): string[] =>
  [...scope.querySelectorAll("#ranking-list > li")].map((li) => li.textContent!.replace(/\s+/g, " ").trim());

// ---------- Live now ----------

it("the Live now block names the live slide at the top, and follows the lecturer's Next", async () => {
  const lecture = await createLectureAndLogIn("Live now block");
  let d = await lecturerDoc(lecture);
  const block = d.getElementById("live-now")!;
  expect(block).not.toBeNull();
  // The student page's LIVE pill, reused.
  expect(block.querySelector(".live-pill")!.textContent).toBe("Live now");
  expect(d.getElementById("live-now-slide")!.textContent).toBe("Slide 1");
  // At the top: before the runs box and both groups.
  for (const id of ["runs", "live-group", "lecture-group"]) {
    expect(block.compareDocumentPosition(d.getElementById(id)!) & 4, id).toBe(4);
  }

  expect((await post(`/l/${lecture.id}/lecturer/slide/next`, lecture.lecturerCookie, {})).status).toBe(303);
  d = await lecturerDoc(lecture);
  expect(d.getElementById("live-now-slide")!.textContent).toBe("Slide 2");
  // The page script renames it on every lecturer frame from the frame's slide.
  expect((await lecturerFrame(lecture)).slide).toBe(2);
});

it("the demo's Live now block names its deck and slide", async () => {
  const d = doc(await text("/l/demo/lecturer", await logIn("demo", "DEMO")));
  expect(d.getElementById("live-now-slide")!.textContent).toMatch(/^Week 4 · slide \d+$/);
});

// ---------- Two groups ----------

it("the page has two headed groups: the live slide's items in the first, the whole lecture's in the second", async () => {
  const lecture = await createLectureAndLogIn("Two groups");
  const d = await lecturerDoc(lecture);
  const live = d.getElementById("live-group")!;
  const whole = d.getElementById("lecture-group")!;
  expect(live.querySelector("h2")!.textContent).toBe("Live slide");
  expect(whole.querySelector("h2")!.textContent).toBe("Whole lecture");
  expect(live.getAttribute("aria-labelledby")).toBe(live.querySelector("h2")!.id);
  expect(whole.getAttribute("aria-labelledby")).toBe(whole.querySelector("h2")!.id);
  // Live slide first, then the whole lecture.
  expect(live.compareDocumentPosition(whole) & 4).toBe(4);
  expect(live.contains(whole) || whole.contains(live)).toBe(false);

  // The live gauge "lost right now", the live slide's controls, its bar,
  // reasons and notes (#now).
  for (const id of ["gauge", "gauge-words", "lost-now-slot", "connection-status", "slide-label", "slide-next-form", "now", "now-bar"]) {
    const el = d.getElementById(id);
    expect(el, id).not.toBeNull();
    expect(live.contains(el), id).toBe(true);
  }
  expect(live.textContent).toContain("Lost right now");

  // People here, lost this run, the "I get it now" share, the hardest
  // slide, the four graphs, notes by slide, the activity log, the ranking.
  for (const id of [
    "stat-tiles",
    "present-value",
    "tap-count-slot",
    "graph-lost",
    "graph-reasons",
    "graph-helped",
    "graph-resolved",
    "notes",
    "activity-log",
    "ranking",
  ]) {
    const el = d.getElementById(id);
    expect(el, id).not.toBeNull();
    expect(whole.contains(el), id).toBe(true);
  }
  for (const label of ["People here", "Lost this run", "Said “I get it now”", "Hardest slide"]) {
    expect(whole.textContent, label).toContain(label);
    expect(live.textContent, label).not.toContain(label);
  }
  // Inside a group, every section is headed one level down.
  for (const group of [live, whole]) {
    expect(group.querySelectorAll("h2").length).toBe(1);
  }
});

// ---------- Runs ----------

const RESET_EXPLANATION = "Every count, graph and note starts from zero. Earlier runs aren't deleted: view them below.";
const RUN_EXPLANATION = "A run is one sitting of this lecture. Starting a fresh run keeps every earlier run, viewable here.";

it("the runs box explains runs, links every earlier run, and marks the run on screen", async () => {
  const lecture = await createLectureAndLogIn("Runs box");
  const base = `/l/${lecture.id}/lecturer`;

  let d = await lecturerDoc(lecture);
  let runs = d.getElementById("runs")!;
  expect(runs.querySelector("h2")!.textContent).toBe("Runs");
  expect(runs.textContent).toContain(RUN_EXPLANATION);
  // Starting a fresh run is how the statistics are reset, and it says so.
  expect(runs.querySelector("#fresh-run-form button")!.textContent).toBe("Reset statistics: start a fresh run");
  expect(d.getElementById("fresh-run-explain")!.textContent).toBe(RESET_EXPLANATION);
  expect(d.getElementById("run-current")!.textContent).toBe("The current run is run 1.");
  expect(runs.textContent).toContain("No earlier runs yet.");
  expect(runs.querySelectorAll('a[href*="?run="]').length).toBe(0);
  // Near the top: before both groups.
  expect(runs.compareDocumentPosition(d.getElementById("live-group")!) & 4).toBe(4);

  await freshRun(lecture);
  await freshRun(lecture);

  d = await lecturerDoc(lecture);
  runs = d.getElementById("runs")!;
  expect(d.getElementById("run-current")!.textContent).toBe("The current run is run 3.");
  expect(runs.textContent).not.toContain("No earlier runs yet.");
  const earlier = [...runs.querySelectorAll('a[href*="?run="]')].map((a) => [a.textContent, a.getAttribute("href")]);
  expect(earlier).toEqual([
    ["Run 1", `${base}?run=1`],
    ["Run 2", `${base}?run=2`],
  ]);
  // The live view marks the current run as the one on screen.
  const onScreen = runs.querySelectorAll('[aria-current="page"]');
  expect(onScreen.length).toBe(1);
  expect(onScreen[0].textContent).toBe("Run 3 (live)");
  expect(onScreen[0].closest("li")!.querySelector(".run-onscreen")!.textContent).toBe("on screen");

  // An earlier run says which run it is, that it's read-only, and links
  // back to the current one.
  d = await lecturerDoc(lecture, "?run=2");
  expect(d.getElementById("run-label")!.textContent).toBe("You're viewing Run 2, read-only.");
  const back = d.getElementById("run-back")!;
  expect(back.getAttribute("href")).toBe(base);
  expect(back.textContent).toBe("Back to the current run, run 3");
  runs = d.getElementById("runs")!;
  const marked = runs.querySelectorAll('[aria-current="page"]');
  expect(marked.length).toBe(1);
  expect(marked[0].textContent).toBe("Run 2");
  expect(marked[0].getAttribute("href")).toBe(`${base}?run=2`);
  expect(marked[0].closest("li")!.querySelector(".run-onscreen")).not.toBeNull();
  // No live block on a read-only run: nothing on it is live.
  expect(d.getElementById("live-now")).toBeNull();
});

it("the demo's runs box explains runs and says it can't be reset", async () => {
  const d = doc(await text("/l/demo/lecturer", await logIn("demo", "DEMO")));
  const runs = d.getElementById("runs")!;
  expect(runs.textContent).toContain(RUN_EXPLANATION);
  expect(runs.querySelector("#runs-demo")!.textContent).toBe(
    "The shared demo keeps its history. Create your own lecture to try a fresh run.",
  );
  expect(runs.querySelector("#fresh-run-form")).toBeNull();
  expect(d.getElementById("fresh-run-explain")).toBeNull();
});

it("the reset confirmation page says what reset does and that nothing is deleted", async () => {
  const lecture = await createLectureAndLogIn("Reset confirmation");
  const d = doc(await text(`/l/${lecture.id}/lecturer/runs/new`, lecture.lecturerCookie));
  expect(d.querySelector("h1")!.textContent).toBe("Reset statistics?");
  expect(d.body.textContent).toContain("Every count, graph and note starts from zero in run 2.");
  expect(d.body.textContent).toContain("Run 1 stays exactly as it is, and you can still view it, read-only, from the Runs box. Nothing is deleted.");
  expect(d.querySelector("#fresh-run-confirm button")!.textContent).toBe("Reset statistics: start run 2");
});

// ---------- Ranking ----------

it("the ranking orders this lecture's runs by people lost, and leaves out any run below min_present", async () => {
  const lecture = await createLectureAndLogIn("Ranking runs");
  const base = `/l/${lecture.id}/lecturer`;

  // Nothing qualifies yet: the empty state names the real threshold.
  let d = await lecturerDoc(lecture);
  let ranking = d.getElementById("ranking")!;
  expect(ranking.querySelector("h3")!.textContent).toBe("Lectures, most confusing first");
  expect(ranking.textContent).toContain(`Lectures appear here once each has had ${MIN_PRESENT} people lost.`);
  expect(rankingRows(d)).toEqual([]);

  // Run 1: exactly min_present lost. Run 2: one more. Run 3 (live): one fewer.
  await lostOnSlide1(lecture, MIN_PRESENT);
  await freshRun(lecture);
  await lostOnSlide1(lecture, MIN_PRESENT + 1);
  await freshRun(lecture);
  await lostOnSlide1(lecture, MIN_PRESENT - 1);

  d = await lecturerDoc(lecture);
  expect(rankingRows(d)).toEqual([`Run 2: ${MIN_PRESENT + 1} people lost`, `Run 1: ${MIN_PRESENT} people lost`]);
  // Each entry links to its run.
  expect([...d.querySelectorAll("#ranking-list a")].map((a) => a.getAttribute("href"))).toEqual([
    `${base}?run=2`,
    `${base}?run=1`,
  ]);
  ranking = d.getElementById("ranking")!;
  expect(ranking.textContent).toContain(`Only runs with at least ${MIN_PRESENT} people lost are listed.`);
  expect(ranking.textContent).not.toContain("Run 3");

  // The same ranking travels in the lecturer stream, already rendered.
  const frame = await lecturerFrame(lecture);
  const fragment = (frame.dashboardHtml as Record<string, string>).ranking;
  expect(rankingRows(doc(`<div id="ranking-body">${fragment}</div>`))).toEqual(rankingRows(d));
  expect(fragment).not.toContain("Run 3");

  // Three more people lost in run 3 bring it in, at the top, as the live run.
  await lostOnSlide1(lecture, 3);
  d = await lecturerDoc(lecture);
  expect(rankingRows(d)).toEqual([
    `Run 3 (live): ${MIN_PRESENT + 2} people lost`,
    `Run 2: ${MIN_PRESENT + 1} people lost`,
    `Run 1: ${MIN_PRESENT} people lost`,
  ]);

  // The earlier-run view shows the same ranking.
  expect(rankingRows(await lecturerDoc(lecture, "?run=1"))).toEqual(rankingRows(d));
});

it("the ranking never reaches a student page or stream", async () => {
  const lecture = await createLectureAndLogIn("Ranking not for students");
  await lostOnSlide1(lecture, MIN_PRESENT);
  const student = await newBrowserCookie(lecture.id);
  const html = await text(`/l/${lecture.id}`, student);
  expect(html).not.toContain("ranking");
  expect(html).not.toContain("most confusing");
});

it("the demo ranks its own two decks, each listed only at min_present or more, most lost first", async () => {
  const d = doc(await text("/l/demo/lecturer", await logIn("demo", "DEMO")));
  const rows = [...d.querySelectorAll("#ranking-list > li")];
  const parsed = rows.map((li) => {
    const m = li.textContent!.replace(/\s+/g, " ").trim().match(/^(Week [46]): (\d+) (?:person|people) lost$/);
    expect(m, li.textContent!).not.toBeNull();
    return { deck: m![1], lost: Number(m![2]) };
  });
  // The demo's min_present is 2.
  for (const row of parsed) expect(row.lost).toBeGreaterThanOrEqual(2);
  expect(new Set(parsed.map((r) => r.deck)).size).toBe(parsed.length);
  expect(parsed.map((r) => r.lost)).toEqual([...parsed.map((r) => r.lost)].sort((a, b) => b - a));
  const ranking = d.getElementById("ranking")!;
  expect(ranking.textContent).toContain(parsed.length === 0 ? "once each has had 2 people lost" : "Only decks with at least 2 people lost are listed.");
});
