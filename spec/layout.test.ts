import { JSDOM } from "jsdom";
import { expect, inject, it } from "vitest";
import { newBrowserCookie } from "./test-helpers.ts";

// The page shell from the colour-and-layout prompt (docs/prompts/finish.md):
// one header on every page, three cards on the home page, and the lecturer
// page's layout slots. Geometry (no overflow, the 2x2 grid, keyboard focus,
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
    ["/l/demo/lecturer?projector=1", lecturer, 200],
  ];
  for (const [path, cookie, status] of pages) {
    const res = await get(path, cookie);
    expect(res.status, path).toBe(status);
    const d = doc(res.html);
    const headers = d.querySelectorAll("body > header");
    expect(headers.length, path).toBe(1);
    const name = headers[0].querySelector("a.site-name")!;
    expect(name.textContent, path).toBe("Hands Down");
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

it("the lecturer page has the layout slots: stat tiles, four graph slots, the live column and the activity log", async () => {
  const d = doc((await get("/l/demo/lecturer", await demoLecturerCookie())).html);
  expect(d.querySelectorAll(".stat-tiles .stat-tile").length).toBeGreaterThanOrEqual(3);
  const slots = [
    ["graph-lost", "Lost, per slide"],
    ["graph-reasons", "What kind of lost"],
    ["graph-helped", "What helped"],
    ["graph-resolved", "Got it now"],
  ];
  for (const [id, heading] of slots) {
    const slot = d.getElementById(id);
    expect(slot, id).not.toBeNull();
    expect(slot!.closest(".graph-grid"), id).not.toBeNull();
    expect(slot!.querySelector("h2")!.textContent, id).toBe(heading);
    expect(slot!.getAttribute("aria-labelledby"), id).toBe(slot!.querySelector("h2")!.id);
    expect(slot!.querySelector(".slot-body"), id).not.toBeNull();
  }
  // The graphs have landed in their slots: each slot body holds either its
  // SVG graph with a table alternative, or its threshold message.
  for (const [id] of slots) {
    const body = d.querySelector(`#${id} .slot-body`)!;
    const graphed = body.querySelector("svg") !== null && body.querySelector("table") !== null;
    const waiting = body.querySelector("p.graph-empty") !== null;
    expect(graphed || waiting, id).toBe(true);
  }

  const log = d.getElementById("activity-log")!;
  expect(log.tagName).toBe("SECTION");
  expect(log.querySelector("h2")!.textContent).toBe("Activity");
  // The activity log has landed in its slot: its filter form, its empty
  // message and its list of lines are all there.
  expect(log.querySelector("form.activity-filter")).not.toBeNull();
  expect(log.querySelector("#activity-empty")).not.toBeNull();
  expect(log.querySelector("ul#activity-lines")).not.toBeNull();
  // Full width: outside the two-column layout, after it.
  expect(log.closest(".lecturer-layout")).toBeNull();
  expect(d.querySelector(".lecturer-layout")!.compareDocumentPosition(log) & 4).toBe(4);

  // Everything the page showed before is still here: the gauge, the slide
  // label, the current slide's section and the notes, now grouped by slide.
  for (const id of ["gauge", "gauge-words", "slide-label", "now", "now-bar", "notes", "connection-status"]) {
    expect(d.getElementById(id), id).not.toBeNull();
  }
  expect(d.querySelector(".live-column #now")).not.toBeNull();
  expect(d.querySelector(".live-column #notes")).not.toBeNull();
});

it("projector mode is server-rendered: ?projector=1 adds the class and its link turns it off", async () => {
  const cookie = await demoLecturerCookie();
  const off = doc((await get("/l/demo/lecturer", cookie)).html);
  expect(off.querySelector("main")!.className).toBe("lecturer");
  const offLink = off.getElementById("projector-link")!;
  expect(offLink.tagName).toBe("A");
  expect(offLink.getAttribute("href")).toBe("/l/demo/lecturer?projector=1");
  expect(offLink.textContent).toBe("Projector mode");

  const on = doc((await get("/l/demo/lecturer?projector=1", cookie)).html);
  expect(on.querySelector("main")!.className).toBe("lecturer projector");
  const onLink = on.getElementById("projector-link")!;
  expect(onLink.getAttribute("href")).toBe("/l/demo/lecturer");
  expect(onLink.textContent).toBe("Leave projector mode");

  // Anything else is off.
  const other = doc((await get("/l/demo/lecturer?projector=yes", cookie)).html);
  expect(other.querySelector("main")!.className).toBe("lecturer");
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
