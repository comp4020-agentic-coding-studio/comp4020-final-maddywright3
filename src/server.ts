import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { marked } from "marked";
import {
  createLecture,
  getLecture,
  hideNoteById,
  lectureSlides,
  startTimedLecture,
  lectureCount,
  liveTapOn,
  openTapOn,
  resolveTap,
  resolvedTapOn,
  setTapHelped,
  yourAnswersOn,
  runsOf,
  setHelpUrl,
  startRun,
  stepCurrentSlide,
  setNote,
  setTapReason,
  tapOncePerSlide,
} from "./db.ts";
import type { Lecture, SlideRef, YourSlide } from "./db.ts";
import {
  BROWSER_COOKIE,
  LECTURER_COOKIE,
  checkCreateLectureRateLimit,
  checkLoginRateLimit,
  createLecturerSession,
  ensureBrowserId,
  rawBrowserCookie,
  recordFailedLogin,
  recordLectureCreation,
  validateBrowserId,
  validateLecturerSession,
} from "./auth.ts";
import { activityClientJs, activityLogHtml, parseActivityFilter } from "./activity.ts";
import type { ActivityFilter, ActivityLine } from "./activity.ts";
import { timelineHtml } from "./timeline.ts";
import { generateAccessCode, hashCode, verifyCode } from "./codes.ts";
import { serializeCookie } from "./cookies.ts";
import { logAction, who } from "./logging.ts";
import {
  HELP_AFTER_SLIDES,
  addConnection,
  addLecturerConnection,
  broadcast,
  broadcastToLecturer,
  computeLecturerState,
  computePastRunState,
  computeState,
  removeConnection,
  removeLecturerConnection,
  scheduleFade,
  scheduleTimedAdvance,
  sendInitialLecturerState,
  sendInitialState,
  startHeartbeat,
} from "./realtime.ts";
import type { Bar, LecturerState, PastRunState } from "./realtime.ts";
import { dashboardClientJs, notesFilterFormHtml, notesListInnerHtml, parseNotesFilter } from "./dashboard.ts";
import type { NotesFilter } from "./dashboard.ts";
import {
  DECK_IDS,
  DECK_SHORT_NAMES,
  DECK_SLIDE_SEPARATOR,
  DECK_TITLES,
  LIVE_DECK,
  CONDENSED_FACTOR,
  clockText,
  currentSlideIndex,
  deckLengthMs,
  lectureElapsedMs,
  liveWindowMs,
  deckCreditHtml,
  deckSlideCount,
  deckSlides,
  isDeckId,
  isValidSlide,
  slideDurations,
  slideName,
} from "./slides.ts";
import type { DeckId } from "./slides.ts";
import { renderPastedSlide, splitPastedSlides } from "./pasted-slides.ts";

const PORT = Number(process.env.PORT ?? 8080);
const BROWSER_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// The one stylesheet, read once at startup (it ships with the app, so it
// never changes under a running process) and served at /style.css. Every
// page links it from page() below; no page carries an inline <style> or a
// style="" attribute, so there is exactly one place the look lives.
const STYLESHEET = readFileSync(new URL("./style.css", import.meta.url), "utf8");

// The header on every page: the app name (home) and the main nav. Plain
// links in a wrapping list, so it works without JS and folds onto a second
// row at 390px instead of scrolling sideways. `current` marks the page the
// visitor is on with aria-current, for a screen reader and for the style.
type NavKey = "home" | "demo" | "lecturer" | "new" | "readme";
const NAV_LINKS: { key: NavKey; href: string; label: string }[] = [
  { key: "home", href: "/", label: "Home" },
  { key: "demo", href: "/l/demo", label: "Join the demo" },
  { key: "lecturer", href: "/l/demo/lecturer", label: "Lecturer view" },
  { key: "new", href: "/new", label: "Create a lecture" },
  { key: "readme", href: "/readme/", label: "How it works" },
];

function siteHeaderHtml(current?: NavKey): string {
  const links = NAV_LINKS.map(
    (link) =>
      `<li><a href="${link.href}"${link.key === current ? ' aria-current="page"' : ""}>${escapeHtml(link.label)}</a></li>`,
  ).join("\n");
  return `<a class="skip-link" href="#main">Skip to content</a>
<header class="site-header">
<div class="site-header-inner">
<a class="site-name" href="/">Hands Down</a>
<nav class="site-nav" aria-label="Main">
<ul>
${links}
</ul>
</nav>
</div>
</header>`;
}

// The Content-Security-Policy every response carries (CLAUDE.md: never
// weaken it). Scripts run only with this response's nonce, so an inline
// script the server didn't write, or an on*="" attribute, never runs;
// nothing loads from another site; no page can be framed. Styles fall under
// default-src 'self', which /style.css satisfies: no page has inline styles.
function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    "img-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
}

// One nonce per request, made in handleRequest and held here for the rest
// of that request, so page() can stamp it on every inline script without
// each handler passing it along. A page built outside a request (there are
// none today) gets a fresh nonce that no header names, so its scripts
// simply don't run rather than running unchecked.
const requestNonce = new AsyncLocalStorage<string>();

function currentNonce(): string {
  return requestNonce.getStore() ?? randomBytes(16).toString("base64");
}

// Every inline <script> in a page gets this request's nonce, here in one
// place, so a script added anywhere inside page() (this branch's or the
// colour branch's) is covered without remembering to add it.
function withNonce(html: string): string {
  const nonce = currentNonce();
  return html.replace(/<script>/g, `<script nonce="${nonce}">`);
}

