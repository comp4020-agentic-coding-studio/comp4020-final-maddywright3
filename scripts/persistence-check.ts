#!/usr/bin/env node
// What markers check, against the live app: does a lecture's data survive the
// machine stopping and starting again, and a redeploy? Not part of pnpm check;
// run with `pnpm persist`. Uses its own lecture, titled "Persistence check",
// never the demo.
//
//   APP_URL=https://comp4020-final-maddywright3.fly.dev pnpm persist
//
// Five browsers (a created lecture's min_present is 5) each tap the same two
// slides, pick the same reason on both and leave a note on both, so bars,
// reason counts and notes all clear the threshold. The script records every
// view, closes everything, waits for Fly to stop the machine, loads it all
// again and compares. Then it asks before redeploying, and compares again.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { JSDOM } from "jsdom";
import { chromium } from "playwright";
import { App, BROWSERS, SLIDES } from "./persistence-app.ts";
import type { Lecture } from "./persistence-app.ts";

const baseUrl = process.env.APP_URL ?? "https://comp4020-final-maddywright3.fly.dev";
const flyApp = process.env.FLY_APP ?? "comp4020-final-maddywright3";
// PERSIST_DRY_RUN=1 checks the script itself against a local app: no Fly,
// no redeploy, the second snapshot taken straight after the first, and
// output kept out of docs/.
const dryRun = process.env.PERSIST_DRY_RUN === "1";
const outRoot = dryRun ? (process.env.PERSIST_OUT ?? "/tmp/persistence-dry-run") : "docs";
const shotDir = `${outRoot}/screenshots/persistence`;
const reportPath = `${outRoot}/persistence-report.md`;
const POLL_MS = 60_000;
const GIVE_UP_MS = 20 * 60_000;

// Fields that are meant to differ between snapshots: nobody is connected after
// a stop, and a tap stops counting as live after its window.
const EXPECTED_TO_CHANGE = new Set(["present", "shown", "live", "youAreCounted", "liveForMs", "topReason"]);

const app = new App(baseUrl);
const log = (line: string) => console.log(`[${new Date().toISOString()}] ${line}`);

export interface Snapshot {
  label: string;
  at: string;
  students: { stream: unknown; pageText: string }[];
  lecturer: { stream: unknown; pageText: string };
}

function visibleText(html: string): string {
  const doc = new JSDOM(html).window.document;
  doc.querySelectorAll("script, style").forEach((el) => el.remove());
  return (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
}

async function snapshot(label: string, lecture: Lecture, cookies: string[]): Promise<Snapshot> {
  const students = [];
  for (const cookie of cookies) {
    const page = await app.page(app.studentPagePath(lecture.id), cookie);
    if (page.status !== 200) throw new Error(`student page -> ${page.status}`);
    const stream = await app.firstFrame(app.studentStreamPath(lecture.id), cookie);
    students.push({ stream, pageText: visibleText(page.html) });
  }
  const page = await app.page(app.lecturerPagePath(lecture.id), lecture.lecturerCookie);
  if (page.status !== 200) throw new Error(`lecturer page -> ${page.status}`);
  const stream = await app.firstFrame(app.lecturerStreamPath(lecture.id), lecture.lecturerCookie);
  return { label, at: new Date().toISOString(), students, lecturer: { stream, pageText: visibleText(page.html) } };
}

async function screenshots(label: string, lecture: Lecture, cookies: string[]): Promise<string[]> {
  mkdirSync(shotDir, { recursive: true });
  const browser = await chromium.launch();
  const files: string[] = [];
  try {
    const shoot = async (who: string, path: string, cookie: string) => {
      const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
      const origin = new URL(baseUrl);
      await context.addCookies(
        cookie.split("; ").map((pair) => {
          const [name, ...rest] = pair.split("=");
          return { name, value: rest.join("="), domain: origin.hostname, path: "/", secure: origin.protocol === "https:" };
        }),
      );
      const page = await context.newPage();
      await page.goto(new URL(path, baseUrl).toString());
      await page.waitForTimeout(1500);
      const file = `${shotDir}/${label}-${who}.png`;
      await page.screenshot({ path: file, fullPage: true });
      files.push(file);
      await context.close();
    };
    await shoot("student-1", app.studentPagePath(lecture.id), cookies[0]);
    await shoot("lecturer", app.lecturerPagePath(lecture.id), lecture.lecturerCookie);
  } finally {
    await browser.close();
  }
  return files;
}

interface Diff {
  where: string;
  before: unknown;
  after: unknown;
  expected: boolean;
}

// Arrays of records with an id (notes) are matched by id, so one lost note
// is one line in the report, not a shift of every note after it.
function byId(list: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(list) || !list.every((x) => typeof x === "object" && x !== null && "id" in x)) return undefined;
  return Object.fromEntries(list.map((x) => [`id${(x as { id: unknown }).id}`, x]));
}

