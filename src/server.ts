import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { marked } from "marked";
import {
  createLecture,
  getLecture,
  hideNoteById,
  lectureCount,
  liveTapFor,
  resolveTap,
  stepCurrentSlide,
  setNote,
  setTapReason,
  tapIfNotRecentlyTapped,
} from "./db.ts";
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
import { generateAccessCode, hashCode, verifyCode } from "./codes.ts";
import { serializeCookie } from "./cookies.ts";
import { logAction, who } from "./logging.ts";
import {
  LIVE_WINDOW_MS,
  addConnection,
  addLecturerConnection,
  broadcast,
  broadcastToLecturer,
  computeLecturerState,
  computeState,
  removeConnection,
  removeLecturerConnection,
  scheduleFade,
  sendInitialLecturerState,
  sendInitialState,
  startHeartbeat,
} from "./realtime.ts";
import type { Bar } from "./realtime.ts";
import {
  DECK_IDS,
  DECK_SHORT_NAMES,
  DECK_TITLES,
  LIVE_DECK,
  currentSlideIndex,
  deckCreditHtml,
  deckSlideCount,
  deckSlides,
  isDeckId,
  isValidSlide,
  slideName,
} from "./slides.ts";
import type { DeckId } from "./slides.ts";

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

const page = (title: string, bodyHtml: string, mainClass?: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<main${mainClass ? ` class="${mainClass}"` : ""}>
${bodyHtml}
</main>
</body>
</html>`;

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

async function handleHome(): Promise<Response> {
  const body = `
    <h1>Confusion meter</h1>
    <p>Tap "I'm lost" during a lecture, and the tap is saved so it's still there when anyone comes back.</p>
    <p><a href="/l/demo">Try the demo lecture</a> &middot; <a href="/readme/">About this app</a> &middot; <a href="/new">Start a lecture</a></p>
  `;
  return new Response(page("Confusion meter", body), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

type GaugeState = { present: number; shown: false } | { present: number; shown: true; live: number };

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

// The gauge is three nodes. What a sighted person reads is one sentence,
// "4 of 23 people are lost right now", but that sentence holds the present
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
    return `${state.live} of ${of} ${plural(of, "person", "people")} ${plural(state.live, "is", "are")} lost right now`;
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
            setText(words, state.live + " of " + of + " " + plural(of, "person", "people") + " " + plural(state.live, "is", "are") + " lost right now");
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
        function slideName(deck, slide, options) {
          options = options || {};
          var short = deck ? deckShortNames[deck] : undefined;
          var name = short ? short + ", slide " + slide : "Slide " + slide;
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
// browsing behaviour identical to a JS one's). A created (/new) lecture has
// no deck of its own, just a number the lecturer advances, so there's no
// content to show here at all.
function slideSectionHtml(lectureId: string, viewedDeck: DeckId, viewedSlide: number): string {
  if (lectureId !== "demo") return "";
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

// Says whether this viewer is on the live slide, or where the lecture is if
// they've browsed away. Rendered here so it's right without JS; the script
// rewrites the same text on browsing and on every stream frame. Plain text,
// not aria-live: the clock moves every 40s, and announcing that each time
// would chatter.
function liveMarkerText(deck: DeckId, viewedSlide: number, liveSlide: number): string {
  return viewedSlide === liveSlide
    ? "Live"
    : `You're on ${slideName(deck, viewedSlide)}. The lecture is on ${slideName(deck, liveSlide)}.`;
}

// Reason buttons appear after tapping, while the caller's own tap is live.
// A fixed list, checked server-side — no free text for students, per
// CLAUDE.md. Each is a tiny one-field <form>, so it works with no JS as a
// full page POST; the enhancement script intercepts submit to send it via
// fetch instead, same pattern as the tap form. A reason can be changed
// while live by just submitting a different one.
function reasonButtonsHtml(lectureId: string, youAreCounted: boolean): string {
  if (!youAreCounted) return "";
  const base = `/l/${encodeURIComponent(lectureId)}`;
  const buttons = REASONS.map(
    (reason) => `<form method="post" action="${base}/reason" class="reason-form">
      <input type="hidden" name="reason" value="${escapeHtml(reason)}">
      <button type="submit">${escapeHtml(reason)}</button>
    </form>`,
  ).join("\n");
  return `
    <fieldset id="reasons">
      <legend>What kind of lost?</legend>
      ${buttons}
    </fieldset>
  `;
}