const page = (title: string, bodyHtml: string, mainClass?: string, current?: NavKey): string => withNonce(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
${siteHeaderHtml(current)}
<main id="main"${mainClass ? ` class="${mainClass}"` : ""}>
${bodyHtml}
</main>
</body>
</html>`);

const notFoundPage = (): string =>
  page("Not found", `<h1>Not found</h1><p>There's nothing here. <a href="/">Back home</a>.</p>`);

const notFoundResponse = (): Response =>
  new Response(notFoundPage(), {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

const isHttps = (req: Request): boolean => req.headers.get("x-forwarded-proto") === "https";

interface BrowserIdentity {
  browserId: string;
  headers: Headers;
}

// Every GET/POST handler that renders a page needs a browser identity and,
// if one was just minted, a Set-Cookie for it — the same five-plus lines
// were repeated verbatim in handleLecture, handleLecturerGet,
// handleLecturerPost, and both /new handlers. Returns headers already
// carrying the content-type and (if minted) the cookie, so a caller only
// ever needs to add anything further, never rebuild this part.
function ensureBrowserIdentity(req: Request): BrowserIdentity {
  const { id: browserId, minted } = ensureBrowserId(req.headers.get("cookie"));
  const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
  if (minted) {
    headers.append(
      "set-cookie",
      serializeCookie(BROWSER_COOKIE, browserId, {
        httpOnly: true,
        sameSite: "Lax",
        path: "/",
        secure: isHttps(req),
        maxAgeSeconds: BROWSER_COOKIE_MAX_AGE,
      }),
    );
  }
  return { browserId, headers };
}

// decodeURIComponent throws on malformed percent-encoding (a lone %E0 isn't
// valid UTF-8) rather than failing softly, and a lecture id comes straight
// from the URL path — so a bad request must not look like a bug that takes
// the whole process down. undefined means "treat this as not found".
function safeDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

// Three ways in, one card each. The demo's code isn't shown here: CLAUDE.md
// allows DEMO on the demo's own pages only, so the lecturer card links to
// the demo's lecturer view, which is where the code is asked for.
async function handleHome(): Promise<Response> {
  const body = `
    <h1>Hands Down</h1>
    <p class="lede">The hand you didn't put up, counted. Tap when you stop following a lecture: nobody sees who, everybody sees how many.</p>
    <ul class="home-cards">
      <li class="card home-card" id="home-student">
        <h2>I'm a student</h2>
        <p>Tap when you stop following. The demo is shared, so others' taps show too.</p>
        <p><a href="/l/demo" class="pill-link primary">Join the demo</a></p>
      </li>
      <li class="card home-card" id="home-lecturer">
        <h2>I'm a lecturer</h2>
        <p>See what the room sees, or start your own lecture: it begins empty.</p>
        <p class="card-links"><a href="/l/demo/lecturer" class="pill-link">Open the demo lecturer view</a> <a href="/new">Create a lecture</a></p>
      </li>
      <li class="card home-card" id="home-how">
        <h2>How it works</h2>
        <p>What Hands Down counts, and what it never shows.</p>
        <p><a href="/readme/" class="pill-link">Read how it works</a></p>
      </li>
    </ul>
  `;
  return new Response(page("Hands Down", body, "home", "home"), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

type GaugeState = { present: number; shown: false } | { present: number; shown: true; live: number };

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

// The gauge is three nodes. What a sighted person reads is one sentence,
// "4 of 23 people here are lost right now", but that sentence holds the present
// count, which changes on every arrival and departure and isn't news worth
// announcing. So the sentence is aria-hidden, and a screen reader gets the
// same facts from two visually hidden nodes instead: the lost count, which
// is aria-live and changes only when the lost count changes or the gauge
// appears or disappears, and the present count, which isn't live.
// Announcing presence changes was the "noisy aria-live" finding from the
// C10 feedback review. Below min_present no count or bar is rendered at
// all, and the live node holds one fixed sentence, so people arriving while
// the room fills up announce nothing either.
// A tap stays live for 60 seconds even if its tab closes, while present
// counts only open pages, so live can briefly exceed present. Someone who
// tapped in the last minute was here, so the "of" side is never smaller
// than the lost side: no "4 of 3".
function gaugeOf(state: { present: number; live: number }): number {
  return Math.max(state.present, state.live);
}

function gaugeWords(state: GaugeState, minPresent: number): string {
  if (state.shown) {
    const of = gaugeOf(state);
    return `${state.live} of ${of} ${plural(of, "person", "people")} here ${plural(state.live, "is", "are")} lost right now`;
  }
  const more = Math.max(0, minPresent - state.present);
  return `Waiting for ${more} more ${plural(more, "person", "people")}`;
}

function lostText(state: GaugeState): string {
  if (state.shown) return `${state.live} ${plural(state.live, "person is", "people are")} lost right now`;
  return "The count shows once enough people are here";
}

function presentText(present: number): string {
  return `${present} ${plural(present, "person", "people")} here`;
}

// A quiet horizontal bar. Its fill is an SVG rect whose width attribute is
// a percentage of the viewBox, so no inline style ever carries a number.
function quietBarHtml(id: string, fraction: number): string {
  const width = Math.round(Math.min(1, Math.max(0, fraction)) * 1000) / 10;
  return `<svg class="gauge-bar" id="${id}" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true" focusable="false"><rect class="gauge-track" width="100" height="4"></rect><rect class="gauge-fill" width="${width}" height="4"></rect></svg>`;
}

function gaugeHtml(state: GaugeState, minPresent: number): string {
  const bar = state.shown ? quietBarHtml("gauge-bar", gaugeOf(state) > 0 ? state.live / gaugeOf(state) : 0) : "";
  return `<section id="gauge" aria-label="Lost right now">
      <p class="gauge-words" id="gauge-words" aria-hidden="true">${escapeHtml(gaugeWords(state, minPresent))}</p>
      ${bar}
      <p class="visually-hidden"><span id="gauge-lost" aria-live="polite">${escapeHtml(lostText(state))}</span>. <span id="gauge-present">${escapeHtml(presentText(state.present))}</span>.</p>
    </section>`;
}

// The browser half of the same gauge, shared by the student and lecturer
// scripts so the two pages can't drift apart. Text is only written when it
// actually differs, so a re-render with the same lost count never touches
// the aria-live node at all.
const GAUGE_CLIENT_JS = `
        function setText(el, text) {
          if (el && el.textContent !== text) el.textContent = text;
        }
        function plural(n, one, many) {
          return n === 1 ? one : many;
        }
        function renderGauge(state, minPresent) {
          var words = document.getElementById("gauge-words");
          if (!words) return;
          var bar = document.getElementById("gauge-bar");
          setText(document.getElementById("gauge-present"), state.present + " " + plural(state.present, "person", "people") + " here");
          if (state.shown) {
            var of = Math.max(state.present, state.live);
            setText(words, state.live + " of " + of + " " + plural(of, "person", "people") + " here " + plural(state.live, "is", "are") + " lost right now");
            setText(document.getElementById("gauge-lost"), state.live + " " + plural(state.live, "person is", "people are") + " lost right now");
            if (!bar) {
              var holder = document.createElement("div");
              holder.innerHTML = ${JSON.stringify(quietBarHtml("gauge-bar", 0))};
              bar = holder.firstElementChild;
              words.insertAdjacentElement("afterend", bar);
            }
            var fraction = of > 0 ? state.live / of : 0;
            bar.querySelector(".gauge-fill").setAttribute("width", String(Math.round(fraction * 1000) / 10));
          } else {
            var more = Math.max(0, minPresent - state.present);
            setText(words, "Waiting for " + more + " more " + plural(more, "person", "people"));
            setText(document.getElementById("gauge-lost"), "The count shows once enough people are here");
            if (bar) bar.remove();
          }
        }
`;

// The browser half of slideName (src/slides.ts), shared by the student and
// lecturer scripts, so a slide is named the same way before and after a
// live update.
const SLIDE_NAME_CLIENT_JS = `
        var deckShortNames = ${JSON.stringify(DECK_SHORT_NAMES)};
        var deckSlideSeparator = ${JSON.stringify(DECK_SLIDE_SEPARATOR)};
        function slideName(deck, slide, options) {
          options = options || {};
          var short = deck ? deckShortNames[deck] : undefined;
          var name = short ? short + deckSlideSeparator + "slide " + slide : "Slide " + slide;
          var of = options.of !== undefined ? " of " + options.of : "";
          return name + of + (options.live ? " (live)" : "");
        }
`;

function barLabel(bar: Bar): string {
  return slideName(bar.deck, bar.slide);
}

// Bars are rendered twice: an inline SVG chart (viewBox-based, so it scales
// to any width without a fixed pixel size — keeps it from forcing
// horizontal scroll at 390px) and a text <table> alternative for screen
// readers. A bar with 0 entries renders neither — there's nothing in the
// markup for a curious viewer to read past an empty chart, same discipline
// as every other gated element on this page.
function barsHtml(bars: Bar[]): string {
  if (bars.length === 0) return "";
  const sorted = [...bars].sort((a, b) => (a.deck ?? "").localeCompare(b.deck ?? "") || a.slide - b.slide);
  const maxCount = Math.max(...sorted.map((b) => b.distinctBrowsers));
  const barWidth = 80;
  const gap = 20;
  const chartWidth = sorted.length * (barWidth + gap) + gap;
  const chartHeight = 200;
  const maxBarHeight = 150;
  const rects = sorted
    .map((bar, i) => {
      const height = maxCount > 0 ? Math.round((bar.distinctBrowsers / maxCount) * maxBarHeight) : 0;
      const x = gap + i * (barWidth + gap);
      const y = chartHeight - height - 20;
      return `<rect x="${x}" y="${y}" width="${barWidth}" height="${height}" fill="currentColor"><title>${escapeHtml(barLabel(bar))}: ${bar.distinctBrowsers}</title></rect><text x="${x + barWidth / 2}" y="${chartHeight - 4}" text-anchor="middle" font-size="16">${i + 1}</text>`;
    })
    .join("\n");
  return `
    <svg class="bar-chart" id="bars-chart" viewBox="0 0 ${chartWidth} ${chartHeight}" role="img" aria-label="Distinct people lost, per slide">
      ${rects}
    </svg>
    <table class="bars" id="bars-table">
      <thead><tr><th scope="col">Slide</th><th scope="col">People lost here</th></tr></thead>
      <tbody>
${sorted.map((bar) => `<tr><td>${escapeHtml(barLabel(bar))}</td><td>${bar.distinctBrowsers}</td></tr>`).join("\n")}
      </tbody>
    </table>
  `;
}

// The demo lecture has two decks. Both are rendered entirely server-side,
// every slide of each, so switching decks or slides is a pure visibility
// toggle with no fetch involved — the script below only flips `hidden`, it
// never loads content over the wire (which would mean a client-side request
// back to this same server just to switch what's showing; rendering
// everything up front avoids that entirely, and keeps a no-JS visitor's
// browsing behaviour identical to a JS one's). A created (/new) lecture shows
// the slide text its lecturer pasted, if any (pastedSlidesHtml); without
// it there's just the number the lecturer advances, and nothing here.
function slideSectionHtml(lectureId: string, viewedDeck: DeckId, viewedSlide: number): string {
  if (lectureId !== "demo") return pastedSlidesHtml(lectureId, viewedSlide);
  const deckDivs = DECK_IDS.map((deckId) => {
    const sections = deckSlides(deckId)
      .map((html, i) => {
        const slideNumber = i + 1;
        const visible = deckId === viewedDeck && slideNumber === viewedSlide;
        return `<section class="slide" data-slide="${slideNumber}"${visible ? "" : " hidden"}>${html}</section>`;
      })
      .join("\n");
    const deckHidden = deckId === viewedDeck ? "" : " hidden";
    return `<div class="deck" data-deck="${deckId}"${deckHidden}>\n${sections}\n<footer class="slide-credit">${deckCreditHtml(deckId)}</footer>\n</div>`;
  }).join("\n");
  return `<div id="slides">\n${deckDivs}\n</div>`;
}

// A created lecture's pasted slides, every one rendered and all but the
// current one hidden, the way the demo shows a deck, so a live slide change
// is a visibility toggle. Rendered on each view from the stored markdown by
// the escaping renderer in src/pasted-slides.ts; never stored as HTML.
function pastedSlidesHtml(lectureId: string, currentSlide: number): string {
  const slides = lectureSlides(lectureId);
  if (slides.length === 0) return "";
  const sections = slides
    .map((markdown, i) => {
      const slideNumber = i + 1;
      const hidden = slideNumber === currentSlide ? "" : " hidden";
      return `<section class="slide" data-slide="${slideNumber}"${hidden}>${renderPastedSlide(markdown)}</section>`;
    })
    .join("\n");
  return `<div id="slides" class="pasted-slides">\n${sections}\n</div>`;
}

function slideProgressLabel(lectureId: string, deck: DeckId, slide: number, liveSlide: number): string {
  const name =
    lectureId === "demo"
      ? slideName(deck, slide, { of: deckSlideCount(deck), live: slide === liveSlide })
      : slideName(null, slide, { live: slide === liveSlide });
  return `<p id="slide-label">${escapeHtml(name)}</p>`;
}

// A plain <select>, submitting via its own tiny no-JS form — picking a deck
// (?deck=D, no slide) lands on that deck's live slide, which is slide 1 if
// nobody is watching it. The enhancement script intercepts `change` to
// switch client-side and reconnect its stream on the new deck instead of
// submitting. Only rendered for the demo — a created lecture has no deck
// choice at all.
function deckMenuHtml(lectureId: string, viewedDeck: DeckId): string {
  if (lectureId !== "demo") return "";
  const base = `/l/${encodeURIComponent(lectureId)}`;
  const options = DECK_IDS.map(
    (id) => `<option value="${id}"${id === viewedDeck ? " selected" : ""}>${escapeHtml(DECK_TITLES[id])}</option>`,
  ).join("\n");
  return `
    <form method="get" action="${base}" id="deck-form">
      <label for="deck-select">Lecture</label>
      <select name="deck" id="deck-select">
        ${options}
      </select>
      <noscript><button type="submit">Go</button></noscript>
    </form>
  `;
}

// Previous/Next as plain links (?deck=D&slide=N) work with no JS at all,
// each a full page load; the script below intercepts clicks to switch
// slides client-side instead. "Back to live" returns to the live slide of
// the deck being viewed (?deck=D with no slide), in one step — each demo
// deck runs its own clock. ADR 004's amendment: browsing is now how a tap
// records an earlier slide, replacing the old grace-window reconciliation
// outright. The link is always in the markup, `hidden` while on the live
// slide, so the script can reveal it when the clock moves on. Only
// rendered for the demo — a created lecture has no deck content in the app
// to browse, just a number the lecturer advances, so there's nothing here
// for a student to flip between.
function slideNavHtml(lectureId: string, viewedDeck: DeckId, viewedSlide: number, liveSlide: number): string {
  if (lectureId !== "demo") return "";
  const base = `/l/${encodeURIComponent(lectureId)}`;
  const maxSlide = deckSlideCount(viewedDeck);
  const prevSlide = viewedSlide - 1;
  const nextSlide = viewedSlide + 1;
  const prevHtml =
    prevSlide >= 1
      ? `<a href="${base}?deck=${viewedDeck}&slide=${prevSlide}" id="slide-prev-link">Previous slide</a>`
      : `<span id="slide-prev-link" aria-disabled="true">Previous slide</span>`;
  const nextHtml =
    nextSlide <= maxSlide
      ? `<a href="${base}?deck=${viewedDeck}&slide=${nextSlide}" id="slide-next-link">Next slide</a>`
      : `<span id="slide-next-link" aria-disabled="true">Next slide</span>`;
  const onLive = viewedSlide === liveSlide;
  const backToLiveHtml = `<a href="${base}?deck=${viewedDeck}" id="back-to-live-link"${onLive ? " hidden" : ""}>Back to live</a>`;
  return `
    <nav id="slide-nav" aria-label="Slide navigation">
      ${prevHtml}
      ${nextHtml}
      ${backToLiveHtml}
    </nav>
  `;
}

// The demo's condensed clock (ADR 006): how far into the deck's 5 minutes
// the shared clock is, and what that would be in the 60-minute lecture it
// stands in for. The page script ticks both each second between frames.
function lectureTimeText(deck: DeckId, elapsedMs: number): string {
  return `Lecture time ${clockText(elapsedMs)} / ${clockText(deckLengthMs(deck))}`;
}

function condensedText(elapsedMs: number): string {
  return `Condensed ${CONDENSED_FACTOR}x from a 60-minute lecture (real time ${clockText(elapsedMs * CONDENSED_FACTOR)})`;
}

function lectureTimeHtml(deck: DeckId, elapsedMs: number): string {
  return `<div class="lecture-clock">
          <p id="lecture-time">${lectureTimeText(deck, elapsedMs)}</p>
          <p id="lecture-condensed">${condensedText(elapsedMs)}</p>
        </div>`;
}

// Says whether this viewer is on the live slide, or where the lecture is if
// they've browsed away. Rendered here so it's right without JS; the script
// rewrites the same text on browsing and on every stream frame. Plain text,
// not aria-live: the clock moves every few seconds, and announcing that each time
// would chatter.
function liveMarkerText(deck: DeckId, viewedSlide: number, liveSlide: number): string {
  return viewedSlide === liveSlide
    ? "Live"
    : `You're on ${slideName(deck, viewedSlide)}. The lecture is on ${slideName(deck, liveSlide)}.`;
}

// The fixed list of reasons, checked on the server. A function so it can be
// used above where REASONS is declared, at module load.
function REASONS_LIST(): string[] {
  return ["Too fast", "Missed a step", "Notation", "Can't see or hear"];
}

// Reason buttons appear after tapping, while the caller's own tap is live.
// A fixed list, checked server-side — no free text for students, per
// CLAUDE.md. Each is a tiny one-field <form>, so it works with no JS as a
// full page POST; the enhancement script intercepts submit to send it via
// fetch instead, same pattern as the tap form. A reason locks once sent
// (ADR 006); see answerButtonsHtml. Each form names the deck
// and slide it's about: with one tap per slide, a browser can have live
// taps on two slides at once.
function slideFieldsHtml(deck: DeckId | undefined, slide: number): string {
  const deckInput = deck !== undefined ? `<input type="hidden" name="deck" value="${deck}">` : "";
  return `${deckInput}<input type="hidden" name="slide" value="${slide}">`;
}

// One button per answer on a fixed list, each its own one-field form so it
// works without JS. Answers lock once sent (ADR 006): after one is chosen
// it's marked aria-pressed="true" and class "answer-chosen", the others
// "answer-other" (style.css dims those), and every button is disabled. The
// page script builds the same markup (buildAnswersHtml) from the same
// inputs, so the two can't drift apart.
interface AnswerSet {
  id: string;
  legend: string;
  path: string;
  field: string;
  formClass: string;
  options: string[];
}

function answerButtonsHtml(
  lectureId: string,
  set: AnswerSet,
  deck: DeckId | undefined,
  slide: number,
  chosen: string | null,
  locked: boolean,
): string {
  const base = `/l/${encodeURIComponent(lectureId)}`;
  const buttons = set.options
    .map((option) => {
      const pressed = chosen === option;
      const cls = chosen === null ? "answer" : pressed ? "answer answer-chosen" : "answer answer-other";
      return `<form method="post" action="${base}${set.path}" class="${set.formClass}">
      ${slideFieldsHtml(deck, slide)}
      <input type="hidden" name="${set.field}" value="${escapeHtml(option)}">
      <button type="submit" class="${cls}" aria-pressed="${pressed}"${locked ? " disabled" : ""}>${escapeHtml(option)}</button>
    </form>`;
    })
    .join("\n");
  return `
    <fieldset id="${set.id}">
      <legend>${escapeHtml(set.legend)}</legend>
      ${buttons}
    </fieldset>
  `;
}

const REASON_SET: AnswerSet = {
  id: "reasons",
  legend: "What kind of lost?",
  path: "/reason",
  field: "reason",
  formClass: "reason-form",
  options: REASONS_LIST(),
};

// Shown in place of the reasons once "I get it now" is pressed for the
// slide being viewed: the reasons no longer apply, what helped does.
const HELPED = ["The next slide", "Re-reading it", "The example", "Someone explained it", "Worked it out myself"];
const GLAD_TEXT = "Glad you've got it now.";
const HELPED_SET: AnswerSet = {
  id: "helped",
  legend: "What helped your understanding?",
  path: "/helped",
  field: "helped",
  formClass: "helped-form",
  options: HELPED,
};

function reasonButtonsHtml(
  lectureId: string,
  deck: DeckId | undefined,
  slide: number,
  live: boolean,
  chosen: string | null,
): string {
  if (!live) return "";
  return answerButtonsHtml(lectureId, REASON_SET, deck, slide, chosen, chosen !== null);
}

function helpedHtml(lectureId: string, deck: DeckId | undefined, slide: number, resolved: boolean, chosen: string | null): string {
  if (!resolved) return "";
  return `<div id="after-clicked">
      <p id="glad-text">${GLAD_TEXT}</p>
      ${answerButtonsHtml(lectureId, HELPED_SET, deck, slide, chosen, chosen !== null)}
    </div>`;
}

// What this browser has said about the slide it's looking at: nothing yet,
// lost and still counted, or lost earlier (resolved, or past the live
// window). One "I'm lost" per slide, ever, so once tapped a slide stays
// tapped for this browser. Only ever computed from its own taps.
type SlideTapStatus = "none" | "live" | "said";

function slideTapStatus(yourSlides: YourSlide[], deck: string | null, slide: number): SlideTapStatus {
  const mine = yourSlides.find((s) => s.deck === deck && s.slide === slide);
  if (mine === undefined) return "none";
  return mine.live ? "live" : "said";
}

const TAP_BUTTON_TEXT: Record<SlideTapStatus, string> = {
  none: "I'm lost",
  live: "You're counted",
  said: "Counted on this slide",
};
const SAID_ON_SLIDE = "You've said you're lost on this slide.";

// The note field: optional, appears alongside the reason buttons while a
// tap is live. "Only your lecturer sees this" is not just a UI claim —
// MeterState never carries note text at all, so a student page has nothing
// to leak even if this copy were wrong.
function noteFormHtml(lectureId: string, deck: DeckId | undefined, slide: number, live: boolean): string {
  if (!live) return "";
  const base = `/l/${encodeURIComponent(lectureId)}`;
  const deckInput = deck !== undefined ? `<input type="hidden" name="deck" value="${deck}">` : "";
  return `
    <form method="post" action="${base}/note" id="note-form">
      ${deckInput}
      <input type="hidden" name="slide" value="${slide}">
      <label for="note-text">What part of this didn't make sense?</label>
      <p id="note-hint">Only your lecturer sees this, and only alongside other people's notes.</p>
      <textarea id="note-text" name="text" maxlength="200" placeholder="e.g. when the budget suddenly included the tool output"></textarea>
      <p id="note-counter">0/200</p>
      <button type="submit" id="note-send">Send</button>
      <p id="note-status" aria-live="polite"></p>
    </form>
  `;
}

// A lecturer who lands on the student page can find their own view. The
// demo's code is public on purpose (CLAUDE.md, ADR 003), so it's shown
// beside the link; no other lecture's code is ever shown after creation.
function lecturerLinkHtml(lectureId: string): string {
  const code = lectureId === "demo" ? ` <span class="lecturer-code">Code: DEMO</span>` : "";
  return `<p class="lecturer-link"><a href="/l/${encodeURIComponent(lectureId)}/lecturer">Lecturer view</a>${code}</p>`;
}

const HELP_OFFER_TEXT = "Want a hand with this?";
const HELP_OFFER_LINK_TEXT = "Your lecturer offers help here.";

// rel="noreferrer": following the link doesn't tell the other site which
// lecture page the student came from.
function helpOfferInnerHtml(url: string): string {
  return `<p id="help-offer" class="help-offer">${HELP_OFFER_TEXT} <a href="${escapeHtml(url)}" rel="noreferrer">${HELP_OFFER_LINK_TEXT}</a></p>`;
}

async function handleLecture(id: string, req: Request): Promise<Response> {
  const lecture = getLecture(id);
  if (!lecture) return notFoundResponse();

  const { browserId, headers } = ensureBrowserIdentity(req);
  logAction("page_view", id, browserId);

  const params = new URL(req.url).searchParams;
  const requestedDeckRaw = params.get("deck");
  const requestedSlideRaw = params.get("slide");
  const requestedDeck = requestedDeckRaw !== null && isDeckId(requestedDeckRaw) ? requestedDeckRaw : undefined;
  const requestedSlideNumber = requestedSlideRaw !== null ? Number(requestedSlideRaw) : NaN;

  // Omitting deck means the default live deck. Omitting slide means that
  // deck's live slide — its own clock's, which is slide 1 when nobody is
  // watching it — so a bare /l/demo, the deck menu (?deck=D) and "Back to
  // live" (?deck=D) all land on live. Previous/Next links always name both.
  // Rendering never starts a clock: only an open student stream does.
  const viewedDeck: DeckId = requestedDeck ?? LIVE_DECK;
  const liveSlide = currentSlideIndex(lecture, viewedDeck);
  const viewedSlide =
    requestedSlideRaw === null
      ? liveSlide
      : Number.isFinite(requestedSlideNumber) && isValidSlide(lecture, viewedDeck, requestedSlideNumber)
        ? requestedSlideNumber
        : 1;
  // Whether this page arrived meaning "put me on live" rather than naming a
  // slide: the script then lands on the slide its stream's first frame
  // reports (see landOnLive below).
  const arrivedLive = requestedSlideRaw === null;

  const state = computeState(id, browserId, id === "demo" ? viewedDeck : null) ?? {
    present: 0,
    shown: false as const,
    slide: liveSlide,
    bars: [] as Bar[],
    yourTapCount: 0,
    youAreCounted: false,
    yourSlides: [] as YourSlide[],
  };
  // The tap controls follow the slide this browser is viewing: "I'm lost"
  // on a slide it hasn't tapped, and on one it has, the button stays
  // unavailable and says so. Reasons, the note and "I get it now" appear
  // while that slide's tap is live. The status line and "I get it now" are
  // always in the DOM (hidden when not needed), so a live update from
  // another tab has stable elements to change rather than building them.
  const viewedDeckOrNull = id === "demo" ? viewedDeck : null;
  const tapStatus = slideTapStatus(state.yourSlides, viewedDeckOrNull, viewedSlide);
  const viewedLive = tapStatus === "live";
  const viewedMine = state.yourSlides.find((s) => s.deck === viewedDeckOrNull && s.slide === viewedSlide);
  const viewedResolved = viewedMine?.resolved ?? false;
  // Tapped and not yet resolved: the reasons and "I get it now" stay for the
  // rest of the lecture, not only while the tap is live. The note stays tied
  // to the live window.
  const viewedOpen = viewedMine !== undefined && !viewedResolved;
  // This browser's own answers on the viewed slide, to mark the chosen
  // button pressed. Read for this page only; never put in a stream.
  const yourAnswers =
    viewedMine !== undefined ? yourAnswersOn(id, browserId, { deck: viewedDeckOrNull, slide: viewedSlide }) : undefined;
  // The status line and "I get it now" sit beside the tap form, not inside
  // it: a <form> nested in another is dropped by the HTML parser, which left
  // "I get it now" submitting a tap instead of resolving one.
  const buttonHtml = `<button class="tap-button" id="tap-button" type="submit"${tapStatus === "none" ? "" : " disabled"}>${TAP_BUTTON_TEXT[tapStatus]}</button>`;
  const tapStatusHtml = `<div class="tap-status">
        <p id="tap-said"${tapStatus === "none" ? " hidden" : ""}>${SAID_ON_SLIDE}</p>
        <form method="post" action="/l/${encodeURIComponent(id)}/resolve" id="resolve-form"${viewedOpen ? "" : " hidden"}>
          ${slideFieldsHtml(id === "demo" ? viewedDeck : undefined, viewedSlide)}
          <button type="submit">I get it now</button>
        </form>
      </div>`;

  // Below min_present, "Total taps" isn't rendered at all — not blanked,
  // not zeroed, just absent — since a hidden gauge still leaking the real
  // total in a sibling element would defeat the point of hiding it.
  const tapCountHtml = state.shown ? `<p id="tap-count">Total taps: ${state.totalTaps}</p>` : "";
  // Only in this browser's own render, and only once it has said it's lost
  // on HELP_AFTER_SLIDES slides in the current run (realtime.ts decides).
  const helpOfferHtml = state.helpUrl !== undefined ? helpOfferInnerHtml(state.helpUrl) : "";
  const topReasonHtml =
    "topReason" in state && state.topReason !== undefined
      ? `<p id="top-reason">Most people here say: ${escapeHtml(state.topReason)}</p>`
      : "";

  const slidesHtml = slideSectionHtml(id, viewedDeck, viewedSlide);

  // Layout containers only; the order in the markup is the phone order
  // (slide, gauge, the sticky tap bar, then reasons and the note below it).
  // style.css places the same blocks in two columns on a wide screen.
  // The slide card's top row is the slide chip and the live marker; the
  // row carries "on-live" while the viewer is on the live slide, which is
  // what turns the marker into the LIVE pill (the script toggles it too).
  const onLiveNow = viewedSlide === liveSlide;
  const body = `
    <div class="lecture-head">
      <h1>${escapeHtml(lecture.title)}</h1>
      ${deckMenuHtml(id, viewedDeck)}
      ${lecturerLinkHtml(id)}
    </div>
    <div class="lecture-layout${slidesHtml === "" ? " no-deck" : ""}">
      <div class="slide-col">
        <div class="slide-card">
          <div class="slide-bar${onLiveNow ? " on-live" : ""}" id="slide-bar">
            ${slideProgressLabel(id, viewedDeck, viewedSlide, liveSlide)}
            ${id === "demo" ? `<p id="live-marker">${escapeHtml(liveMarkerText(viewedDeck, viewedSlide, liveSlide))}</p>` : ""}
          </div>
          ${slidesHtml}
        </div>
        ${id === "demo" ? lectureTimeHtml(viewedDeck, lectureElapsedMs(id, viewedDeck)) : ""}
        <div id="timeline">${timelineHtml(lecture, viewedDeck, viewedSlide, liveSlide, state.bars)}</div>
        ${slideNavHtml(id, viewedDeck, viewedSlide, liveSlide)}
      </div>
      <div class="gauge-panel">
        ${gaugeHtml(state, lecture.min_present)}
        <p id="connection-status" aria-live="polite"></p>
        ${topReasonHtml}
      </div>
      <div class="tap-bar">
        <form method="post" action="/l/${encodeURIComponent(id)}/tap" id="tap-form">
          ${id === "demo" ? `<input type="hidden" name="deck" id="deck-input" value="${viewedDeck}">` : ""}
          <input type="hidden" name="slide" id="slide-input" value="${viewedSlide}">
          ${buttonHtml}
        </form>
        ${tapStatusHtml}
      </div>
      <div class="after-tap">
        <div id="help-offer-slot" aria-live="polite">${helpOfferHtml}</div>
        ${reasonButtonsHtml(id, id === "demo" ? viewedDeck : undefined, viewedSlide, viewedOpen, yourAnswers?.reason ?? null)}
        ${helpedHtml(id, id === "demo" ? viewedDeck : undefined, viewedSlide, viewedResolved, yourAnswers?.helped ?? null)}
        ${noteFormHtml(id, id === "demo" ? viewedDeck : undefined, viewedSlide, viewedLive)}
        <p id="tap-feedback" aria-live="polite"></p>
        ${tapCountHtml}
        <div id="bars">${barsHtml(state.bars)}</div>
        <p id="your-count">You've said you're lost ${state.yourTapCount} time${state.yourTapCount === 1 ? "" : "s"} in this lecture</p>
        <p id="tap-hint">Other tabs in this browser count as you.</p>
      </div>
    </div>
    <script>
      (function () {
        var minPresent = ${JSON.stringify(lecture.min_present)};
        var deckSlideCounts = ${JSON.stringify(
          id === "demo" ? Object.fromEntries(DECK_IDS.map((d) => [d, deckSlideCount(d)])) : undefined,
        )};
        var deckLengths = ${JSON.stringify(
          id === "demo" ? Object.fromEntries(DECK_IDS.map((d) => [d, deckLengthMs(d)])) : undefined,
        )};
        var condensedFactor = ${JSON.stringify(CONDENSED_FACTOR)};
${GAUGE_CLIENT_JS}
${SLIDE_NAME_CLIENT_JS}
        var form = document.getElementById("tap-form");
        var button = document.getElementById("tap-button");
        var feedback = document.getElementById("tap-feedback");
        var tapCount = document.getElementById("tap-count");
        var yourCount = document.getElementById("your-count");
        var slideInput = document.getElementById("slide-input");
        var deckInput = document.getElementById("deck-input");
        var deckSelect = document.getElementById("deck-select");
        var deckForm = document.getElementById("deck-form");
        var connectionStatus = document.getElementById("connection-status");

        var liveMarker = document.getElementById("live-marker");
        var slideBar = document.getElementById("slide-bar");

        // Kept separate: the deck/slide this browser is looking at (what a
        // tap records, what the arrows move), and the live slide of that
        // deck's shared clock (what "Back to live" returns to in one step).
        // Browsing away from live never changes the live slide for anyone.
        var viewedDeck = ${JSON.stringify(viewedDeck)};
        var viewedSlide = ${JSON.stringify(viewedSlide)};
        var liveSlide = ${JSON.stringify(liveSlide)};
        // True while this page means "put me on live" and the viewer hasn't
        // browsed yet: the stream's first frame then lands on the slide it
        // reports. That covers arriving with no ?slide= (a refresh while
        // alone restarts the clock just after this page rendered) and
        // switching deck (joining that deck's clock wherever it is). Once
        // landed, the view stays put as the clock moves on — the marker and
        // "Back to live" say where the lecture is.
        var landOnLive = ${JSON.stringify(arrivedLive)};

        function maxSlideFor(deck) {
          return deckSlideCounts ? deckSlideCounts[deck] : undefined;
        }

        // The label says "(live)" only while this viewer is on the live
        // slide, so it's rewritten whenever either one moves.
        function updateLiveState() {
          var onLive = viewedSlide === liveSlide;
          var labelDeck = isDemo ? viewedDeck : null;
          var label = document.getElementById("slide-label");
          if (label) {
            label.textContent = slideName(labelDeck, viewedSlide, { of: maxSlideFor(viewedDeck), live: onLive });
          }
          if (slideBar) slideBar.classList.toggle("on-live", onLive);
          if (liveMarker) {
            liveMarker.textContent = onLive
              ? "Live"
              : "You're on " + slideName(labelDeck, viewedSlide) + ". The lecture is on " + slideName(labelDeck, liveSlide) + ".";
          }
          var backLink = document.getElementById("back-to-live-link");
          if (backLink) {
            backLink.hidden = onLive;
            backLink.setAttribute("href", tapBaseUrl + "?deck=" + viewedDeck);
          }
        }

        // The timeline is re-marked in place, never rebuilt: which segment is
        // live, which one this browser is viewing (only when that isn't the
        // live slide), and which slides have a bar. Until the first stream
        // frame, the server-rendered shading stands.
        var timelineBars = null;
        function timelineLinkTarget(link) {
          var href = link && (link.getAttribute("href") || link.getAttribute("xlink:href"));
          if (!href) return null;
          var params = new URLSearchParams(href.split("?")[1] || "");
          var slide = Number(params.get("slide"));
          if (!slide) return null;
          return { deck: params.get("deck") || viewedDeck, slide: slide };
        }
        // The live and "you" marks are ring rects inside a segment's link
        // (inset as in src/timeline.ts), so a mark moves to its new link
        // rather than the timeline being redrawn.
        var RING_INSET = 2;
        function placeRing(cls, seg) {
          var svg = document.querySelector("#timeline svg");
          if (!svg) return;
          var ring = svg.querySelector("." + cls);
          if (!seg) {
            if (ring) ring.remove();
            return;
          }
          if (!ring) {
            ring = document.createElementNS("http://www.w3.org/2000/svg", "rect");
            ring.setAttribute("class", cls);
          }
          var x = Number(seg.getAttribute("x"));
          var w = Number(seg.getAttribute("width"));
          var h = Number(seg.getAttribute("height"));
          ring.setAttribute("x", String(Math.round((x + RING_INSET) * 10) / 10));
          ring.setAttribute("y", String(RING_INSET));
          ring.setAttribute("width", String(Math.max(0, Math.round((w - 2 * RING_INSET) * 10) / 10)));
          ring.setAttribute("height", String(h - 2 * RING_INSET));
          // The live ring sits under the "you" ring, as the server draws it.
          var link = seg.closest("a");
          if (cls === "timeline-live" && link.querySelector(".timeline-you")) {
            link.insertBefore(ring, link.querySelector(".timeline-you"));
          } else if (ring.parentNode !== link || cls === "timeline-you") {
            link.appendChild(ring);
          }
        }
        function markTimeline() {
          var segs = document.querySelectorAll("#timeline .timeline-segment");
          var items = document.querySelectorAll("#timeline-text li");
          var liveSeg = null, youSeg = null;
          for (var i = 0; i < segs.length; i++) {
            var link = segs[i].closest("a");
            var t = timelineLinkTarget(link);
            if (!t || t.deck !== viewedDeck) continue;
            var isLive = t.slide === liveSlide;
            var isYou = t.slide === viewedSlide && viewedSlide !== liveSlide;
            if (isLive) liveSeg = segs[i];
            if (isYou) youSeg = segs[i];
            if (timelineBars) {
              segs[i].classList.toggle("shaded", timelineBars.some(function (b) {
                return (b.deck || viewedDeck) === t.deck && b.slide === t.slide;
              }));
            }
            // The screen-reader list says the same as the rings and shading.
            if (items[i]) {
              var notes = [];
              if (segs[i].classList.contains("shaded")) notes.push("people were lost here");
              if (isLive) notes.push("live");
              if (isYou) notes.push("you're here");
              var name = link.getAttribute("aria-label") || "";
              items[i].textContent = name + (notes.length ? ": " + notes.join(", ") : "");
            }
          }
          placeRing("timeline-live", liveSeg);
          placeRing("timeline-you", youSeg);
        }

        function showSlide(deck, slide) {
          viewedDeck = deck;
          viewedSlide = slide;
          if (deckInput) deckInput.value = deck;
          if (slideInput) slideInput.value = String(slide);
          if (deckSelect) deckSelect.value = deck;
          var decks = document.querySelectorAll("#slides .deck");
          for (var d = 0; d < decks.length; d++) {
            decks[d].hidden = decks[d].dataset.deck !== deck;
          }
          // A created lecture's pasted slides have no deck around them.
          var slides = isDemo
            ? document.querySelectorAll("#slides .deck[data-deck=\\"" + deck + "\\"] .slide")
            : document.querySelectorAll("#slides .slide");
          for (var i = 0; i < slides.length; i++) {
            slides[i].hidden = Number(slides[i].dataset.slide) !== slide;
          }
          var maxSlide = maxSlideFor(deck);
          var prevLink = document.getElementById("slide-prev-link");
          var nextLink = document.getElementById("slide-next-link");
          if (prevLink) {
            if (slide > 1) {
              prevLink.outerHTML = '<a href="?deck=' + deck + '&slide=' + (slide - 1) + '" id="slide-prev-link">Previous slide</a>';
            } else {
              prevLink.outerHTML = '<span id="slide-prev-link" aria-disabled="true">Previous slide</span>';
            }
          }
          if (nextLink) {
            if (!maxSlide || slide < maxSlide) {
              nextLink.outerHTML = '<a href="?deck=' + deck + '&slide=' + (slide + 1) + '" id="slide-next-link">Next slide</a>';
            } else {
              nextLink.outerHTML = '<span id="slide-next-link" aria-disabled="true">Next slide</span>';
            }
          }
          updateLiveState();
          markTimeline();
          attachNavHandlers();
          updateTapControls();
        }

        // One delegated listener: a segment browses this browser to that
        // slide, like the arrows, without changing the live slide for anyone.
        // A segment on another deck is left to its link (a full page load).
        var timelineEl = document.getElementById("timeline");
        if (timelineEl) {
          timelineEl.addEventListener("click", function (event) {
            var link = event.target && event.target.closest ? event.target.closest("a") : null;
            if (!link || !timelineEl.contains(link)) return;
            var t = timelineLinkTarget(link);
            if (!t || t.deck !== viewedDeck) return;
            event.preventDefault();
            landOnLive = false;
            showSlide(t.deck, t.slide);
          });
        }

        function attachNavHandlers() {
          var prevLink = document.getElementById("slide-prev-link");
          var nextLink = document.getElementById("slide-next-link");
          if (prevLink && prevLink.tagName === "A") {
            prevLink.addEventListener("click", function (event) {
              event.preventDefault();
              landOnLive = false;
              showSlide(viewedDeck, viewedSlide - 1);
            });
          }
          if (nextLink && nextLink.tagName === "A") {
            nextLink.addEventListener("click", function (event) {
              event.preventDefault();
              landOnLive = false;
              showSlide(viewedDeck, viewedSlide + 1);
            });
          }
        }
        attachNavHandlers();

        // Attached once: the back link is never replaced, only shown/hidden.
        var backToLiveLink = document.getElementById("back-to-live-link");
        if (backToLiveLink) {
          backToLiveLink.addEventListener("click", function (event) {
            event.preventDefault();
            showSlide(viewedDeck, liveSlide);
          });
        }

        // Each deck runs its own clock, started by whoever opens a stream on
        // it first — so switching deck reconnects the stream naming the new
        // deck (closing the old one, which stops the old deck's clock if this
        // was its last viewer) and lands on the new deck's live slide.
        if (deckSelect && deckForm) {
          deckSelect.addEventListener("change", function (event) {
            event.preventDefault();
            // The old deck's live slide means nothing on the new one; until
            // the new stream's first frame says otherwise, assume slide 1
            // (what an unwatched deck would start on).
            liveSlide = 1;
            showSlide(deckSelect.value, 1);
            landOnLive = true;
            connect();
          });
        }

        document.addEventListener("keydown", function (event) {
          var active = document.activeElement;
          var tag = active && active.tagName;
          if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
          // A created lecture has no slides here to browse: its slide is the
          // lecturer's, and the arrows mustn't quietly change what a tap
          // records.
          if (!isDemo) return;
          var maxSlide = maxSlideFor(viewedDeck);
          if (event.key === "ArrowLeft" && viewedSlide > 1) {
            landOnLive = false;
            showSlide(viewedDeck, viewedSlide - 1);
          }
          if (event.key === "ArrowRight" && (!maxSlide || viewedSlide < maxSlide)) {
            landOnLive = false;
            showSlide(viewedDeck, viewedSlide + 1);
          }
        });

        function renderBars(bars) {
          var container = document.getElementById("bars");
          if (!container) return;
          if (!bars || bars.length === 0) {
            container.innerHTML = "";
            return;
          }
          var sorted = bars.slice().sort(function (a, b) {
            return (a.deck || "").localeCompare(b.deck || "") || a.slide - b.slide;
          });
          var maxCount = Math.max.apply(null, sorted.map(function (b) { return b.distinctBrowsers; }));
          var barWidth = 80, gap = 20, chartHeight = 200, maxBarHeight = 150;
          var chartWidth = sorted.length * (barWidth + gap) + gap;
          var svgNS = "http://www.w3.org/2000/svg";
          var svg = document.createElementNS(svgNS, "svg");
          svg.setAttribute("class", "bar-chart");
          svg.setAttribute("viewBox", "0 0 " + chartWidth + " " + chartHeight);
          svg.setAttribute("role", "img");
          svg.setAttribute("aria-label", "Distinct people lost, per slide");
          sorted.forEach(function (bar, i) {
            var label = slideName(bar.deck, bar.slide);
            var height = maxCount > 0 ? Math.round((bar.distinctBrowsers / maxCount) * maxBarHeight) : 0;
            var x = gap + i * (barWidth + gap);
            var y = chartHeight - height - 20;
            var rect = document.createElementNS(svgNS, "rect");
            rect.setAttribute("x", String(x));
            rect.setAttribute("y", String(y));
            rect.setAttribute("width", String(barWidth));
            rect.setAttribute("height", String(height));
            rect.setAttribute("fill", "currentColor");
            var title = document.createElementNS(svgNS, "title");
            title.textContent = label + ": " + bar.distinctBrowsers;
            rect.appendChild(title);
            svg.appendChild(rect);
            var text = document.createElementNS(svgNS, "text");
            text.setAttribute("x", String(x + barWidth / 2));
            text.setAttribute("y", String(chartHeight - 4));
            text.setAttribute("text-anchor", "middle");
            text.setAttribute("font-size", "16");
            text.textContent = String(i + 1);
            svg.appendChild(text);
          });
          var table = document.createElement("table");
          table.className = "bars";
          var thead = document.createElement("thead");
          thead.innerHTML = "<tr><th>Slide</th><th>People lost here</th></tr>";
          var tbody = document.createElement("tbody");
          sorted.forEach(function (bar) {
            var label = slideName(bar.deck, bar.slide);
            var tr = document.createElement("tr");
            var tdLabel = document.createElement("td");
            tdLabel.textContent = label;
            var tdCount = document.createElement("td");
            tdCount.textContent = String(bar.distinctBrowsers);
            tr.appendChild(tdLabel);
            tr.appendChild(tdCount);
            tbody.appendChild(tr);
          });
          table.appendChild(thead);
          table.appendChild(tbody);
          container.innerHTML = "";
          container.appendChild(svg);
          container.appendChild(table);
        }

        // Answers this browser chose, by "set:deck:slide", kept on this page
        // only so the chosen button stays marked after a live update. The
        // stream never carries the answer itself, only that one was sent.
        var chosenAnswers = {};
        // The server-rendered page already marks this browser's own choice.
        (function () {
          var pressed = document.querySelectorAll(".answer[aria-pressed=true]");
          for (var i = 0; i < pressed.length; i++) {
            var set = pressed[i].closest("fieldset").id;
            chosenAnswers[set + ":" + viewedDeck + ":" + viewedSlide] = pressed[i].textContent;
          }
        })();

        // A sent answer locks at once, before the stream confirms it: the
        // chosen button pressed, the rest dimmed, all of them unavailable.
        // aria-disabled, not disabled, so the button a keyboard user just
        // pressed keeps focus (the tap button does the same).
        function lockAnswers(fieldset, chosen) {
          var buttons = fieldset.querySelectorAll("button.answer");
          for (var i = 0; i < buttons.length; i++) {
            var isChosen = buttons[i].textContent === chosen;
            buttons[i].className = "answer " + (isChosen ? "answer-chosen" : "answer-other");
            buttons[i].setAttribute("aria-pressed", String(isChosen));
            buttons[i].disabled = false;
            buttons[i].setAttribute("aria-disabled", "true");
          }
        }

        function attachAnswerHandlers(fieldset) {
          if (!fieldset) return;
          var disabled = fieldset.querySelectorAll("button.answer[disabled]");
          for (var d = 0; d < disabled.length; d++) {
            disabled[d].disabled = false;
            disabled[d].setAttribute("aria-disabled", "true");
          }
          var forms = fieldset.querySelectorAll("form");
          for (var i = 0; i < forms.length; i++) {
            forms[i].addEventListener("submit", function (event) {
              event.preventDefault();
              var answerForm = event.target;
              var pressedButton = answerForm.querySelector("button.answer");
              if (pressedButton.getAttribute("aria-disabled") === "true") return;
              var chosen = pressedButton.textContent;
              chosenAnswers[fieldset.id + ":" + viewedDeck + ":" + viewedSlide] = chosen;
              lockAnswers(fieldset, chosen);
              fetch(answerForm.action, {
                method: "POST",
                body: new URLSearchParams(new FormData(answerForm)),
              }).catch(function () {});
            });
          }
        }
        attachAnswerHandlers(document.getElementById("reasons"));
        attachAnswerHandlers(document.getElementById("helped"));

        function attachNoteHandlers() {
          var noteFormEl = document.getElementById("note-form");
          var noteTextEl = document.getElementById("note-text");
          var noteCounterEl = document.getElementById("note-counter");
          var noteStatusEl = document.getElementById("note-status");
          if (noteTextEl && noteCounterEl) {
            noteTextEl.addEventListener("input", function () {
              noteCounterEl.textContent = noteTextEl.value.length + "/200";
            });
          }
          if (noteFormEl) {
            noteFormEl.addEventListener("submit", function (event) {
              event.preventDefault();
              if (noteStatusEl) noteStatusEl.textContent = "";
              fetch(noteFormEl.action, { method: "POST", body: new URLSearchParams(new FormData(noteFormEl)) })
                .then(function (res) {
                  if (!res.ok) throw new Error("note failed");
                  if (noteStatusEl) noteStatusEl.textContent = "Sent";
                  if (noteTextEl) noteTextEl.value = "";
                  if (noteCounterEl) noteCounterEl.textContent = "0/200";
                })
                .catch(function () {
                  if (noteStatusEl) noteStatusEl.textContent = "Couldn't send. Try again.";
                });
            });
          }
        }

        var tapBaseUrl = ${JSON.stringify(`/l/${encodeURIComponent(id)}`)};
        var answerSets = ${JSON.stringify({ reasons: REASON_SET, helped: HELPED_SET })};
        var gladText = ${JSON.stringify(GLAD_TEXT)};
        var isDemo = ${JSON.stringify(id === "demo")};

        // The deck and slide a reason, note or "I get it now" is about: the
        // one being viewed when the form was built.
        function slideFieldsHtml() {
          return (isDemo ? '<input type="hidden" name="deck" value="' + viewedDeck + '">' : "")
            + '<input type="hidden" name="slide" value="' + viewedSlide + '">';
        }

        function escapeText(text) {
          return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        }

        // The same markup answerButtonsHtml renders on the server.
        function buildAnswersHtml(set, chosen, locked) {
          var html = '<fieldset id="' + set.id + '"><legend>' + escapeText(set.legend) + '</legend>';
          for (var i = 0; i < set.options.length; i++) {
            var option = set.options[i];
            var pressed = chosen === option;
            var cls = chosen === null ? "answer" : pressed ? "answer answer-chosen" : "answer answer-other";
            html += '<form method="post" action="' + tapBaseUrl + set.path + '" class="' + set.formClass + '">'
              + slideFieldsHtml()
              + '<input type="hidden" name="' + set.field + '" value="' + escapeText(option) + '">'
              + '<button type="submit" class="' + cls + '" aria-pressed="' + pressed + '"' + (locked ? " disabled" : "") + '>'
              + escapeText(option) + '</button></form>';
          }
          return html + '</fieldset>';
        }

        function buildNoteFormHtml() {
          return '<form method="post" action="' + tapBaseUrl + '/note" id="note-form">'
            + slideFieldsHtml()
            + '<label for="note-text">What part of this didn\\'t make sense?</label>'
            + '<p id="note-hint">Only your lecturer sees this, and only alongside other people\\'s notes.</p>'
            + '<textarea id="note-text" name="text" maxlength="200" placeholder="e.g. when the budget suddenly included the tool output"></textarea>'
            + '<p id="note-counter">0/200</p>'
            + '<button type="submit" id="note-send">Send</button>'
            + '<p id="note-status" aria-live="polite"></p>'
            + '</form>';
        }

        // What sits under the tap bar for the slide being viewed:
        // - its tap is live: the reasons (locked once one is sent) and the note;
        // - "I get it now" was pressed: "Glad you've got it now." and what
        //   helped (locked once sent), the reasons gone;
        // - otherwise nothing.
        // Each part is rebuilt only when what it shows changes, so an
        // unrelated live update never tears down a focused button.
        var shownAnswers = {};
        // The parts keep the same order as the server renders them, reasons
        // then note then what helped, so the reading and Tab order never
        // change: a part being rebuilt replaces itself in place, and a new
        // one goes in after the parts that come before it.
        var PART_ORDER = ["reasons", "note-form", "after-clicked"];
        function placePart(id, html) {
          var holder = document.createElement("div");
          holder.innerHTML = html;
          var el = holder.firstElementChild;
          var existing = document.getElementById(id);
          if (existing) {
            existing.replaceWith(el);
            return el;
          }
          var after = null;
          for (var i = PART_ORDER.indexOf(id) - 1; i >= 0 && !after; i--) after = document.getElementById(PART_ORDER[i]);
          if (after) after.insertAdjacentElement("afterend", el);
          else feedback.insertAdjacentElement("beforebegin", el);
          return el;
        }
        function renderAnswerSet(setId, show, answered, wrap) {
          var partId = wrap || setId;
          var key = show ? [viewedDeck, viewedSlide, answered].join(":") : null;
          var existing = document.getElementById(partId);
          if (shownAnswers[setId] === key && (existing !== null) === show) return;
          var hadFocus = existing && existing.contains(document.activeElement);
          shownAnswers[setId] = key;
          if (!show) {
            if (existing) existing.remove();
            return;
          }
          var chosen = chosenAnswers[setId + ":" + viewedDeck + ":" + viewedSlide];
          var setHtml = buildAnswersHtml(answerSets[setId], chosen === undefined ? null : chosen, answered);
          var el = placePart(partId, wrap ? '<div id="' + wrap + '"><p id="glad-text">' + escapeText(gladText) + '</p>' + setHtml + '</div>' : setHtml);
          attachAnswerHandlers(document.getElementById(setId));
          if (hadFocus) {
            var target = el.querySelector(".answer-chosen") || el.querySelector("button.answer");
            if (target) target.focus();
          }
        }
        var noteBuiltFor = null;
        function renderReasonsAndNote(mine) {
          var live = !!(mine && mine.live);
          var resolved = !!(mine && mine.resolved);
          // Tapped and not resolved: the reasons stay for the rest of the
          // lecture; the note stays tied to the live window.
          var open = !!mine && !resolved;
          renderAnswerSet("reasons", open, open && mine.answeredReason);
          var existingNote = document.getElementById("note-form");
          var key = viewedDeck + ":" + viewedSlide;
          if (existingNote && (!live || noteBuiltFor !== key)) {
            existingNote.remove();
            existingNote = null;
          }
          if (live && !existingNote) {
            noteBuiltFor = key;
            placePart("note-form", buildNoteFormHtml());
            attachNoteHandlers();
          }
          renderAnswerSet("helped", resolved, resolved && mine.answeredHelped, "after-clicked");
        }

        var resolveForm = document.getElementById("resolve-form");
        if (resolveForm) {
          resolveForm.addEventListener("submit", function (event) {
            event.preventDefault();
            fetch(resolveForm.action, { method: "POST", body: new URLSearchParams(new FormData(resolveForm)) })
              .catch(function () {});
          });
        }

        attachNoteHandlers();

        function render(state) {
          // A demo frame names its deck; ignore its slide if it's about a
          // deck this page has since switched away from.
          if (!state.deck || state.deck === viewedDeck) {
            liveSlide = state.slide;
            if (typeof state.lectureElapsedMs === "number") syncLectureClock(state.lectureElapsedMs);
            if (landOnLive && isDemo) {
              landOnLive = false;
              showSlide(viewedDeck, liveSlide);
            } else if (!isDemo && viewedSlide !== liveSlide) {
              // A created lecture's slide is wherever the lecturer's Next or
              // Previous left it, and there's nothing here to browse, so the
              // page follows: the label, the slide a tap records, and the
              // tap controls for that slide.
              showSlide(viewedDeck, liveSlide);
            }
            updateLiveState();
          }
          // renderGauge (shared with the lecturer page) only touches the
          // aria-live node on an actual lost-count change or a shown
          // boundary crossing, so a screen reader hears only what's news.
          renderGauge(state, minPresent);
          if (state.shown) {
            if (!tapCount) {
              tapCount = document.createElement("p");
              tapCount.id = "tap-count";
              feedback.insertAdjacentElement("afterend", tapCount);
            }
            tapCount.textContent = "Total taps: " + state.totalTaps;
          } else {
            if (tapCount) {
              tapCount.remove();
              tapCount = null;
            }
          }
          renderBars(state.bars);
          timelineBars = state.bars || [];
          markTimeline();
          var topReasonEl = document.getElementById("top-reason");
          if (state.topReason) {
            if (!topReasonEl) {
              topReasonEl = document.createElement("p");
              topReasonEl.id = "top-reason";
              gauge.insertAdjacentElement("afterend", topReasonEl);
            }
            topReasonEl.textContent = "Most people here say: " + state.topReason;
          } else if (topReasonEl) {
            topReasonEl.remove();
          }
          renderHelpOffer(state.helpUrl);
          yourCount.textContent = "You've said you're lost " + state.yourTapCount + " time" + (state.yourTapCount === 1 ? "" : "s") + " in this lecture";
          lastYourSlides = state.yourSlides || [];
          updateTapControls();
        }

        // This browser's own help offer: present in its frame only once it
        // has said it's lost on enough slides in this run.
        var helpOfferSlot = document.getElementById("help-offer-slot");
        function renderHelpOffer(url) {
          if (!helpOfferSlot) return;
          var link = helpOfferSlot.querySelector("a");
          if (!url) {
            if (helpOfferSlot.firstChild) helpOfferSlot.textContent = "";
            return;
          }
          if (link && link.getAttribute("href") === url) return;
          var p = document.createElement("p");
          p.id = "help-offer";
          p.className = "help-offer";
          p.appendChild(document.createTextNode(${JSON.stringify(HELP_OFFER_TEXT)} + " "));
          var a = document.createElement("a");
          a.href = url;
          a.rel = "noreferrer";
          a.textContent = ${JSON.stringify(HELP_OFFER_LINK_TEXT)};
          p.appendChild(a);
          helpOfferSlot.textContent = "";
          helpOfferSlot.appendChild(p);
        }

        // The tap controls for the slide being viewed, from this browser's
        // own taps (the latest frame's yourSlides). Called on every frame and
        // on every change of slide, so browsing to a slide shows whether
        // you've already said you're lost on it.
        var lastYourSlides = ${JSON.stringify(state.yourSlides)};
        var tapButtonText = ${JSON.stringify(TAP_BUTTON_TEXT)};
        function viewedMine() {
          var deck = isDemo ? viewedDeck : null;
          for (var i = 0; i < lastYourSlides.length; i++) {
            var mine = lastYourSlides[i];
            if ((mine.deck || null) === deck && mine.slide === viewedSlide) return mine;
          }
          return null;
        }
        function viewedTapStatus() {
          var mine = viewedMine();
          if (!mine) return "none";
          return mine.live ? "live" : "said";
        }
        function updateTapControls() {
          if (!button || !resolveForm) return;
          var status = viewedTapStatus();
          if (button.textContent !== "Sending...") {
            setTapEnabled(status === "none");
            button.textContent = tapButtonText[status];
          }
          var said = document.getElementById("tap-said");
          if (said) said.hidden = status === "none";
          var deckField = resolveForm.querySelector("input[name=deck]");
          if (deckField) deckField.value = viewedDeck;
          var slideField = resolveForm.querySelector("input[name=slide]");
          if (slideField) slideField.value = String(viewedSlide);
          var openTap = viewedMine();
          if (openTap && !openTap.resolved) {
            resolveForm.hidden = false;
          } else if (!resolveForm.hidden) {
            // Hiding a focused control drops focus to <body>; hand it to
            // the tap button, the next thing a keyboard user needs.
            var hadFocus = resolveForm.contains(document.activeElement);
            resolveForm.hidden = true;
            if (hadFocus) button.focus();
          }
          var mine = viewedMine();
          var afterTap = document.querySelector(".after-tap");
          var focusInAfterTap = (!mine || mine.resolved) && afterTap && afterTap.contains(document.activeElement)
            && (document.activeElement.closest("#reasons") || document.activeElement.closest("#note-form"));
          renderReasonsAndNote(mine);
          // Focus that was in the reasons or note, now gone, moves to the
          // first thing that replaced it, or else the tap button.
          if (focusInAfterTap && !afterTap.contains(document.activeElement)) {
            var next = document.querySelector("#helped button.answer");
            (next || button).focus();
          }
        }

        // The demo's condensed clock: re-synced from every frame, ticked
        // locally each second in between, so it moves in every open page
        // without a frame per second. Text only, no animation.
        var lectureTimeEl = document.getElementById("lecture-time");
        var condensedEl = document.getElementById("lecture-condensed");
        var clockBase = null;
        function clockText(ms) {
          var total = Math.floor(ms / 1000);
          var m = Math.floor(total / 60);
          var sec = total % 60;
          return m + ":" + (sec < 10 ? "0" : "") + sec;
        }
        function showLectureClock() {
          if (!lectureTimeEl || !clockBase || !deckLengths) return;
          var length = deckLengths[viewedDeck];
          var elapsed = (clockBase.elapsed + (Date.now() - clockBase.at)) % length;
          setText(lectureTimeEl, "Lecture time " + clockText(elapsed) + " / " + clockText(length));
          setText(condensedEl, "Condensed " + condensedFactor + "x from a 60-minute lecture (real time " + clockText(elapsed * condensedFactor) + ")");
        }
        function syncLectureClock(elapsed) {
          clockBase = { elapsed: elapsed, at: Date.now() };
          showLectureClock();
        }
        if (lectureTimeEl) setInterval(showLectureClock, 1000);

        var source = null;
        function connect() {
          if (source) source.close();
          source = new EventSource(tapBaseUrl + "/events" + (isDemo ? "?deck=" + encodeURIComponent(viewedDeck) : ""));
          source.onmessage = function (event) {
            if (connectionStatus) connectionStatus.textContent = "";
            render(JSON.parse(event.data));
          };
          source.onerror = function () {
            if (connectionStatus) connectionStatus.textContent = "Reconnecting...";
          };
        }
        connect();

        // Once the script runs, the button is never \`disabled\`: a disabled
        // button can't hold focus, so a keyboard user who pressed Enter on it
        // was dropped back to the top of the page. aria-disabled keeps it
        // focusable and still says it's unavailable; presses are ignored here.
        function setTapEnabled(enabled) {
          button.disabled = false;
          if (enabled) button.removeAttribute("aria-disabled");
          else button.setAttribute("aria-disabled", "true");
        }
        setTapEnabled(!button.disabled);

        form.addEventListener("submit", function (event) {
          event.preventDefault();
          if (button.getAttribute("aria-disabled") === "true") return;
          feedback.textContent = "";
          setTapEnabled(false);
          button.textContent = "Sending...";
          fetch(form.action, {
            method: "POST",
            body: new URLSearchParams({
              deck: deckInput ? deckInput.value : "",
              slide: slideInput ? slideInput.value : "",
            }),
          })
            .then(function (res) {
              if (!res.ok) throw new Error("tap failed");
              button.textContent = "You're counted";
            })
            .catch(function () {
              setTapEnabled(true);
              button.textContent = "I'm lost";
              feedback.textContent = "Couldn't send. Try again.";
            });
        });
      })();
    </script>
  `;

  return new Response(page(lecture.title, body, "lecture", id === "demo" ? "demo" : undefined), {
    status: 200,
    headers,
  });
}

// The deck a tap or note is filed under. Only the demo has decks: a created
// lecture's slides are just numbers, so any deck sent for one (a stale page,
// a hand-made request) is dropped rather than stored, or its taps would
// group apart from its notes on the same slide.
function deckFor(lectureId: string, submitted: string | null): string | undefined {
  if (lectureId !== "demo") return undefined;
  return submitted !== null && submitted !== "" ? submitted : undefined;
}

async function handleTap(id: string, req: Request): Promise<Response> {
  const lecture = getLecture(id);
  if (!lecture) return notFoundResponse();

  const cookieHeader = req.headers.get("cookie");
  const browserId = validateBrowserId(cookieHeader);
  if (!browserId) {
    logAction("tap_rejected", id, rawBrowserCookie(cookieHeader));
    return new Response("Forbidden", {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // A tap always records the deck and slide the viewer says they're looking
  // at — no reconciliation against a "current" slide, since browsing to an
  // earlier one is now a normal, expected thing to do (ADR 004's amendment).
  // An out-of-range or missing value can only mean a malformed request, so
  // it's rejected rather than silently substituted. A created lecture (no
  // deck concept at all) always submits an empty deck, which isValidSlide
  // treats as fine since it ignores the deck entirely for non-demo lectures.
  const body = await req.text();
  const params = new URLSearchParams(body);
  const submittedDeckRaw = params.get("deck");
  const submittedDeck = deckFor(lecture.id, submittedDeckRaw);
  const submittedSlideRaw = params.get("slide");
  const submittedSlide = submittedSlideRaw !== null ? Number(submittedSlideRaw) : NaN;
  if (!isValidSlide(lecture, submittedDeck, submittedSlide)) {
    logAction("tap_rejected", id, browserId);
    return new Response("Invalid slide", {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const inserted = tapOncePerSlide(id, browserId, submittedDeck ?? null, submittedSlide);
  if (inserted) {
    broadcast(id);
    scheduleFade(id);
    logAction("tap", id, browserId);
  } else {
    logAction("tap_ignored", id, browserId);
  }

  return new Response(null, {
    status: 303,
    headers: { location: slidePageLocation(id, submittedDeck ?? null, submittedSlide) },
  });
}

// Where a no-JS form POST lands: the page for the deck and slide the student
// tapped. A bare /l/:id would land on the default deck's live slide, so the
// note form there would carry a slide the student never tapped.
function slidePageLocation(id: string, deck: string | null, slide: number): string {
  const deckParam = deck !== null ? `deck=${encodeURIComponent(deck)}&` : "";
  return `/l/${encodeURIComponent(id)}?${deckParam}slide=${slide}`;
}

// Where a reason or "I get it now" returns to: the slide the form named,
// or else the tap it acted on; with neither there's no slide to return to,
// so the lecture page.
function tapPageLocation(
  id: string,
  slideRef: SlideRef | undefined,
  tap: { deck: string | null; slide: number | null } | undefined,
): string {
  if (slideRef !== undefined) return slidePageLocation(id, slideRef.deck, slideRef.slide);
  if (tap === undefined || tap.slide === null) return `/l/${encodeURIComponent(id)}`;
  return slidePageLocation(id, tap.deck, tap.slide);
}

// The deck and slide a reason or "I get it now" is about. Pages from before
// one-tap-per-slide name none, and get the browser's latest live tap
// (undefined here); a slide that's named but invalid is "invalid".
function namedSlide(lecture: Lecture, params: URLSearchParams): SlideRef | undefined | "invalid" {
  const slideRaw = params.get("slide");
  if (slideRaw === null) return undefined;
  const deck = deckFor(lecture.id, params.get("deck"));
  const slide = Number(slideRaw);
  if (!isValidSlide(lecture, deck, slide)) return "invalid";
  return { deck: deck ?? null, slide };
}

const REASONS = REASONS_LIST();

async function handleReason(id: string, req: Request): Promise<Response> {
  const lecture = getLecture(id);
  if (!lecture) return notFoundResponse();

  const cookieHeader = req.headers.get("cookie");
  const browserId = validateBrowserId(cookieHeader);
  if (!browserId) {
    logAction("tap_rejected", id, rawBrowserCookie(cookieHeader));
    return new Response("Forbidden", {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const params = new URLSearchParams(await req.text());
  const reason = params.get("reason") ?? "";
  const slideRef = namedSlide(lecture, params);
  if (!REASONS.includes(reason) || slideRef === "invalid") {
    logAction("reason_rejected", id, browserId);
    return new Response("Invalid reason", {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // Answers lock once sent (ADR 006): a slide whose tap already has a
  // reason, or has no live tap to put one on, refuses the request. setTapReason's
  // own "reason IS NULL" holds this even for two requests at once.
  // A form that names its slide acts on that slide's tap for the rest of the
  // lecture, until "I get it now"; one that doesn't falls back to the live tap.
  const tap =
    slideRef !== undefined
      ? openTapOn(id, browserId, slideRef)
      : liveTapOn(id, browserId, new Date(Date.now() - liveWindowMs(id)).toISOString(), slideRef);
  if (tap === undefined || !setTapReason(tap.id, reason)) {
    logAction("reason_refused", id, browserId);
    return answerRefused("A reason can only be sent once per slide, while you're counted as lost on it.");
  }
  logAction("reason_set", id, browserId);
  broadcast(id);
  broadcastToLecturer(id);

  return new Response(null, {
    status: 303,
    headers: { location: tapPageLocation(id, slideRef, tap) },
  });
}

// 409, with a plain sentence: the request was well formed, but the answer
// is already given (or there's nothing yet to answer).
function answerRefused(message: string): Response {
  return new Response(message, {
    status: 409,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

// "What helped your understanding?" (ADR 006), asked after "I get it now".
// Accepted once per slide, and only once that slide's tap is resolved; the
// answer comes from a fixed list checked here. Counted for the lecturer per
// (deck, slide, answer), gated like reasons; never sent to any student.
async function handleHelped(id: string, req: Request): Promise<Response> {
  const lecture = getLecture(id);
  if (!lecture) return notFoundResponse();

  const cookieHeader = req.headers.get("cookie");
  const browserId = validateBrowserId(cookieHeader);
  if (!browserId) {
    logAction("tap_rejected", id, rawBrowserCookie(cookieHeader));
    return new Response("Forbidden", {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const params = new URLSearchParams(await req.text());
  const helped = params.get("helped") ?? "";
  const slideRef = namedSlide(lecture, params);
  if (!HELPED.includes(helped) || slideRef === undefined || slideRef === "invalid") {
    logAction("helped_rejected", id, browserId);
    return new Response("Invalid answer", {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const tap = resolvedTapOn(id, browserId, slideRef);
  if (tap === undefined || !setTapHelped(tap.id, helped)) {
    logAction("helped_refused", id, browserId);
    return answerRefused("What helped can only be sent once per slide, after \"I get it now\".");
  }
  logAction("helped_set", id, browserId);
  broadcast(id);
  broadcastToLecturer(id);

  return new Response(null, {
    status: 303,
    headers: { location: slidePageLocation(id, slideRef.deck, slideRef.slide) },
  });
}

// "I get it now": ends the caller's own live tap at once, independent of
// the 60s window. The tap's slide is untouched, so Phase 2's bars
// (distinct-browser-ever-tapped) are unaffected — a resolved/not-live tap
// was still a real moment of being lost on that slide.
async function handleResolve(id: string, req: Request): Promise<Response> {
  const lecture = getLecture(id);
  if (!lecture) return notFoundResponse();

  const cookieHeader = req.headers.get("cookie");
  const browserId = validateBrowserId(cookieHeader);
  if (!browserId) {
    logAction("tap_rejected", id, rawBrowserCookie(cookieHeader));
    return new Response("Forbidden", {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const slideRef = namedSlide(lecture, new URLSearchParams(await req.text()));
  if (slideRef === "invalid") {
    logAction("tap_rejected", id, browserId);
    return new Response("Invalid slide", {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // A form that names its slide acts on that slide's tap for the rest of the
  // lecture, until "I get it now"; one that doesn't falls back to the live tap.
  const tap =
    slideRef !== undefined
      ? openTapOn(id, browserId, slideRef)
      : liveTapOn(id, browserId, new Date(Date.now() - liveWindowMs(id)).toISOString(), slideRef);
  if (tap !== undefined && resolveTap(tap.id)) {
    logAction("tap_resolved", id, browserId);
    broadcast(id);
    broadcastToLecturer(id);
  }

  return new Response(null, {
    status: 303,
    headers: { location: tapPageLocation(id, slideRef, tap) },
  });
}

const NOTE_MAX_LENGTH = 200;
// These three patterns double as the mechanism that "stops people
// identifying themselves by accident" (ADR 004's amendment) — a URL, email
// or phone number in a note could point back to the writer as easily as a
// name would.
const URL_PATTERN = /https?:\/\/|www\./i;
const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PHONE_PATTERN = /(\+?[\d\s().-]*\d[\d\s().-]*){7,}/;

function validateNoteText(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "A note can't be empty.";
  if (trimmed.length > NOTE_MAX_LENGTH) return `Notes are limited to ${NOTE_MAX_LENGTH} characters.`;
  if (URL_PATTERN.test(trimmed)) return "Notes can't contain a URL.";
  if (EMAIL_PATTERN.test(trimmed)) return "Notes can't contain an email address.";
  if (PHONE_PATTERN.test(trimmed.replace(/[^\d+().\s-]/g, ""))) return "Notes can't contain a phone number.";
  return undefined;
}

// Lecturer-only: a note's text never reaches broadcast(id) (the
// student-facing broadcast), only broadcastToLecturer(id) — notes never
// reach students, by construction, not by filtering.
async function handleNote(id: string, req: Request): Promise<Response> {
  const lecture = getLecture(id);
  if (!lecture) return notFoundResponse();

  const cookieHeader = req.headers.get("cookie");
  const browserId = validateBrowserId(cookieHeader);
  if (!browserId) {
    logAction("tap_rejected", id, rawBrowserCookie(cookieHeader));
    return new Response("Forbidden", {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const body = await req.text();
  const params = new URLSearchParams(body);
  const submittedDeckRaw = params.get("deck");
  const submittedDeck = deckFor(lecture.id, submittedDeckRaw);
  const submittedSlideRaw = params.get("slide");
  const submittedSlide = submittedSlideRaw !== null ? Number(submittedSlideRaw) : NaN;
  const text = params.get("text") ?? "";

  if (!isValidSlide(lecture, submittedDeck, submittedSlide)) {
    logAction("note_rejected", id, browserId);
    return new Response("Invalid slide", {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const rejectionMessage = validateNoteText(text);
  if (rejectionMessage !== undefined) {
    logAction("note_rejected", id, browserId);
    return new Response(rejectionMessage, {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  setNote(id, submittedDeck ?? null, browserId, submittedSlide, text.trim());
  logAction("note_submitted", id, browserId);
  broadcastToLecturer(id);

  const deckParam = submittedDeck !== undefined ? `deck=${submittedDeck}&` : "";
  return new Response(null, {
    status: 303,
    headers: { location: `/l/${encodeURIComponent(id)}?${deckParam}slide=${submittedSlide}` },
  });
}

// The note id in the URL is an opaque row id the lecturer only ever sees
// inside their own already-authenticated dashboard — never derivable by a
// student — so it doesn't leak anything by existing as a path segment.
async function handleHideNote(id: string, noteId: number, req: Request): Promise<Response> {
  const lecture = getLecture(id);
  if (!lecture) return notFoundResponse();

  const cookieHeader = req.headers.get("cookie");
  if (!validateLecturerSession(id, cookieHeader)) {
    return new Response("Forbidden", {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const browserId = validateBrowserId(cookieHeader);
  hideNoteById(noteId);
  logAction("note_hidden", id, browserId);
  broadcastToLecturer(id);

  return new Response(null, {
    status: 303,
    headers: { location: `/l/${encodeURIComponent(id)}/lecturer` },
  });
}

// Student-only: a lecturer's own bid+lsess cookies must still get student
// state and count as present here, since this is the route a student page
// connects to — lecturer state lives on its own route (handleLecturerEvents)
// instead of being chosen by which cookies happen to be present.
function handleEvents(id: string, req: IncomingMessage, res: ServerResponse): void {
  const lecture = getLecture(id);
  if (!lecture) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  const cookieHeader = req.headers.cookie;
  const browserId = validateBrowserId(cookieHeader);
  if (!browserId) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  // The demo stream names the deck it's watching (?deck=week-6); missing or
  // invalid means the default live deck, same fallback as the page itself.
  // A created lecture has no decks, so its streams watch none.
  const requestedDeck = new URL(req.url ?? "/", "http://localhost").searchParams.get("deck");
  const deck: DeckId | null =
    id === "demo" ? (requestedDeck !== null && isDeckId(requestedDeck) ? requestedDeck : LIVE_DECK) : null;

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  addConnection(id, browserId, res, deck);
  logAction("stream_open", id, browserId);
  sendInitialState(id, browserId, res, deck);
  broadcast(id);
  scheduleFade(id);

  req.on("close", () => {
    removeConnection(id, browserId, res);
    logAction("stream_close", id, browserId);
    broadcast(id);
  });
}

function handleLecturerEvents(id: string, req: IncomingMessage, res: ServerResponse): void {
  const lecture = getLecture(id);
  if (!lecture) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  const cookieHeader = req.headers.cookie;
  if (!validateLecturerSession(id, cookieHeader)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  const browserId = validateBrowserId(cookieHeader);
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  addLecturerConnection(id, res);
  logAction("stream_open", id, browserId);
  sendInitialLecturerState(id, res);
  broadcastToLecturer(id);

  req.on("close", () => {
    removeLecturerConnection(id, res);
    logAction("stream_close", id, browserId);
  });
}

function lecturerLoginForm(id: string, error?: string): string {
  return `
    <h1>Lecturer view</h1>
    ${error ? `<p class="form-error">${escapeHtml(error)}</p>` : ""}
    <form method="post" action="/l/${encodeURIComponent(id)}/lecturer" class="inline-form">
      <label for="code">Lecture code</label>
      <input id="code" name="code" required autocomplete="off">
      <button type="submit">Enter</button>
    </form>
  `;
}

interface DashboardReasonCount {
  deck: string | null;
  slide: number;
  reason: string;
  count: number;
}

interface DashboardNote {
  deck: string | null;
  slide: number;
  id: number;
  text: string;
  created_at: string;
}

function reasonCountsHtml(reasonCounts: DashboardReasonCount[]): string {
  if (reasonCounts.length === 0) return "";
  const sorted = [...reasonCounts].sort(
    (a, b) => (a.deck ?? "").localeCompare(b.deck ?? "") || a.slide - b.slide || b.count - a.count,
  );
  const rows = sorted
    .map((entry) => {
      const label = slideName(entry.deck, entry.slide);
      return `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(entry.reason)}</td><td>${entry.count}</td></tr>`;
    })
    .join("\n");
  return `
    <table class="reason-counts" id="reason-counts">
      <thead><tr><th>Slide</th><th>Reason</th><th>Count</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// Each note's Hide button posts to a lecturer-only route; the note's id in
// the URL is an opaque row id the lecturer only ever sees inside their own
// already-authenticated dashboard. A hidden note is removed from the DOM
// entirely on the next broadcast, not just visually hidden — same privacy
// discipline as every other gated element on this page.
function noteItemsHtml(lectureId: string, notes: DashboardNote[]): string {
  const sorted = [...notes].sort(
    (a, b) =>
      (a.deck ?? "").localeCompare(b.deck ?? "") ||
      a.slide - b.slide ||
      b.created_at.localeCompare(a.created_at),
  );
  const base = `/l/${encodeURIComponent(lectureId)}`;
  return sorted
    .map((note) => {
      const label = slideName(note.deck, note.slide);
      return `<li class="note" data-note-id="${note.id}">
        <p class="note-slide">${escapeHtml(label)}</p>
        <p class="note-text">${escapeHtml(note.text)}</p>
        <form method="post" action="${base}/lecturer/note/${note.id}/hide" class="hide-note-form">
          <button type="submit">Hide</button>
        </form>
      </li>`;
    })
    .join("\n");
}

interface SlideKey {
  deck: string | null;
  slide: number;
}

const onSlide = (key: SlideKey) => (entry: { deck: string | null; slide: number }): boolean =>
  entry.deck === key.deck && entry.slide === key.slide;

// The current slide, first and large, for a projector: its bar, its
// reasons, its notes. Everything here is filtered from arrays the server
// already gated per (deck, slide) and per reason, so this can't show
// anything the history below doesn't; a slide with too few taps to show
// says so rather than showing zero, since absent isn't the same as none.
function nowSectionInnerHtml(
  lectureId: string,
  key: SlideKey,
  bars: Bar[],
  reasonCounts: DashboardReasonCount[],
  notes: DashboardNote[],
  minPresent: number,
): string {
  const bar = bars.find(onSlide(key));
  const maxCount = Math.max(1, ...bars.map((b) => b.distinctBrowsers));
  const barHtml = bar
    ? `<p>${bar.distinctBrowsers} ${plural(bar.distinctBrowsers, "person has", "people have")} said they were lost here</p>${quietBarHtml("now-bar-svg", bar.distinctBrowsers / maxCount)}`
    : `<p id="now-empty">Shows once ${minPresent} people have said they were lost here.</p>`;
  const reasons = reasonCounts.filter(onSlide(key)).sort((a, b) => b.count - a.count);
  const reasonsHtml =
    reasons.length > 0
      ? `<ul id="now-reasons">${reasons.map((r) => `<li>${escapeHtml(r.reason)}: ${r.count}</li>`).join("")}</ul>`
      : "";
  const slideNotes = notes.filter(onSlide(key));
  const notesListHtml =
    slideNotes.length > 0
      ? `<h3 id="now-notes-heading">What didn't make sense</h3><ul id="now-notes" class="notes-list">${noteItemsHtml(lectureId, slideNotes)}</ul>`
      : "";
  return `<h2 id="now-heading">On the live slide: <span id="now-slide-name">${escapeHtml(slideName(key.deck, key.slide))}</span></h2><div id="now-bar">${barHtml}</div>${reasonsHtml}${notesListHtml}`;
}

// A timed lecture has no Previous/Next: its clock moves the slides. Before
// it starts, the lecturer gets one button; after, a line saying it's
// running. Start is idempotent, so a second tab still showing the button
// does no harm.
function timedControlsHtml(lecture: Lecture): string {
  const durations = slideDurations(lecture) ?? [];
  const totalMinutes = Math.round(durations.reduce((sum, ms) => sum + ms, 0) / 6000) / 10;
  if (lecture.started_at === null) {
    return `<form method="post" action="/l/${encodeURIComponent(lecture.id)}/lecturer/start" id="start-lecture-form">
      <button type="submit">Start lecture</button>
    </form>
    <p id="timed-status">Timed, ${totalMinutes} minutes. Slides move on their own once you start.</p>`;
  }
  return `<p id="timed-status">Timed, ${totalMinutes} minutes. Started, and slides move on their own.</p>`;
}

function lecturerDashboard(
  id: string,
  state: LecturerState,
  lecture: Lecture,
  notesFilter: NotesFilter,
  minPresent: number,
  activity: { lecture: Lecture; lines: ActivityLine[]; filter: ActivityFilter },
  projector = false,
): string {
  // Below min_present, the total isn't rendered at all — not blanked, not
  // an empty placeholder — so there's nothing in the markup for a curious
  // viewer to read past a merely-hidden gauge. Bars, reasonCounts and notes
  // are all gated separately, per (deck, slide) or (deck, slide, reason),
  // independently of shown — each helper already renders nothing for an
  // empty array, so this needs no extra branching.
  const tapCountHtml = state.shown ? `<p id="tap-count">Total taps: ${state.totalTaps}</p>` : "";

  // The demo's slide is clock-driven (ADR 004): there's nothing for a
  // lecturer to control, so no Previous/Next controls are rendered for it.
  // The lecturer's current slide is always the live one: the demo's is
  // LIVE_DECK's clock, a created lecture's is wherever Next/Prev left it.
  const slideLabelHtml = `<p id="slide-label">${escapeHtml(slideName(id === "demo" ? LIVE_DECK : null, state.slide, { live: true }))}</p>`;
  const slideControlsHtml =
    id === "demo"
      ? slideLabelHtml
      : lecture.pacing === "timed"
        ? `${slideLabelHtml}\n${timedControlsHtml(lecture)}`
        : `
    ${slideLabelHtml}
    <div class="slide-controls">
    <form method="post" action="/l/${encodeURIComponent(id)}/lecturer/slide/prev" id="slide-prev-form">
      <button type="submit">Previous slide</button>
    </form>
    <form method="post" action="/l/${encodeURIComponent(id)}/lecturer/slide/next" id="slide-next-form">
      <button type="submit">Next slide</button>
    </form>
    </div>`;

  const nowKey: SlideKey = { deck: id === "demo" ? LIVE_DECK : null, slide: state.slide };
  const lecturerUrl = `/l/${encodeURIComponent(id)}/lecturer`;
  // A plain link, so it works without JS: ?projector=1 is rendered with
  // larger type by the server, and the same link without it turns it off.
  const projectorLinkHtml = projector
    ? `<a href="${lecturerUrl}" id="projector-link" class="pill-link">Leave projector mode</a>`
    : `<a href="${lecturerUrl}?projector=1" id="projector-link" class="pill-link">Projector mode</a>`;

  // The layout shell: stat tiles across the top; below them the live
  // column (the current slide and its notes) and a 2x2 grid of graph
  // slots; the activity log full width at the bottom. The live column
  // comes first in the markup, so a phone and a screen reader reach the
  // current slide before the history; style.css puts it on the right on a
  // wide screen. The graph slots and the activity log are headings over an
  // empty body (.slot-body) for the graphs to fill; until they do, the bars
  // and reason tables sit in the matching slot.
  return `
    <div class="lecturer-head">
      <h1>Lecturer view</h1>
      ${projectorLinkHtml}
    </div>
${runControlsHtml(id, state.run)}
    ${id === "demo" ? "" : pastedSlidesHtml(id, state.slide)}
    <section id="stat-tiles" class="stat-tiles" aria-label="Right now">
      <div class="card stat-tile tile-gauge">
        <h2 class="tile-label">Lost right now</h2>
        ${gaugeHtml(state, minPresent)}
        <p id="connection-status" aria-live="polite"></p>
      </div>
      <div class="card stat-tile tile-taps">
        <h2 class="tile-label">Taps this lecture</h2>
        <p class="tile-wait" id="tap-count-wait"${state.shown ? " hidden" : ""}>Shows once ${minPresent} people are here</p>
        <div id="tap-count-slot">${tapCountHtml}</div>
      </div>
      <div class="card stat-tile tile-slide">
        <h2 class="tile-label">Live slide</h2>
        ${slideControlsHtml}
      </div>
      <div id="dashboard-tiles" class="dashboard-tiles">${state.dashboardHtml.tiles}</div>
    </section>
    <div class="lecturer-layout">
      <div class="live-column">
        <section id="now" class="card" aria-labelledby="now-heading">${nowSectionInnerHtml(id, nowKey, state.bars, state.reasonCounts, state.notes, minPresent)}</section>
        <section id="notes" class="card" aria-labelledby="notes-heading">
          <h2 id="notes-heading">What didn't make sense, by slide</h2>
          ${notesFilterFormHtml(lecture, notesFilter)}
          <div id="notes-groups">${notesListInnerHtml(state.noteGroups, notesFilter, lecture.min_present)}</div>
        </section>
      </div>
      <div class="graph-grid">
        <section id="graph-lost" class="card graph-slot" aria-labelledby="graph-lost-heading">
          <h2 id="graph-lost-heading">Lost, per slide</h2>
          <div class="slot-body" id="bars">${state.dashboardHtml.graphLost}</div>
        </section>
        <section id="graph-reasons" class="card graph-slot" aria-labelledby="graph-reasons-heading">
          <h2 id="graph-reasons-heading">What kind of lost</h2>
          <div class="slot-body" id="graph-reasons-body">${state.dashboardHtml.graphReasons}</div>
        </section>
        <section id="graph-helped" class="card graph-slot" aria-labelledby="graph-helped-heading">
          <h2 id="graph-helped-heading">What helped</h2>
          <div class="slot-body" id="graph-helped-body">${state.dashboardHtml.graphHelped}</div>
        </section>
        <section id="graph-resolved" class="card graph-slot" aria-labelledby="graph-resolved-heading">
          <h2 id="graph-resolved-heading">Got it now</h2>
          <div class="slot-body" id="graph-resolved-body">${state.dashboardHtml.graphResolved}</div>
        </section>
      </div>
    </div>
${activityLogHtml(activity.lecture, activity.lines, activity.filter)}
    <script>
      (function () {
        var minPresent = ${JSON.stringify(minPresent)};
        var nowDeck = ${JSON.stringify(nowKey.deck)};
        var lectureBase = ${JSON.stringify(`/l/${encodeURIComponent(id)}`)};
${GAUGE_CLIENT_JS}
${SLIDE_NAME_CLIENT_JS}
${activityClientJs(activity.filter)}
        var connectionStatus = document.getElementById("connection-status");

${dashboardClientJs(notesFilter, minPresent)}
        // One listener for every Hide button, including ones a live update
        // adds later. Without JS each is a plain POST form.
        document.addEventListener("submit", function (event) {
          var hideForm = event.target;
          if (!hideForm.classList || !hideForm.classList.contains("hide-note-form")) return;
          event.preventDefault();
          fetch(hideForm.action, { method: "POST" }).catch(function () {});
        });

        function isNow(entry, slide) {
          return (entry.deck || null) === nowDeck && entry.slide === slide;
        }

        // A list is rebuilt only when the notes in it actually change, so
        // a focused Hide button isn't torn down by an unrelated update.
        var noteSignatures = {};
        function notesChanged(key, notes) {
          var sig = JSON.stringify(notes.map(function (n) { return [n.id, n.text]; }));
          if (noteSignatures[key] === sig) return false;
          noteSignatures[key] = sig;
          return true;
        }

        function buildNotesList(notes, listId) {
          var sorted = notes.slice().sort(function (a, b) {
            return (
              (a.deck || "").localeCompare(b.deck || "") ||
              a.slide - b.slide ||
              b.created_at.localeCompare(a.created_at)
            );
          });
          var list = document.createElement("ul");
          list.id = listId;
          list.className = "notes-list";
          sorted.forEach(function (note) {
            var label = slideName(note.deck, note.slide);
            var li = document.createElement("li");
            li.className = "note";
            li.dataset.noteId = String(note.id);
            var slideP = document.createElement("p");
            slideP.className = "note-slide";
            slideP.textContent = label;
            var textP = document.createElement("p");
            textP.className = "note-text";
            textP.textContent = note.text;
            var hideForm = document.createElement("form");
            hideForm.method = "post";
            hideForm.action = lectureBase + "/lecturer/note/" + note.id + "/hide";
            hideForm.className = "hide-note-form";
            var hideButton = document.createElement("button");
            hideButton.type = "submit";
            hideButton.textContent = "Hide";
            hideForm.appendChild(hideButton);
            li.appendChild(slideP);
            li.appendChild(textP);
            li.appendChild(hideForm);
            list.appendChild(li);
          });
          return list;
        }

        // The current slide first: its bar, its reasons, its notes, each
        // filtered from arrays the server already gated.
        function renderNow(state) {
          var now = document.getElementById("now");
          if (!now) return;
          var nowName = document.getElementById("now-slide-name");
          if (nowName) setText(nowName, slideName(nowDeck, state.slide));
          var barBox = document.getElementById("now-bar");
          var bar = null;
          var maxCount = 1;
          (state.bars || []).forEach(function (b) {
            if (b.distinctBrowsers > maxCount) maxCount = b.distinctBrowsers;
            if (isNow(b, state.slide)) bar = b;
          });
          var empty = document.getElementById("now-empty");
          var svg = document.getElementById("now-bar-svg");
          if (bar) {
            if (empty) empty.remove();
            var text = bar.distinctBrowsers + " " + plural(bar.distinctBrowsers, "person has", "people have") + " said they were lost here";
            var p = barBox.querySelector("p");
            if (!p) {
              p = document.createElement("p");
              barBox.prepend(p);
            }
            setText(p, text);
            if (!svg) {
              var holder = document.createElement("div");
              holder.innerHTML = ${JSON.stringify(quietBarHtml("now-bar-svg", 0))};
              svg = holder.firstElementChild;
              barBox.appendChild(svg);
            }
            svg.querySelector(".gauge-fill").setAttribute("width", String(Math.round((bar.distinctBrowsers / maxCount) * 1000) / 10));
          } else {
            if (svg) svg.remove();
            var oldP = barBox.querySelector("p:not(#now-empty)");
            if (oldP) oldP.remove();
            if (!empty) {
              empty = document.createElement("p");
              empty.id = "now-empty";
              empty.textContent = "Shows once " + minPresent + " people have said they were lost here.";
              barBox.appendChild(empty);
            }
          }

          var reasons = (state.reasonCounts || []).filter(function (r) { return isNow(r, state.slide); })
            .sort(function (a, b) { return b.count - a.count; });
          var reasonsList = document.getElementById("now-reasons");
          if (reasons.length === 0) {
            if (reasonsList) reasonsList.remove();
          } else {
            if (!reasonsList) {
              reasonsList = document.createElement("ul");
              reasonsList.id = "now-reasons";
              barBox.insertAdjacentElement("afterend", reasonsList);
            }
            var reasonsText = reasons.map(function (r) { return r.reason + ": " + r.count; });
            if (reasonsList.dataset.sig !== JSON.stringify(reasonsText)) {
              reasonsList.dataset.sig = JSON.stringify(reasonsText);
              reasonsList.innerHTML = "";
              reasonsText.forEach(function (t) {
                var li = document.createElement("li");
                li.textContent = t;
                reasonsList.appendChild(li);
              });
            }
          }

          var nowNotes = (state.notes || []).filter(function (n) { return isNow(n, state.slide); });
          if (notesChanged("now", nowNotes)) {
            var oldHeading = document.getElementById("now-notes-heading");
            var oldList = document.getElementById("now-notes");
            if (oldHeading) oldHeading.remove();
            if (oldList) oldList.remove();
            if (nowNotes.length > 0) {
              var h = document.createElement("h3");
              h.id = "now-notes-heading";
              h.textContent = "What didn't make sense";
              now.appendChild(h);
              now.appendChild(buildNotesList(nowNotes, "now-notes"));
            }
          }
        }

        function render(state) {
          var slideLabel = document.getElementById("slide-label");
          if (slideLabel) setText(slideLabel, slideName(nowDeck, state.slide, { live: true }));
          // A created lecture's pasted slides follow the live slide.
          var pastedSlides = document.querySelectorAll("#slides.pasted-slides .slide");
          for (var ps = 0; ps < pastedSlides.length; ps++) {
            pastedSlides[ps].hidden = Number(pastedSlides[ps].dataset.slide) !== state.slide;
          }
          // renderGauge (shared with the student page) only touches the
          // aria-live node on an actual lost-count change or a shown
          // boundary crossing.
          renderGauge(state, minPresent);
          var tapCountSlot = document.getElementById("tap-count-slot");
          var tapCountWait = document.getElementById("tap-count-wait");
          if (tapCountWait) tapCountWait.hidden = !!state.shown;
          if (state.shown) {
            var tapCount = document.getElementById("tap-count");
            if (!tapCount) {
              tapCount = document.createElement("p");
              tapCount.id = "tap-count";
              tapCountSlot.appendChild(tapCount);
            }
            setText(tapCount, "Total taps: " + state.totalTaps);
          } else {
            var oldTapCount = document.getElementById("tap-count");
            if (oldTapCount) oldTapCount.remove();
          }
          renderNow(state);
          renderDashboard(state);
          renderActivity(state.activityLog);
        }

        // A fresh run started (here or in another session): the run
        // picker, the slide and every count change at once, so the page is
        // fetched again rather than patched.
        var renderedRun = ${JSON.stringify(state.run)};
        var source = new EventSource(${JSON.stringify(`/l/${encodeURIComponent(id)}/lecturer/events`)});
        source.onmessage = function (event) {
          if (connectionStatus) connectionStatus.textContent = "";
          var state = JSON.parse(event.data);
          if (state.run !== renderedRun) {
            source.close();
            window.location.reload();
            return;
          }
          render(state);
        };
        source.onerror = function () {
          if (connectionStatus) connectionStatus.textContent = "Reconnecting...";
        };
      })();
    </script>
  `;
}

const DEMO_RUN_MESSAGE = "The shared demo keeps its history. Create your own lecture to try a fresh run.";
const DEMO_HELP_LINK_MESSAGE =
  "The shared demo's help link is fixed, because its code is public. Create your own lecture to set one.";

// The run picker and the fresh-run button, in their own block near the top
// of the lecturer view (ADR 006 section 3). Plain links, so they work
// without JS. The current run links to the live view; earlier runs to
// ?run=N. `viewing` is the run on screen, marked aria-current.
function runControlsHtml(id: string, viewing: number): string {
  const base = `/l/${encodeURIComponent(id)}/lecturer`;
  const runs = runsOf(id);
  const current = runs.length > 0 ? runs[runs.length - 1].number : 1;
  const items = runs
    .map((run) => {
      const isCurrent = run.number === current;
      const label = `Run ${run.number}${isCurrent ? " (live)" : ""}`;
      const href = isCurrent ? base : `${base}?run=${run.number}`;
      const ariaCurrent = run.number === viewing ? ` aria-current="page"` : "";
      return `<li><a href="${href}"${ariaCurrent}>${label}</a></li>`;
    })
    .join("");
  const freshRun =
    id === "demo"
      ? `<p id="runs-demo">${escapeHtml(DEMO_RUN_MESSAGE)}</p>`
      : `<form method="get" action="${base}/runs/new" id="fresh-run-form">
        <button type="submit">Start a fresh run</button>
      </form>`;
  return `
    <section id="runs" class="runs" aria-labelledby="runs-heading">
      <h2 id="runs-heading">Runs</h2>
      <ul class="run-picker">${items}</ul>
      ${freshRun}
    </section>
${helpLinkSectionHtml(id)}`;
}

// The lecturer's help link, editable here (the demo's is fixed). Students
// see it only on their own page, once they've said they're lost on
// HELP_AFTER_SLIDES slides in the current run; nothing here says who.
function helpLinkSectionHtml(id: string): string {
  const lecture = getLecture(id);
  const current = lecture?.help_url ?? null;
  const explain = `<p>A student who says they're lost on ${HELP_AFTER_SLIDES} or more slides in this run sees this link on their own page. You never see who.</p>`;
  if (id === "demo") {
    return `
    <section id="help-link" class="help-link" aria-labelledby="help-link-heading">
      <h2 id="help-link-heading">Help link</h2>
      ${explain}
      <p id="help-url-current">${current ? escapeHtml(current) : "None"}</p>
      <p>${escapeHtml(DEMO_HELP_LINK_MESSAGE)}</p>
    </section>`;
  }
  return `
    <section id="help-link" class="help-link" aria-labelledby="help-link-heading">
      <h2 id="help-link-heading">Help link</h2>
      ${explain}
      <form method="post" action="/l/${encodeURIComponent(id)}/lecturer/help-link" class="inline-form" id="help-link-form">
        <label for="help-url">Where students can get help (https, leave empty for none)</label>
        <input id="help-url" name="url" type="url" maxlength="${HELP_URL_MAX_LENGTH}" value="${current ? escapeHtml(current) : ""}" autocomplete="off">
        <button type="submit">Save help link</button>
      </form>
    </section>`;
}

// Notes in a past run: the same gated list, with no Hide button, since a
// past run is read-only.
function readOnlyNotesHtml(notes: DashboardNote[]): string {
  if (notes.length === 0) return "";
  const sorted = [...notes].sort(
    (a, b) =>
      (a.deck ?? "").localeCompare(b.deck ?? "") || a.slide - b.slide || b.created_at.localeCompare(a.created_at),
  );
  const items = sorted
    .map(
      (note) => `<li class="note">
        <p class="note-slide">${escapeHtml(slideName(note.deck, note.slide))}</p>
        <p class="note-text">${escapeHtml(note.text)}</p>
      </li>`,
    )
    .join("\n");
  return `<section id="notes"><h3>What didn't make sense</h3><ul id="notes-list" class="notes-list">${items}</ul></section>`;
}

// An earlier run, read-only: a static render with no stream and no
// controls, gated exactly as the live view is.
function pastRunHtml(id: string, past: PastRunState): string {
  const totalHtml =
    past.totalTaps !== undefined ? `<p id="tap-count">Total taps in run ${past.run}: ${past.totalTaps}</p>` : "";
  const empty =
    past.bars.length === 0 && past.reasonCounts.length === 0 && past.notes.length === 0
      ? `<p>No slide in this run reached the threshold to show.</p>`
      : "";
  return `
    <div class="lecturer-head">
      <h1>Lecturer view</h1>
      <p id="run-label">Run ${past.run}, read-only</p>
      <p><a href="/l/${encodeURIComponent(id)}/lecturer">Back to the live run</a></p>
    </div>
${runControlsHtml(id, past.run)}
    <div class="lecturer-layout">
      <div class="all-panel">
        <h2>Every slide in run ${past.run}</h2>
        ${totalHtml}
        ${empty}
        <div id="bars">${barsHtml(past.bars)}</div>
        <div id="reason-counts-container">${reasonCountsHtml(past.reasonCounts)}</div>
        ${readOnlyNotesHtml(past.notes)}
      </div>
    </div>
  `;
}

function forbiddenText(): Response {
  return new Response("Forbidden", { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function demoRefusal(title: string, message: string): Response {
  return new Response(
    page(
      title,
      `<h1>${escapeHtml(title)}</h1><p class="form-error">${escapeHtml(message)}</p><p><a href="/l/demo/lecturer">Back to the lecturer view</a> &middot; <a href="/new">Create your own lecture</a></p>`,
    ),
    { status: 403, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

// "Start a fresh run", step 1: a confirmation page saying what happens. The
// form names the run it replaces, so submitting it twice makes one run.
async function handleFreshRunGet(id: string, req: Request): Promise<Response> {
  const lecture = getLecture(id);
  if (!lecture) return notFoundResponse();
  const cookieHeader = req.headers.get("cookie");
  if (id === "demo") {
    logAction("run_start_rejected", id, validateBrowserId(cookieHeader));
    return demoRefusal("Start a fresh run", DEMO_RUN_MESSAGE);
  }
  if (!validateLecturerSession(id, cookieHeader)) return forbiddenText();
  const base = `/l/${encodeURIComponent(id)}/lecturer`;
  const next = lecture.run + 1;
  const body = `
    <h1>Start a fresh run?</h1>
    <p>Run ${lecture.run} stays exactly as it is, and you can still view it, read-only, from the run picker. Nothing is deleted.</p>
    <p>Run ${next} starts empty, on slide 1. Every open student page moves to it, and each student can say they're lost on each slide again.</p>
    <form method="post" action="${base}/runs" id="fresh-run-confirm">
      <input type="hidden" name="run" value="${lecture.run}">
      <button type="submit">Start run ${next}</button>
    </form>
    <p><a href="${base}">Cancel, back to the lecturer view</a></p>
  `;
  return new Response(page("Start a fresh run", body), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// Step 2: inserts one row into runs and deletes nothing (CLAUDE.md: reset
// never deletes). Everything live then reads the new run.
async function handleFreshRunPost(id: string, req: Request): Promise<Response> {
  const lecture = getLecture(id);
  if (!lecture) return notFoundResponse();
  const cookieHeader = req.headers.get("cookie");
  const browserId = validateBrowserId(cookieHeader);
  if (id === "demo") {
    logAction("run_start_rejected", id, browserId);
    return demoRefusal("Start a fresh run", DEMO_RUN_MESSAGE);
  }
  if (!validateLecturerSession(id, cookieHeader)) {
    logAction("run_start_rejected", id, browserId);
    return forbiddenText();
  }
  const runRaw = new URLSearchParams(await req.text()).get("run") ?? "";
  if (!/^[1-9][0-9]{0,8}$/.test(runRaw)) {
    return new Response("Invalid run", { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  if (startRun(id, Number(runRaw))) {
    logAction("run_started", id, browserId);
    broadcast(id);
  }
  return new Response(null, { status: 303, headers: { location: `/l/${encodeURIComponent(id)}/lecturer` } });
}

const HELP_URL_MAX_LENGTH = 300;

// https only, at most 300 characters, as typed and as stored. Empty clears
// it. Returns the URL to store, null for none, or an error message.
function parseHelpUrl(raw: string): { url: string | null } | { error: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { url: null };
  if (trimmed.length > HELP_URL_MAX_LENGTH) return { error: `Help links are limited to ${HELP_URL_MAX_LENGTH} characters.` };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { error: "That isn't a web address. Use one starting with https://." };
  }
  if (parsed.protocol !== "https:" || parsed.hostname === "") return { error: "Help links must start with https://." };
  if (parsed.username !== "" || parsed.password !== "") return { error: "Help links can't contain a username or password." };
  if (parsed.href.length > HELP_URL_MAX_LENGTH) return { error: `Help links are limited to ${HELP_URL_MAX_LENGTH} characters.` };
  return { url: parsed.href };
}

async function handleHelpLinkPost(id: string, req: Request): Promise<Response> {
  const lecture = getLecture(id);
  if (!lecture) return notFoundResponse();
  const cookieHeader = req.headers.get("cookie");
  const browserId = validateBrowserId(cookieHeader);
  if (!validateLecturerSession(id, cookieHeader)) {
    logAction("help_url_rejected", id, browserId);
    return forbiddenText();
  }
  if (id === "demo") {
    logAction("help_url_rejected", id, browserId);
    return demoRefusal("Help link", DEMO_HELP_LINK_MESSAGE);
  }
  const result = parseHelpUrl(new URLSearchParams(await req.text()).get("url") ?? "");
  const base = `/l/${encodeURIComponent(id)}/lecturer`;
  if ("error" in result) {
    logAction("help_url_rejected", id, browserId);
    return new Response(
      page(
        "Help link",
        `<h1>Help link not saved</h1><p class="form-error">${escapeHtml(result.error)}</p><p><a href="${base}">Back to the lecturer view</a></p>`,
      ),
      { status: 400, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }
  setHelpUrl(id, result.url);
  logAction("help_url_set", id, browserId);
  // Students who already qualify see the new link (or lose a cleared one)
  // at once, each in their own frame.
  broadcast(id);
  return new Response(null, { status: 303, headers: { location: base } });
}

async function handleLecturerGet(id: string, req: Request): Promise<Response> {
  const lecture = getLecture(id);
  if (!lecture) return notFoundResponse();

  const { headers } = ensureBrowserIdentity(req);

  const navKey: NavKey | undefined = id === "demo" ? "lecturer" : undefined;
  if (!validateLecturerSession(id, req.headers.get("cookie"))) {
    return new Response(page("Lecturer view", lecturerLoginForm(id), undefined, navKey), { status: 200, headers });
  }
  const projector = new URL(req.url).searchParams.get("projector") === "1";

  // ?run=N names an earlier run, shown read-only. The current run's number
  // (or none) is the live view; anything else isn't a run of this lecture.
  const runParam = new URL(req.url).searchParams.get("run");
  if (runParam !== null) {
    const run = /^[1-9][0-9]{0,8}$/.test(runParam) ? Number(runParam) : NaN;
    if (!(run >= 1 && run <= lecture.run)) return notFoundResponse();
    if (run < lecture.run) {
      return new Response(
        page(`Lecturer view, run ${run}`, pastRunHtml(id, computePastRunState(lecture, run)), "lecturer", navKey),
        { status: 200, headers },
      );
    }
  }

  // computeLecturerState only misses for a lecture that doesn't exist,
  // which was checked above.
  const state = computeLecturerState(id);
  if (!state) return notFoundResponse();
  const notesFilter = parseNotesFilter(lecture, new URL(req.url).searchParams);
  const activity = {
    lecture,
    lines: state.activityLog,
    filter: parseActivityFilter(lecture, new URL(req.url).searchParams),
  };
  const mainClass = projector ? "lecturer projector" : "lecturer";
  return new Response(page("Lecturer view", lecturerDashboard(id, state, lecture, notesFilter, lecture.min_present, activity, projector), mainClass, navKey), {
    status: 200,
    headers,
  });
}

async function handleLecturerPost(id: string, req: Request): Promise<Response> {
  const lecture = getLecture(id);
  if (!lecture) return notFoundResponse();

  const { browserId, headers } = ensureBrowserIdentity(req);

  if (!checkLoginRateLimit(id, browserId)) {
    logAction("lecturer_login_failed", id, browserId);
    return new Response(page("Lecturer view", lecturerLoginForm(id, "Too many attempts. Try again in a minute.")), {
      status: 429,
      headers,
    });
  }

  const body = await req.text();
  const code = new URLSearchParams(body).get("code") ?? "";

  if (!verifyCode(code, lecture.code_hash, lecture.code_salt)) {
    recordFailedLogin(id, browserId);
    logAction("lecturer_login_failed", id, browserId);
    return new Response(page("Lecturer view", lecturerLoginForm(id, "Wrong code.")), { status: 200, headers });
  }

  const token = createLecturerSession(id);
  headers.append(
    "set-cookie",
    serializeCookie(LECTURER_COOKIE, token, {
      httpOnly: true,
      sameSite: "Strict",
      path: `/l/${encodeURIComponent(id)}/lecturer`,
      secure: isHttps(req),
    }),
  );
  logAction("lecturer_login_ok", id, browserId);
  headers.set("location", `/l/${encodeURIComponent(id)}/lecturer`);
  return new Response(null, { status: 303, headers });
}

// Shared by Previous and Next: both need a lecturer session, both reject the
// demo (its slide is clock-driven, not lecturer-editable), and both just
// differ in which direction they move the slide number.
async function handleSlideChange(id: string, req: Request, direction: 1 | -1): Promise<Response> {
  const lecture = getLecture(id);
  if (!lecture) return notFoundResponse();

  const cookieHeader = req.headers.get("cookie");
  const browserId = validateBrowserId(cookieHeader);

  if (id === "demo" || !validateLecturerSession(id, cookieHeader)) {
    logAction("slide_change_rejected", id, browserId);
    return new Response("Forbidden", {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // A timed lecture's slide is its clock's, not the lecturer's to move.
  if (lecture.pacing === "timed") {
    logAction("slide_change_rejected", id, browserId);
    return new Response("This lecture is timed: its slides move on their own.", {
      status: 409,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  stepCurrentSlide(id, direction);
  logAction("slide_changed", id, browserId);
  broadcast(id);
  broadcastToLecturer(id);

  return new Response(null, {
    status: 303,
    headers: { location: `/l/${encodeURIComponent(id)}/lecturer` },
  });
}

// What a lecturer typed at /new, kept as typed so a rejected form comes
// back filled in.
interface NewLectureInput {
  title: string;
  slides: string;
  pacing: string;
  minutes: string;
  slideMinutes: string;
  slidesText: string;
  helpUrl: string;
}

const EMPTY_NEW_LECTURE: NewLectureInput = {
  title: "",
  slides: "",
  pacing: "next",
  minutes: "",
  slideMinutes: "",
  slidesText: "",
  helpUrl: "",
};

function readNewLectureInput(body: string): NewLectureInput {
  const params = new URLSearchParams(body);
  const get = (name: string): string => params.get(name) ?? "";
  return {
    title: get("title").trim(),
    slides: get("slides").trim(),
    pacing: get("pacing") || "next",
    minutes: get("minutes").trim(),
    slideMinutes: get("slide_minutes").trim(),
    slidesText: get("slides_text"),
    helpUrl: get("help_url").trim(),
  };
}

// ADR 006, section 4: the page says what the app is for before it asks for
// anything. Plain fields and radio buttons, so it works without JS; every
// limit is shown here and checked again in handleNewPost.
// Start lecture (ADR 006, section 4): lecturer-only, session checked, and
// only for a timed lecture. It stores the start time, so the clock carries
// on through a restart, arms the timer that pushes each slide change, and
// tells every open stream at once.
async function handleStartLecture(id: string, req: Request): Promise<Response> {
  const lecture = getLecture(id);
  if (!lecture) return notFoundResponse();

  const cookieHeader = req.headers.get("cookie");
  const browserId = validateBrowserId(cookieHeader);

  if (id === "demo" || !validateLecturerSession(id, cookieHeader)) {
    logAction("lecture_start_rejected", id, browserId);
    return new Response("Forbidden", {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  if (lecture.pacing !== "timed") {
    logAction("lecture_start_rejected", id, browserId);
    return new Response("This lecture moves when you press Next; there's nothing to start.", {
      status: 409,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  if (startTimedLecture(id)) {
    logAction("lecture_started", id, browserId);
    scheduleTimedAdvance(id);
    broadcast(id);
    broadcastToLecturer(id);
  }

  return new Response(null, {
    status: 303,
    headers: { location: `/l/${encodeURIComponent(id)}/lecturer` },
  });
}

function newLectureForm(error?: string, input: NewLectureInput = EMPTY_NEW_LECTURE): string {
  const value = (v: string): string => (v ? ` value="${escapeHtml(v)}"` : "");
  const checked = (pacing: string): string => (input.pacing === pacing ? " checked" : "");
  return `
    <h1>Start a lecture</h1>
    <p class="new-intro">Run this beside your own slides. Students tap on the slide you're on, and you see where the room got lost.</p>
    ${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ""}
    <form method="post" action="/new" class="new-lecture-form">
      <label for="title">Lecture title</label>
      <input id="title" name="title" required maxlength="${LECTURE_TITLE_MAX_LENGTH}"${value(input.title)}>

      <label for="slides">Number of slides</label>
      <p class="field-hint" id="slides-hint">1 to ${MAX_SLIDES}. Pasted slide text below sets this for you.</p>
      <input id="slides" name="slides" type="number" min="1" max="${MAX_SLIDES}" inputmode="numeric" aria-describedby="slides-hint"${value(input.slides)}>

      <fieldset class="pacing">
        <legend>Pacing</legend>
        <label class="choice"><input type="radio" name="pacing" value="next"${checked("next")}> I'll press Next</label>
        <label class="choice"><input type="radio" name="pacing" value="timed"${checked("timed")}> Timed</label>
        <p class="field-hint">A timed lecture starts when you press Start lecture in the lecturer view, then moves to the next slide on its own.</p>
        <label for="minutes">Total minutes, if timed</label>
        <p class="field-hint" id="minutes-hint">${MIN_LECTURE_MINUTES} to ${MAX_LECTURE_MINUTES}, split evenly across the slides.</p>
        <input id="minutes" name="minutes" type="number" min="${MIN_LECTURE_MINUTES}" max="${MAX_LECTURE_MINUTES}" step="any" aria-describedby="minutes-hint"${value(input.minutes)}>
        <label for="slide-minutes">Or minutes per slide</label>
        <p class="field-hint" id="slide-minutes-hint">One number per slide, separated by commas, e.g. 2, 3, 1.5. Used instead of the total.</p>
        <input id="slide-minutes" name="slide_minutes" aria-describedby="slide-minutes-hint"${value(input.slideMinutes)}>
      </fieldset>

      <label for="slides-text">Slide text (optional)</label>
      <p class="field-hint" id="slides-text-hint">Markdown, with a line of --- between slides. Up to 50 KB. HTML shows as plain text, images aren't shown, and only http and https links stay links.</p>
      <textarea id="slides-text" name="slides_text" rows="10" aria-describedby="slides-text-hint">
${escapeHtml(input.slidesText)}</textarea>

      <label for="help-url">Where students can get help (optional)</label>
      <p class="field-hint" id="help-url-hint">An https link, up to ${HELP_URL_MAX_LENGTH} characters.</p>
      <input id="help-url" name="help_url" type="url" maxlength="${HELP_URL_MAX_LENGTH}" aria-describedby="help-url-hint"${value(input.helpUrl)}>

      <button type="submit">Create</button>
    </form>
  `;
}

const LECTURE_TITLE_MAX_LENGTH = 100;
const MAX_SLIDES = 60;
const MIN_LECTURE_MINUTES = 5;
const MAX_LECTURE_MINUTES = 180;
const SLIDES_TEXT_MAX_BYTES = 50 * 1024;
// A straight COUNT(*) >= N check with no logic to get wrong — exercising it
// cleanly means actually creating 500 lectures or adding a test-only seam to
// lower the threshold, and neither is worth the cost here, so this one is
// judged by hand rather than enforced by a test (same enforced/judged split
// the README already uses for other claims).
const LECTURE_TOTAL_CAP = 500;

interface ValidNewLecture {
  title: string;
  slideCount: number | null;
  pacing: "next" | "timed";
  slideDurationsMs: number[] | null;
  slides: string[];
  helpUrl: string | null;
}

// Every limit /new states, checked here whatever the browser allowed. The
// first problem found is the message; the form comes back with the input.
function validateNewLecture(input: NewLectureInput): ValidNewLecture | string {
  if (!input.title) return "A title is required.";
  if (input.title.length > LECTURE_TITLE_MAX_LENGTH) {
    return `Titles are limited to ${LECTURE_TITLE_MAX_LENGTH} characters.`;
  }

  let slides: string[] = [];
  if (input.slidesText.trim() !== "") {
    if (Buffer.byteLength(input.slidesText, "utf8") > SLIDES_TEXT_MAX_BYTES) {
      return "Pasted slide text is limited to 50 KB.";
    }
    slides = splitPastedSlides(input.slidesText);
    if (slides.length > MAX_SLIDES) {
      return `The pasted text makes ${slides.length} slides. A lecture has at most ${MAX_SLIDES}.`;
    }
  }

  // Pasted slides' count wins over the number field (ADR 006).
  let slideCount: number | null = slides.length > 0 ? slides.length : null;
  if (slideCount === null && input.slides !== "") {
    const n = Number(input.slides);
    if (!Number.isInteger(n) || n < 1 || n > MAX_SLIDES) return `The number of slides must be 1 to ${MAX_SLIDES}.`;
    slideCount = n;
  }

  if (input.pacing !== "next" && input.pacing !== "timed") return "Choose a pacing: I'll press Next, or Timed.";
  let slideDurationsMs: number[] | null = null;
  if (input.pacing === "timed") {
    if (slideCount === null) return "A timed lecture needs a number of slides, or pasted slide text.";
    const totalMessage = `A timed lecture runs ${MIN_LECTURE_MINUTES} to ${MAX_LECTURE_MINUTES} minutes in total.`;
    let perSlideMinutes: number[];
    if (input.slideMinutes !== "") {
      perSlideMinutes = input.slideMinutes.split(/[\s,]+/).filter((part) => part !== "").map(Number);
      if (perSlideMinutes.length !== slideCount || perSlideMinutes.some((m) => !Number.isFinite(m) || m <= 0)) {
        return `Minutes per slide need one number per slide (${slideCount}), each more than 0.`;
      }
    } else {
      const total = input.minutes === "" ? NaN : Number(input.minutes);
      if (!Number.isFinite(total)) return totalMessage;
      perSlideMinutes = Array.from({ length: slideCount }, () => total / slideCount);
    }
    const total = perSlideMinutes.reduce((sum, m) => sum + m, 0);
    if (total < MIN_LECTURE_MINUTES - 1e-9 || total > MAX_LECTURE_MINUTES + 1e-9) return totalMessage;
    slideDurationsMs = perSlideMinutes.map((m) => Math.round(m * 60_000));
  }

  // The same rule as editing it from the lecturer view: one parser.
  const parsedHelpUrl = parseHelpUrl(input.helpUrl);
  if ("error" in parsedHelpUrl) return parsedHelpUrl.error;
  const helpUrl = parsedHelpUrl.url;

  return { title: input.title, slideCount, pacing: input.pacing, slideDurationsMs, slides, helpUrl };
}

async function handleNewGet(req: Request): Promise<Response> {
  const { headers } = ensureBrowserIdentity(req);
  return new Response(page("Start a lecture", newLectureForm(), undefined, "new"), { status: 200, headers });
}

async function handleNewPost(req: Request): Promise<Response> {
  const { browserId, headers } = ensureBrowserIdentity(req);

  const input = readNewLectureInput(await req.text());
  const valid = validateNewLecture(input);
  if (typeof valid === "string") {
    return new Response(page("Start a lecture", newLectureForm(valid, input)), { status: 400, headers });
  }
  if (!checkCreateLectureRateLimit(browserId)) {
    return new Response(
      page("Start a lecture", newLectureForm("Too many lectures from this browser. Try again in an hour.", input)),
      { status: 429, headers },
    );
  }
  if (lectureCount() >= LECTURE_TOTAL_CAP) {
    return new Response(
      page("Start a lecture", newLectureForm("This app isn't accepting new lectures right now.", input)),
      { status: 429, headers },
    );
  }

  const id = randomBytes(4).toString("hex");
  const code = generateAccessCode();
  createLecture(id, valid.title, 5, hashCode(code), {
    helpUrl: valid.helpUrl,
    slideCount: valid.slideCount,
    pacing: valid.pacing,
    slideDurationsMs: valid.slideDurationsMs,
    slides: valid.slides,
  });
  recordLectureCreation(browserId);
  logAction("lecture_created", id, browserId);

  const studentUrl = `/l/${id}`;
  const lecturerUrl = `/l/${id}/lecturer`;
  const timedHtml =
    valid.pacing === "timed"
      ? `<p>This lecture is timed. Its slides start moving when you press Start lecture in the lecturer view.</p>`
      : "";
  const bodyHtml = `
    <h1>Lecture created</h1>
    <p>Student link: <a href="${studentUrl}">${studentUrl}</a></p>
    <p>Lecturer code (shown once, write it down): <strong>${escapeHtml(code)}</strong></p>
    ${timedHtml}
    <p><a href="${lecturerUrl}">Go to the lecturer view</a></p>
  `;
  return new Response(page("Lecture created", bodyHtml), { status: 200, headers });
}

async function handleReadme(): Promise<Response> {
  const md = await readFile("README.md", "utf8");
  const html = await marked.parse(md);
  const body = `<div>${html}</div>`;
  return new Response(page("About", body, "readme", "readme"), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// no-cache, not a long max-age: the stylesheet has no versioned URL, so a
// browser revalidates rather than keeping an old look after a deploy.
async function handleStylesheet(): Promise<Response> {
  return new Response(STYLESHEET, {
    status: 200,
    headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-cache" },
  });
}

const DOCS_CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

async function handleDocs(reqPath: string): Promise<Response> {
  const relative = reqPath.slice("/docs/".length);
  const resolved = normalize(join("docs", relative));
  if (resolved !== "docs" && !resolved.startsWith(`docs${sep}`)) {
    return notFoundResponse();
  }
  try {
    const data = await readFile(resolved);
    const contentType = DOCS_CONTENT_TYPES[extname(resolved).toLowerCase()] ?? "application/octet-stream";
    return new Response(data, { status: 200, headers: { "content-type": contentType } });
  } catch {
    return notFoundResponse();
  }
}

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;
  const method = req.method;

  if (method === "GET" && pathname === "/") return handleHome();
  if (method === "GET" && pathname === "/readme/") return handleReadme();
  if (method === "GET" && pathname === "/style.css") return handleStylesheet();
  if (method === "GET" && pathname === "/new") return handleNewGet(req);
  if (method === "POST" && pathname === "/new") return handleNewPost(req);

  const lecturerMatch = pathname.match(/^\/l\/([^/]+)\/lecturer$/);
  if (lecturerMatch) {
    const id = safeDecode(lecturerMatch[1]);
    if (id === undefined) return notFoundResponse();
    if (method === "GET") return handleLecturerGet(id, req);
    if (method === "POST") return handleLecturerPost(id, req);
  }

  const slideNextMatch = pathname.match(/^\/l\/([^/]+)\/lecturer\/slide\/next$/);
  if (method === "POST" && slideNextMatch) {
    const id = safeDecode(slideNextMatch[1]);
    if (id === undefined) return notFoundResponse();
    return handleSlideChange(id, req, 1);
  }

  const startMatch = pathname.match(/^\/l\/([^/]+)\/lecturer\/start$/);
  if (method === "POST" && startMatch) {
    const id = safeDecode(startMatch[1]);
    if (id === undefined) return notFoundResponse();
    return handleStartLecture(id, req);
  }

  const slidePrevMatch = pathname.match(/^\/l\/([^/]+)\/lecturer\/slide\/prev$/);
  if (method === "POST" && slidePrevMatch) {
    const id = safeDecode(slidePrevMatch[1]);
    if (id === undefined) return notFoundResponse();
    return handleSlideChange(id, req, -1);
  }

  const lectureMatch = pathname.match(/^\/l\/([^/]+)$/);
  if (method === "GET" && lectureMatch) {
    const id = safeDecode(lectureMatch[1]);
    if (id === undefined) return notFoundResponse();
    return handleLecture(id, req);
  }

  const tapMatch = pathname.match(/^\/l\/([^/]+)\/tap$/);
  if (method === "POST" && tapMatch) {
    const id = safeDecode(tapMatch[1]);
    if (id === undefined) return notFoundResponse();
    return handleTap(id, req);
  }

  const reasonMatch = pathname.match(/^\/l\/([^/]+)\/reason$/);
  if (method === "POST" && reasonMatch) {
    const id = safeDecode(reasonMatch[1]);
    if (id === undefined) return notFoundResponse();
    return handleReason(id, req);
  }

  const helpedMatch = pathname.match(/^\/l\/([^/]+)\/helped$/);
  if (method === "POST" && helpedMatch) {
    const id = safeDecode(helpedMatch[1]);
    if (id === undefined) return notFoundResponse();
    return handleHelped(id, req);
  }

  const resolveMatch = pathname.match(/^\/l\/([^/]+)\/resolve$/);
  if (method === "POST" && resolveMatch) {
    const id = safeDecode(resolveMatch[1]);
    if (id === undefined) return notFoundResponse();
    return handleResolve(id, req);
  }

  const noteMatch = pathname.match(/^\/l\/([^/]+)\/note$/);
  if (method === "POST" && noteMatch) {
    const id = safeDecode(noteMatch[1]);
    if (id === undefined) return notFoundResponse();
    return handleNote(id, req);
  }

  const freshRunMatch = pathname.match(/^\/l\/([^/]+)\/lecturer\/runs\/new$/);
  if (method === "GET" && freshRunMatch) {
    const id = safeDecode(freshRunMatch[1]);
    if (id === undefined) return notFoundResponse();
    return handleFreshRunGet(id, req);
  }

  const runsMatch = pathname.match(/^\/l\/([^/]+)\/lecturer\/runs$/);
  if (method === "POST" && runsMatch) {
    const id = safeDecode(runsMatch[1]);
    if (id === undefined) return notFoundResponse();
    return handleFreshRunPost(id, req);
  }

  const helpLinkMatch = pathname.match(/^\/l\/([^/]+)\/lecturer\/help-link$/);
  if (method === "POST" && helpLinkMatch) {
    const id = safeDecode(helpLinkMatch[1]);
    if (id === undefined) return notFoundResponse();
    return handleHelpLinkPost(id, req);
  }

  const hideNoteMatch = pathname.match(/^\/l\/([^/]+)\/lecturer\/note\/(\d+)\/hide$/);
  if (method === "POST" && hideNoteMatch) {
    const id = safeDecode(hideNoteMatch[1]);
    if (id === undefined) return notFoundResponse();
    return handleHideNote(id, Number(hideNoteMatch[2]), req);
  }

  if (method === "GET" && pathname.startsWith("/docs/")) return handleDocs(pathname);

  return notFoundResponse();
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Set before anything is written, so every response this request makes
  // carries the policy: pages, redirects, errors, streams and the stylesheet.
  const nonce = randomBytes(16).toString("base64");
  res.setHeader("content-security-policy", contentSecurityPolicy(nonce));
  await requestNonce.run(nonce, () => routeRequest(req, res));
}

async function routeRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
  const { pathname } = new URL(url);

  const lecturerEventsMatch = req.method === "GET" && pathname.match(/^\/l\/([^/]+)\/lecturer\/events$/);
  if (lecturerEventsMatch) {
    const id = safeDecode(lecturerEventsMatch[1]);
    if (id === undefined) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    handleLecturerEvents(id, req, res);
    return;
  }

  const eventsMatch = req.method === "GET" && pathname.match(/^\/l\/([^/]+)\/events$/);
  if (eventsMatch) {
    const id = safeDecode(eventsMatch[1]);
    if (id === undefined) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    handleEvents(id, req, res);
    return;
  }

  const headers: Record<string, string> = {};
  if (req.headers.cookie) headers.cookie = req.headers.cookie;
  if (req.headers["x-forwarded-proto"]) {
    headers["x-forwarded-proto"] = String(req.headers["x-forwarded-proto"]);
  }

  const requestInit: RequestInit = { method: req.method, headers };
  if (req.method === "POST") {
    requestInit.body = await readBody(req);
    headers["content-type"] = String(req.headers["content-type"] ?? "application/x-www-form-urlencoded");
  }

  const request = new Request(url, requestInit);
  const response = await route(request);

  const responseHeaders: Record<string, string | string[]> = {};
  for (const [key, value] of response.headers) {
    if (key.toLowerCase() === "set-cookie") continue;
    responseHeaders[key] = value;
  }
  const setCookies = response.headers.getSetCookie();
  if (setCookies.length > 0) responseHeaders["set-cookie"] = setCookies;

  res.writeHead(response.status, responseHeaders);
  res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
}

// Enough context to reproduce the error (route, lecture, hashed who) — never
// the request body or note text, which this never even reads: pathname and
// the cookie header are all that's available to the top-level handler, by
// construction, so there's nothing here that could leak a POST body even by
// accident.
function logServerError(req: IncomingMessage, err: unknown): void {
  const pathname = (() => {
    try {
      return new URL(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`).pathname;
    } catch {
      return req.url ?? "/";
    }
  })();
  const lectureId = pathname.match(/^\/l\/([^/]+)/)?.[1];
  const browserId = rawBrowserCookie(req.headers.cookie);
  console.error(
    JSON.stringify({
      time: new Date().toISOString(),
      action: "error",
      route: pathname,
      lecture: lectureId,
      who: who(browserId),
      error: String(err),
    }),
  );
}

const server = createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (err) {
    logServerError(req, err);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    }
    res.end("Internal server error");
  }
});

startHeartbeat();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`listening on 0.0.0.0:${PORT}`);
});
