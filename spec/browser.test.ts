import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

// What jsdom can't see: real layout, colour contrast, keyboard focus, a
// throttled connection, two people at once. Runs in a real Chromium.
const baseUrl = inject("baseUrl");
const origin = new URL(baseUrl).origin;
const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1920, height: 1080 },
];
const PAGES = ["/", "/readme/", "/l/demo", "/l/demo/lecturer", "/l/demo/lecturer?projector=1", "/new", "/no-such-page"];
const COLOUR_SCHEMES = ["light", "dark"] as const;
// The header's nav, in order, on every page.
const NAV = [
  { text: "Home", href: "/" },
  { text: "Join the demo", href: "/l/demo" },
  { text: "Lecturer view", href: "/l/demo/lecturer" },
  { text: "Create a lecture", href: "/new" },
  { text: "How it works", href: "/readme/" },
];

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});

interface Watched {
  context: BrowserContext;
  page: Page;
  problems: string[];
}

// Every console error, failed request and off-origin request is a test
// failure, whatever the test is checking. A page can look fine and throw.
async function openWatched(
  width: number,
  height: number,
  expectedNotFound?: string,
  options: { colorScheme?: "light" | "dark"; javaScriptEnabled?: boolean } = {},
): Promise<Watched> {
  const context = await browser.newContext({ viewport: { width, height }, ...options });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(`console error: ${msg.text()}`);
  });
  page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
  // A blocked script or load under the Content-Security-Policy, named
  // rather than only showing up as a console error.
  await page.exposeFunction("__reportCspViolation", (detail: string) => problems.push(`CSP violation: ${detail}`));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      (window as unknown as { __reportCspViolation: (d: string) => void }).__reportCspViolation(
        `${e.violatedDirective} blocked ${e.blockedURI || "inline"}`,
      );
    });
  });
  page.on("request", (req) => {
    const url = new URL(req.url());
    if ((url.protocol === "http:" || url.protocol === "https:") && url.origin !== origin) {
      problems.push(`third-party request: ${req.url()}`);
    }
  });
  page.on("requestfailed", (req) => {
    // Leaving a page cancels its open event stream; that's the browser
    // closing a stream on purpose, not a request that failed.
    const aborted = req.failure()?.errorText === "net::ERR_ABORTED";
    if (aborted && new URL(req.url()).pathname.endsWith("/events")) return;
    problems.push(`failed request: ${req.url()} ${req.failure()?.errorText}`);
  });
  page.on("console", (msg) => {
    // Chromium logs the document's own 404 as a console error; that status
    // is the 404 page doing its job, checked separately below.
    if (msg.type() === "error" && msg.location().url === expectedNotFound) {
      const i = problems.lastIndexOf(`console error: ${msg.text()}`);
      if (i !== -1) problems.splice(i, 1);
    }
  });
  page.on("response", (res) => {
    if (res.status() < 400) return;
    if (res.url() === expectedNotFound && res.request().isNavigationRequest() && res.status() === 404) return;
    problems.push(`HTTP ${res.status()}: ${res.url()}`);
  });
  return { context, page, problems };
}

async function logInAsDemoLecturer(context: BrowserContext): Promise<void> {
  await context.request.get(new URL("/l/demo", baseUrl).toString());
  const res = await context.request.post(new URL("/l/demo/lecturer", baseUrl).toString(), {
    form: { code: "DEMO" },
    maxRedirects: 0,
  });
  expect(res.status()).toBe(303);
}

