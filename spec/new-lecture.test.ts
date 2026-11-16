import { JSDOM } from "jsdom";
import { expect, inject, it } from "vitest";
import { newBrowserCookie } from "./test-helpers.ts";

const baseUrl = inject("baseUrl");

// Each create uses a fresh browser: /new allows 3 lectures per browser per
// hour, and this file makes more than that.
async function postNew(fields: Record<string, string>): Promise<Response> {
  const cookie = await newBrowserCookie("demo");
  return fetch(new URL("/new", baseUrl), {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}

interface Created {
  id: string;
  code: string;
}

async function create(fields: Record<string, string>): Promise<Created> {
  const res = await postNew(fields);
  const html = await res.text();
  expect(res.status, html).toBe(200);
  const id = html.match(/Student link: <a href="\/l\/([a-f0-9]+)"/)?.[1];
  const code = html.match(/<strong>([A-Z0-9]+)<\/strong>/)?.[1];
  if (!id || !code) throw new Error("couldn't parse the new lecture's id/code");
  return { id, code };
}

async function getHtml(path: string, cookie?: string): Promise<string> {
  const res = await fetch(new URL(path, baseUrl), { headers: cookie ? { cookie } : {} });
  return res.text();
}

it("every lecture page links to its lecturer view; only the demo shows its code", async () => {
  const demo = new JSDOM(await getHtml("/l/demo")).window.document;
  // The page's own link, not the site header's nav link to the same place.
  const demoLink = demo.querySelector('.lecturer-link a[href="/l/demo/lecturer"]');
  expect(demoLink?.textContent).toBe("Lecturer view");
  expect(demoLink?.closest(".lecturer-link")?.textContent).toContain("Code: DEMO");

  const lecture = await create({ title: "Lecturer link test", slides: "60", minutes: "60" });
  const html = await getHtml(`/l/${lecture.id}`);
  const doc = new JSDOM(html).window.document;
  expect(doc.querySelector(`.lecturer-link a[href="/l/${lecture.id}/lecturer"]`)?.textContent).toBe("Lecturer view");
  expect(html).not.toContain(lecture.code);
  expect(html).not.toMatch(/Code:/);
});

// ---------- /new explains itself, and checks every limit on the server ----------

it("/new opens by saying what the app is for, and asks for slides, minutes, slide text and a help link", async () => {
  const html = await getHtml("/new");
  const doc = new JSDOM(html).window.document;
  const first = doc.querySelector("main h1 + p");
  expect(first?.textContent).toBe(
    "Run this beside your own slides. Students tap on the slide you're on, and you see where the room got lost.",
  );
  const form = doc.querySelector('form[action="/new"]')!;
  for (const name of ["title", "slides", "minutes", "slide_minutes", "slides_text", "help_url"]) {
    const field = form.querySelector(`[name="${name}"]`);
    expect(field, name).not.toBeNull();
    // Every field has a visible label.
    expect(doc.querySelector(`label[for="${field!.id}"]`), `label for ${name}`).not.toBeNull();
  }
  // Every created lecture is timed: there's no pacing choice, and the total
  // starts at an hour.
  expect(form.querySelector('input[name="pacing"]')).toBeNull();
  expect(html).not.toContain("I'll press Next");
  expect((form.querySelector("#minutes") as HTMLInputElement).value).toBe("60");
});

it("/new needs a total in minutes or minutes per slide, and a number of slides", async () => {
  await expectRejected({ title: "No minutes", slides: "10" }, /5 to 180/);
  await expectRejected({ title: "No slides", minutes: "60" }, /number of slides/);
  // Per-slide minutes stand in for the total.
  await create({ title: "Per-slide only", slides: "2", slide_minutes: "3, 3" });
});

it("every new lecture is timed, with Start lecture and Previous and Next in the lecturer view", async () => {
  const lecture = await create({ title: "Always timed", slides: "10", minutes: "60" });
  const doc = new JSDOM(await getHtml(`/l/${lecture.id}/lecturer`, await loginLecturer(lecture))).window.document;
  expect(doc.querySelector(`form[action="/l/${lecture.id}/lecturer/start"]`)?.textContent).toContain("Start lecture");
  expect(doc.getElementById("slide-prev-form")).not.toBeNull();
  expect(doc.getElementById("slide-next-form")).not.toBeNull();
  expect(doc.getElementById("timed-status")?.textContent).toContain("Previous and Next still work");
});

async function expectRejected(fields: Record<string, string>, message: RegExp): Promise<string> {
  const res = await postNew(fields);
  const html = await res.text();
  expect(res.status, html).toBe(400);
  const doc = new JSDOM(html).window.document;
  expect(doc.querySelector(".form-error")?.textContent).toMatch(message);
  // The form comes back with what was typed, so nothing has to be retyped.
  expect((doc.querySelector('[name="title"]') as HTMLInputElement).value).toBe(fields.title);
  return html;
}

it("the number of slides must be 1 to 60", async () => {
  await expectRejected({ title: "Zero slides", slides: "0" }, /1 to 60/);
  await expectRejected({ title: "Too many slides", slides: "61" }, /1 to 60/);
  await expectRejected({ title: "Not a number", slides: "ten" }, /1 to 60/);
});

it("a lecture's total must be 5 to 180 minutes", async () => {
  await expectRejected({ title: "Too short", slides: "10", minutes: "4" }, /5 to 180/);
  const html = await expectRejected(
    { title: "Too long", slides: "10", minutes: "181" },
    /5 to 180/,
  );
  const doc = new JSDOM(html).window.document;
  expect((doc.querySelector('[name="minutes"]') as HTMLInputElement).value).toBe("181");
});

it("per-slide minutes need one number per slide, adding up to 5 to 180", async () => {
  await expectRejected(
    { title: "Short list", slides: "3", slide_minutes: "2, 2" },
    /one number per slide/i,
  );
  await expectRejected(
    { title: "Too little", slides: "3", slide_minutes: "1, 1, 1" },
    /5 to 180/,
  );
  await create({ title: "Per-slide timing", slides: "3", slide_minutes: "2, 2.5, 3" });
});

it("pasted slides over 50 KB are rejected, and kept in the form", async () => {
  const text = "a".repeat(50 * 1024 + 1);
  const html = await expectRejected({ title: "Big paste", slides_text: text }, /50 KB/);
  const doc = new JSDOM(html).window.document;
  expect((doc.querySelector('[name="slides_text"]') as HTMLTextAreaElement).value).toBe(text);
});

it("pasted slides can make at most 60 slides", async () => {
  const text = Array.from({ length: 61 }, (_, i) => `Slide ${i + 1}`).join("\n---\n");
  await expectRejected({ title: "61 pasted", slides_text: text }, /60/);
});

it("the help link must be https and at most 300 characters", async () => {
  await expectRejected({ title: "http help", slides: "60", minutes: "60", help_url: "http://example.org/help" }, /https/);
  await expectRejected({ title: "js help", slides: "60", minutes: "60", help_url: "javascript:alert(1)" }, /https/);
  await expectRejected(
    { title: "Long help", slides: "60", minutes: "60", help_url: `https://example.org/${"a".repeat(281)}` },
    /300 characters/,
  );
  await create({ title: "Good help", slides: "60", minutes: "60", help_url: "https://example.org/help" });
});

// ---------- Pasted slides: escaped, no images, only web links ----------

async function loginLecturer(lecture: Created): Promise<string> {
  const cookie = await newBrowserCookie(lecture.id);
  const res = await fetch(new URL(`/l/${lecture.id}/lecturer`, baseUrl), {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: `code=${lecture.code}`,
    redirect: "manual",
  });
  const lsess = res.headers
    .getSetCookie()
    .find((c) => c.startsWith("lsess="))
    ?.split(";")[0];
  if (!lsess) throw new Error("lecturer login failed");
  return `${cookie}; ${lsess}`;
}

function slideSections(html: string): Element[] {
  return [...new JSDOM(html).window.document.querySelectorAll("#slides .slide")];
}

const HOSTILE = [
  "# Intro\n\n<script>alert('pasted')</script>\n\nHello <b onclick=\"x()\">there</b>",
  "## Pictures\n\n![a diagram of the stack](https://example.org/diagram.png)\n\n<img src=\"https://example.org/x.png\">",
  "## Links\n\n[bad](javascript:alert(1)) [data](data:text/html,hi) [relative](/l/demo) [good](https://example.org/notes)",
].join("\n---\n");

it("pasted slides show on the student page and the lecturer view, with HTML escaped", async () => {
  const lecture = await create({ title: "Pasted slides", slides: "9", minutes: "60", slides_text: HOSTILE });
  const studentHtml = await getHtml(`/l/${lecture.id}`);

  // The page's own scripts carry a nonce; the pasted one is text.
  expect(studentHtml).not.toMatch(/<script>alert/);
  expect(studentHtml).toContain("&lt;script&gt;alert(&#39;pasted&#39;)&lt;/script&gt;");
  expect(studentHtml).not.toMatch(/<b onclick/);

  const sections = slideSections(studentHtml);
  // The pasted text's count (3) wins over the number field (9).
  expect(sections).toHaveLength(3);
  expect(sections[0].querySelector("h1")?.textContent).toBe("Intro");
  expect(sections[0].hasAttribute("hidden")).toBe(false);
  expect(sections[1].hasAttribute("hidden")).toBe(true);
  expect(sections[0].querySelector("script, [onclick]")).toBeNull();

  const lecturerHtml = await getHtml(`/l/${lecture.id}/lecturer`, await loginLecturer(lecture));
  const lecturerSlides = slideSections(lecturerHtml);
  expect(lecturerSlides).toHaveLength(3);
  expect(lecturerSlides[0].querySelector("h1")?.textContent).toBe("Intro");
  expect(lecturerHtml).not.toMatch(/<script>alert/);
});

it("an image in pasted slides loads nothing: no <img>, just its alt text", async () => {
  const lecture = await create({ title: "Pasted images", minutes: "60", slides_text: HOSTILE });
  const html = await getHtml(`/l/${lecture.id}`);
  const pictures = slideSections(html)[1];
  expect(pictures.querySelector("img")).toBeNull();
  expect(pictures.textContent).toContain("a diagram of the stack");
  expect(html).not.toMatch(/<img/i);
  expect(html).not.toContain('src="https://example.org');
});

it("only http and https links in pasted slides stay links", async () => {
  const lecture = await create({ title: "Pasted links", minutes: "60", slides_text: HOSTILE });
  const links = slideSections(await getHtml(`/l/${lecture.id}`))[2];
  const anchors = [...links.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")]);
  expect(anchors).toEqual([["good", "https://example.org/notes"]]);
  expect(links.textContent).toContain("bad");
  expect(links.innerHTML).not.toMatch(/javascript:|data:text/);
});

it("pasted slides' count sets the lecture's slide count: Next stops at the last one", async () => {
  const lecture = await create({ title: "Two pasted", slides: "40", minutes: "60", slides_text: "One\n---\nTwo" });
  const lecturerCookie = await loginLecturer(lecture);
  for (let i = 0; i < 3; i++) {
    await fetch(new URL(`/l/${lecture.id}/lecturer/slide/next`, baseUrl), {
      method: "POST",
      headers: { cookie: lecturerCookie },
      redirect: "manual",
    });
  }
  const doc = new JSDOM(await getHtml(`/l/${lecture.id}`)).window.document;
  expect(doc.getElementById("slide-label")?.textContent).toBe("Slide 2 (live)");
  expect(doc.querySelector("#slides .slide:not([hidden])")?.textContent?.trim()).toBe("Two");
});

it("a created lecture without slide text still shows just Slide N", async () => {
  const lecture = await create({ title: "No slide text", slides: "5", minutes: "60" });
  const doc = new JSDOM(await getHtml(`/l/${lecture.id}`)).window.document;
  expect(doc.getElementById("slides")).toBeNull();
  expect(doc.getElementById("slide-label")?.textContent).toBe("Slide 1 (live)");
});

// ---------- Timed lectures start on the lecturer's cue ----------

interface Frame {
  slide: number;
}

// The student stream's frames, read as they arrive.
async function openStream(lectureId: string): Promise<{ next: (ms: number) => Promise<Frame>; close: () => void }> {
  const cookie = await newBrowserCookie(lectureId);
  const controller = new AbortController();
  const res = await fetch(new URL(`/l/${lectureId}/events`, baseUrl), { signal: controller.signal, headers: { cookie } });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  async function next(ms: number): Promise<Frame> {
    const deadline = Date.now() + ms;
    for (;;) {
      const sep = buffer.indexOf("\n\n");
      if (sep !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        if (data) return JSON.parse(data.slice(6)) as Frame;
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`no frame within ${ms}ms`);
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no frame within ${ms}ms`)), remaining)),
      ]);
      if (chunk.done) throw new Error("stream closed");
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  }
  return { next, close: () => controller.abort() };
}

async function waitForSlide(stream: { next: (ms: number) => Promise<Frame> }, slide: number, ms: number): Promise<number> {
  const started = Date.now();
  for (;;) {
    const frame = await stream.next(Math.max(1, ms - (Date.now() - started)));
    if (frame.slide === slide) return Date.now() - started;
  }
}

function startLecture(lectureId: string, cookie?: string): Promise<Response> {
  return fetch(new URL(`/l/${lectureId}/lecturer/start`, baseUrl), {
    method: "POST",
    headers: cookie ? { cookie } : {},
    redirect: "manual",
  });
}

async function liveSlideOnPage(lectureId: string): Promise<string | null | undefined> {
  return new JSDOM(await getHtml(`/l/${lectureId}`)).window.document.getElementById("slide-label")?.textContent;
}

it("Start lecture needs the lecture's own lecturer session", async () => {
  const lecture = await create({ title: "Start needs a session", slides: "10", minutes: "30" });
  const other = await create({ title: "Someone else's", slides: "10", minutes: "30" });

  expect((await startLecture(lecture.id)).status).toBe(403);
  expect((await startLecture(lecture.id, await newBrowserCookie(lecture.id))).status).toBe(403);
  expect((await startLecture(lecture.id, await loginLecturer(other))).status).toBe(403);
  expect((await startLecture("demo", await newBrowserCookie("demo"))).status).toBe(403);

  const ok = await startLecture(lecture.id, await loginLecturer(lecture));
  expect(ok.status).toBe(303);
  expect(ok.headers.get("location")).toBe(`/l/${lecture.id}/lecturer`);
});

it("the lecturer view of a timed lecture offers Start lecture, and Previous and Next", async () => {
  const lecture = await create({ title: "Timed controls", slides: "10", minutes: "30" });
  const cookie = await loginLecturer(lecture);
  const before = new JSDOM(await getHtml(`/l/${lecture.id}/lecturer`, cookie)).window.document;
  const startForm = before.querySelector(`form[action="/l/${lecture.id}/lecturer/start"]`);
  expect(startForm?.textContent).toContain("Start lecture");
  expect(before.getElementById("slide-next-form")).not.toBeNull();

  // Before Start, Next moves the slide the clock will start from.
  const next = await fetch(new URL(`/l/${lecture.id}/lecturer/slide/next`, baseUrl), {
    method: "POST",
    headers: { cookie },
    redirect: "manual",
  });
  expect(next.status).toBe(303);
  expect(await liveSlideOnPage(lecture.id)).toBe("Slide 2 (live)");

  await startLecture(lecture.id, cookie);
  const after = new JSDOM(await getHtml(`/l/${lecture.id}/lecturer`, cookie)).window.document;
  expect(after.querySelector(`form[action="/l/${lecture.id}/lecturer/start"]`)).toBeNull();
  expect(after.getElementById("timed-status")?.textContent).toMatch(/started/i);
  expect(after.getElementById("slide-next-form")).not.toBeNull();
});

// The shortest legal timing: 5 minutes over 60 slides is 5 seconds a slide.
it(
  "a timed lecture stays on slide 1 until Start lecture, then moves on its clock",
  async () => {
    const lecture = await create({ title: "Timed clock", slides: "60", minutes: "5" });
    const stream = await openStream(lecture.id);
    try {
      expect((await stream.next(1000)).slide).toBe(1);
      // A student arriving doesn't start it: still slide 1 past a slide's length.
      await new Promise((resolve) => setTimeout(resolve, 5500));
      expect(await liveSlideOnPage(lecture.id)).toBe("Slide 1 (live)");

      const started = await startLecture(lecture.id, await loginLecturer(lecture));
      expect(started.status).toBe(303);
      expect(await liveSlideOnPage(lecture.id)).toBe("Slide 1 (live)");

      // The open stream is told on time, with nothing else happening.
      const tookMs = await waitForSlide(stream, 2, 7000);
      expect(tookMs).toBeGreaterThan(3500);
      expect(await liveSlideOnPage(lecture.id)).toBe("Slide 2 (live)");
    } finally {
      stream.close();
    }
  },
  20_000,
);

function moveSlide(lectureId: string, cookie: string, direction: "next" | "prev"): Promise<Response> {
  return fetch(new URL(`/l/${lectureId}/lecturer/slide/${direction}`, baseUrl), {
    method: "POST",
    headers: { cookie },
    redirect: "manual",
  });
}

// The lecturer can move ahead of or behind the clock; it then carries on
// from the slide they chose, a full slide's time later.
it(
  "on a started timed lecture, Next moves the live slide and the clock runs on from there",
  async () => {
    const lecture = await create({ title: "Timed override", slides: "60", minutes: "5" });
    const cookie = await loginLecturer(lecture);
    const stream = await openStream(lecture.id);
    try {
      expect((await stream.next(1000)).slide).toBe(1);
      expect((await startLecture(lecture.id, cookie)).status).toBe(303);
      // Partway into slide 1, so a clock that wasn't reset would move sooner.
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const pressed = Date.now();
      const next = await moveSlide(lecture.id, cookie, "next");
      expect(next.status).toBe(303);
      expect(await liveSlideOnPage(lecture.id)).toBe("Slide 2 (live)");
      await waitForSlide(stream, 2, 2000);
      await waitForSlide(stream, 3, 8000);
      const tookMs = Date.now() - pressed;
      expect(tookMs).toBeGreaterThan(3500);
      expect(tookMs).toBeLessThan(7000);

      // Previous goes back one, and the clock carries on from that slide.
      expect((await moveSlide(lecture.id, cookie, "prev")).status).toBe(303);
      expect(await liveSlideOnPage(lecture.id)).toBe("Slide 2 (live)");
    } finally {
      stream.close();
    }
  },
  20_000,
);

it(
  "Next and Previous before Start move the slide, and Start runs the clock from there",
  async () => {
    const lecture = await create({ title: "Timed from slide 3", slides: "60", minutes: "5" });
    const cookie = await loginLecturer(lecture);
    expect((await moveSlide(lecture.id, cookie, "next")).status).toBe(303);
    expect((await moveSlide(lecture.id, cookie, "next")).status).toBe(303);
    expect((await moveSlide(lecture.id, cookie, "next")).status).toBe(303);
    expect((await moveSlide(lecture.id, cookie, "prev")).status).toBe(303);
    expect(await liveSlideOnPage(lecture.id)).toBe("Slide 3 (live)");
    // Not started: it stays there however long it waits.
    await new Promise((resolve) => setTimeout(resolve, 5500));
    expect(await liveSlideOnPage(lecture.id)).toBe("Slide 3 (live)");

    const stream = await openStream(lecture.id);
    try {
      expect((await stream.next(1000)).slide).toBe(3);
      const pressed = Date.now();
      expect((await startLecture(lecture.id, cookie)).status).toBe(303);
      expect(await liveSlideOnPage(lecture.id)).toBe("Slide 3 (live)");
      await waitForSlide(stream, 4, 8000);
      const tookMs = Date.now() - pressed;
      expect(tookMs).toBeGreaterThan(3500);
      expect(tookMs).toBeLessThan(7000);
    } finally {
      stream.close();
    }
  },
  25_000,
);
