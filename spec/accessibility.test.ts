import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { expect, inject, it } from "vitest";
import { newBrowserCookie } from "./test-helpers.ts";

// axe-core in jsdom: checks DOM/ARIA structure and semantics (missing
// labels, invalid ARIA attributes, heading order, landmark structure) —
// real violations a browser's own axe run would also catch, just not
// anything geometry-dependent (colour contrast, real layout, genuine
// keyboard-driven tab order). Those stay manual, hand-verified checks — see
// CLAUDE.md and the Phase 5 plan for why Playwright (which could check
// those) was ruled out: it needs a Chromium-install step in the shipped CI
// workflow, which CLAUDE.md forbids outright, not just "ask first."
const baseUrl = inject("baseUrl");
const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

interface AxeViolation {
  id: string;
  impact: string | null;
  description: string;
  nodes: { html: string }[];
}

async function checkAccessibility(html: string): Promise<AxeViolation[]> {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: baseUrl });
  dom.window.eval(axeSource);
  const results = (await dom.window.axe.run(dom.window.document)) as { violations: AxeViolation[] };
  return results.violations;
}

function describeViolations(violations: AxeViolation[]): string {
  return violations
    .map((v) => `${v.id} (${v.impact}): ${v.description}\n  ${v.nodes.map((n) => n.html).join("\n  ")}`)
    .join("\n\n");
}

it("the home page has no axe violations", async () => {
  const html = await (await fetch(new URL("/", baseUrl))).text();
  const violations = await checkAccessibility(html);
  expect(violations, describeViolations(violations)).toEqual([]);
});

it("/readme/ has no axe violations", async () => {
  const html = await (await fetch(new URL("/readme/", baseUrl))).text();
  const violations = await checkAccessibility(html);
  expect(violations, describeViolations(violations)).toEqual([]);
});

it("the demo lecture page has no axe violations, on the live slide and while browsing", async () => {
  const cookie = await newBrowserCookie("demo");

  const liveHtml = await (await fetch(new URL("/l/demo", baseUrl), { headers: { cookie } })).text();
  const liveViolations = await checkAccessibility(liveHtml);
  expect(liveViolations, describeViolations(liveViolations)).toEqual([]);

  // A different slide and deck, since browsing renders different content
  // (the diagram slides in particular, with their inline SVG) — worth
  // checking on its own rather than assuming the live slide's markup
  // generalizes.
  const browsingHtml = await (
    await fetch(new URL("/l/demo?deck=week-6&slide=9", baseUrl), { headers: { cookie } })
  ).text();
  const browsingViolations = await checkAccessibility(browsingHtml);
  expect(browsingViolations, describeViolations(browsingViolations)).toEqual([]);
});

it("the demo lecture page has no axe violations once a tap is live (reasons, said-you're-lost line, note form shown)", async () => {
  const cookie = await newBrowserCookie("demo");
  await fetch(new URL("/l/demo/tap", baseUrl), {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: "deck=week-4&slide=1",
  });
  const html = await (await fetch(new URL("/l/demo", baseUrl), { headers: { cookie } })).text();
  const violations = await checkAccessibility(html);
  expect(violations, describeViolations(violations)).toEqual([]);
});

it("the lecturer login form has no axe violations", async () => {
  const cookie = await newBrowserCookie("demo");
  const html = await (await fetch(new URL("/l/demo/lecturer", baseUrl), { headers: { cookie } })).text();
  const violations = await checkAccessibility(html);
  expect(violations, describeViolations(violations)).toEqual([]);
});

it("the lecturer dashboard has no axe violations once logged in, with bars/reasons/notes rendered", async () => {
  const cookie = await newBrowserCookie("demo");
  const loginRes = await fetch(new URL("/l/demo/lecturer", baseUrl), {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: "code=DEMO",
    redirect: "manual",
  });
  const lsessCookie = loginRes.headers
    .getSetCookie()
    .find((c) => c.startsWith("lsess="))
    ?.split(";")[0];
  expect(lsessCookie).toBeDefined();

  const html = await (
    await fetch(new URL("/l/demo/lecturer", baseUrl), { headers: { cookie: `${cookie}; ${lsessCookie}` } })
  ).text();
  const violations = await checkAccessibility(html);
  expect(violations, describeViolations(violations)).toEqual([]);
});

it("the /new form has no axe violations, including its error state", async () => {
  const cookie = await newBrowserCookie("demo");
  const html = await (await fetch(new URL("/new", baseUrl), { headers: { cookie } })).text();
  const violations = await checkAccessibility(html);
  expect(violations, describeViolations(violations)).toEqual([]);

  const errorRes = await fetch(new URL("/new", baseUrl), {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: "title=",
  });
  const errorHtml = await errorRes.text();
  const errorViolations = await checkAccessibility(errorHtml);
  expect(errorViolations, describeViolations(errorViolations)).toEqual([]);
});

it("a created lecture's lecturer dashboard (Previous/Next controls) has no axe violations", async () => {
  const createRes = await fetch(new URL("/new", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "title=Accessibility+test+lecture",
  });
  const createHtml = await createRes.text();
  const id = createHtml.match(/Student link: <a href="\/l\/([a-f0-9]+)"/)?.[1];
  const code = createHtml.match(/<strong>([A-Z0-9]+)<\/strong>/)?.[1];
  expect(id).toBeDefined();
  expect(code).toBeDefined();

  const cookie = await newBrowserCookie(id!);
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

  const html = await (
    await fetch(new URL(`/l/${id}/lecturer`, baseUrl), { headers: { cookie: `${cookie}; ${lsessCookie}` } })
  ).text();
  const violations = await checkAccessibility(html);
  expect(violations, describeViolations(violations)).toEqual([]);
});

// jsdom can't compute focus rings, so this checks the rule is shipped on
// every page: without it, a reset or a browser default could leave keyboard
// users with no visible focus on the tap button or reason buttons. The CSS
// moved from an inline <style> to /style.css in Phase 5, so "shipped on
// every page" now means every page links the stylesheet and the stylesheet
// carries the rule — the same rule, checked against what's actually served.
it("every page styles :focus-visible with a visible outline", async () => {
  const cookie = await newBrowserCookie("demo");
  for (const path of ["/", "/readme/", "/l/demo", "/new", "/l/demo/lecturer"]) {
    const html = await (await fetch(new URL(path, baseUrl), { headers: { cookie } })).text();
    expect(html, path).toContain('<link rel="stylesheet" href="/style.css">');
  }
  const css = await (await fetch(new URL("/style.css", baseUrl))).text();
  expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*3px solid/);
});