async function axeViolations(page: Page): Promise<string[]> {
  // The page's Content-Security-Policy rightly blocks an injected <script>
  // tag (addScriptTag), so axe is evaluated through DevTools instead, which
  // the page's policy doesn't govern. The policy itself is never relaxed.
  await page.evaluate(axeSource);
  const violations = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: () => Promise<{ violations: { id: string; nodes: { html: string }[] }[] }> } }).axe;
    const results = await axe.run();
    return results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(" | ")}`);
  });
  return violations;
}

async function hasHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
}

async function focusedIsVisible(page: Page): Promise<{ tag: string; text: string; visible: boolean; href: string | null }> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return { tag: "body", text: "", visible: false, href: null };
    const style = getComputedStyle(el);
    const visible = el.matches(":focus-visible") && style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0;
    return { tag: el.tagName, text: (el.textContent ?? "").trim(), visible, href: el.getAttribute("href") };
  });
}

// Tabs until the focused element matches, checking the focus ring is
// visible at every stop on the way. Shift+Tab when the target is earlier in
// the page, as a keyboard user would.
async function tabTo(
  page: Page,
  matches: (f: { tag: string; text: string; href: string | null }) => boolean,
  maxTabs = 60,
  key: "Tab" | "Shift+Tab" = "Tab",
): Promise<void> {
  for (let i = 0; i < maxTabs; i++) {
    await page.keyboard.press(key);
    const focused = await focusedIsVisible(page);
    expect(focused.visible, `focus not visible on ${focused.tag} "${focused.text}"`).toBe(true);
    if (matches(focused)) return;
  }
  throw new Error("never reached the target by Tab");
}

async function yourTapCount(page: Page): Promise<number> {
  const text = (await page.locator("#your-count").textContent()) ?? "";
  return Number(text.match(/(\d+) time/)?.[1] ?? NaN);
}

describe.each(VIEWPORTS)("at $width x $height", ({ width, height }) => {
  it.each(PAGES)("%s has no axe violations (contrast included), no horizontal scroll, and no errors", async (path) => {
    const url = new URL(path, baseUrl).toString();
    const w = await openWatched(width, height, path === "/no-such-page" ? url : undefined);
    try {
      if (path.startsWith("/l/demo/lecturer")) await logInAsDemoLecturer(w.context);
      const res = await w.page.goto(url);
      expect(res?.status()).toBe(path === "/no-such-page" ? 404 : 200);
      await w.page.waitForLoadState("networkidle").catch(() => {});
      expect(await axeViolations(w.page)).toEqual([]);
      expect(await hasHorizontalScroll(w.page)).toBe(false);
      expect(w.problems).toEqual([]);
    } finally {
      await w.context.close();
    }
  }, 30_000);

  // The same sweep in the dark theme, with contrast: every colour is
  // redefined there, so passing in light says nothing about dark.
  it.each(PAGES)("%s in the dark theme has no axe violations (contrast included) and no horizontal scroll", async (path) => {
    const url = new URL(path, baseUrl).toString();
    const w = await openWatched(width, height, path === "/no-such-page" ? url : undefined, { colorScheme: "dark" });
    try {
      if (path.startsWith("/l/demo/lecturer")) await logInAsDemoLecturer(w.context);
      await w.page.goto(url);
      await w.page.waitForLoadState("networkidle").catch(() => {});
      expect(await w.page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(true);
      expect(await axeViolations(w.page)).toEqual([]);
      expect(await hasHorizontalScroll(w.page)).toBe(false);
      expect(w.problems).toEqual([]);
    } finally {
      await w.context.close();
    }
  }, 30_000);

  it("the header nav is reached by Tab, in order, with a visible focus ring at every stop", async () => {
    const w = await openWatched(width, height);
    const { page } = w;
    try {
      await page.goto(new URL("/readme/", baseUrl).toString());
      // Skip link, then the app name (home), then the nav in order.
      await tabTo(page, (f) => f.tag === "A" && f.text === "Skip to content", 1);
      await tabTo(page, (f) => f.tag === "A" && f.text === "Hands Down" && f.href === "/", 1);
      for (const link of NAV) {
        await tabTo(page, (f) => f.tag === "A" && f.text === link.text && f.href === link.href, 1);
        // Every nav link is on screen when it has focus: none is clipped
        // or pushed off the side at 390px.
        const box = await page.evaluate(() => {
          const r = document.activeElement!.getBoundingClientRect();
          return { left: r.left, right: r.right, height: r.height };
        });
        expect(box.left, link.text).toBeGreaterThanOrEqual(0);
        expect(box.right, link.text).toBeLessThanOrEqual(width);
        expect(box.height, link.text).toBeGreaterThanOrEqual(44);
      }
      // Enter follows the focused link: the last one is How it works.
      await page.keyboard.press("Enter");
      await page.waitForURL(new URL("/readme/", baseUrl).toString());
      expect(w.problems).toEqual([]);
    } finally {
      await w.context.close();
    }
  }, 30_000);

  it("projector mode turns on and off by its link, with and without JavaScript, and scales type 1.5x", async () => {
    for (const javaScriptEnabled of [true, false]) {
      const w = await openWatched(width, height, undefined, { javaScriptEnabled });
      const { page } = w;
      try {
        await logInAsDemoLecturer(w.context);
        await page.goto(new URL("/l/demo/lecturer", baseUrl).toString());
        const main = page.locator("main");
        const fontSize = (): Promise<number> => main.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
        const normal = await fontSize();
        expect(await main.getAttribute("class")).toBe("lecturer");

        await page.locator("#projector-link").click();
        await page.waitForURL(/\?projector=1$/);
        expect(await main.getAttribute("class")).toBe("lecturer projector");
        expect(await page.locator("#projector-link").textContent()).toBe("Leave projector mode");
        expect(await fontSize()).toBeCloseTo(normal * 1.5, 0);
        expect(await hasHorizontalScroll(page)).toBe(false);

        await page.locator("#projector-link").click();
        await page.waitForURL(/\/lecturer$/);
        expect(await main.getAttribute("class")).toBe("lecturer");
        expect(await page.locator("#projector-link").textContent()).toBe("Projector mode");
        expect(await fontSize()).toBeCloseTo(normal, 1);
        expect(w.problems).toEqual([]);
      } finally {
        await w.context.close();
      }
    }
  }, 30_000);

  it("the lecturer layout: the live slide group, then tiles, 2x2 graph slots beside the notes column, activity log under both", async () => {
    const w = await openWatched(width, height);
    const { page } = w;
    try {
      await logInAsDemoLecturer(w.context);
      await page.goto(new URL("/l/demo/lecturer", baseUrl).toString());
      const box = async (selector: string) => (await page.locator(selector).boundingBox())!;
      const [liveNow, live, tiles, lost, reasons, helped, resolved, notes, log] = await Promise.all(
        ["#live-now", "#live-group", ".stat-tiles", "#graph-lost", "#graph-reasons", "#graph-helped", "#graph-resolved", "#notes", "#activity-log"].map(box),
      );
      // Live now at the top, then the live slide group, then the whole lecture.
      expect(live.y).toBeGreaterThan(liveNow.y + liveNow.height - 1);
      expect(tiles.y).toBeGreaterThan(live.y + live.height - 1);
      for (const b of [lost, reasons, helped, resolved, notes]) expect(b.y).toBeGreaterThan(tiles.y + tiles.height - 1);
      for (const b of [lost, reasons, helped, resolved, notes]) expect(log.y).toBeGreaterThanOrEqual(b.y + b.height);
      if (width >= 1200) {
        // 2x2: lost beside reasons, helped beside resolved, one row down.
        expect(Math.abs(lost.y - reasons.y)).toBeLessThan(1);
        expect(reasons.x).toBeGreaterThan(lost.x);
        expect(Math.abs(helped.x - lost.x)).toBeLessThan(1);
        expect(helped.y).toBeGreaterThan(lost.y);
        expect(Math.abs(resolved.x - reasons.x)).toBeLessThan(1);
        // The notes column is on the right; the log spans both.
        expect(notes.x).toBeGreaterThan(reasons.x + reasons.width - 1);
        expect(log.width).toBeGreaterThan(notes.x + notes.width - lost.x - 2);
        // About 1200px wide, at normal type.
        expect(log.width).toBeLessThanOrEqual(1200);
        expect(await page.locator("main").evaluate((el) => getComputedStyle(el).fontSize)).toBe("18px");
      } else {
        // One column: every block starts at the same left edge.
        for (const b of [reasons, helped, resolved, notes, log]) expect(Math.abs(b.x - lost.x)).toBeLessThan(1);
      }
      expect(await hasHorizontalScroll(page)).toBe(false);
      expect(w.problems).toEqual([]);
    } finally {
      await w.context.close();
    }
  }, 30_000);

  // A created lecture's lecturer view: Live now, the runs box with an
  // earlier run, both groups and a ranking with entries, in light and dark,
  // and its earlier run's read-only view.
  it.each(COLOUR_SCHEMES)("a created lecture's lecturer view with two runs, %s: no axe violations, no horizontal scroll", async (colorScheme) => {
    const w = await openWatched(width, height, undefined, { colorScheme });
    try {
      const request = w.context.request;
      const created = await (await request.post(new URL("/new", baseUrl).toString(), { form: { title: "Runs and ranking", slides: "60", minutes: "60" } })).text();
      const lectureId = created.match(/Student link: <a href="\/l\/([a-f0-9]+)"/)![1];
      const code = created.match(/<strong>([A-Z0-9]+)<\/strong>/)![1];
      await request.post(new URL(`/l/${lectureId}/lecturer`, baseUrl).toString(), { form: { code }, maxRedirects: 0 });
      // Five people lost in run 1, then a fresh run, so the ranking has an entry.
      for (let i = 0; i < 5; i++) {
        const student = await browser.newContext();
        await student.request.get(new URL(`/l/${lectureId}`, baseUrl).toString());
        await student.request.post(new URL(`/l/${lectureId}/tap`, baseUrl).toString(), { form: { slide: "1" }, maxRedirects: 0 });
        await student.close();
      }
      await request.post(new URL(`/l/${lectureId}/lecturer/runs`, baseUrl).toString(), { form: { run: "1" }, maxRedirects: 0 });
      for (const path of [`/l/${lectureId}/lecturer`, `/l/${lectureId}/lecturer?run=1`]) {
        await w.page.goto(new URL(path, baseUrl).toString());
        await w.page.waitForLoadState("networkidle").catch(() => {});
        expect(await w.page.locator("#ranking-list li").count(), path).toBe(1);
        expect(await axeViolations(w.page), path).toEqual([]);
        expect(await hasHorizontalScroll(w.page), path).toBe(false);
      }
      expect(w.problems).toEqual([]);
    } finally {
      await w.context.close();
    }
  }, 30_000);

  it("keyboard only: tap, reason, note, I get it now, arrow keys, Back to live", async () => {
    const w = await openWatched(width, height);
    const { page } = w;
    try {
      await page.goto(new URL("/l/demo", baseUrl).toString());
      const label = page.locator("#slide-label");
      const startLabel = await label.textContent();

      await tabTo(page, (f) => f.tag === "BUTTON" && f.text === "I'm lost");
      await page.keyboard.press("Enter");
      await page.locator("#reasons").waitFor();
      // The tap's live update re-renders around the button: focus must
      // still be somewhere visible, not dropped to <body>.
      expect((await focusedIsVisible(page)).visible, "focus lost after the tap's live update").toBe(true);

      await tabTo(page, (f) => f.tag === "BUTTON" && f.text === "Too fast");
      await page.keyboard.press("Enter");
      expect((await focusedIsVisible(page)).visible, "focus lost after picking a reason").toBe(true);

      await tabTo(page, (f) => f.tag === "TEXTAREA");
      await page.keyboard.type("the bit about the budget");
      await tabTo(page, (f) => f.tag === "BUTTON" && f.text === "Send");
      await page.keyboard.press("Enter");
      await expect.poll(() => page.locator("#note-status").textContent(), { timeout: 2000 }).toBe("Sent");
      expect((await focusedIsVisible(page)).visible, "focus lost after sending the note").toBe(true);

      // In the layout, "I get it now" sits beside the tap button, before the
      // reasons and note, so from Send it's back up the page.
      await tabTo(page, (f) => f.tag === "BUTTON" && f.text === "I get it now", 60, "Shift+Tab");
      await page.keyboard.press("Enter");
      // After "I get it now" the person can undo it: "I'm lost" is offered
      // again on this slide (pressing it reopens the same tap; see below).
      const tapButton = page.locator("#tap-button");
      await expect.poll(() => tapButton.textContent(), { timeout: 2000 }).toBe("I'm lost");
      expect(await tapButton.getAttribute("aria-disabled")).toBeNull();
      expect(await page.locator("#tap-said").isVisible()).toBe(false);
      expect(await page.locator("#resolve-form").isVisible()).toBe(false);
      expect((await focusedIsVisible(page)).visible, "focus lost after I get it now").toBe(true);

      await page.keyboard.press("ArrowRight");
      await expect.poll(() => label.textContent()).not.toBe(startLabel);
      // A slide this browser hasn't tapped offers "I'm lost" again.
      await expect.poll(() => tapButton.textContent()).toBe("I'm lost");
      expect(await tapButton.getAttribute("aria-disabled")).toBeNull();
      expect(await page.locator("#tap-said").isVisible()).toBe(false);
      // Back to live is in the slide bar, above the tap bar.
      await tabTo(page, (f) => f.tag === "A" && f.text === "Back to live", 80, "Shift+Tab");
      await page.keyboard.press("Enter");
      await expect.poll(() => label.textContent()).toBe(startLabel);

      expect(w.problems).toEqual([]);
    } finally {
      await w.context.close();
    }
  }, 60_000);

  // One "I'm lost" per slide, but undoable: after "I get it now", "I'm
  // lost" reopens the same tap. All by keyboard, focus never dropped, and a
  // reason chosen before stays chosen.
  it("keyboard only: tap, reason, I get it now, then I'm lost again reopens the same tap", async () => {
    const w = await openWatched(width, height);
    const { page } = w;
    try {
      await page.goto(new URL("/l/demo?deck=week-6&slide=2", baseUrl).toString());
      const tapButton = page.locator("#tap-button");
      await tabTo(page, (f) => f.tag === "BUTTON" && f.text === "I'm lost");
      await page.keyboard.press("Enter");
      await page.locator("#reasons").waitFor();
      await expect.poll(() => tapButton.textContent(), { timeout: 2000 }).toBe("You're counted");
      expect((await focusedIsVisible(page)).visible, "focus lost after the tap").toBe(true);

      await tabTo(page, (f) => f.tag === "BUTTON" && f.text === "Notation");
      await page.keyboard.press("Enter");
      await expect.poll(() => page.locator("#reasons button.answer-chosen").textContent()).toBe("Notation");
      expect((await focusedIsVisible(page)).visible, "focus lost after picking a reason").toBe(true);

      await tabTo(page, (f) => f.tag === "BUTTON" && f.text === "I get it now", 60, "Shift+Tab");
      await page.keyboard.press("Enter");
      await page.locator("#helped").waitFor();
      await expect.poll(() => tapButton.textContent(), { timeout: 2000 }).toBe("I'm lost");
      expect(await tapButton.getAttribute("aria-disabled")).toBeNull();
      expect(await page.locator("#tap-said").isVisible()).toBe(false);
      expect(await page.locator("#reasons").count()).toBe(0);
      expect(await page.locator("#note-form").count()).toBe(0);
      expect(await page.locator("#glad-text").textContent()).toBe("Glad you've got it now.");
      // Hiding "I get it now" hands focus to the tap button, now available.
      const afterResolve = await focusedIsVisible(page);
      expect(afterResolve.visible, "focus lost after I get it now").toBe(true);
      expect(afterResolve.text).toBe("I'm lost");

      // Loaded again, the page still offers "I'm lost" and still knows the
      // reason sent before, though the reasons aren't on it.
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.reload();
      await expect.poll(() => tapButton.textContent()).toBe("I'm lost");
      expect(await page.locator("#reasons").count()).toBe(0);
      await tabTo(page, (f) => f.tag === "BUTTON" && f.text === "I'm lost");
      await page.keyboard.press("Enter");
      await expect.poll(() => tapButton.textContent(), { timeout: 2000 }).toBe("You're counted");
      expect(await tapButton.getAttribute("aria-disabled")).toBe("true");
      await page.locator("#reasons").waitFor();
      await page.locator("#note-form").waitFor();
      expect(await page.locator("#resolve-form").isVisible()).toBe(true);
      expect(await page.locator("#tap-said").isVisible()).toBe(true);
      expect(await page.locator("#helped").count()).toBe(0);
      // The reason sent before is still chosen and locked.
      expect(await page.locator("#reasons button.answer-chosen").textContent()).toBe("Notation");
      expect(await page.locator("#reasons button[aria-disabled=true]").count()).toBe(4);
      expect((await focusedIsVisible(page)).visible, "focus lost after I'm lost again").toBe(true);
      // The same tap, reopened: still one in this browser's count.
      expect(await yourTapCount(page)).toBe(1);
      expect(await hasHorizontalScroll(page)).toBe(false);
      expect(w.problems).toEqual([]);
    } finally {
      await w.context.close();
    }
  }, 60_000);

  it("timeline: a segment is reached by Tab and Enter browses to that slide for this browser only", async () => {
    const w = await openWatched(width, height);
    const { page } = w;
    try {
      await page.goto(new URL("/l/demo", baseUrl).toString());
      await page.waitForLoadState("networkidle").catch(() => {});
      expect(await hasHorizontalScroll(page)).toBe(false);
      const label = page.locator("#slide-label");
      // The live mark is a ring inside the live segment's link.
      await page.locator("#timeline a .timeline-live").waitFor();
      const startLabel = await label.textContent();
      const liveHref = await page.locator("#timeline a:has(.timeline-live)").first().getAttribute("href");

      // Tab into the timeline (visible focus at every stop), then on to a
      // segment that isn't the live one.
      await tabTo(page, (f) => f.tag === "a" && f.href !== null && /[?&]slide=/.test(f.href), 120);
      if ((await focusedIsVisible(page)).href === liveHref) {
        await tabTo(page, (f) => f.tag === "a" && f.href !== null && /[?&]slide=/.test(f.href), 1);
      }
      const target = (await focusedIsVisible(page)).href!;
      expect(target).not.toBe(liveHref);
      const urlBefore = page.url();
      await page.keyboard.press("Enter");

      await expect.poll(() => label.textContent()).not.toBe(startLabel);
      // That segment now carries the "you" ring, and only that one does.
      await expect.poll(() => page.locator(`#timeline a[href="${target}"] .timeline-you`).count()).toBe(1);
      expect(await page.locator("#timeline .timeline-you").count()).toBe(1);
      // Browsed in place: no navigation.
      expect(page.url()).toBe(urlBefore);
      expect(await hasHorizontalScroll(page)).toBe(false);
      expect(w.problems).toEqual([]);
    } finally {
      await w.context.close();
    }
  }, 60_000);

  // A created lecture's student arrows: plain links reached by Tab,
  // browsing in place, the arrow keys within 1 to its slide count, and
  // Back to live.
  it("a created lecture: arrows by Tab and keyboard, bounded, Back to live", async () => {
    const w = await openWatched(width, height);
    const { page } = w;
    try {
      const created = await (
        await w.context.request.post(new URL("/new", baseUrl).toString(), {
          form: { title: "Student arrows", slides: "5", minutes: "60" },
        })
      ).text();
      const lectureId = created.match(/Student link: <a href="\/l\/([a-f0-9]+)"/)![1];
      await page.goto(new URL(`/l/${lectureId}`, baseUrl).toString());
      await page.waitForLoadState("networkidle").catch(() => {});
      const label = page.locator("#slide-label");
      await expect.poll(() => label.textContent()).toBe("Slide 1 (live)");

      await tabTo(page, (f) => f.tag === "A" && f.text === "Next slide", 80);
      const urlBefore = page.url();
      await page.keyboard.press("Enter");
      await expect.poll(() => label.textContent()).toBe("Slide 2");
      // Browsed in place: no navigation.
      expect(page.url()).toBe(urlBefore);

      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => label.textContent()).toBe("Slide 3");
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => label.textContent()).toBe("Slide 4");
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => label.textContent()).toBe("Slide 5");
      // The last slide is the bound: Next is no longer a link.
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(200);
      expect(await label.textContent()).toBe("Slide 5");
      expect(await page.locator("#slide-next-link").evaluate((el) => el.tagName)).toBe("SPAN");

      const back = page.locator("#back-to-live-link");
      await expect.poll(() => back.isVisible()).toBe(true);
      await back.click();
      await expect.poll(() => label.textContent()).toBe("Slide 1 (live)");
      expect(await back.isVisible()).toBe(false);

      expect(await hasHorizontalScroll(page)).toBe(false);
      expect(w.problems).toEqual([]);
    } finally {
      await w.context.close();
    }
  }, 60_000);

  it("answers lock once sent: reasons, then what helped, with contrast intact", async () => {
    const w = await openWatched(width, height);
    const { page } = w;
    try {
      await page.goto(new URL("/l/demo?deck=week-6&slide=4", baseUrl).toString());
      await page.locator("#tap-button").click();
      await page.locator("#reasons").waitFor();
      await page.locator("#reasons button", { hasText: "Missed a step" }).click();

      const reasonButtons = page.locator("#reasons button.answer");
      await expect.poll(() => reasonButtons.evaluateAll((bs) => bs.every((b) => b.getAttribute("aria-disabled") === "true"))).toBe(true);
      const states = await reasonButtons.evaluateAll((bs) =>
        bs.map((b) => [b.textContent, b.getAttribute("aria-pressed"), b.className]),
      );
      expect(states).toEqual([
        ["Too fast", "false", "answer answer-other"],
        ["Missed a step", "true", "answer answer-chosen"],
        ["Notation", "false", "answer answer-other"],
        ["Can't see or hear", "false", "answer answer-other"],
      ]);
      // Still locked when the page is loaded again (the server marks it).
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.goto(new URL("/l/demo?deck=week-6&slide=4", baseUrl).toString());
      await page.locator("#reasons").waitFor();
      expect(await page.locator("#reasons button.answer-chosen").textContent()).toBe("Missed a step");
      expect(await axeViolations(page)).toEqual([]);

      await page.locator("#resolve-form button").click();
      await page.locator("#helped").waitFor();
      expect(await page.locator("#glad-text").textContent()).toBe("Glad you've got it now.");
      expect(await page.locator("#reasons").count()).toBe(0);
      await page.locator("#helped button", { hasText: "The example" }).click();
      await expect.poll(() => page.locator("#helped button.answer-chosen").textContent()).toBe("The example");
      expect(await page.locator("#helped button[aria-disabled=true]").count()).toBe(5);
      expect(await axeViolations(page)).toEqual([]);
      expect(await hasHorizontalScroll(page)).toBe(false);
      expect(w.problems).toEqual([]);
    } finally {
      await w.context.close();
    }
  }, 30_000);

  it("two people: a tap in one browser reaches the other within a second", async () => {
    const a = await openWatched(width, height);
    const b = await openWatched(width, height);
    try {
      await a.page.goto(new URL("/l/demo", baseUrl).toString());
      await b.page.goto(new URL("/l/demo", baseUrl).toString());
      const lost = b.page.locator("#gauge-lost");
      // Demo's min_present is 2, so with both here the count is shown.
      await expect.poll(() => lost.textContent(), { timeout: 3000 }).not.toMatch(/^Waiting/);
      const before = await lost.textContent();

      await a.page.locator("#tap-button").click();
      await expect.poll(() => lost.textContent(), { timeout: 1000, interval: 50 }).not.toBe(before);

      expect([...a.problems, ...b.problems]).toEqual([]);
    } finally {
      await a.context.close();
      await b.context.close();
    }
  }, 30_000);

  it("Slow 4G: Sending... shows within 100 ms and the tap still counts", async () => {
    const w = await openWatched(width, height);
    const { page } = w;
    try {
      await page.goto(new URL("/l/demo", baseUrl).toString());
      await page.locator("#tap-button").waitFor();
      const cdp = await w.context.newCDPSession(page);
      // DevTools' "Slow 4G" preset.
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 562.5,
        downloadThroughput: (1.6 * 1024 * 1024 * 0.9) / 8,
        uploadThroughput: (750 * 1024 * 0.9) / 8,
      });
      const before = await yourTapCount(page);

      const msToSending = await page.evaluate(
        () =>
          new Promise<number>((resolve) => {
            const button = document.getElementById("tap-button")!;
            const start = performance.now();
            const observer = new MutationObserver(() => {
              if (button.textContent === "Sending...") {
                observer.disconnect();
                resolve(performance.now() - start);
              }
            });
            observer.observe(button, { childList: true, characterData: true, subtree: true });
            button.click();
          }),
      );
      expect(msToSending).toBeLessThan(100);

      await expect.poll(() => yourTapCount(page), { timeout: 15_000 }).toBe(before + 1);
      expect(w.problems).toEqual([]);
    } finally {
      await w.context.close();
    }
  }, 45_000);
});

