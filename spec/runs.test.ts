import { expect, inject, it } from "vitest";
import { newBrowserCookie } from "./test-helpers.ts";

// ADR 006 section 3: a fresh run, never a delete. Each test makes its own
// lecture, so no other file's taps or streams change what it counts. The
// demo is only ever asked to reset (and refuses), never tapped here.
const baseUrl = inject("baseUrl");

interface NewLecture {
  id: string;
  cookie: string;
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
  return { id, cookie: "", lecturerCookie: await logIn(id, code) };
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

async function get(path: string, cookie: string): Promise<Response> {
  return fetch(new URL(path, baseUrl), { headers: { cookie }, redirect: "manual" });
}

async function text(path: string, cookie: string): Promise<string> {
  return (await get(path, cookie)).text();
}

// Every frame a stream sends, kept as raw JSON text and parsed.
class Stream {
  frames: Record<string, unknown>[] = [];
  private controller = new AbortController();
  private waiters: (() => void)[] = [];

  static async open(path: string, cookie: string): Promise<Stream> {
    const stream = new Stream();
    const res = await fetch(new URL(path, baseUrl), { headers: { cookie }, signal: stream.controller.signal });
    if (res.status !== 200 || !res.body) throw new Error(`stream ${path} answered ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const data = frame.split("\n").find((l) => l.startsWith("data: "));
            if (data) stream.frames.push(JSON.parse(data.slice(6)));
            stream.waiters.splice(0).forEach((w) => w());
          }
        }
      } catch {
        // aborted
      }
    })();
    return stream;
  }

  async waitFor(predicate: (frame: Record<string, unknown>) => boolean, timeoutMs = 2000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = [...this.frames].reverse().find(predicate);
      if (found) return found;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`no matching frame within ${timeoutMs}ms: ${JSON.stringify(this.frames.at(-1))}`);
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, remaining);
      });
    }
  }

  latest(): Record<string, unknown> | undefined {
    return this.frames.at(-1);
  }

  close(): void {
    this.controller.abort();
  }
}

// The run number the confirmation page offers to replace, read the way a
// person's browser would submit it.
async function freshRun(lecture: NewLecture): Promise<Response> {
  const confirm = await text(`/l/${lecture.id}/lecturer/runs/new`, lecture.lecturerCookie);
  const run = confirm.match(/name="run" value="(\d+)"/)?.[1];
  if (!run) throw new Error("no run field on the confirmation page");
  return post(`/l/${lecture.id}/lecturer/runs`, lecture.lecturerCookie, { run });
}

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

it("a fresh run deletes nothing: run 1's total, bar, reasons and notes are all still there", async () => {
  const lecture = await createLectureAndLogIn("Fresh run keeps rows");
  const cookies = await Promise.all(Array.from({ length: 5 }, () => newBrowserCookie(lecture.id)));
  // Five students present, so the total clears min_present (5) and is shown.
  const streams = await Promise.all(cookies.map((c) => Stream.open(`/l/${lecture.id}/events`, c)));
  try {
    for (const cookie of cookies) {
      expect((await post(`/l/${lecture.id}/tap`, cookie, { slide: "1" })).status).toBe(303);
      await post(`/l/${lecture.id}/reason`, cookie, { slide: "1", reason: "Too fast" });
      await post(`/l/${lecture.id}/note`, cookie, { slide: "1", text: "the run one note" });
    }
    await streams[0].waitFor((f) => f.present === 5);

    const before = await text(`/l/${lecture.id}/lecturer`, lecture.lecturerCookie);
    expect(before).toContain("Total taps: 5");
    expect(before).toContain("<td>Slide 1</td><td>5</td>");
    expect(before).toContain("<td>Too fast</td><td>5</td>");
    expect(occurrences(before, "the run one note")).toBe(5);

    const res = await freshRun(lecture);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/l/${lecture.id}/lecturer`);

    // The past run, read-only: every count exactly as it was.
    const pastRun = await text(`/l/${lecture.id}/lecturer?run=1`, lecture.lecturerCookie);
    expect(pastRun).toContain("Total taps in run 1: 5");
    expect(pastRun).toContain("<td>Slide 1</td><td>5</td>");
    expect(pastRun).toContain("<td>Too fast</td><td>5</td>");
    expect(occurrences(pastRun, "the run one note")).toBe(5);

    // The live run starts empty.
    const live = await text(`/l/${lecture.id}/lecturer`, lecture.lecturerCookie);
    expect(live).toContain("Total taps: 0");
    expect(live).not.toContain("<td>Slide 1</td><td>5</td>");
    expect(live).not.toContain("the run one note");
  } finally {
    streams.forEach((s) => s.close());
  }
});

