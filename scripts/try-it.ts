#!/usr/bin/env node
// Follows the README's "Try it" steps the way a marker does, with only the
// URL: two fresh Chrome profiles (separate browser contexts, no shared
// cookies), starting from /readme/. Each step is checked against what the
// README says will happen, with a screenshot. Not part of pnpm check: run
// with `pnpm try-it` against a running app.
//
//   APP_URL=http://localhost:8080 pnpm try-it
//
// Writes docs/try-it-report.md and docs/screenshots/try-it/. Step 4 creates
// one lecture titled "Try it check"; nothing else is created, and the demo
// only gets the taps the README itself asks for.

import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import type { BrowserContext, Page } from "playwright";

const baseUrl = process.env.APP_URL ?? "http://localhost:8080";
const outRoot = process.env.TRY_IT_OUT ?? "docs";
const shotDir = `${outRoot}/screenshots/try-it`;

interface Step {
  step: string;
  readme: string;
  checks: { what: string; ok: boolean; detail: string }[];
  screenshots: string[];
}

const steps: Step[] = [];
const problems: string[] = [];

function watch(page: Page, who: string): void {
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`${who}: console error: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`${who}: page error: ${e.message}`));
  page.on("request", (r) => {
    const u = new URL(r.url());
    if ((u.protocol === "http:" || u.protocol === "https:") && u.origin !== new URL(baseUrl).origin) {
      problems.push(`${who}: third-party request ${r.url()}`);
    }
  });
}

async function shot(page: Page, name: string, step: Step): Promise<void> {
  const file = `${shotDir}/${name}.png`;
  await page.screenshot({ path: file, fullPage: true });
  step.screenshots.push(file);
}

function check(step: Step, what: string, ok: boolean, detail = ""): void {
  step.checks.push({ what, ok, detail });
}

async function text(page: Page, selector: string): Promise<string> {
  return ((await page.locator(selector).first().textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
}

async function main(): Promise<void> {
  mkdirSync(shotDir, { recursive: true });
  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  const browser = await chromium.launch();
  const profiles: BrowserContext[] = [];
  const newProfile = async (viewport = { width: 1280, height: 900 }) => {
    const context = await browser.newContext({ viewport });
    profiles.push(context);
    return context;
  };

  try {
    // Step 0: a marker starts at /readme/ with only the URL.
    const s0: Step = { step: "0", readme: "A marker starts at /readme/ with only the URL.", checks: [], screenshots: [] };
    steps.push(s0);
    const profileA = await newProfile();
    const a = await profileA.newPage();
    watch(a, "profile A");
    const readmeRes = await a.goto(new URL("/readme/", baseUrl).toString());
    check(s0, "/readme/ answers 200", readmeRes?.status() === 200, String(readmeRes?.status()));
    const demoLink = a.locator('a[href="/l/demo"]').first();
    check(s0, "/readme/ links to /l/demo", (await demoLink.count()) > 0);
    await shot(a, "0-readme", s0);

    // Step 1: open /l/demo in two profiles.
    const s1: Step = {
      step: "1",
      readme: 'Open /l/demo in Chrome and again in an incognito window. Each window is one person, and the demo needs two.',
      checks: [],
      screenshots: [],
    };
    steps.push(s1);
    await demoLink.click();
    await a.waitForURL(/\/l\/demo/);
    const profileB = await newProfile({ width: 390, height: 844 });
    const b = await profileB.newPage();
    watch(b, "profile B");
    await b.goto(new URL("/l/demo", baseUrl).toString());
    await a.waitForTimeout(1500);
    const gaugeA = await text(a, "#gauge");
    const gaugeB = await text(b, "#gauge");
    check(s1, "both pages render the tap button", (await a.locator("#tap-button").count()) > 0 && (await b.locator("#tap-button").count()) > 0);
    check(s1, "with two people the gauge shows a count, not 'Waiting'", !/waiting/i.test(gaugeA) && !/waiting/i.test(gaugeB), `A: "${gaugeA}" / B: "${gaugeB}"`);
    await shot(a, "1-profile-a", s1);
    await shot(b, "1-profile-b-phone", s1);

    // Step 2: tap in one, both update within a second, fades after 20 s.
    const s2: Step = {
      step: "2",
      readme: 'Press "I\'m lost" in one. Both update within a second. A tap counts for 20 seconds in the demo.',
      checks: [],
      screenshots: [],
    };
    steps.push(s2);
    const beforeB = await text(b, "#gauge");
    const tappedAt = Date.now();
    await a.locator("#tap-button").click();
    const reached = await b
      .waitForFunction((before) => (document.getElementById("gauge")?.textContent ?? "").replace(/\s+/g, " ").trim() !== before, beforeB, { timeout: 3000 })
      .then(() => Date.now() - tappedAt)
      .catch(() => -1);
    check(s2, "the other profile's gauge changes within a second", reached >= 0 && reached <= 1000, `${reached} ms`);
    await shot(a, "2-after-tap-a", s2);
    await shot(b, "2-after-tap-b-phone", s2);
    const afterTapB = await text(b, "#gauge");
    const faded = await b
      .waitForFunction((after) => (document.getElementById("gauge")?.textContent ?? "").replace(/\s+/g, " ").trim() !== after, afterTapB, { timeout: 70_000 })
      .then(() => Date.now() - tappedAt)
      .catch(() => -1);
    check(s2, "the tap stops counting after about 20 s (README says 20 in the demo)", faded >= 19_000 && faded <= 25_000, `${faded} ms`);

    // Step 3: lecturer view with DEMO, lecturer isn't counted.
    const s3: Step = {
      step: "3",
      readme: "With both still open, open /l/demo/lecturer in a new tab and enter DEMO. The lecturer isn't counted as a person.",
      checks: [],
      screenshots: [],
    };
    steps.push(s3);
    const presentBefore = await text(b, "#gauge");
    const lecturer = await profileA.newPage();
    watch(lecturer, "lecturer tab");
    await lecturer.goto(new URL("/l/demo/lecturer", baseUrl).toString());
    const codeInput = lecturer.locator('input[name="code"]');
    check(s3, "the lecturer page asks for a code", (await codeInput.count()) > 0);
    await codeInput.fill("DEMO");
    await codeInput.press("Enter");
    await lecturer.waitForLoadState("networkidle").catch(() => {});
    check(s3, "DEMO opens the lecturer view", !(await lecturer.locator('input[name="code"]').count()), lecturer.url());
    await lecturer.waitForTimeout(1500);
    const presentAfter = await text(b, "#gauge");
    check(s3, "the students' count doesn't change when the lecturer joins", presentBefore === presentAfter, `"${presentBefore}" -> "${presentAfter}"`);
    await shot(lecturer, "3-lecturer", s3);

    // Step 4: start your own lecture; it waits for five people.
    const s4: Step = { step: "4", readme: "Start your own lecture. A real lecture waits for five people.", checks: [], screenshots: [] };
    steps.push(s4);
    const profileC = await newProfile();
    const c = await profileC.newPage();
    watch(c, "profile C");
    await c.goto(new URL("/new", baseUrl).toString());
    await c.locator('input[name="title"]').fill("Try it check");
    await c.locator('form[action="/new"] button[type="submit"], form[action="/new"] input[type="submit"]').first().click();
    await c.waitForLoadState("networkidle").catch(() => {});
    const studentHref = await c.locator('a[href^="/l/"]').filter({ hasText: /\/l\/[a-f0-9]+/ }).first().getAttribute("href").catch(() => null);
    check(s4, "/new creates a lecture and shows its student link", Boolean(studentHref), String(studentHref));
    await shot(c, "4-created", s4);
    if (studentHref) {
      await c.goto(new URL(studentHref, baseUrl).toString());
      await c.waitForTimeout(1000);
      const g = await text(c, "#gauge");
      check(s4, "alone, the new lecture waits for more people (threshold five)", /waiting for 4 more/i.test(g), `"${g}"`);
      await shot(c, "4-new-lecture-alone", s4);
    }
  } finally {
    for (const p of profiles) await p.close();
    await browser.close();
  }

  const failed = steps.flatMap((s) => s.checks.filter((c) => !c.ok).map((c) => `step ${s.step}: ${c.what}`));
  const lines = [
    "# Try it, from the URL alone",
    "",
    `Ran on commit \`${commit}\` against ${baseUrl}, ${new Date().toISOString()}. Two fresh Chrome profiles (separate contexts, no shared cookies), plus a third for step 4. Profile B uses a 390x844 phone viewport.`,
    "",
  ];
  for (const s of steps) {
    lines.push(`## Step ${s.step}`, "", `> ${s.readme}`, "", "| Check | Result | Detail |", "|---|---|---|");
    for (const c of s.checks) lines.push(`| ${c.what} | ${c.ok ? "pass" : "FAIL"} | ${c.detail.replace(/\|/g, "/")} |`);
    lines.push("", `Screenshots: ${s.screenshots.map((f) => f.replace(`${outRoot}/`, "")).join(", ")}`, "");
  }
  lines.push("## Console, page errors and third-party requests", "", problems.length ? problems.map((p) => `- ${p}`).join("\n") : "None.", "");
  lines.push("## Steps that need changes", "", failed.length ? failed.map((f) => `- ${f}`).join("\n") : "None: every step worked as written.", "");
  writeFileSync(`${outRoot}/try-it-report.md`, lines.join("\n"));
  console.log(lines.join("\n"));
  if (failed.length || problems.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
