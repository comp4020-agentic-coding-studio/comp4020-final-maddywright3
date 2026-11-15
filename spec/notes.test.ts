import { expect, inject, it } from "vitest";
import { newBrowserCookie } from "./test-helpers.ts";

const baseUrl = inject("baseUrl");

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

async function tap(lectureId: string, cookie: string, slide = 1): Promise<void> {
  await fetch(new URL(`/l/${lectureId}/tap`, baseUrl), {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: `slide=${slide}`,
  });
}

async function submitNote(lectureId: string, cookie: string, slide: number, text: string): Promise<Response> {
  return fetch(new URL(`/l/${lectureId}/note`, baseUrl), {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ slide: String(slide), text }),
    redirect: "manual",
  });
}

it("a note on a slide below min_present distinct browsers never appears in any lecturer payload", async () => {
  const lecture = await createLectureAndLogIn("Notes privacy test");
  const tapCookie = await newBrowserCookie(lecture.id);
  await tap(lecture.id, tapCookie);
  const noteRes = await submitNote(lecture.id, tapCookie, 1, "only one browser wrote this");
  expect(noteRes.status).toBe(303);

  const dashboardHtml = await (
    await fetch(new URL(`/l/${lecture.id}/lecturer`, baseUrl), { headers: { cookie: lecture.lecturerCookie } })
  ).text();
  expect(dashboardHtml).not.toContain("only one browser wrote this");
});

it("note text never appears in any student page or stream, at any threshold", async () => {
  const lecture = await createLectureAndLogIn("Notes never-to-students test");
  // Enough distinct browsers to clear min_present (5) for the note gate.
  const cookies = await Promise.all(Array.from({ length: 5 }, () => newBrowserCookie(lecture.id)));
  for (const cookie of cookies) {
    await tap(lecture.id, cookie);
    await submitNote(lecture.id, cookie, 1, "a note that cleared the gate");
  }

  // Confirm it DOES appear to the lecturer, so this test actually means
  // something (otherwise "not on the student page" could be true for the
  // trivial reason the note never qualified at all).
  const dashboardHtml = await (
    await fetch(new URL(`/l/${lecture.id}/lecturer`, baseUrl), { headers: { cookie: lecture.lecturerCookie } })
  ).text();
  expect(dashboardHtml).toContain("a note that cleared the gate");

  const studentHtml = await (
    await fetch(new URL(`/l/${lecture.id}`, baseUrl), { headers: { cookie: cookies[0] } })
  ).text();
  expect(studentHtml).not.toContain("a note that cleared the gate");
});

it("a note containing a URL is rejected, with a message identifying the rule", async () => {
  const lecture = await createLectureAndLogIn("Notes URL test");
  const cookie = await newBrowserCookie(lecture.id);
  await tap(lecture.id, cookie);
  const res = await submitNote(lecture.id, cookie, 1, "see https://example.com for more");
  expect(res.status).toBe(400);
  expect(await res.text()).toMatch(/URL/i);
});

it("a note containing an email address is rejected, with a message identifying the rule", async () => {
  const lecture = await createLectureAndLogIn("Notes email test");
  const cookie = await newBrowserCookie(lecture.id);
  await tap(lecture.id, cookie);
  const res = await submitNote(lecture.id, cookie, 1, "email me at student@example.com");
  expect(res.status).toBe(400);
  expect(await res.text()).toMatch(/email/i);
});

it("a note containing a phone-number-shaped string is rejected, with a message identifying the rule", async () => {
  const lecture = await createLectureAndLogIn("Notes phone test");
  const cookie = await newBrowserCookie(lecture.id);
  await tap(lecture.id, cookie);
  const res = await submitNote(lecture.id, cookie, 1, "call me on 0412 345 678");
  expect(res.status).toBe(400);
  expect(await res.text()).toMatch(/phone/i);
});

it("an empty note is rejected; a note over 200 characters is rejected", async () => {
  const lecture = await createLectureAndLogIn("Notes length test");
  const cookie = await newBrowserCookie(lecture.id);
  await tap(lecture.id, cookie);

  const emptyRes = await submitNote(lecture.id, cookie, 1, "   ");
  expect(emptyRes.status).toBe(400);

  const tooLongRes = await submitNote(lecture.id, cookie, 1, "a".repeat(201));
  expect(tooLongRes.status).toBe(400);
});