it("an earlier run is still viewable, read-only, through plain links in the run picker", async () => {
  const lecture = await createLectureAndLogIn("Run picker");
  const firstView = await text(`/l/${lecture.id}/lecturer`, lecture.lecturerCookie);
  expect(firstView).toContain('<section id="runs"');
  expect(firstView).toContain("Run 1 (live)");

  expect((await freshRun(lecture)).status).toBe(303);

  const live = await text(`/l/${lecture.id}/lecturer`, lecture.lecturerCookie);
  expect(live).toContain(`href="/l/${lecture.id}/lecturer?run=1"`);
  expect(live).toContain("Run 2 (live)");

  const pastRes = await get(`/l/${lecture.id}/lecturer?run=1`, lecture.lecturerCookie);
  expect(pastRes.status).toBe(200);
  const past = await pastRes.text();
  expect(past).toContain("Run 1, read-only");
  // A static render: no live stream, nothing to hide or change.
  expect(past).not.toContain("/lecturer/events");
  expect(past).not.toContain("hide-note-form");
  expect(past).toContain(`href="/l/${lecture.id}/lecturer"`);

  expect((await get(`/l/${lecture.id}/lecturer?run=3`, lecture.lecturerCookie)).status).toBe(404);
  expect((await get(`/l/${lecture.id}/lecturer?run=abc`, lecture.lecturerCookie)).status).toBe(404);
});

it("a browser can tap the same slide again in a new run, and its own page starts the run fresh", async () => {
  const lecture = await createLectureAndLogIn("Tap again in a new run");
  const student = await newBrowserCookie(lecture.id);
  const stream = await Stream.open(`/l/${lecture.id}/events`, student);
  const lecturerStream = await Stream.open(`/l/${lecture.id}/lecturer/events`, lecture.lecturerCookie);
  try {
    await post(`/l/${lecture.id}/tap`, student, { slide: "1" });
    await stream.waitFor((f) => f.yourTapCount === 1);
    // One tap per slide per run: a second tap in the same run changes nothing.
    await post(`/l/${lecture.id}/tap`, student, { slide: "1" });
    await post(`/l/${lecture.id}/lecturer/slide/next`, lecture.lecturerCookie, {});
    await stream.waitFor((f) => f.slide === 2 && f.yourTapCount === 1);
    await lecturerStream.waitFor((f) => f.run === 1);

    expect((await freshRun(lecture)).status).toBe(303);
    // Every open page hears about the new run: the student's own slides are
    // the new run's (none yet), and the slide goes back to the start.
    await stream.waitFor((f) => f.yourTapCount === 0 && (f.yourSlides as unknown[]).length === 0 && f.slide === 1);
    await lecturerStream.waitFor((f) => f.run === 2 && f.slide === 1);

    await post(`/l/${lecture.id}/tap`, student, { slide: "1" });
    const after = await stream.waitFor((f) => f.yourTapCount === 1);
    expect(after.yourSlides).toEqual([
      { deck: null, slide: 1, live: true, resolved: false, answeredReason: false, answeredHelped: false },
    ]);
  } finally {
    stream.close();
    lecturerStream.close();
  }
});

it("the shared demo can't be reset: 403 with the message, from the page and the form", async () => {
  const lecturerCookie = await logIn("demo", "DEMO");
  const message = "The shared demo keeps its history. Create your own lecture to try a fresh run.";

  const view = await text("/l/demo/lecturer", lecturerCookie);
  expect(view).toContain(message);
  expect(view).not.toContain('action="/l/demo/lecturer/runs/new"');

  const confirm = await get("/l/demo/lecturer/runs/new", lecturerCookie);
  expect(confirm.status).toBe(403);
  expect(await confirm.text()).toContain(message);

  const reset = await post("/l/demo/lecturer/runs", lecturerCookie, { run: "1" });
  expect(reset.status).toBe(403);
  expect(await reset.text()).toContain(message);

  expect(await text("/l/demo/lecturer", lecturerCookie)).not.toContain("?run=2");
});

it("starting a fresh run needs that lecture's lecturer session", async () => {
  const lecture = await createLectureAndLogIn("Reset needs a session");
  const other = await createLectureAndLogIn("Someone else's lecture");
  const student = await newBrowserCookie(lecture.id);

  expect((await get(`/l/${lecture.id}/lecturer/runs/new`, student)).status).toBe(403);
  expect((await post(`/l/${lecture.id}/lecturer/runs`, student, { run: "1" })).status).toBe(403);
  // Another lecture's session doesn't count here either.
  expect((await post(`/l/${lecture.id}/lecturer/runs`, other.lecturerCookie, { run: "1" })).status).toBe(403);

  const view = await text(`/l/${lecture.id}/lecturer`, lecture.lecturerCookie);
  expect(view).toContain("Run 1 (live)");
  expect(view).not.toContain("?run=1");
});

it("a repeated confirmation starts one run, not two", async () => {
  const lecture = await createLectureAndLogIn("Double submit");
  const confirm = await text(`/l/${lecture.id}/lecturer/runs/new`, lecture.lecturerCookie);
  expect(confirm).toContain("Nothing is deleted");
  const run = confirm.match(/name="run" value="(\d+)"/)?.[1];
  expect(run).toBe("1");
  expect((await post(`/l/${lecture.id}/lecturer/runs`, lecture.lecturerCookie, { run: "1" })).status).toBe(303);
  expect((await post(`/l/${lecture.id}/lecturer/runs`, lecture.lecturerCookie, { run: "1" })).status).toBe(303);
  const view = await text(`/l/${lecture.id}/lecturer`, lecture.lecturerCookie);
  expect(view).toContain("Run 2 (live)");
  expect(view).not.toContain("Run 3");
});
