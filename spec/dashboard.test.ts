import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import { expect, inject, it } from "vitest";
import { newBrowserCookie } from "./test-helpers.ts";

// The lecturer dashboard (round 2 item 3): stat tiles, four graphs and the
// notes grouped by slide. Every number on it is an aggregate, gated as
// CLAUDE.md says, in the page and in the lecturer stream alike.

const baseUrl = inject("baseUrl");

interface NewLecture {
  id: string;
  lecturerCookie: string;
}

async function createLectureAndLogIn(title: string): Promise<NewLecture> {
  const createRes = await fetch(new URL("/new", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `title=${encodeURIComponent(title)}&slides=60&minutes=60`,
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
  const lsess = loginRes.headers
    .getSetCookie()
    .find((c) => c.startsWith("lsess="))
    ?.split(";")[0];
  if (!lsess) throw new Error("lecturer login failed");
  return { id, lecturerCookie: `${cookie}; ${lsess}` };
}

async function post(lectureId: string, path: string, cookie: string, body: string): Promise<Response> {
  return fetch(new URL(`/l/${lectureId}/${path}`, baseUrl), {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body,
    redirect: "manual",
  });
}

async function browsers(lectureId: string, n: number): Promise<string[]> {
  return Promise.all(Array.from({ length: n }, () => newBrowserCookie(lectureId)));
}

async function lecturerPage(lecture: NewLecture, query = ""): Promise<string> {
  const res = await fetch(new URL(`/l/${lecture.id}/lecturer${query}`, baseUrl), {
    headers: { cookie: lecture.lecturerCookie },
  });
  return res.text();
}

// Reads the first frame of an SSE stream as raw text plus parsed JSON.
async function firstFrame(path: string, cookie: string): Promise<{ raw: string; state: Record<string, unknown> }> {
  const controller = new AbortController();
  const res = await fetch(new URL(path, baseUrl), { headers: { cookie }, signal: controller.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + 2000;
  try {
    for (;;) {
      const sep = buffer.indexOf("\n\n");
      if (sep !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const data = frame.split("\n").find((l) => l.startsWith("data: "));
        if (data) {
          const raw = data.slice("data: ".length);
          return { raw, state: JSON.parse(raw) as Record<string, unknown> };
        }
        continue;
      }
      if (Date.now() > deadline) throw new Error("no SSE frame");
      const { value, done } = await reader.read();
      if (done) throw new Error("stream closed");
      buffer += decoder.decode(value, { stream: true });
    }
  } finally {
    controller.abort();
  }
}

function lecturerFrame(lecture: NewLecture) {
  return firstFrame(`/l/${lecture.id}/lecturer/events`, lecture.lecturerCookie);
}

function section(html: string, id: string): Element {
  const el = new JSDOM(html).window.document.getElementById(id);
  if (!el) throw new Error(`no #${id} in the page`);
  return el;
}

function bidOf(cookie: string): string {
  return cookie.replace(/^bid=/, "");
}

it("the dashboard renders its stat tiles and four graph sections with the slot ids", async () => {
  const lecture = await createLectureAndLogIn("Dashboard slots");
  const html = await lecturerPage(lecture);
  for (const id of ["stat-tiles", "graph-lost", "graph-reasons", "graph-helped", "graph-resolved", "notes"]) {
    expect(section(html, id)).toBeTruthy();
  }
  const tiles = section(html, "stat-tiles").textContent!;
  expect(tiles).toMatch(/People here/);
  // "Lost right now" is about the live slide, so it's in the Live slide group.
  expect(section(html, "live-group").textContent).toMatch(/Lost right now/);
  expect(tiles).toMatch(/Lost this run/);
  expect(tiles).toMatch(/I get it now/);
  expect(tiles).toMatch(/Hardest slide/);
});

it("each empty state shows its threshold message with the lecture's real min_present", async () => {
  const lecture = await createLectureAndLogIn("Dashboard empty states");
  const html = await lecturerPage(lecture);
  expect(section(html, "graph-lost").textContent).toContain("Shows once 5 people have been lost on a slide");
  expect(section(html, "graph-reasons").textContent).toContain("Shows once 5 people have chosen the same reason on a slide");
  expect(section(html, "graph-helped").textContent).toContain("Shows once 5 people have said the same thing helped on a slide");
  expect(section(html, "graph-resolved").textContent).toContain(
    "Shows once a slide has 5 people still lost and 5 who said “I get it now”",
  );
  expect(section(html, "notes").textContent).toContain("Notes on a slide show once 5 people have written one there");
  const tiles = section(html, "stat-tiles").textContent!;
  expect(tiles).toContain("Shows once 5 people have been lost");
  expect(tiles).toContain("Shows once 5 people are here");
  // Never a threshold below the real one.
  expect(html).not.toMatch(/Shows once [0-4] /);

  // The same messages travel in the live payload, so a live update can't
  // replace them with a different number.
  const { raw } = await lecturerFrame(lecture);
  expect(raw).toContain("Shows once 5 people have been lost on a slide");
  expect(raw).not.toMatch(/Shows once [0-4] /);
});

it("the share tile and the hardest slide are absent below the threshold, in the payload and the HTML", async () => {
  const lecture = await createLectureAndLogIn("Dashboard derived numbers");
  // Four people lost on slide 1: below 5, so no bar, no hardest slide, no share.
  const four = await browsers(lecture.id, 4);
  for (const c of four) await post(lecture.id, "tap", c, "slide=1");
  for (const c of four.slice(0, 2)) await post(lecture.id, "resolve", c, "slide=1");

  let { state } = await lecturerFrame(lecture);
  let stats = state.stats as Record<string, unknown>;
  expect(stats).not.toHaveProperty("hardest");
  expect(stats).not.toHaveProperty("resolvedShare");
  expect(stats).not.toHaveProperty("lostThisRun");
  let html = await lecturerPage(lecture);
  expect(html).not.toContain('id="hardest-value"');
  expect(html).not.toContain('id="share-value"');
  expect(html).not.toContain('id="lost-run-value"');
  expect(JSON.stringify(state)).not.toContain('id="hardest-value"');
  expect(JSON.stringify(state)).not.toContain('id="share-value"');

  // Six more on slide 1 (10 lost), 3 more resolve (5 resolved, 5 still
  // lost): the hardest slide and the share now qualify.
  const six = await browsers(lecture.id, 6);
  for (const c of six) await post(lecture.id, "tap", c, "slide=1");
  // Four resolved so far would still hide the share: 4 < 5.
  for (const c of six.slice(0, 2)) await post(lecture.id, "resolve", c, "slide=1");
  ({ state } = await lecturerFrame(lecture));
  stats = state.stats as Record<string, unknown>;
  expect(stats.lostThisRun).toBe(10);
  expect(stats.hardest).toEqual({ slides: [{ deck: null, slide: 1 }], distinctBrowsers: 10 });
  expect(stats).not.toHaveProperty("resolvedShare");
  html = await lecturerPage(lecture);
  expect(html).toContain('id="hardest-value"');
  expect(html).not.toContain('id="share-value"');

  await post(lecture.id, "resolve", six[2], "slide=1");
  ({ state } = await lecturerFrame(lecture));
  stats = state.stats as Record<string, unknown>;
  expect(stats.resolvedShare).toEqual({ resolved: 5, stillLost: 5, percent: 50 });
  html = await lecturerPage(lecture);
  const tiles = section(html, "stat-tiles").textContent!;
  expect(tiles).toContain("50%");
  expect(tiles).toContain("of slides with enough taps to show");
  expect(tiles).toContain("Slide 1");
});

it("the hardest slide shows every slide tied for the most", async () => {
  const lecture = await createLectureAndLogIn("Dashboard hardest tie");
  const five = await browsers(lecture.id, 5);
  for (const c of five) {
    await post(lecture.id, "tap", c, "slide=2");
    await post(lecture.id, "tap", c, "slide=3");
  }
  const { state } = await lecturerFrame(lecture);
  expect((state.stats as Record<string, unknown>).hardest).toEqual({
    slides: [
      { deck: null, slide: 2 },
      { deck: null, slide: 3 },
    ],
    distinctBrowsers: 5,
  });
  const hardest = new JSDOM(await lecturerPage(lecture)).window.document.getElementById("hardest-value")!;
  expect(hardest.textContent).toContain("Slide 2");
  expect(hardest.textContent).toContain("Slide 3");
});

it("the graphs draw only gated counts, with a table alternative and class names for colour", async () => {
  const lecture = await createLectureAndLogIn("Dashboard graphs");
  const five = await browsers(lecture.id, 5);
  for (const c of five) {
    await post(lecture.id, "tap", c, "slide=1");
    await post(lecture.id, "reason", c, "slide=1&reason=Notation");
  }
  // A sixth, alone on Too fast: below the gate, so absent everywhere.
  const [lone] = await browsers(lecture.id, 1);
  await post(lecture.id, "tap", lone, "slide=1");
  await post(lecture.id, "reason", lone, "slide=1&reason=Too+fast");

  const html = await lecturerPage(lecture);
  const lost = section(html, "graph-lost");
  expect(lost.querySelector("svg")).not.toBeNull();
  expect(lost.querySelector("svg rect.series-lost")).not.toBeNull();
  expect(lost.innerHTML).toContain("<tr><td>Slide 1</td><td>6</td></tr>");

  const reasons = section(html, "graph-reasons");
  expect(reasons.querySelector("svg rect.series-3")).not.toBeNull();
  expect(reasons.innerHTML).toContain("<tr><td>Slide 1</td><td>Notation</td><td>5</td></tr>");
  expect(reasons.textContent).not.toContain("Too fast: 1");
  expect(reasons.querySelector("table")!.textContent).not.toContain("Too fast");

  // No inline colour anywhere: classes only.
  expect(html).not.toMatch(/\sstyle="/);
  expect(lost.innerHTML).not.toMatch(/\sfill="#/);
});

it("graph-resolved shows a slide's split only when both counts qualify", async () => {
  const lecture = await createLectureAndLogIn("Dashboard resolved split");
  const nine = await browsers(lecture.id, 9);
  for (const c of nine) await post(lecture.id, "tap", c, "slide=1");
  for (const c of nine.slice(0, 5)) await post(lecture.id, "resolve", c, "slide=1");

  // 5 resolved, 4 still lost: no split yet.
  let { state } = await lecturerFrame(lecture);
  expect(state.resolvedSplit).toEqual([]);
  let html = await lecturerPage(lecture);
  expect(section(html, "graph-resolved").querySelector("table")).toBeNull();

  const [tenth] = await browsers(lecture.id, 1);
  await post(lecture.id, "tap", tenth, "slide=1");
  ({ state } = await lecturerFrame(lecture));
  expect(state.resolvedSplit).toEqual([{ deck: null, slide: 1, stillLost: 5, resolved: 5 }]);
  html = await lecturerPage(lecture);
  const resolved = section(html, "graph-resolved");
  expect(resolved.querySelector("svg rect.series-lost")).not.toBeNull();
  expect(resolved.querySelector("svg rect.series-resolved")).not.toBeNull();
  expect(resolved.innerHTML).toContain("<tr><td>Slide 1</td><td>5</td><td>5</td></tr>");
});

it("no dashboard payload or page contains a browser ID, a hash of one, or any per-student grouping", async () => {
  const lecture = await createLectureAndLogIn("Dashboard privacy");
  const five = await browsers(lecture.id, 5);
  for (const [i, c] of five.entries()) {
    await post(lecture.id, "tap", c, "slide=1");
    await post(lecture.id, "reason", c, "slide=1&reason=Notation");
    await post(lecture.id, "note", c, `slide=1&text=${encodeURIComponent(`privacy note ${i}`)}`);
  }
  const html = await lecturerPage(lecture);
  const { raw, state } = await lecturerFrame(lecture);
  // The note did reach the lecturer, so the check below means something.
  expect(html).toContain("privacy note 0");
  expect(raw).toContain("privacy note 0");
  for (const c of [...five, lecture.lecturerCookie.split(";")[0]]) {
    const bid = bidOf(c);
    const hash = createHash("sha256").update(bid).digest("hex");
    for (const text of [html, raw]) {
      expect(text).not.toContain(bid);
      expect(text).not.toContain(hash);
      expect(text).not.toContain(hash.slice(0, 8));
    }
  }
  // No key in the payload names a browser, a student or a person's id.
  const keys: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      for (const [k, child] of Object.entries(v)) {
        keys.push(k);
        walk(child);
      }
    }
  };
  walk(state);
  expect(keys.filter((k) => /browser_?id|student|who|person|byBrowser/i.test(k))).toEqual([]);
  expect(html).not.toMatch(/Student \d|student-\d|data-browser/i);
});

it("no student page or stream carries the dashboard", async () => {
  const lecture = await createLectureAndLogIn("Dashboard never to students");
  const five = await browsers(lecture.id, 5);
  for (const c of five) await post(lecture.id, "tap", c, "slide=1");
  const studentHtml = await (
    await fetch(new URL(`/l/${lecture.id}`, baseUrl), { headers: { cookie: five[0] } })
  ).text();
  for (const id of ["stat-tiles", "graph-lost", "graph-reasons", "graph-helped", "graph-resolved", "hardest-value"]) {
    expect(studentHtml).not.toContain(`id="${id}"`);
  }
  const { raw, state } = await firstFrame(`/l/${lecture.id}/events`, five[0]);
  expect(state).not.toHaveProperty("stats");
  expect(state).not.toHaveProperty("dashboardHtml");
  expect(state).not.toHaveProperty("resolvedSplit");
  expect(raw).not.toContain("graph-");
});

it("the notes filter works without JS: plain GET by deck and slide, grouped by slide, newest first", async () => {
  const lecture = await createLectureAndLogIn("Dashboard notes filter");
  const five = await browsers(lecture.id, 5);
  for (const [i, c] of five.entries()) {
    await post(lecture.id, "tap", c, "slide=2");
    await post(lecture.id, "note", c, `slide=2&text=${encodeURIComponent(`slide two note ${i}`)}`);
    await post(lecture.id, "tap", c, "slide=3");
    await post(lecture.id, "note", c, `slide=3&text=${encodeURIComponent(`slide three note ${i}`)}`);
  }

  // Unfiltered: both slides, each its own group, newest note first.
  const all = section(await lecturerPage(lecture), "notes");
  const groups = [...all.querySelectorAll(".note-group")];
  expect(groups.map((g) => g.querySelector("h3")!.textContent)).toEqual(["Slide 3", "Slide 2"]);
  const slide2Notes = [...groups[1].querySelectorAll(".note-text")].map((n) => n.textContent);
  expect(slide2Notes).toEqual([4, 3, 2, 1, 0].map((i) => `slide two note ${i}`));
  expect(groups[1].querySelectorAll(".hide-note-form button").length).toBe(5);

  // The filter is a plain GET form, so it works with no script at all.
  const form = all.querySelector("form#notes-filter")!;
  expect(form.getAttribute("method")).toBe("get");
  expect(form.getAttribute("action")).toBe(`/l/${lecture.id}/lecturer`);
  expect(form.querySelector('[name="slide"]')).not.toBeNull();

  const filtered = section(await lecturerPage(lecture, "?slide=2"), "notes");
  expect(filtered.textContent).toContain("slide two note 0");
  expect(filtered.textContent).not.toContain("slide three note");
  // The slide filter is a dropdown of every slide; the chosen one stays selected.
  expect(filtered.querySelector('select[name="slide"] option[selected]')!.getAttribute("value")).toBe("2");

  const none = section(await lecturerPage(lecture, "?slide=9"), "notes");
  expect(none.querySelectorAll(".note-group").length).toBe(0);
  expect(none.textContent).toContain("No notes to show on Slide 9");

  // Nonsense filters are ignored rather than breaking the page.
  const junk = await fetch(new URL(`/l/${lecture.id}/lecturer?slide=abc&deck=%3Cscript%3E`, baseUrl), {
    headers: { cookie: lecture.lecturerCookie },
  });
  expect(junk.status).toBe(200);
  expect(await junk.text()).not.toContain("<script>alert");
});

it("the demo's notes filter offers its decks", async () => {
  const cookie = await newBrowserCookie("demo");
  const login = await fetch(new URL("/l/demo/lecturer", baseUrl), {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: "code=DEMO",
    redirect: "manual",
  });
  const lsess = login.headers.getSetCookie().find((c) => c.startsWith("lsess="))!.split(";")[0];
  const html = await (
    await fetch(new URL("/l/demo/lecturer?deck=week-6&slide=3", baseUrl), { headers: { cookie: `${cookie}; ${lsess}` } })
  ).text();
  const deck = section(html, "notes").querySelector('select[name="deck"]') as HTMLSelectElement;
  expect([...deck.options].map((o) => o.value)).toEqual(["", "week-4", "week-6"]);
  expect(deck.value).toBe("week-6");
});

it("the dashboard updates live: a tap that makes a slide qualify reaches the lecturer stream", async () => {
  const lecture = await createLectureAndLogIn("Dashboard live");
  const five = await browsers(lecture.id, 5);
  for (const c of five.slice(0, 4)) await post(lecture.id, "tap", c, "slide=4");
  let { state } = await lecturerFrame(lecture);
  let fragments = state.dashboardHtml as Record<string, string>;
  expect(fragments.graphLost).toContain("Shows once 5 people have been lost on a slide");
  await post(lecture.id, "tap", five[4], "slide=4");
  ({ state } = await lecturerFrame(lecture));
  fragments = state.dashboardHtml as Record<string, string>;
  expect(fragments.graphLost).toContain("<tr><td>Slide 4</td><td>5</td></tr>");
  expect(fragments.tiles).toContain('id="hardest-value"');
});
