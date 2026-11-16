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

// Decided outcome (see src/db.ts's setNote): the author's resubmit is a
// newer, distinct write, and ON CONFLICT ... DO UPDATE always sets
// hidden_at = NULL — so a replace that lands after a hide un-hides the note.
// This is the correct behaviour, not an accident of implementation: a
// lecturer who hides a note and then the author keeps writing should see the
// author's latest word, not have it silently suppressed by one timing
// accident. If the replace instead landed before the hide, the note stays
// hidden — this test exercises the "replace after hide" ordering, which is
// the one that could otherwise surprise a lecturer (a note they just hid
// reappearing).
it("a note resubmitted after being hidden reappears — replace wins over hide", async () => {
  const lecture = await createLectureAndLogIn("Hide vs replace race test");
  const cookies = await Promise.all(Array.from({ length: 5 }, () => newBrowserCookie(lecture.id)));
  const targetMarker = "zzz_target_note_marker_zzz";
  for (let i = 0; i < cookies.length; i++) {
    await tap(lecture.id, cookies[i]);
    await submitNote(lecture.id, cookies[i], 1, i === 0 ? targetMarker : `original note ${i}`);
  }

  const dashboardHtml = await (
    await fetch(new URL(`/l/${lecture.id}/lecturer`, baseUrl), { headers: { cookie: lecture.lecturerCookie } })
  ).text();
  // Find cookies[0]'s own note specifically (by its distinctive marker
  // text), not just the first data-note-id match — note order in the
  // dashboard isn't guaranteed to match submission order. Split into
  // per-<li> blocks first rather than one non-greedy regex spanning the
  // whole list: a non-greedy match starting at the wrong <li> will happily
  // cross a `</li>` boundary to reach the marker in a later one, matching
  // the wrong note's id.
  const liBlocks = dashboardHtml.split("<li ").slice(1);
  const targetBlock = liBlocks.find((block) => block.includes(targetMarker));
  const noteId = targetBlock?.match(/data-note-id="(\d+)"/)?.[1];
  expect(noteId).toBeDefined();

  // Hide, then the same author replaces their note — in that order, so the
  // replace is the one landing last.
  const hideRes = await fetch(new URL(`/l/${lecture.id}/lecturer/note/${noteId}/hide`, baseUrl), {
    method: "POST",
    headers: { cookie: lecture.lecturerCookie },
    redirect: "manual",
  });
  expect(hideRes.status).toBe(303);

  await submitNote(lecture.id, cookies[0], 1, "replaced after being hidden");

  const afterHtml = await (
    await fetch(new URL(`/l/${lecture.id}/lecturer`, baseUrl), { headers: { cookie: lecture.lecturerCookie } })
  ).text();
  expect(afterHtml).toContain("replaced after being hidden");
});

// Decided outcome (see src/db.ts's stepCurrentSlide, fixed for this reason):
// the slide must advance by exactly one per Next press, even when two
// presses race. The pre-fix implementation read current_slide, computed +1,
// then wrote it back — two concurrent reads of the same value would both
// compute and write the same result, losing one press. stepCurrentSlide
// computes the new value inside a single atomic UPDATE instead.
it("two lecturers pressing Next at once both register — the slide advances by exactly two", async () => {
  const lecture = await createLectureAndLogIn("Concurrent Next test");

  const before = await fetch(new URL(`/l/${lecture.id}/lecturer`, baseUrl), {
    headers: { cookie: lecture.lecturerCookie },
  });
  const beforeHtml = await before.text();
  const beforeSlide = Number(beforeHtml.match(/Slide (\d+)/)?.[1]);
  expect(beforeSlide).toBe(1);

  const nextUrl = new URL(`/l/${lecture.id}/lecturer/slide/next`, baseUrl);
  await Promise.all([
    fetch(nextUrl, { method: "POST", headers: { cookie: lecture.lecturerCookie } }),
    fetch(nextUrl, { method: "POST", headers: { cookie: lecture.lecturerCookie } }),
  ]);

  const afterHtml = await (
    await fetch(new URL(`/l/${lecture.id}/lecturer`, baseUrl), { headers: { cookie: lecture.lecturerCookie } })
  ).text();
  const afterSlide = Number(afterHtml.match(/Slide (\d+)/)?.[1]);
  expect(afterSlide).toBe(beforeSlide + 2);
});

// One tap per browser per slide is held by a unique index, not by a check
// before the insert, so requests landing at the same moment can't both get
// in. Ten at once from one browser on one slide count once; one more on a
// different slide counts.
it("ten taps at once from one browser on one slide count once", async () => {
  const lecture = await createLectureAndLogIn("Parallel taps test");
  const cookie = await newBrowserCookie(lecture.id);
  const tapNow = (slide: number) =>
    fetch(new URL(`/l/${lecture.id}/tap`, baseUrl), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `slide=${slide}`,
      redirect: "manual",
    });
  const results = await Promise.all(Array.from({ length: 10 }, () => tapNow(1)));
  expect(results.every((r) => r.status === 303)).toBe(true);
  await tapNow(2);

  const yourCount = (html: string) => Number(html.match(/You've said you're lost (\d+) time/)?.[1]);
  const html = await (await fetch(new URL(`/l/${lecture.id}`, baseUrl), { headers: { cookie } })).text();
  expect(yourCount(html)).toBe(2);
});
