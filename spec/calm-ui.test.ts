import { JSDOM } from "jsdom";
import { expect, inject, it } from "vitest";
import { newBrowserCookie } from "./test-helpers.ts";

// Phase 5's calm UI, checked against the running app. jsdom can't lay out
// or paint, so what's checkable here is what's shipped: one stylesheet,
// linked from every page, with no inline styles anywhere; the tokens in it
// clear 4.5:1 in both themes; the rules the spec asks for exist; and the
// gauge says what it should, without leaking anything below min_present.
const baseUrl = inject("baseUrl");

const STYLESHEET_LINK = '<link rel="stylesheet" href="/style.css">';

async function getCss(): Promise<string> {
  return (await fetch(new URL("/style.css", baseUrl))).text();
}

// The body of the first top-level rule whose selector list is exactly
// `selector`, e.g. ruleBody(css, ".tap-button").
function ruleBody(css: string, selector: string, from = 0): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(^|\\n|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css.slice(from));
  if (!match) throw new Error(`no rule for ${selector}`);
  return match[2];
}

function mediaBlock(css: string, query: RegExp): string {
  const match = query.exec(css);
  if (!match) throw new Error(`no @media block matching ${query}`);
  // Walk braces from the block's opening one to its matching close.
  let depth = 0;
  const start = css.indexOf("{", match.index);
  for (let i = start; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}") depth--;
    if (depth === 0) return css.slice(start + 1, i);
  }
  throw new Error("unbalanced braces");
}

function tokens(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

function themeTokens(css: string): { light: Record<string, string>; dark: Record<string, string> } {
  const light = tokens(ruleBody(css, ":root"));
  const darkBlock = mediaBlock(css, /@media\s*\(prefers-color-scheme:\s*dark\)/);
  const dark = { ...light, ...tokens(ruleBody(darkBlock, ":root")) };
  return { light, dark };
}

function resolveColour(theme: Record<string, string>, name: string): string {
  let value = theme[name];
  for (let i = 0; i < 5 && value?.startsWith("var("); i++) value = theme[value.slice(4, -1).trim()];
  if (!value || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`${name} isn't a 6-digit hex colour: ${value}`);
  return value;
}

// WCAG 2 relative luminance and contrast ratio, by hand.
function luminance(hex: string): number {
  const channel = (i: number): number => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Hue in degrees, and chroma (max - min channel, 0 to 1): how much colour
// there is at all. HSL saturation isn't used for "is this a colour",
// because a near-white paper like #f6f1e7 has high saturation and almost
// no colour.
function hueAndChroma(hex: string): { h: number; chroma: number } {
  const [r, g, b] = [0, 1, 2].map((i) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return { h: 0, chroma: 0 };
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, chroma: d };
}

// The named colours, in the graphs' categorical order. The graph markup
// uses these names, so the test pins them.
const CATEGORICAL = ["--lost", "--accent", "--clicked", "--sky", "--fern", "--clay"];

function remOrPx(value: string): number {
  const m = value.trim().match(/^([\d.]+)(rem|px)$/);
  if (!m) throw new Error(`not a rem/px length: ${value}`);
  return m[2] === "rem" ? Number(m[1]) * 16 : Number(m[1]);
}

async function lecturerLogin(id: string, code: string): Promise<string> {
  const cookie = await newBrowserCookie(id);
  const res = await fetch(new URL(`/l/${id}/lecturer`, baseUrl), {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: `code=${code}`,
    redirect: "manual",
  });
  const lsess = res.headers
    .getSetCookie()
    .find((c) => c.startsWith("lsess="))
    ?.split(";")[0];
  if (!lsess) throw new Error("lecturer login failed");
  return `${cookie}; ${lsess}`;
}

async function createLecture(title: string): Promise<{ id: string; code: string }> {
  const html = await (
    await fetch(new URL("/new", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `title=${encodeURIComponent(title)}`,
    })
  ).text();
  const id = html.match(/Student link: <a href="\/l\/([a-f0-9]+)"/)?.[1];
  const code = html.match(/<strong>([A-Z0-9]+)<\/strong>/)?.[1];
  if (!id || !code) throw new Error("couldn't parse the new lecture's id/code");
  return { id, code };
}

async function post(path: string, cookie: string, body: string): Promise<Response> {
  return fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body,
    redirect: "manual",
  });
}