// The no-JS unlock time is computed once, server-side, as an absolute
// instant ("You can tap again at 3:45pm") — a static page has no ticking
// countdown to show, so there's no point sending a relative duration here.
function unlockTimeLabel(liveForMs: number): string {
  const unlockAt = new Date(Date.now() + liveForMs);
  const formatter = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    hour: "numeric",
    minute: "2-digit",
  });
  return `You can tap again at ${formatter.format(unlockAt)}`;
}

// The note field: optional, appears alongside the reason buttons while a
// tap is live. "Only your lecturer sees this" is not just a UI claim —
// MeterState never carries note text at all, so a student page has nothing
// to leak even if this copy were wrong.
function noteFormHtml(lectureId: string, deck: DeckId | undefined, slide: number, youAreCounted: boolean): string {
  if (!youAreCounted) return "";
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
  };
  // Without JS, the unlock instant is printed as static text ("You can tap
  // again at 3:45pm") — a static page has no countdown to tick. With JS,
  // the script below counts down locally from liveForMs instead. The
  // countdown paragraph and "I get it now" form are always in the DOM
  // (hidden when the tap isn't live), rather than created only when the
  // page happens to render with youAreCounted already true — another tab's
  // tap reaching this one over SSE needs stable elements to update, not
  // ones it has to build from scratch mid-stream.
  const youAreCountedNow = state.youAreCounted;
  const liveForMsNow = "liveForMs" in state ? state.liveForMs : undefined;
  // The countdown and "I get it now" sit beside the tap form, not inside it:
  // a <form> nested in another is dropped by the HTML parser, which left
  // "I get it now" submitting a tap instead of resolving one.
  const buttonHtml = `<button class="tap-button" id="tap-button" type="submit"${youAreCountedNow ? " disabled" : ""}>${youAreCountedNow ? "You're already counted" : "I'm lost"}</button>`;
  const tapStatusHtml = `<div class="tap-status">
        <p id="tap-countdown"${youAreCountedNow ? "" : " hidden"}>${liveForMsNow !== undefined ? escapeHtml(unlockTimeLabel(liveForMsNow)) : ""}</p>
        <form method="post" action="/l/${encodeURIComponent(id)}/resolve" id="resolve-form"${youAreCountedNow ? "" : " hidden"}>
          <button type="submit">I get it now</button>
        </form>
      </div>`;

  // Below min_present, "Total taps" isn't rendered at all — not blanked,
  // not zeroed, just absent — since a hidden gauge still leaking the real
  // total in a sibling element would defeat the point of hiding it.
  const tapCountHtml = state.shown ? `<p id="tap-count">Total taps: ${state.totalTaps}</p>` : "";
  const topReasonHtml =
    "topReason" in state && state.topReason !== undefined
      ? `<p id="top-reason">Most people here say: ${escapeHtml(state.topReason)}</p>`
      : "";

  // Layout containers only; the order in the markup is the phone order
  // (slide, gauge, the sticky tap bar, then reasons and the note below it).
  // style.css places the same blocks in two columns on a wide screen.
  const body = `
    <div class="lecture-head">
      <h1>${escapeHtml(lecture.title)}</h1>
      ${deckMenuHtml(id, viewedDeck)}
    </div>
    <div class="lecture-layout${id === "demo" ? "" : " no-deck"}">
      <div class="slide-col">
        <div class="slide-bar">
          ${slideProgressLabel(id, viewedDeck, viewedSlide, liveSlide)}
          ${slideNavHtml(id, viewedDeck, viewedSlide, liveSlide)}
        </div>
        ${id === "demo" ? `<p id="live-marker">${escapeHtml(liveMarkerText(viewedDeck, viewedSlide, liveSlide))}</p>` : ""}
        ${slideSectionHtml(id, viewedDeck, viewedSlide)}
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
        ${reasonButtonsHtml(id, state.youAreCounted)}
        ${noteFormHtml(id, id === "demo" ? viewedDeck : undefined, viewedSlide, state.youAreCounted)}
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
          var slides = document.querySelectorAll("#slides .deck[data-deck=\\"" + deck + "\\"] .slide");
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
          attachNavHandlers();
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

        var countdownTimer = null;

        function stopCountdown() {
          if (countdownTimer) {
            clearInterval(countdownTimer);
            countdownTimer = null;
          }
        }

        // Ticks down locally from the most recently received liveForMs,
        // rather than diffing against the device clock — a wrong or skewed
        // clock doesn't give a wrong countdown this way.
        function startCountdown(liveForMs) {
          stopCountdown();
          var remainingMs = liveForMs;
          var countdownEl = document.getElementById("tap-countdown");
          function tick() {
            if (!countdownEl) return;
            var seconds = Math.max(0, Math.ceil(remainingMs / 1000));
            var m = Math.floor(seconds / 60);
            var s = seconds % 60;
            countdownEl.textContent = "You can tap again in " + m + ":" + (s < 10 ? "0" : "") + s;
            remainingMs -= 1000;
            if (remainingMs < -1000) stopCountdown();
          }
          tick();
          countdownTimer = setInterval(tick, 1000);
        }

        function attachReasonHandlers() {
          var forms = document.querySelectorAll(".reason-form");
          for (var i = 0; i < forms.length; i++) {
            forms[i].addEventListener("submit", function (event) {
              event.preventDefault();
              var reasonForm = event.target;
              var reasonInput = reasonForm.querySelector("input[name=reason]");
              fetch(reasonForm.action, {
                method: "POST",
                body: new URLSearchParams({ reason: reasonInput.value }),
              }).catch(function () {});
            });
          }
        }
        attachReasonHandlers();

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
        var reasonsList = ${JSON.stringify(REASONS)};
        var isDemo = ${JSON.stringify(id === "demo")};

        function buildReasonsHtml() {
          var html = '<fieldset id="reasons"><legend>What kind of lost?</legend>';
          for (var i = 0; i < reasonsList.length; i++) {
            var r = reasonsList[i];
            html += '<form method="post" action="' + tapBaseUrl + '/reason" class="reason-form">'
              + '<input type="hidden" name="reason" value="' + r + '">'
              + '<button type="submit">' + r + '</button></form>';
          }
          html += '</fieldset>';
          return html;
        }

        function buildNoteFormHtml() {
          var deckInputHtml = isDemo ? '<input type="hidden" name="deck" value="' + viewedDeck + '">' : "";
          return '<form method="post" action="' + tapBaseUrl + '/note" id="note-form">'
            + deckInputHtml
            + '<input type="hidden" name="slide" value="' + viewedSlide + '">'
            + '<label for="note-text">What part of this didn\\'t make sense?</label>'
            + '<p id="note-hint">Only your lecturer sees this, and only alongside other people\\'s notes.</p>'
            + '<textarea id="note-text" name="text" maxlength="200" placeholder="e.g. when the budget suddenly included the tool output"></textarea>'
            + '<p id="note-counter">0/200</p>'
            + '<button type="submit" id="note-send">Send</button>'
            + '<p id="note-status" aria-live="polite"></p>'
            + '</form>';
        }

        // Builds the reason fieldset and note form fresh each time a tap
        // goes live (another tab's tap reaching this one via SSE included,
        // not just this tab's own submit) — removed entirely, not merely
        // hidden, once the tap is no longer live, same discipline as every
        // other gated-on-a-condition element on this page.
        function renderReasonsAndNote(youAreCounted) {
          var existingReasons = document.getElementById("reasons");
          var existingNote = document.getElementById("note-form");
          if (!youAreCounted) {
            if (existingReasons) existingReasons.remove();
            if (existingNote) existingNote.remove();
            return;
          }
          if (!existingReasons) {
            var wrapper = document.createElement("div");
            wrapper.innerHTML = buildReasonsHtml();
            feedback.insertAdjacentElement("beforebegin", wrapper.firstElementChild);
            attachReasonHandlers();
          }
          if (!existingNote) {
            var noteWrapper = document.createElement("div");
            noteWrapper.innerHTML = buildNoteFormHtml();
            feedback.insertAdjacentElement("beforebegin", noteWrapper.firstElementChild);
            attachNoteHandlers();
          }
        }

        var resolveForm = document.getElementById("resolve-form");
        if (resolveForm) {
          resolveForm.addEventListener("submit", function (event) {
            event.preventDefault();
            fetch(resolveForm.action, { method: "POST" })
              .then(function () {
                stopCountdown();
              })
              .catch(function () {});
          });
        }

        attachNoteHandlers();

        function render(state) {
          // A demo frame names its deck; ignore its slide if it's about a
          // deck this page has since switched away from.
          if (!state.deck || state.deck === viewedDeck) {
            liveSlide = state.slide;
            if (landOnLive && isDemo) {
              landOnLive = false;
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
          yourCount.textContent = "You've said you're lost " + state.yourTapCount + " time" + (state.yourTapCount === 1 ? "" : "s") + " in this lecture";
          var countdownEl2 = document.getElementById("tap-countdown");
          var resolveFormEl = document.getElementById("resolve-form");
          if (state.youAreCounted) {
            setTapEnabled(false);
            button.textContent = "You're counted";
            if (countdownEl2) countdownEl2.hidden = false;
            if (resolveFormEl) resolveFormEl.hidden = false;
            if (typeof state.liveForMs === "number") startCountdown(state.liveForMs);
          } else {
            setTapEnabled(true);
            button.textContent = "I'm lost";
            stopCountdown();
            if (countdownEl2) {
              countdownEl2.hidden = true;
              countdownEl2.textContent = "";
            }
            if (resolveFormEl) {
              // Hiding a focused control drops focus to <body>; hand it to
              // the tap button, the next thing a keyboard user needs.
              var hadFocus = resolveFormEl.contains(document.activeElement);
              resolveFormEl.hidden = true;
              if (hadFocus) button.focus();
            }
          }
          var afterTap = document.querySelector(".after-tap");
          var focusInAfterTap = !state.youAreCounted && afterTap && afterTap.contains(document.activeElement)
            && (document.activeElement.closest("#reasons") || document.activeElement.closest("#note-form"));
          renderReasonsAndNote(state.youAreCounted);
          if (focusInAfterTap) button.focus();
        }

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

  return new Response(page(lecture.title, body, "lecture"), { status: 200, headers });
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

  const since = new Date(Date.now() - LIVE_WINDOW_MS).toISOString();
  const inserted = tapIfNotRecentlyTapped(id, browserId, since, submittedDeck ?? null, submittedSlide);
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

// The caller's live tap decides where a reason or "I get it now" returns
// to; with no live tap there's no slide to return to, so the lecture page.
function tapPageLocation(id: string, tap: { deck: string | null; slide: number | null } | undefined): string {
  if (tap === undefined || tap.slide === null) return `/l/${encodeURIComponent(id)}`;
  return slidePageLocation(id, tap.deck, tap.slide);
}

const REASONS = ["Too fast", "Missed a step", "Notation", "Can't see or hear"];

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

  const body = await req.text();
  const reason = new URLSearchParams(body).get("reason") ?? "";
  if (!REASONS.includes(reason)) {
    logAction("reason_rejected", id, browserId);
    return new Response("Invalid reason", {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const since = new Date(Date.now() - LIVE_WINDOW_MS).toISOString();
  setTapReason(id, browserId, since, reason);
  logAction("reason_set", id, browserId);
  broadcast(id);
  broadcastToLecturer(id);

  return new Response(null, {
    status: 303,
    headers: { location: tapPageLocation(id, liveTapFor(id, browserId, since)) },
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

  const since = new Date(Date.now() - LIVE_WINDOW_MS).toISOString();
  // Read before resolving: once resolved, it's no longer the live tap.
  const tap = liveTapFor(id, browserId, since);
  resolveTap(id, browserId, since);
  logAction("tap_resolved", id, browserId);
  broadcast(id);
  broadcastToLecturer(id);

  return new Response(null, {
    status: 303,
    headers: { location: tapPageLocation(id, tap) },
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

// Notes on every slide except the current one (those lead the page, in
// #now). The whole section is absent when there are none.
function notesHtml(lectureId: string, notes: DashboardNote[]): string {
  if (notes.length === 0) return "";
  return `
    <section id="notes">
      <h2>What didn't make sense, on other slides</h2>
      <ul id="notes-list" class="notes-list">${noteItemsHtml(lectureId, notes)}</ul>
    </section>
  `;
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
): string {
  const bar = bars.find(onSlide(key));
  const maxCount = Math.max(1, ...bars.map((b) => b.distinctBrowsers));
  const barHtml = bar
    ? `<p>${bar.distinctBrowsers} ${plural(bar.distinctBrowsers, "person has", "people have")} been lost on this slide</p>${quietBarHtml("now-bar-svg", bar.distinctBrowsers / maxCount)}`
    : `<p id="now-empty">Not enough taps on this slide to show yet</p>`;
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
  return `<h2 id="now-heading">On this slide</h2><div id="now-bar">${barHtml}</div>${reasonsHtml}${notesListHtml}`;
}

function lecturerDashboard(
  id: string,
  state:
    | {
        present: number;
        shown: false;
        slide: number;
        bars: Bar[];
        reasonCounts: DashboardReasonCount[];
        notes: DashboardNote[];
      }
    | {
        present: number;
        shown: true;
        slide: number;
        bars: Bar[];
        live: number;
        totalTaps: number;
        reasonCounts: DashboardReasonCount[];
        notes: DashboardNote[];
      },
  minPresent: number,
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
      : `
    ${slideLabelHtml}
    <form method="post" action="/l/${encodeURIComponent(id)}/lecturer/slide/prev" id="slide-prev-form">
      <button type="submit">Previous slide</button>
    </form>
    <form method="post" action="/l/${encodeURIComponent(id)}/lecturer/slide/next" id="slide-next-form">
      <button type="submit">Next slide</button>
    </form>`;

  const nowKey: SlideKey = { deck: id === "demo" ? LIVE_DECK : null, slide: state.slide };
  const isNow = onSlide(nowKey);

  return `
    <div class="lecturer-head">
      <h1>Lecturer view</h1>