it("resize mid-tap: tap at 1920x1080, shrink to 390x844 while Sending..., the tap counts and nothing overflows", async () => {
  const w = await openWatched(1920, 1080);
  const { page } = w;
  try {
    // Hold the tap request open so the resize lands while it's in flight.
    await page.route("**/l/demo/tap", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      await route.continue();
    });
    await page.goto(new URL("/l/demo", baseUrl).toString());
    const before = await yourTapCount(page);

    await page.locator("#tap-button").click();
    await expect.poll(() => page.locator("#tap-button").textContent(), { timeout: 500, interval: 10 }).toBe("Sending...");
    await page.setViewportSize({ width: 390, height: 844 });

    await expect.poll(() => yourTapCount(page), { timeout: 5000 }).toBe(before + 1);
    expect(await hasHorizontalScroll(page)).toBe(false);
    expect(w.problems).toEqual([]);
  } finally {
    await w.context.close();
  }
}, 30_000);

// The page scripts re-render slide names on every live update; they must
// use the same wording as the server, deck and "(live)" included. Each
// check clears the server-rendered text first, so only the script can put
// it back.
it("live updates name the deck and slide the same way the server does", async () => {
  const student = await openWatched(1920, 1080);
  const lecturer = await openWatched(1920, 1080);
  const tapper = await openWatched(1920, 1080);
  try {
    // Two browsers lost on week-6 slide 9, so the bars have a demo row.
    for (const ctx of [student.context, tapper.context]) {
      await ctx.request.get(new URL("/l/demo", baseUrl).toString());
      await ctx.request.post(new URL("/l/demo/tap", baseUrl).toString(), { form: { deck: "week-6", slide: "9" } });
    }

    await logInAsDemoLecturer(lecturer.context);
    await student.page.goto(new URL("/l/demo", baseUrl).toString());
    await lecturer.page.goto(new URL("/l/demo/lecturer", baseUrl).toString());
    for (const page of [student.page, lecturer.page]) {
      await page.evaluate(() => {
        document.getElementById("slide-label")!.textContent = "";
        document.getElementById("bars")!.innerHTML = "";
      });
    }
    // A tap on week-6 slide 9 changes that slide's bar, so every open page
    // gets a frame with different bars. The lecturer page redraws a
    // dashboard section only when it changed; a tap below the threshold
    // elsewhere wouldn't change the bars on a fresh database.
    const other = await openWatched(1920, 1080);
    try {
      await other.context.request.get(new URL("/l/demo", baseUrl).toString());
      await other.context.request.post(new URL("/l/demo/tap", baseUrl).toString(), { form: { deck: "week-6", slide: "9" } });
    } finally {
      await other.context.close();
    }

    await expect.poll(() => lecturer.page.locator("#slide-label").textContent(), { timeout: 3000 }).toMatch(/^Week 4 \u00b7 slide \d+ \(live\)$/);
    await expect.poll(() => lecturer.page.locator("#bars td", { hasText: "Week 6 \u00b7 slide 9" }).count(), { timeout: 3000 }).toBe(1);
    await expect.poll(() => student.page.locator("#bars td", { hasText: "Week 6 \u00b7 slide 9" }).count(), { timeout: 3000 }).toBe(1);

    // Browsing away drops "(live)", and the marker names the deck.
    const label = student.page.locator("#slide-label");
    await expect.poll(() => label.textContent(), { timeout: 3000 }).toMatch(/^Week 4 \u00b7 slide \d+ of 10 \(live\)$/);
    const live = Number((await label.textContent())!.match(/slide (\d+)/)![1]);
    // On the live slide, the marker is the LIVE pill.
    expect(await student.page.locator("#slide-bar").getAttribute("class")).toBe("slide-bar on-live");
    await student.page.keyboard.press(live > 1 ? "ArrowLeft" : "ArrowRight");
    const viewed = live > 1 ? live - 1 : live + 1;
    await expect.poll(() => label.textContent()).toBe(`Week 4 \u00b7 slide ${viewed} of 10`);
    // Off the live slide, the marker isn't the LIVE pill any more.
    expect(await student.page.locator("#slide-bar").getAttribute("class")).toBe("slide-bar");
    expect(await student.page.locator("#live-marker").textContent()).toBe(
      `You're on Week 4 \u00b7 slide ${viewed}. The lecture is on Week 4 \u00b7 slide ${live}.`,
    );

    expect(student.problems).toEqual([]);
    expect(lecturer.problems).toEqual([]);
  } finally {
    await student.context.close();
    await lecturer.context.close();
    await tapper.context.close();
  }
}, 30_000);

