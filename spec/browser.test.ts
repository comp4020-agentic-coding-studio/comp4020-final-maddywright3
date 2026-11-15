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
const PAGES = ["/", "/readme/", "/l/demo", "/l/demo/lecturer", "/new", "/no-such-page"];

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
async function openWatched(width: number, height: number, expectedNotFound?: string): Promise<Watched> {
  const context = await browser.newContext({ viewport: { width, height } });
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

async function focusedIsVisible(page: Page): Promise<{ tag: string; text: string; visible: boolean }> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return { tag: "body", text: "", visible: false };
    const style = getComputedStyle(el);
    const visible = el.matches(":focus-visible") && style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0;
    return { tag: el.tagName, text: (el.textContent ?? "").trim(), visible };
  });
}

// Tabs until the focused element matches, checking the focus ring is
// visible at every stop on the way. Shift+Tab when the target is earlier in
// the page, as a keyboard user would.
async function tabTo(
  page: Page,
  matches: (f: { tag: string; text: string }) => boolean,
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
      if (path === "/l/demo/lecturer") await logInAsDemoLecturer(w.context);
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
      // One "I'm lost" per slide, ever: after "I get it now" this slide stays
      // used for this browser, and the page says so rather than offering a
      // tap the server would ignore.
      const tapButton = page.locator("#tap-button");
      await expect.poll(() => tapButton.textContent(), { timeout: 2000 }).toBe("Counted on this slide");
      expect(await tapButton.getAttribute("aria-disabled")).toBe("true");
      expect(await page.locator("#tap-said").textContent()).toBe("You've said you're lost on this slide.");
      expect(await page.locator("#tap-said").isVisible()).toBe(true);
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
    // Any tap broadcasts a frame to every open page.
    const other = await openWatched(1920, 1080);
    try {
      await other.context.request.get(new URL("/l/demo", baseUrl).toString());
      await other.context.request.post(new URL("/l/demo/tap", baseUrl).toString(), { form: { deck: "week-4", slide: "1" } });
    } finally {
      await other.context.close();
    }

    await expect.poll(() => lecturer.page.locator("#slide-label").textContent(), { timeout: 3000 }).toMatch(/^Week 4, slide \d+ \(live\)$/);
    await expect.poll(() => lecturer.page.locator("#bars td", { hasText: "Week 6, slide 9" }).count(), { timeout: 3000 }).toBe(1);
    await expect.poll(() => student.page.locator("#bars td", { hasText: "Week 6, slide 9" }).count(), { timeout: 3000 }).toBe(1);

    // Browsing away drops "(live)", and the marker names the deck.
    const label = student.page.locator("#slide-label");
    await expect.poll(() => label.textContent(), { timeout: 3000 }).toMatch(/^Week 4, slide \d+ of 10 \(live\)$/);
    const live = Number((await label.textContent())!.match(/slide (\d+)/)![1]);
    await student.page.keyboard.press(live > 1 ? "ArrowLeft" : "ArrowRight");
    const viewed = live > 1 ? live - 1 : live + 1;
    await expect.poll(() => label.textContent()).toBe(`Week 4, slide ${viewed} of 10`);
    expect(await student.page.locator("#live-marker").textContent()).toBe(
      `You're on Week 4, slide ${viewed}. The lecture is on Week 4, slide ${live}.`,
    );

    expect(student.problems).toEqual([]);
    expect(lecturer.problems).toEqual([]);
  } finally {
    await student.context.close();
    await lecturer.context.close();
    await tapper.context.close();
  }
}, 30_000);

// A created lecture's slide is wherever the lecturer's Next/Prev leaves it.
// The student page has no slides of its own to browse, so it must follow:
// the label, and the slide a tap records, move when the lecturer presses
// Next, with no reload.
it("a created lecture's student page follows the lecturer's Next live", async () => {
  const lecturer = await openWatched(1920, 1080);
  const student = await openWatched(390, 844);
  try {
    const created = await lecturer.context.request.post(new URL("/new", baseUrl).toString(), { form: { title: "Follow Next test" } });
    const createdHtml = await created.text();
    const lectureId = createdHtml.match(/\/l\/([a-f0-9]+)/)![1];
    const code = createdHtml.match(/<strong>([A-Z0-9]+)<\/strong>/)![1];
    await lecturer.context.request.post(new URL(`/l/${lectureId}/lecturer`, baseUrl).toString(), { form: { code }, maxRedirects: 0 });

    await student.page.goto(new URL(`/l/${lectureId}`, baseUrl).toString());
    const label = student.page.locator("#slide-label");
    await expect.poll(() => label.textContent()).toBe("Slide 1 (live)");

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
    expect(yourSlides).toEqual([{ deck: null, slide: 2, live: true }]);
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