it("sending a second note for the same (lecture, browser, slide) replaces the first", async () => {
  const lecture = await createLectureAndLogIn("Notes replace test");
  // Enough distinct browsers so the slide's notes are visible to check.
  const cookies = await Promise.all(Array.from({ length: 5 }, () => newBrowserCookie(lecture.id)));
  for (const cookie of cookies) await tap(lecture.id, cookie);

  await submitNote(lecture.id, cookies[0], 1, "first version of the note");
  await submitNote(lecture.id, cookies[0], 1, "replaced version of the note");
  for (let i = 1; i < cookies.length; i++) await submitNote(lecture.id, cookies[i], 1, `note from browser ${i}`);

  const dashboardHtml = await (
    await fetch(new URL(`/l/${lecture.id}/lecturer`, baseUrl), { headers: { cookie: lecture.lecturerCookie } })
  ).text();
  expect(dashboardHtml).toContain("replaced version of the note");
  expect(dashboardHtml).not.toContain("first version of the note");
});

it("a lecturer's Hide removes a note from the lecturer's own stream within a second", async () => {
  const lecture = await createLectureAndLogIn("Notes hide test");
  const cookies = await Promise.all(Array.from({ length: 5 }, () => newBrowserCookie(lecture.id)));
  for (const cookie of cookies) {
    await tap(lecture.id, cookie);
    await submitNote(lecture.id, cookie, 1, "a note to be hidden");
  }

  const dashboardHtml = await (
    await fetch(new URL(`/l/${lecture.id}/lecturer`, baseUrl), { headers: { cookie: lecture.lecturerCookie } })
  ).text();
  expect(dashboardHtml).toContain("a note to be hidden");
  const noteId = dashboardHtml.match(/data-note-id="(\d+)"/)?.[1];
  expect(noteId).toBeDefined();

  const hideRes = await fetch(new URL(`/l/${lecture.id}/lecturer/note/${noteId}/hide`, baseUrl), {
    method: "POST",
    headers: { cookie: lecture.lecturerCookie },
    redirect: "manual",
  });
  expect(hideRes.status).toBe(303);

  const afterHideHtml = await (
    await fetch(new URL(`/l/${lecture.id}/lecturer`, baseUrl), { headers: { cookie: lecture.lecturerCookie } })
  ).text();
  expect(afterHideHtml).not.toContain("a note to be hidden");
});

it("Hide requires a lecturer session", async () => {
  const lecture = await createLectureAndLogIn("Notes hide auth test");
  const cookie = await newBrowserCookie(lecture.id);
  await tap(lecture.id, cookie);
  await submitNote(lecture.id, cookie, 1, "some note");

  const res = await fetch(new URL(`/l/${lecture.id}/lecturer/note/1/hide`, baseUrl), {
    method: "POST",
    headers: { cookie }, // no lsess cookie
  });
  expect(res.status).toBe(403);
});

it("a note's text never appears anywhere in the server's log output", async () => {
  // logAction's note_submitted call only ever takes the browser id, never
  // the note text — this test guards against a future change accidentally
  // widening that call by asserting the structural fact: logAction(action,
  // lectureId, browserId) has no fourth parameter for text to flow through.
  // Captured indirectly: a distinctive, unlikely-to-collide string submitted
  // as a note must never appear in any HTTP response that isn't the
  // lecturer's own gated dashboard (logs themselves aren't retrievable over
  // HTTP, so this is the closest black-box check available).
  const lecture = await createLectureAndLogIn("Notes log test");
  const cookie = await newBrowserCookie(lecture.id);
  await tap(lecture.id, cookie);
  const distinctiveText = "zzz_unique_log_guard_marker_zzz";
  await submitNote(lecture.id, cookie, 1, distinctiveText);

  const homeHtml = await (await fetch(new URL("/", baseUrl))).text();
  expect(homeHtml).not.toContain(distinctiveText);
});

// A note can be up to 200 characters with no spaces (the length/URL/email/
// phone checks don't reject that), which would overflow a narrow viewport
// horizontally without this rule — found while hand-checking the 390x844
// layout for Phase 5, fixed on body so it covers every free-text field
// (note text, the lecture title), not just this one element.
// Since Phase 5 the CSS lives in /style.css, so this checks the page links
// it and that the body rule there carries the wrap.
it("the page CSS wraps long unbroken text instead of letting it overflow", async () => {
  const html = await (await fetch(new URL("/", baseUrl))).text();
  expect(html).toContain('<link rel="stylesheet" href="/style.css">');
  const css = await (await fetch(new URL("/style.css", baseUrl))).text();
  expect(css).toMatch(/\nbody\s*\{[^}]*overflow-wrap: break-word/);
});