${slideControlsHtml}
    </div>
    <div class="lecturer-layout">
      <div class="now-panel">
        ${gaugeHtml(state, minPresent)}
        <p id="connection-status" aria-live="polite"></p>
${tapCountHtml}
        <section id="now" aria-labelledby="now-heading">${nowSectionInnerHtml(id, nowKey, state.bars, state.reasonCounts, state.notes)}</section>
      </div>
      <div class="all-panel">
        <h2>Every slide so far</h2>
        <div id="bars">${barsHtml(state.bars)}</div>
        <div id="reason-counts-container">${reasonCountsHtml(state.reasonCounts)}</div>
        <div id="other-notes">${notesHtml(id, state.notes.filter((n) => !isNow(n)))}</div>
      </div>
    </div>
    <script>
      (function () {
        var minPresent = ${JSON.stringify(minPresent)};
        var nowDeck = ${JSON.stringify(nowKey.deck)};
        var lectureBase = ${JSON.stringify(`/l/${encodeURIComponent(id)}`)};
${GAUGE_CLIENT_JS}
${SLIDE_NAME_CLIENT_JS}
        var connectionStatus = document.getElementById("connection-status");

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

        function attachHideNoteHandlers() {
          var forms = document.querySelectorAll(".hide-note-form");
          for (var i = 0; i < forms.length; i++) {
            forms[i].addEventListener("submit", function (event) {
              event.preventDefault();
              fetch(event.target.action, { method: "POST" }).catch(function () {});
            });
          }
        }
        attachHideNoteHandlers();

        function renderReasonCounts(reasonCounts) {
          var container = document.getElementById("reason-counts-container");
          if (!container) return;
          if (!reasonCounts || reasonCounts.length === 0) {
            container.innerHTML = "";
            return;
          }
          var sorted = reasonCounts.slice().sort(function (a, b) {
            return (a.deck || "").localeCompare(b.deck || "") || a.slide - b.slide || b.count - a.count;
          });
          var table = document.createElement("table");
          table.className = "reason-counts";
          table.id = "reason-counts";
          var thead = document.createElement("thead");
          thead.innerHTML = "<tr><th>Slide</th><th>Reason</th><th>Count</th></tr>";
          var tbody = document.createElement("tbody");
          sorted.forEach(function (entry) {
            var label = slideName(entry.deck, entry.slide);
            var tr = document.createElement("tr");
            var tdLabel = document.createElement("td");
            tdLabel.textContent = label;
            var tdReason = document.createElement("td");
            tdReason.textContent = entry.reason;
            var tdCount = document.createElement("td");
            tdCount.textContent = String(entry.count);
            tr.appendChild(tdLabel);
            tr.appendChild(tdReason);
            tr.appendChild(tdCount);
            tbody.appendChild(tr);
          });
          table.appendChild(thead);
          table.appendChild(tbody);
          container.innerHTML = "";
          container.appendChild(table);
        }

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

        // Notes on every slide but the current one. A hidden note is
        // removed from the DOM entirely on the next broadcast, not just
        // visually hidden — same privacy discipline as every other gated
        // element on this page.
        function renderOtherNotes(notes) {
          var container = document.getElementById("other-notes");
          if (!container || !notesChanged("other", notes)) return;
          container.innerHTML = "";
          if (notes.length === 0) return;
          var section = document.createElement("section");
          section.id = "notes";
          var heading = document.createElement("h2");
          heading.textContent = "What didn't make sense, on other slides";
          section.appendChild(heading);
          section.appendChild(buildNotesList(notes, "notes-list"));
          container.appendChild(section);
          attachHideNoteHandlers();
        }

        // The current slide first: its bar, its reasons, its notes, each
        // filtered from arrays the server already gated.
        function renderNow(state) {
          var now = document.getElementById("now");
          if (!now) return;
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
            var text = bar.distinctBrowsers + " " + plural(bar.distinctBrowsers, "person has", "people have") + " been lost on this slide";
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
              empty.textContent = "Not enough taps on this slide to show yet";
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
              attachHideNoteHandlers();
            }
          }
        }

        function render(state) {
          var slideLabel = document.getElementById("slide-label");
          if (slideLabel) setText(slideLabel, slideName(nowDeck, state.slide, { live: true }));
          // renderGauge (shared with the student page) only touches the
          // aria-live node on an actual lost-count change or a shown
          // boundary crossing.
          renderGauge(state, minPresent);
          var gauge = document.getElementById("gauge");
          if (state.shown) {
            var tapCount = document.getElementById("tap-count");
            if (!tapCount) {
              tapCount = document.createElement("p");
              tapCount.id = "tap-count";
              gauge.insertAdjacentElement("afterend", tapCount);
            }
            setText(tapCount, "Total taps: " + state.totalTaps);
          } else {
            var oldTapCount = document.getElementById("tap-count");
            if (oldTapCount) oldTapCount.remove();
          }
          renderNow(state);
          renderBars(state.bars);
          renderReasonCounts(state.reasonCounts);
          renderOtherNotes((state.notes || []).filter(function (n) { return !isNow(n, state.slide); }));
        }

        var source = new EventSource(${JSON.stringify(`/l/${encodeURIComponent(id)}/lecturer/events`)});
        source.onmessage = function (event) {
          if (connectionStatus) connectionStatus.textContent = "";
          render(JSON.parse(event.data));
        };
        source.onerror = function () {
          if (connectionStatus) connectionStatus.textContent = "Reconnecting...";
        };
      })();
    </script>
  `;
}

async function handleLecturerGet(id: string, req: Request): Promise<Response> {
  const lecture = getLecture(id);
  if (!lecture) return notFoundResponse();

  const { headers } = ensureBrowserIdentity(req);

  if (!validateLecturerSession(id, req.headers.get("cookie"))) {
    return new Response(page("Lecturer view", lecturerLoginForm(id)), { status: 200, headers });
  }

  const state = computeLecturerState(id) ?? {
    present: 0,
    shown: false as const,
    slide: currentSlideIndex(lecture),
    bars: [] as Bar[],
    reasonCounts: [] as DashboardReasonCount[],
    notes: [] as DashboardNote[],
  };
  return new Response(page("Lecturer view", lecturerDashboard(id, state, lecture.min_present), "lecturer"), {
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

  stepCurrentSlide(id, direction);
  logAction("slide_changed", id, browserId);
  broadcast(id);
  broadcastToLecturer(id);

  return new Response(null, {
    status: 303,
    headers: { location: `/l/${encodeURIComponent(id)}/lecturer` },
  });
}

function newLectureForm(error?: string): string {
  return `
    <h1>Start a lecture</h1>
    ${error ? `<p class="form-error">${escapeHtml(error)}</p>` : ""}
    <form method="post" action="/new" class="inline-form">
      <label for="title">Lecture title</label>
      <input id="title" name="title" required>
      <button type="submit">Create</button>
    </form>
  `;
}

const LECTURE_TITLE_MAX_LENGTH = 100;
// A straight COUNT(*) >= N check with no logic to get wrong — exercising it
// cleanly means actually creating 500 lectures or adding a test-only seam to
// lower the threshold, and neither is worth the cost here, so this one is
// judged by hand rather than enforced by a test (same enforced/judged split
// the README already uses for other claims).
const LECTURE_TOTAL_CAP = 500;

async function handleNewGet(req: Request): Promise<Response> {
  const { headers } = ensureBrowserIdentity(req);
  return new Response(page("Start a lecture", newLectureForm()), { status: 200, headers });
}

async function handleNewPost(req: Request): Promise<Response> {
  const { browserId, headers } = ensureBrowserIdentity(req);

  const body = await req.text();
  const title = new URLSearchParams(body).get("title")?.trim();
  if (!title) {
    return new Response(page("Start a lecture", newLectureForm("A title is required.")), {
      status: 400,
      headers,
    });
  }
  if (title.length > LECTURE_TITLE_MAX_LENGTH) {
    return new Response(
      page("Start a lecture", newLectureForm(`Titles are limited to ${LECTURE_TITLE_MAX_LENGTH} characters.`)),
      { status: 400, headers },
    );
  }
  if (!checkCreateLectureRateLimit(browserId)) {
    return new Response(
      page("Start a lecture", newLectureForm("Too many lectures from this browser. Try again in an hour.")),
      { status: 429, headers },
    );
  }
  if (lectureCount() >= LECTURE_TOTAL_CAP) {
    return new Response(
      page("Start a lecture", newLectureForm("This app isn't accepting new lectures right now.")),
      { status: 429, headers },
    );
  }

  const id = randomBytes(4).toString("hex");
  const code = generateAccessCode();
  createLecture(id, title, 5, hashCode(code));
  recordLectureCreation(browserId);
  logAction("lecture_created", id, browserId);

  const studentUrl = `/l/${id}`;
  const lecturerUrl = `/l/${id}/lecturer`;
  const bodyHtml = `
    <h1>Lecture created</h1>
    <p>Student link: <a href="${studentUrl}">${studentUrl}</a></p>
    <p>Lecturer code (shown once, write it down): <strong>${escapeHtml(code)}</strong></p>
    <p><a href="${lecturerUrl}">Go to the lecturer view</a></p>
  `;
  return new Response(page("Lecture created", bodyHtml), { status: 200, headers });
}

async function handleReadme(): Promise<Response> {
  const md = await readFile("README.md", "utf8");
  const html = await marked.parse(md);
  const body = `<div>${html}</div>`;
  return new Response(page("About", body), {
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