function compare(where: string, a: unknown, b: unknown, out: Diff[]): void {
  const aById = byId(a);
  const bById = byId(b);
  if (aById && bById) {
    for (const key of new Set([...Object.keys(aById), ...Object.keys(bById)])) {
      if (!(key in bById)) out.push({ where: `${where}.${key}`, before: aById[key], after: "missing", expected: false });
      else if (!(key in aById)) out.push({ where: `${where}.${key}`, before: "missing", after: bById[key], expected: false });
      else compare(`${where}.${key}`, aById[key], bById[key], out);
    }
    return;
  }
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      compare(`${where}.${key}`, (a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], out);
    }
    return;
  }
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  const field = where.split(".").at(-1)!;
  out.push({ where, before: a, after: b, expected: EXPECTED_TO_CHANGE.has(field) });
}

export function diffSnapshots(before: Snapshot, after: Snapshot): Diff[] {
  const out: Diff[] = [];
  before.students.forEach((s, i) => {
    compare(`browser${i + 1}.stream`, s.stream, after.students[i].stream, out);
    compare(`browser${i + 1}.pageText`, s.pageText, after.students[i].pageText, out);
  });
  compare("lecturer.stream", before.lecturer.stream, after.lecturer.stream, out);
  compare("lecturer.pageText", before.lecturer.pageText, after.lecturer.pageText, out);
  return out;
}

function machineStates(): { id: string; state: string }[] {
  const json = execFileSync("flyctl", ["machine", "list", "-a", flyApp, "--json"], { encoding: "utf8" });
  return (JSON.parse(json) as { id: string; state: string }[]).map((m) => ({ id: m.id, state: m.state }));
}