// A created lecture's live slide is wherever the lecturer's Next/Prev (or
// its clock) leaves it. A student can browse with the arrows, as on the
// demo, without moving anyone's live slide; while on the live slide, the
// page follows: the label, and the slide a tap records, move when the
// lecturer presses Next, with no reload.
it("a created lecture's student page follows the lecturer's Next live", async () => {
  const lecturer = await openWatched(1920, 1080);
  const student = await openWatched(390, 844);
  try {
    const created = await lecturer.context.request.post(new URL("/new", baseUrl).toString(), { form: { title: "Follow Next test", slides: "60", minutes: "60" } });
    const createdHtml = await created.text();
    const lectureId = createdHtml.match(/Student link: <a href="\/l\/([a-f0-9]+)"/)![1];
    const code = createdHtml.match(/<strong>([A-Z0-9]+)<\/strong>/)![1];
    await lecturer.context.request.post(new URL(`/l/${lectureId}/lecturer`, baseUrl).toString(), { form: { code }, maxRedirects: 0 });

    await student.page.goto(new URL(`/l/${lectureId}`, baseUrl).toString());
    const label = student.page.locator("#slide-label");
    await expect.poll(() => label.textContent()).toBe("Slide 1 (live)");
    // The arrow keys browse this browser only, as on the demo: the label,
    // the slide a tap records and the live marker move, the live slide doesn't.
    await student.page.keyboard.press("ArrowRight");
    await expect.poll(() => label.textContent()).toBe("Slide 2");
    expect(await student.page.locator("#slide-input").inputValue()).toBe("2");
    expect(await student.page.locator("#live-marker").textContent()).toBe("You're on Slide 2. The lecture is on Slide 1.");
    await student.page.keyboard.press("ArrowLeft");
    await expect.poll(() => label.textContent()).toBe("Slide 1 (live)");
    expect(await student.page.locator("#slide-input").inputValue()).toBe("1");

    await lecturer.page.goto(new URL(`/l/${lectureId}/lecturer`, baseUrl).toString());
    await lecturer.page.locator("#slide-next-form button").click();
    await expect.poll(() => label.textContent(), { timeout: 3000 }).toBe("Slide 2 (live)");
    expect(await student.page.locator("#slide-input").inputValue()).toBe("2");

    // A tap now records slide 2, the one the lecturer moved to.
    await student.page.locator("#tap-button").click();
    await expect.poll(() => student.page.locator("#tap-said").isVisible(), { timeout: 3000 }).toBe(true);
    // The browser's own record of its taps says slide 2, nothing else.
    const yourSlides = await student.page.evaluate(
      (id) =>
        new Promise((resolve) => {
          const source = new EventSource(`/l/${id}/events`);
          source.onmessage = (e) => {
            source.close();
            resolve(JSON.parse(e.data).yourSlides);
          };
        }),
      lectureId,
    );
    expect(yourSlides).toEqual([
      { deck: null, slide: 2, live: true, resolved: false, answeredReason: false, answeredHelped: false },
    ]);
    await lecturer.page.locator("#slide-next-form button").click();
    await expect.poll(() => label.textContent(), { timeout: 3000 }).toBe("Slide 3 (live)");
    // A new slide offers "I'm lost" again.
    await expect.poll(() => student.page.locator("#tap-button").textContent()).toBe("I'm lost");

    expect(student.problems).toEqual([]);
    expect(lecturer.problems).toEqual([]);
  } finally {
    await lecturer.context.close();
    await student.context.close();
  }
}, 30_000);

