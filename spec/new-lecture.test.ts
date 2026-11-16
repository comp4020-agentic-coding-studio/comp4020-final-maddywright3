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
  const demoLink = demo.querySelector('a[href="/l/demo/lecturer"]');
  expect(demoLink?.textContent).toBe("Lecturer view");
  expect(demoLink?.closest(".lecturer-link")?.textContent).toContain("Code: DEMO");

  const lecture = await create({ title: "Lecturer link test" });
  const html = await getHtml(`/l/${lecture.id}`);
  const doc = new JSDOM(html).window.document;
  expect(doc.querySelector(`a[href="/l/${lecture.id}/lecturer"]`)?.textContent).toBe("Lecturer view");
  expect(html).not.toContain(lecture.code);
  expect(html).not.toMatch(/Code:/);
});

// ---------- /new explains itself, and checks every limit on the server ----------

it("/new opens by saying what the app is for, and asks for slides, pacing, slide text and a help link", async () => {
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
  const pacing = [...form.querySelectorAll('input[name="pacing"]')].map((r) => [
    (r as HTMLInputElement).value,
    r.closest("label")?.textContent?.trim(),
  ]);
  expect(pacing).toEqual([
    ["next", "I'll press Next"],
    ["timed", "Timed"],
  ]);
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

it("a timed lecture's total must be 5 to 180 minutes", async () => {
  await expectRejected({ title: "Too short", slides: "10", pacing: "timed", minutes: "4" }, /5 to 180/);
  const html = await expectRejected(
    { title: "Too long", slides: "10", pacing: "timed", minutes: "181" },
    /5 to 180/,
  );
  const doc = new JSDOM(html).window.document;
  expect((doc.querySelector('input[name="pacing"][value="timed"]') as HTMLInputElement).checked).toBe(true);
  expect((doc.querySelector('[name="minutes"]') as HTMLInputElement).value).toBe("181");
});

it("per-slide minutes need one number per slide, adding up to 5 to 180", async () => {
  await expectRejected(
    { title: "Short list", slides: "3", pacing: "timed", slide_minutes: "2, 2" },
    /one number per slide/i,
  );
  await expectRejected(
    { title: "Too little", slides: "3", pacing: "timed", slide_minutes: "1, 1, 1" },
    /5 to 180/,
  );
  await create({ title: "Per-slide timing", slides: "3", pacing: "timed", slide_minutes: "2, 2.5, 3" });
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
  await expectRejected({ title: "http help", help_url: "http://example.org/help" }, /https/);
  await expectRejected({ title: "js help", help_url: "javascript:alert(1)" }, /https/);
  await expectRejected(
    { title: "Long help", help_url: `https://example.org/${"a".repeat(281)}` },
    /300 characters/,
  );
  await create({ title: "Good help", help_url: "https://example.org/help" });
});