// An open stream, so a browser counts as present. Resolves once the first
// frame has arrived.
async function presence(lectureId: string): Promise<() => void> {
  const cookie = await newBrowserCookie(lectureId);
  const controller = new AbortController();
  const res = await fetch(new URL(`/l/${lectureId}/events`, baseUrl), {
    signal: controller.signal,
    headers: { cookie },
  });
  await res.body!.getReader().read();
  return () => controller.abort();
}

// Every page template there is, in the states that render differently.
async function everyPage(): Promise<{ name: string; html: string }[]> {
  const cookie = await newBrowserCookie("demo");
  const get = async (path: string, c = cookie): Promise<string> =>
    (await fetch(new URL(path, baseUrl), { headers: { cookie: c } })).text();

  const tapped = await newBrowserCookie("demo");
  await post("/l/demo/tap", tapped, "deck=week-4&slide=1");

  const lecture = await createLecture("Calm UI page sweep");
  const lecturerCookie = await lecturerLogin(lecture.id, lecture.code);
  const demoLecturer = await lecturerLogin("demo", "DEMO");

  return [
    { name: "/", html: await get("/") },
    { name: "/readme/", html: await get("/readme/") },
    { name: "/new", html: await get("/new") },
    { name: "/new error", html: await (await post("/new", cookie, "title=")).text() },
    { name: "404", html: await get("/no-such-page") },
    { name: "/l/demo", html: await get("/l/demo") },
    { name: "/l/demo tapped", html: await get("/l/demo", tapped) },
    { name: "/l/demo week-4 diagram", html: await get("/l/demo?deck=week-4&slide=10") },
    { name: "/l/demo week-6 diagram", html: await get("/l/demo?deck=week-6&slide=9") },
    { name: "lecturer login", html: await get("/l/demo/lecturer") },
    { name: "lecturer wrong code", html: await (await post("/l/demo/lecturer", cookie, "code=nope")).text() },
    { name: "demo lecturer dashboard", html: await get("/l/demo/lecturer", demoLecturer) },
    { name: "created lecture", html: await get(`/l/${lecture.id}`) },
    { name: "created lecturer dashboard", html: await get(`/l/${lecture.id}/lecturer`, lecturerCookie) },
  ];
}

it("/style.css is served as text/css", async () => {
  const res = await fetch(new URL("/style.css", baseUrl));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toMatch(/^text\/css/);
  expect((await res.text()).length).toBeGreaterThan(0);
});

it("every page links /style.css and carries no inline style of any kind", async () => {
  for (const { name, html } of await everyPage()) {
    expect(html, name).toContain(STYLESHEET_LINK);
    expect(html, name).not.toMatch(/<style[\s>]/i);
    expect(html, name).not.toMatch(/\sstyle\s*=/i);
    // Scripts toggle `hidden` or a class, never an inline style.
    expect(html, name).not.toMatch(/\.style\./);
  }
});

it("nothing in the stylesheet loads from anywhere: no web fonts, no imports, no URLs", async () => {
  const css = await getCss();
  expect(css).not.toMatch(/@font-face|@import/i);
  // The only url() allowed is an in-document SVG marker reference.
  for (const m of css.matchAll(/url\(([^)]*)\)/g)) expect(m[1]).toMatch(/^#/);
  expect(ruleBody(css, ":root")).toMatch(/--font:\s*system-ui/);
  expect(ruleBody(css, "body")).toMatch(/font-family:\s*var\(--font\)/);
});

