import { JSDOM } from "jsdom";
import { expect, inject, it } from "vitest";
import { newBrowserCookie } from "./test-helpers.ts";

// The page shell from the colour-and-layout prompt (docs/prompts/finish.md):
// one header on every page, and three cards on the home page. Geometry (no overflow, the 2x2 grid, keyboard focus,
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
  expect(await current("/")).toEqual(["Home"]);
  expect(await current("/l/demo")).toEqual(["Join the demo"]);
  expect(await current("/l/demo/lecturer")).toEqual(["Lecturer view"]);
  expect(await current("/new")).toEqual(["Create a lecture"]);
  expect(await current("/readme/")).toEqual(["How it works"]);
  expect(await current("/no-such-page")).toEqual([]);
});

it("the home page has three cards: student, lecturer, how it works, each with a short line and its links", async () => {
  const d = doc((await get("/")).html);
  const cards = [...d.querySelectorAll(".home-cards > li.card")];
  expect(cards.map((c) => c.querySelector("h2")!.textContent)).toEqual(["I'm a student", "I'm a lecturer", "How it works"]);
  const links = (card: Element): string[][] =>
    [...card.querySelectorAll("a")].map((a) => [a.textContent!, a.getAttribute("href")!]);
  expect(links(cards[0])).toEqual([["Join the demo", "/l/demo"]]);
  expect(links(cards[1])).toEqual([
    ["Open the demo lecturer view", "/l/demo/lecturer"],
    ["Create a lecture", "/new"],
  ]);
  expect(links(cards[2])).toEqual([["Read how it works", "/readme/"]]);
  for (const card of cards) {
    // One short line, then the links.
    const line = card.querySelector("h2 + p")!;
    expect(line.querySelector("a")).toBeNull();
    expect(line.textContent!.length).toBeLessThanOrEqual(80);
  }
  // CLAUDE.md shows the demo's code on the demo's own pages only, and the
  // home page isn't one of them.
  expect(d.body.textContent).not.toMatch(/\bDEMO\b/);
});

it("the student slide card has the chip and the live marker together above the slide", async () => {
  const cookie = await newBrowserCookie("demo");
  const d = doc((await get("/l/demo?deck=week-6&slide=3", cookie)).html);
  const card = d.querySelector(".slide-card")!;
  const bar = card.querySelector("#slide-bar")!;
  expect(bar.querySelector("#slide-label")!.textContent).toBe("Week 6 · slide 3 of 9");
  expect(bar.querySelector("#live-marker")).not.toBeNull();
  expect(bar.compareDocumentPosition(card.querySelector("#slides")!) & 4).toBe(4);
});
