import { expect, inject, it } from "vitest";
import { newBrowserCookie } from "./test-helpers.ts";

// The help link (finish.md, "Lecturer dashboard and after the hand checks",
// item 2): a browser that has said it's lost on 3 or more slides in the
// current run sees its lecturer's help link, on its own page and in its own
// stream only. The lecturer never learns who saw it.
const baseUrl = inject("baseUrl");
const HELP_URL = "https://example.edu/help/comp4020";
// The rendered offer. Its words also sit in every student page's script,
// which builds the offer when a frame brings a link, so a page is checked
// for the rendered element and for the URL, never for the words alone.
const OFFER = '<p id="help-offer"';

async function createLectureAndLogIn(title: string): Promise<{ id: string; lecturerCookie: string }> {
  const createHtml = await (
    await fetch(new URL("/new", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
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

async function page(path: string, cookie: string): Promise<string> {
  return (await fetch(new URL(path, baseUrl), { headers: { cookie } })).text();
}

async function tapSlides(id: string, cookie: string, slides: number[]): Promise<void> {
  for (const slide of slides) {
    expect((await post(`/l/${id}/tap`, cookie, { slide: String(slide) })).status).toBe(303);
  }
}

// Collects every raw frame a stream sends, as text, so a test can check a
// string never appears in any of them.
class RawStream {
  raw = "";
  private controller = new AbortController();

  static async open(path: string, cookie: string): Promise<RawStream> {
    const stream = new RawStream();
    const res = await fetch(new URL(path, baseUrl), { headers: { cookie }, signal: stream.controller.signal });
    if (res.status !== 200 || !res.body) throw new Error(`stream ${path} answered ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          stream.raw += decoder.decode(value, { stream: true });
        }
      } catch {
        // aborted
      }
    })();
    return stream;
  }

  frames(): Record<string, unknown>[] {
    return [...this.raw.matchAll(/data: (.*)\n\n/g)].map((m) => JSON.parse(m[1]));
  }

  async waitFor(predicate: (f: Record<string, unknown>) => boolean, timeoutMs = 2000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.frames().reverse().find(predicate);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`no matching frame: ${JSON.stringify(this.frames().at(-1))}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  close(): void {
    this.controller.abort();
  }
}

it("the demo is seeded with the course's communication page as its help link", async () => {
  const lecturerCookie = await logIn("demo", "DEMO");
  const view = await page("/l/demo/lecturer", lecturerCookie);
  expect(view).toContain("https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/topics/communication/");
});

it("a browser lost on 3 slides sees the help link on its own page and stream; one on 2 doesn't", async () => {
  const lecture = await createLectureAndLogIn("Help link threshold");
  expect((await post(`/l/${lecture.id}/lecturer/help-link`, lecture.lecturerCookie, { url: HELP_URL })).status).toBe(303);

  const three = await newBrowserCookie(lecture.id);
  const two = await newBrowserCookie(lecture.id);
  const threeStream = await RawStream.open(`/l/${lecture.id}/events`, three);
  const twoStream = await RawStream.open(`/l/${lecture.id}/events`, two);
  try {
    await tapSlides(lecture.id, three, [1, 2]);
    await tapSlides(lecture.id, two, [1, 2]);
    await threeStream.waitFor((f) => f.yourTapCount === 2);
    expect(threeStream.raw).not.toContain(HELP_URL);
    expect(await page(`/l/${lecture.id}`, three)).not.toContain(OFFER);

    await tapSlides(lecture.id, three, [3]);
    const frame = await threeStream.waitFor((f) => f.yourTapCount === 3);
    expect(frame.helpUrl).toBe(HELP_URL);
    const threePage = await page(`/l/${lecture.id}`, three);
    expect(threePage).toContain(
      `<p id="help-offer" class="help-offer">Want a hand with this? <a href="${HELP_URL}" rel="noreferrer">Your lecturer offers help here.</a></p>`,
    );

    // The other browser, on 2 slides, received frames after the third tap
    // too, and none of them carries the link.
    await twoStream.waitFor((f) => f.yourTapCount === 2 && (f.bars as unknown[]) !== undefined);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(twoStream.frames().length).toBeGreaterThan(1);
    expect(twoStream.raw).not.toContain(HELP_URL);
    expect(twoStream.raw).not.toContain("helpUrl");
    const twoPage = await page(`/l/${lecture.id}`, two);
    expect(twoPage).not.toContain(OFFER);
    expect(twoPage).not.toContain(HELP_URL);
  } finally {
    threeStream.close();
    twoStream.close();
  }
});

it("the help offer never reaches the lecturer's stream or page", async () => {
  const lecture = await createLectureAndLogIn("Help link stays private");
  await post(`/l/${lecture.id}/lecturer/help-link`, lecture.lecturerCookie, { url: HELP_URL });
  const lecturerStream = await RawStream.open(`/l/${lecture.id}/lecturer/events`, lecture.lecturerCookie);
  const student = await newBrowserCookie(lecture.id);
  const studentStream = await RawStream.open(`/l/${lecture.id}/events`, student);
  try {
    await tapSlides(lecture.id, student, [1, 2, 3, 4]);
    await studentStream.waitFor((f) => f.helpUrl === HELP_URL);
    await lecturerStream.waitFor((f) => f.present === 1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(lecturerStream.frames().length).toBeGreaterThan(1);
    expect(lecturerStream.raw).not.toContain(HELP_URL);
    expect(lecturerStream.raw).not.toContain("helpUrl");

    // The lecturer's page shows the link they set (in its edit form) but
    // never the offer, or anything saying who has seen it.
    const view = await page(`/l/${lecture.id}/lecturer`, lecture.lecturerCookie);
    expect(view).not.toContain(OFFER);
    expect(view).not.toContain("help-offer");
  } finally {
    lecturerStream.close();
    studentStream.close();
  }
});

it("the help offer counts slides in the current run only", async () => {
  const lecture = await createLectureAndLogIn("Help link per run");
  await post(`/l/${lecture.id}/lecturer/help-link`, lecture.lecturerCookie, { url: HELP_URL });
  const student = await newBrowserCookie(lecture.id);
  await tapSlides(lecture.id, student, [1, 2, 3]);
  expect(await page(`/l/${lecture.id}`, student)).toContain(OFFER);

  expect((await post(`/l/${lecture.id}/lecturer/runs`, lecture.lecturerCookie, { run: "1" })).status).toBe(303);
  expect(await page(`/l/${lecture.id}`, student)).not.toContain(OFFER);
  await tapSlides(lecture.id, student, [1, 2, 3]);
  expect(await page(`/l/${lecture.id}`, student)).toContain(OFFER);
});

it("a help link must be https and at most 300 characters", async () => {
  const lecture = await createLectureAndLogIn("Help link validation");
  const base = `/l/${lecture.id}/lecturer/help-link`;
  const longUrl = `https://example.edu/${"a".repeat(301 - "https://example.edu/".length)}`;
  expect(longUrl.length).toBe(301);
  const atLimit = longUrl.slice(0, 300);

  for (const bad of ["http://example.edu/help", "javascript:alert(1)", "example.edu/help", "ftp://example.edu", longUrl]) {
    const res = await post(base, lecture.lecturerCookie, { url: bad });
    expect(res.status, bad).toBe(400);
  }
  expect(await page(`/l/${lecture.id}/lecturer`, lecture.lecturerCookie)).not.toContain("example.edu");

  expect((await post(base, lecture.lecturerCookie, { url: atLimit })).status).toBe(303);
  expect(await page(`/l/${lecture.id}/lecturer`, lecture.lecturerCookie)).toContain(`value="${atLimit}"`);

  // Empty clears it.
  expect((await post(base, lecture.lecturerCookie, { url: "" })).status).toBe(303);
  expect(await page(`/l/${lecture.id}/lecturer`, lecture.lecturerCookie)).not.toContain("example.edu");
});

it("editing the help link needs that lecture's lecturer session", async () => {
  const lecture = await createLectureAndLogIn("Help link needs a session");
  const other = await createLectureAndLogIn("Another lecturer");
  const student = await newBrowserCookie(lecture.id);
  const base = `/l/${lecture.id}/lecturer/help-link`;

  expect((await post(base, student, { url: HELP_URL })).status).toBe(403);
  expect((await post(base, other.lecturerCookie, { url: HELP_URL })).status).toBe(403);
  expect(await page(`/l/${lecture.id}/lecturer`, lecture.lecturerCookie)).not.toContain(HELP_URL);

  // The demo's link is fixed even for its own lecturer: its code is public.
  const demoLecturer = await logIn("demo", "DEMO");
  expect((await post("/l/demo/lecturer/help-link", demoLecturer, { url: HELP_URL })).status).toBe(403);
  expect(await page("/l/demo/lecturer", demoLecturer)).not.toContain(HELP_URL);
});