async function waitForStop(): Promise<{ stoppedAt: string } | { gaveUpAt: string }> {
  console.log("\nREMINDER: any open tab on the live site keeps the machine running. Close them all now.\n");
  const start = Date.now();
  for (;;) {
    const machines = machineStates();
    log(`machines: ${machines.map((m) => `${m.id} ${m.state}`).join(", ")}`);
    if (machines.length > 0 && machines.every((m) => m.state === "stopped")) return { stoppedAt: new Date().toISOString() };
    if (Date.now() - start >= GIVE_UP_MS) return { gaveUpAt: new Date().toISOString() };
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

async function ask(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return answer.trim().toLowerCase() === "y";
}

function diffTable(diffs: Diff[]): string {
  if (diffs.length === 0) return "No field changed.\n";
  const rows = diffs.map(
    (d) =>
      `| ${d.where} | ${JSON.stringify(d.before)?.slice(0, 80)} | ${JSON.stringify(d.after)?.slice(0, 80)} | ${d.expected ? "expected" : "UNEXPECTED"} |`,
  );
  return ["| Field | Before | After | |", "|---|---|---|---|", ...rows].join("\n") + "\n";
}

async function main(): Promise<void> {
  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  log(`persistence check against ${baseUrl}, commit ${commit}`);

  const lecture = await app.createLecture("Persistence check");
  log(`created lecture ${lecture.id}`);
  const cookies = await Promise.all(Array.from({ length: BROWSERS }, () => app.newBrowser(lecture.id)));

  for (const [s, slide] of SLIDES.entries()) {
    if (s > 0) await app.nextSlide(lecture);
    for (const [b, cookie] of cookies.entries()) {
      await app.visitSlide(lecture.id, cookie, slide, `Persistence check: browser ${b + 1}, slide ${slide}`);
    }
    log(`slide ${slide}: ${BROWSERS} browsers tapped, chose a reason, left a note`);
  }

  const before = await snapshot("before", lecture, cookies);
  const shotsBefore = await screenshots("1-before", lecture, cookies);
  mkdirSync(outRoot, { recursive: true });
  writeFileSync(`${shotDir}/before.json`, JSON.stringify(before, null, 2));
  log("recorded every view; all streams and pages are closed");

  const stop = dryRun ? { stoppedAt: "dry run: no stop" } : await waitForStop();
  let afterStop: Snapshot | undefined;
  let startedAt: string | undefined;
  if ("stoppedAt" in stop) {
    log(`machine stopped by ${stop.stoppedAt}; loading again starts it`);
    afterStop = await snapshot("after-stop", lecture, cookies);
    startedAt = afterStop.at;
    await screenshots("2-after-stop", lecture, cookies);
    writeFileSync(`${shotDir}/after-stop.json`, JSON.stringify(afterStop, null, 2));
  } else {
    log(`gave up at ${stop.gaveUpAt}: the machine never stopped`);
  }

  let afterRedeploy: Snapshot | undefined;
  if (!dryRun && (await ask("Redeploy now with flyctl deploy, then compare again?"))) {
    execFileSync("flyctl", ["deploy", "--remote-only", "--ha=false", "-a", flyApp], { stdio: "inherit" });
    afterRedeploy = await snapshot("after-redeploy", lecture, cookies);
    await screenshots("3-after-redeploy", lecture, cookies);
    writeFileSync(`${shotDir}/after-redeploy.json`, JSON.stringify(afterRedeploy, null, 2));
  }

  const stopDiffs = afterStop ? diffSnapshots(before, afterStop) : [];
  const redeployDiffs = afterRedeploy ? diffSnapshots(before, afterRedeploy) : [];
  const unexpected = [...stopDiffs, ...redeployDiffs].filter((d) => !d.expected);

  const report = `# Persistence report

Ran on commit \`${commit}\` against ${baseUrl}, lecture \`${lecture.id}\` ("Persistence check").
${BROWSERS} browsers each tapped slides ${SLIDES.join(" and ")}, chose the same reason and left a note on both.

| Event | Time (UTC) |
|---|---|
| Recorded before | ${before.at} |
| Machine seen stopped | ${"stoppedAt" in stop ? stop.stoppedAt : `never; gave up at ${stop.gaveUpAt}`} |
| Machine started by the next request | ${startedAt ?? "not reached"} |
| Redeployed and compared | ${afterRedeploy?.at ?? "not run"} |

Fields marked expected are meant to change: nobody is connected after a stop (present, shown) and taps stop counting as live (live, youAreCounted, liveForMs, topReason).

## After the machine stopped and started

${afterStop ? diffTable(stopDiffs) : "Not reached.\n"}
## After a redeploy

${afterRedeploy ? diffTable(redeployDiffs) : "Not run.\n"}
## Result

${unexpected.length === 0 ? "Nothing that should persist changed." : `${unexpected.length} field(s) changed that should have persisted.`}

Screenshots: ${shotsBefore.map((f) => f.replace("docs/", "")).join(", ")} and the matching after-stop and after-redeploy files in docs/screenshots/persistence/.
`;
  writeFileSync(reportPath, report);
  log(`wrote ${reportPath}`);
  if (unexpected.length > 0) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
