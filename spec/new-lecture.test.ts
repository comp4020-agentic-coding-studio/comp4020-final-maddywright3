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
