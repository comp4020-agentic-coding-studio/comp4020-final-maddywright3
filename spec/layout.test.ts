import { JSDOM } from "jsdom";
import { expect, inject, it } from "vitest";
import { newBrowserCookie } from "./test-helpers.ts";

// The page shell from the colour-and-layout prompt (docs/prompts/finish.md):
// one header on every page. Geometry (no overflow, the 2x2 grid, keyboard focus,
// contrast in light and dark) is checked in a real browser in
// spec/browser.test.ts; this checks what the server renders.
const baseUrl = inject("baseUrl");

const doc = (html: string): Document => new JSDOM(html).window.document;

async function get(path: string, cookie?: string): Promise<{ status: number; html: string }> {
  const res = await fetch(new URL(path, baseUrl), { headers: cookie ? { cookie } : {} });
  return { status: res.status, html: await res.text() };
}

async function demoLecturerCookie(): Promise<string> {
  const cookie = await newBrowserCookie("demo");
  const res = await fetch(new URL("/l/demo/lecturer", baseUrl), {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: "code=DEMO",
    redirect: "manual",
  });
  const lsess = res.headers
    .getSetCookie()
    .find((c) => c.startsWith("lsess="))
    ?.split(";")[0];
  if (!lsess) throw new Error("demo lecturer login failed");
  return `${cookie}; ${lsess}`;
}

const NAV = [
  ["Home", "/"],
  ["Join the demo", "/l/demo"],
  ["Lecturer view", "/l/demo/lecturer"],
  ["Create a lecture", "/new"],
  ["How it works", "/readme/"],
];

it("every page has the header: the app name linking home, and the main nav in order", async () => {
  const lecturer = await demoLecturerCookie();
  const pages: [string, string | undefined, number][] = [
    ["/", undefined, 200],
    ["/readme/", undefined, 200],
    ["/new", undefined, 200],
    ["/no-such-page", undefined, 404],
    ["/l/demo", undefined, 200],
    ["/l/demo/lecturer", undefined, 200],
    ["/l/demo/lecturer", lecturer, 200],
  ];
  for (const [path, cookie, status] of pages) {
    const res = await get(path, cookie);
    expect(res.status, path).toBe(status);
    const d = doc(res.html);
    const headers = d.querySelectorAll("body > header");
    expect(headers.length, path).toBe(1);
    const name = headers[0].querySelector("a.site-name")!;
    expect(name.textContent, path).toBe("Confusion meter");
    expect(name.getAttribute("href"), path).toBe("/");
    const nav = headers[0].querySelectorAll('nav[aria-label="Main"]');
    expect(nav.length, path).toBe(1);
    const links = [...nav[0].querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")]);
    expect(links, path).toEqual(NAV);
    // One <main>, after the header, which the skip link targets.
    expect(d.querySelectorAll("main").length, path).toBe(1);
    expect(d.querySelector("main")!.id, path).toBe("main");
    expect(d.querySelector("a.skip-link")!.getAttribute("href"), path).toBe("#main");
  }
});

it("the nav marks the page you're on, and only that one", async () => {
  const current = async (path: string): Promise<string[]> =>
    [...doc((await get(path)).html).querySelectorAll('nav[aria-label="Main"] a[aria-current="page"]')].map(
      (a) => a.textContent!,
    );
  expect(await current("/l/demo")).toEqual(["Join the demo"]);
  expect(await current("/l/demo/lecturer")).toEqual(["Lecturer view"]);
  expect(await current("/new")).toEqual(["Create a lecture"]);
  expect(await current("/readme/")).toEqual(["How it works"]);
  expect(await current("/no-such-page")).toEqual([]);
});