// README "Safety in numbers": the activity log reaches the lecturer only
// while min_present people are here. An open lecturer page shows it once
// the room fills, and clears it again when people leave.
it("the lecturer's activity log shows once 5 are here and clears when the room empties", async () => {
  const post = (path: string, cookie: string, body: Record<string, string>) =>
    fetch(new URL(path, baseUrl), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
      redirect: "manual",
    });
  const creatorRes = await fetch(new URL("/l/demo", baseUrl));
  const creator = creatorRes.headers.getSetCookie().find((c) => c.startsWith("bid="))!.split(";")[0];
  const created = await (await post("/new", creator, { title: "Log gate", slides: "10", minutes: "60" })).text();
  const id = created.match(/Student link: <a href="\/l\/([a-f0-9]+)"/)![1];
  const code = created.match(/<strong>([A-Z0-9]+)<\/strong>/)![1];

  const lecturer = await openWatched(1920, 1080);
  const students: Awaited<ReturnType<typeof openWatched>>[] = [];
  try {
    await lecturer.context.request.get(new URL(`/l/${id}`, baseUrl).toString());
    await lecturer.context.request.post(new URL(`/l/${id}/lecturer`, baseUrl).toString(), { form: { code }, maxRedirects: 0 });
    await lecturer.page.goto(new URL(`/l/${id}/lecturer`, baseUrl).toString());
    const lines = lecturer.page.locator("#activity-lines li");
    await expect.poll(() => lecturer.page.locator("#activity-waiting").isVisible()).toBe(true);

    for (let i = 0; i < 5; i++) {
      const s = await openWatched(390, 844);
      students.push(s);
      await s.page.goto(new URL(`/l/${id}`, baseUrl).toString());
    }
    await students[0].page.locator("#tap-button").click();
    await expect.poll(() => lines.count(), { timeout: 3000 }).toBe(1);
    expect(await lecturer.page.locator("#activity-waiting").isVisible()).toBe(false);

    for (const s of students.splice(1)) await s.context.close();
    await expect.poll(() => lines.count(), { timeout: 3000 }).toBe(0);
    expect(await lecturer.page.locator("#activity-waiting").isVisible()).toBe(true);

    expect([...lecturer.problems, ...students.flatMap((s) => s.problems)]).toEqual([]);
  } finally {
    for (const s of students) await s.context.close();
    await lecturer.context.close();
  }
}, 45_000);
