import { expect, inject, it } from "vitest";
import { newBrowserCookie } from "./test-helpers.ts";

// The student page's lecture timeline: one segment per slide, sized by the
// slide's duration on the demo, shaded only where a slide's bar passes
// min_present, and a plain link to that slide that moves nobody else.
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
  const cookie = await newBrowserCookie(id);
  const res = await fetch(new URL(`/l/${id}/lecturer`, baseUrl), {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: `code=${code}`,
    redirect: "manual",
  });
  const lsess = res.headers.getSetCookie().find((c) => c.startsWith("lsess="))?.split(";")[0];
  if (!lsess) throw new Error("lecturer login failed");
  return { id, lecturerCookie: `${cookie}; ${lsess}` };
}

function post(path: string, cookie: string, body: Record<string, string>): Promise<Response> {
  return fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    redirect: "manual",
  });
}

async function tapBy(lectureId: string, n: number, slide: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const cookie = await newBrowserCookie(lectureId);
    await post(`/l/${lectureId}/tap`, cookie, { slide: String(slide) });
  }
}

async function pageHtml(path: string, cookie?: string): Promise<string> {
  const res = await fetch(new URL(path, baseUrl), cookie ? { headers: { cookie } } : {});
  return res.text();
}

// The timeline's markup, or "" when absent.
function timeline(html: string): string {
  return html.match(/<div id="timeline">[\s\S]*?<\/svg>/)?.[0] ?? "";
}

interface Segment {
  href: string;
  label: string;
  cls: string;
  x: number;
  width: number;
}

function segments(html: string): Segment[] {
  const out: Segment[] = [];
  const re =
    /<a href="([^"]*)" data-slide="\d+" aria-label="([^"]*)"><rect class="(timeline-segment[^"]*)" x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/g;
  for (const m of timeline(html).matchAll(re)) {
    out.push({ href: m[1].replace(/&amp;/g, "&"), label: m[2], cls: m[3], x: Number(m[4]), width: Number(m[5]) });
  }
  return out;
}

// What a person can read or hear from the timeline: its text and labels.
function readable(html: string): string {
  const t = timeline(html);
  const labels = [...t.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]);
  const text = t.replace(/<[^>]*>/g, " ");
  return `${labels.join(" ")} ${text}`;
}

it("the demo timeline has one segment link per slide, and their widths fill the viewBox", async () => {
  const html = await pageHtml("/l/demo?deck=week-4&slide=1");
  expect(timeline(html)).toContain('viewBox="0 0 1000 40"');
  expect(timeline(html)).toContain('role="group" aria-label="Lecture timeline"');
  const count = Number(html.match(/slide \d+ of (\d+)/)?.[1]);
  expect(count).toBeGreaterThan(1);
  const segs = segments(html);
  expect(segs.map((s) => s.href)).toEqual(Array.from({ length: count }, (_, i) => `?deck=week-4&slide=${i + 1}`));
  const total = segs.reduce((a, s) => a + s.width, 0);
  expect(Math.abs(total - 1000)).toBeLessThan(1);
  // Laid end to end, from 0, in order.
  expect(segs[0].x).toBe(0);
  for (let i = 1; i < segs.length; i++) {
    expect(Math.abs(segs[i].x - (segs[i - 1].x + segs[i - 1].width))).toBeLessThan(0.11);
  }
  expect(segs[0].label).toBe("Week 4 · slide 1, starts 0:00");
  expect(segs[1].label).toMatch(/^Week 4 · slide 2, starts \d+:\d\d$/);
});

it("a segment is shaded only once min_present distinct browsers tapped that slide, and shows no count", async () => {
  const lecture = await createLectureAndLogIn("Timeline threshold");
  await tapBy(lecture.id, MIN_PRESENT - 1, 1);
  const below = await pageHtml(`/l/${lecture.id}`);
  const belowSegs = segments(below);
  expect(belowSegs).toHaveLength(1);
  expect(belowSegs[0].cls).not.toContain("shaded");
  expect(readable(below)).not.toMatch(/\b4\b/);

  await tapBy(lecture.id, 1, 1);
  const at = await pageHtml(`/l/${lecture.id}`);
  expect(segments(at)[0].cls).toContain("shaded");
  expect(readable(at)).not.toMatch(/\b5\b/);
});

it("a created lecture shows segments only for the slides reached so far", async () => {
  const lecture = await createLectureAndLogIn("Timeline reached");
  const first = segments(await pageHtml(`/l/${lecture.id}`));
  expect(first.map((s) => [s.href, s.label])).toEqual([["?slide=1", "Slide 1"]]);

  const next = await post(`/l/${lecture.id}/lecturer/slide/next`, lecture.lecturerCookie, {});
  expect(next.status).toBeLessThan(400);
  const second = segments(await pageHtml(`/l/${lecture.id}`));
  expect(second.map((s) => [s.href, s.label])).toEqual([
    ["?slide=1", "Slide 1"],
    ["?slide=2", "Slide 2"],
  ]);
  expect(second[0].width).toBe(500);
  expect(second[1].width).toBe(500);
});

it("a segment link works without JavaScript: its href shows that slide", async () => {
  const html = await pageHtml("/l/demo?deck=week-4&slide=1");
  const third = segments(html)[2];
  const target = new URL(third.href, new URL("/l/demo", baseUrl));
  const landed = await pageHtml(target.pathname + target.search);
  expect(landed).toMatch(/<p id="slide-label">Week 4 · slide 3 of \d+/);
  // The viewed slide is marked on its own segment.
  expect(timeline(landed)).toMatch(/data-slide="3"[^>]*>[^]*?class="timeline-you"/);
});

it("following a segment moves nobody else's slide", async () => {
  const lecture = await createLectureAndLogIn("Timeline isolation");
  await post(`/l/${lecture.id}/lecturer/slide/next`, lecture.lecturerCookie, {});
  await post(`/l/${lecture.id}/lecturer/slide/next`, lecture.lecturerCookie, {});

  const other = await newBrowserCookie(lecture.id);
  const controller = new AbortController();
  const res = await fetch(new URL(`/l/${lecture.id}/events`, baseUrl), { headers: { cookie: other }, signal: controller.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const slides: number[] = [];
  let buffer = "";
  const reading = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const data = buffer
            .slice(0, sep)
            .split("\n")
            .find((l) => l.startsWith("data: "));
          buffer = buffer.slice(sep + 2);
          if (data) slides.push((JSON.parse(data.slice(6)) as { slide: number }).slide);
        }
      }
    } catch {
      // aborted on close
    }
  })();
  try {
    await new Promise((r) => setTimeout(r, 300));
    expect(slides.length).toBeGreaterThan(0);
    expect(slides.every((s) => s === 3)).toBe(true);

    // Someone else follows the timeline back to slide 1.
    const browsing = await newBrowserCookie(lecture.id);
    const html = await pageHtml(`/l/${lecture.id}`, browsing);
    const first = segments(html)[0];
    expect(first.href).toBe("?slide=1");
    const landed = await pageHtml(`/l/${lecture.id}${first.href}`, browsing);
    expect(landed).toMatch(/<p id="slide-label">Slide 1</);

    await new Promise((r) => setTimeout(r, 500));
    expect(slides.every((s) => s === 3)).toBe(true);
  } finally {
    controller.abort();
    await reading;
  }
});