it("type is fluid, body text is at least 1rem, and lines are at most 65ch", async () => {
  const css = await getCss();
  const root = tokens(ruleBody(css, ":root"));
  const step0 = root["--step-0"].match(/^clamp\(([^,]+),/);
  expect(step0, "--step-0 is a clamp()").not.toBeNull();
  expect(remOrPx(step0![1])).toBeGreaterThanOrEqual(16);
  for (const step of ["--step-1", "--step-2", "--step-3"]) expect(root[step]).toMatch(/^clamp\(/);
  expect(ruleBody(css, "body")).toMatch(/font-size:\s*var\(--step-0\)/);

  expect(root["--measure"]).toBe("65ch");
  expect(ruleBody(css, "main")).toMatch(/max-width:\s*var\(--measure\)/);
  expect(ruleBody(css, "p,\nli")).toMatch(/max-width:\s*var\(--measure\)/);
});

it("every text colour clears 4.5:1 on every background, in light and in dark", async () => {
  const css = await getCss();
  const themes = themeTokens(css);
  // --lost is text on the counted (outlined) I'm lost button.
  const texts = ["--ink", "--ink-muted", "--accent", "--lost"];
  const backgrounds = ["--paper", "--surface"];
  for (const [name, theme] of Object.entries(themes)) {
    for (const fg of texts) {
      for (const bg of backgrounds) {
        const ratio = contrast(resolveColour(theme, fg), resolveColour(theme, bg));
        expect(ratio, `${name}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    }
    // Text on the filled pills: I'm lost, the LIVE pill and primary links,
    // and I get it now.
    for (const bg of ["--lost", "--accent", "--clicked"]) {
      const ratio = contrast(resolveColour(theme, "--on-colour"), resolveColour(theme, bg));
      expect(ratio, `${name}: --on-colour on ${bg} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
    // The gauge fill against its track: a non-text graphic, but kept at
    // the text bar anyway so the bar reads without the words.
    const fill = contrast(resolveColour(theme, "--lost"), resolveColour(theme, "--line"));
    expect(fill, `${name}: gauge fill on its track is ${fill.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  }
});

it("graph marks and control borders clear 3:1 on --surface and --paper, in light and in dark", async () => {
  const css = await getCss();
  for (const [name, theme] of Object.entries(themeTokens(css))) {
    // Every categorical colour is a graph mark; --ink-muted borders the
    // text inputs, and --accent outlines buttons and pill links.
    for (const mark of [...CATEGORICAL, "--ink-muted"]) {
      for (const bg of ["--surface", "--paper"]) {
        const ratio = contrast(resolveColour(theme, mark), resolveColour(theme, bg));
        expect(ratio, `${name}: ${mark} on ${bg} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
      }
    }
  }
  // The borders that say "this is a control" use those tokens, not the
  // quiet --line hairline that only decorates cards and tables.
  expect(ruleBody(css, "button")).toMatch(/border:\s*1px solid var\(--accent\)/);
  expect(ruleBody(css, ".pill-link")).toMatch(/border:\s*1px solid var\(--accent\)/);
  expect(ruleBody(css, "#slide-nav a,\n#slide-nav span")).toMatch(/border:\s*1px solid var\(--accent\)/);
  expect(ruleBody(css, 'input:not([type="hidden"]),\nselect,\ntextarea')).toMatch(/border:\s*1px solid var\(--ink-muted\)/);
});

it("the only colours are the six named ones, being lost is violet, and nothing is red", async () => {
  const css = await getCss();
  for (const [name, theme] of Object.entries(themeTokens(css))) {
    const coloured: string[] = [];
    for (const token of Object.keys(theme)) {
      if (!/^#[0-9a-f]{6}$/i.test(theme[token])) continue;
      const { h, chroma } = hueAndChroma(theme[token]);
      if (chroma > 0.15) {
        coloured.push(token);
        // Red reads as alarm; being lost isn't one. Wattle and clay are
        // warm on purpose, but neither is red.
        expect(h >= 15 && h <= 340, `${name}: ${token} ${theme[token]} is red (hue ${h.toFixed(0)})`).toBe(true);
      }
    }
    expect(coloured.sort(), `${name}: the colours are the six named ones`).toEqual([...CATEGORICAL].sort());
    const lost = hueAndChroma(resolveColour(theme, "--lost")).h;
    expect(lost > 240 && lost < 290, `${name}: --lost is violet (hue ${lost.toFixed(0)})`).toBe(true);
  }
});

it("has a dark theme, and short transitions that stop under reduced motion", async () => {
  const css = await getCss();
  expect(css).toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)/);

  const reduce = mediaBlock(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  expect(reduce).toMatch(/transition:\s*none\s*!important/);
  expect(reduce).toMatch(/animation:\s*none\s*!important/);

  // Every transition is declared inside the no-preference block, and short.
  const allowed = mediaBlock(css, /@media\s*\(prefers-reduced-motion:\s*no-preference\)/);
  const outside = css.replace(allowed, "").replace(reduce, "");
  expect(outside).not.toMatch(/transition\s*:/);
  const durations = [...allowed.matchAll(/(\d+)ms/g)].map((m) => Number(m[1]));
  expect(durations.length).toBeGreaterThan(0);
  for (const ms of durations) expect(ms).toBeLessThan(150);
  expect(css).not.toMatch(/@keyframes/);
});

it("on a phone 'I'm lost' is a violet pill in a sticky bottom bar at least 56px tall; on a desktop the slide takes two thirds", async () => {
  const css = await getCss();
  const tapBar = ruleBody(css, ".tap-bar");
  expect(tapBar).toMatch(/position:\s*sticky/);
  expect(tapBar).toMatch(/bottom:\s*0/);

  const button = ruleBody(css, ".tap-button");
  const minHeight = button.match(/min-height:\s*([^;]+);/)?.[1].trim();
  expect(minHeight).toBeDefined();
  const resolved = minHeight!.startsWith("var(")
    ? tokens(ruleBody(css, ":root"))[minHeight!.slice(4, -1)]
    : minHeight!;
  expect(remOrPx(resolved)).toBeGreaterThanOrEqual(56);
  expect(button).toMatch(/width:\s*100%/);
  expect(button).toMatch(/background:\s*var\(--lost\)/);
  expect(button).toMatch(/color:\s*var\(--on-colour\)/);
  expect(button).toMatch(/border-radius:\s*var\(--pill\)/);

  const desktop = mediaBlock(css, /@media\s*\(min-width:\s*60rem\)/);
  expect(ruleBody(desktop, ".lecture-layout")).toMatch(/grid-template-columns:\s*minmax\(0,\s*2fr\)\s*minmax\([^)]*\)/);
  expect(ruleBody(desktop, ".lecture-layout")).toMatch(/"slide gauge"/);
  expect(ruleBody(desktop, ".tap-bar")).toMatch(/position:\s*static/);
});

it("the live marker has its own style, and on the live slide it's the LIVE pill in --accent", async () => {
  const css = await getCss();
  expect(ruleBody(css, "#live-marker")).toMatch(/color:\s*var\(--ink\)/);
  const pill = ruleBody(css, ".slide-bar.on-live #live-marker");
  expect(pill).toMatch(/background:\s*var\(--accent\)/);
  expect(pill).toMatch(/color:\s*var\(--on-colour\)/);
  expect(pill).toMatch(/text-transform:\s*uppercase/);

  // The server marks the bar on-live only while the viewer is on the live
  // slide; the marker's own text is unchanged ("Live").
  const cookie = await newBrowserCookie("demo");
  const get = async (path: string): Promise<Document> =>
    new JSDOM(await (await fetch(new URL(path, baseUrl), { headers: { cookie } })).text()).window.document;
  const live = await get("/l/demo?deck=week-6");
  expect(live.getElementById("slide-bar")!.classList.contains("on-live")).toBe(true);
  expect(live.getElementById("live-marker")!.textContent).toBe("Live");
  const browsing = await get("/l/demo?deck=week-6&slide=3");
  expect(browsing.getElementById("slide-bar")!.classList.contains("on-live")).toBe(false);
});

it("after a tap, the reasons and the note come after the tap bar, and 'I get it now' is its own form", async () => {
  const cookie = await newBrowserCookie("demo");
  await post("/l/demo/tap", cookie, "deck=week-4&slide=1");
  const html = await (await fetch(new URL("/l/demo", baseUrl), { headers: { cookie } })).text();
  const doc = new JSDOM(html).window.document;

  const tapButton = doc.getElementById("tap-button")!;
  const reasons = doc.getElementById("reasons")!;
  const note = doc.getElementById("note-form")!;
  expect(tapButton.closest(".tap-bar")).not.toBeNull();
  // DOCUMENT_POSITION_FOLLOWING = 4
  expect(tapButton.compareDocumentPosition(reasons) & 4).toBe(4);
  expect(reasons.compareDocumentPosition(note) & 4).toBe(4);

  // A <form> nested in another is dropped by the parser, and its button
  // then submits the outer form, so "I get it now" would send a tap.
  const resolveForm = doc.getElementById("resolve-form") as HTMLFormElement | null;
  expect(resolveForm).not.toBeNull();
  const resolveButton = [...doc.querySelectorAll("button")].find((b) => b.textContent === "I get it now");
  expect(resolveButton?.form?.id).toBe("resolve-form");
});

it("above min_present the gauge reads 'N of M people here are lost right now' over a quiet bar", async () => {
  const closers = [await presence("demo"), await presence("demo")]; // demo's min_present is 2
  try {
    const cookie = await newBrowserCookie("demo");
    await post("/l/demo/tap", cookie, "deck=week-4&slide=1");
    const html = await (await fetch(new URL("/l/demo", baseUrl), { headers: { cookie } })).text();
    const doc = new JSDOM(html).window.document;

    const words = doc.getElementById("gauge-words")!.textContent!;
    const m = words.match(/^(\d+) of (\d+) (person|people) here (is|are) lost right now$/);
    expect(m, words).not.toBeNull();
    const [lost, of] = [Number(m![1]), Number(m![2])];
    expect(lost).toBeGreaterThanOrEqual(1);
    expect(of).toBeGreaterThanOrEqual(lost);
    expect(m![3]).toBe(of === 1 ? "person" : "people");
    expect(m![4]).toBe(lost === 1 ? "is" : "are");

    const fill = doc.querySelector("#gauge-bar .gauge-fill");
    expect(fill).not.toBeNull();
    const width = Number(fill!.getAttribute("width"));
    expect(width).toBeCloseTo((lost / of) * 100, 0);

    // The aria-live node holds the lost count only, never the present one,
    // so people arriving or leaving don't change what it says.
    const live = doc.getElementById("gauge-lost")!;
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.textContent).toBe(`${lost} ${lost === 1 ? "person is" : "people are"} lost right now`);
    expect(doc.getElementById("gauge-words")!.getAttribute("aria-hidden")).toBe("true");
  } finally {
    closers.forEach((close) => close());
  }
});

it("below min_present the gauge shows no count and no bar, and its live text doesn't change as people arrive", async () => {
  const lecture = await createLecture("Calm UI below threshold"); // min_present 5
  const tapper = await newBrowserCookie(lecture.id);
  await post(`/l/${lecture.id}/tap`, tapper, "deck=&slide=1");

  const read = async (): Promise<Document> =>
    new JSDOM(await (await fetch(new URL(`/l/${lecture.id}`, baseUrl), { headers: { cookie: tapper } })).text())
      .window.document;

  const before = await read();
  const close = await presence(lecture.id);
  try {
    const after = await read();
    for (const doc of [before, after]) {
      expect(doc.getElementById("gauge-words")!.textContent).toMatch(/^Waiting for \d+ more (person|people)$/);
      expect(doc.getElementById("gauge-bar")).toBeNull();
      expect(doc.getElementById("gauge-lost")!.textContent).not.toMatch(/\d/);
    }
    expect(after.getElementById("gauge-lost")!.textContent).toBe(before.getElementById("gauge-lost")!.textContent);
    expect(after.getElementById("gauge-words")!.textContent).not.toBe(before.getElementById("gauge-words")!.textContent);
  } finally {
    close();
  }
});

it("the lecturer view puts the current slide's bar and notes first, and projector mode scales type 1.5x", async () => {
  const lecture = await createLecture("Calm UI lecturer order");
  const lecturerCookie = await lecturerLogin(lecture.id, lecture.code);
  for (let i = 0; i < 5; i++) {
    const cookie = await newBrowserCookie(lecture.id);
    await post(`/l/${lecture.id}/tap`, cookie, "slide=1");
    await post(`/l/${lecture.id}/note`, cookie, `slide=1&text=${encodeURIComponent(`current slide note ${i}`)}`);
  }
  const html = await (
    await fetch(new URL(`/l/${lecture.id}/lecturer`, baseUrl), { headers: { cookie: lecturerCookie } })
  ).text();
  const doc = new JSDOM(html).window.document;

  const now = doc.getElementById("now")!;
  expect(now).not.toBeNull();
  expect(now.textContent).toContain("5 people have said they were lost here");
  expect(now.querySelector(".gauge-fill")).not.toBeNull();
  expect(now.textContent).toContain("current slide note 0");
  // #now comes before the every-slide history.
  expect(now.compareDocumentPosition(doc.getElementById("bars")!) & 4).toBe(4);

  // Normal type by default: the lecturer page sets no type scale of its
  // own. Projector mode multiplies every step of the scale by 1.5.
  const css = await getCss();
  expect(ruleBody(css, "main.lecturer")).not.toMatch(/--step-|--small/);
  const root = tokens(ruleBody(css, ":root"));
  const projector = tokens(ruleBody(css, "main.lecturer.projector"));
  const numbers = (value: string): number[] => [...value.matchAll(/([\d.]+)(rem|vw)/g)].map((m) => Number(m[1]));
  for (const step of ["--step-0", "--step-1", "--step-2", "--step-3", "--small"]) {
    const expected = numbers(root[step]).map((n) => n * 1.5);
    const actual = numbers(projector[step]);
    expect(actual.length, step).toBe(expected.length);
    actual.forEach((n, i) => expect(n, `${step} part ${i}`).toBeCloseTo(expected[i], 4));
  }
  expect(ruleBody(css, "main.lecturer.projector")).toMatch(/font-size:\s*var\(--step-0\)/);
});
