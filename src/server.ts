import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { marked } from "marked";
import {
  createLecture,
  getLecture,
  hideNoteById,
  resolveTap,
  setCurrentSlide,
  setNote,
  setTapReason,
  tapIfNotRecentlyTapped,
} from "./db.ts";
import {
  BROWSER_COOKIE,
  LECTURER_COOKIE,
  checkLoginRateLimit,
  createLecturerSession,
  ensureBrowserId,
  rawBrowserCookie,
  recordFailedLogin,
  validateBrowserId,
  validateLecturerSession,
} from "./auth.ts";
import { generateAccessCode, hashCode, verifyCode } from "./codes.ts";
import { serializeCookie } from "./cookies.ts";
import { logAction } from "./logging.ts";
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
  scheduleSlideAdvance,
  startHeartbeat,
} from "./realtime.ts";
import type { Bar } from "./realtime.ts";
import {
  DECK_IDS,
  DECK_TITLES,
  LIVE_DECK,
  currentSlideIndex,
  deckCreditHtml,
  deckSlideCount,
  deckSlides,
  isDeckId,
  isValidSlide,
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

const STYLE = `
  body {
    font-family: system-ui, sans-serif;
    max-width: 40rem;
    margin: 0 auto;
    padding: 1rem;
    line-height: 1.5;
  }
  .tap-button {
    display: block;
    width: 100%;
    font-size: 1.5rem;
    padding: 1.5rem;
    margin: 1.5rem 0;
    min-height: 3.5rem;
  }
  table.bars {
    border-collapse: collapse;
    width: 100%;
  }
  table.bars th, table.bars td {
    border-bottom: 1px solid #ccc;
    padding: 0.25rem 0.5rem;
    text-align: left;
  }
  svg.bar-chart {
    width: 100%;
    height: auto;
    display: block;
  }
  table.reason-counts {
    border-collapse: collapse;
    width: 100%;
  }
  table.reason-counts th, table.reason-counts td {
    border-bottom: 1px solid #ccc;
    padding: 0.25rem 0.5rem;
    text-align: left;
  }
  #reasons {
    border: none;
    padding: 0;
    margin: 1rem 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  #reasons .reason-form {
    margin: 0;
  }
  #note-form textarea {
    width: 100%;
    min-height: 4rem;
    font: inherit;
  }
  ul#notes-list {
    list-style: none;
    padding: 0;
  }
  li.note {
    border: 1px solid #ccc;
    border-radius: 0.5rem;
    padding: 0.75rem;
    margin: 0.5rem 0;
  }
`;

const page = (title: string, bodyHtml: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
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

function gaugeMessage(
  state: { present: number; shown: false } | { present: number; shown: true; live: number },
  minPresent: number,
): string {
  if (state.shown) {
    return `${state.present} people here, ${state.live} lost right now`;
  }
  return `Waiting for ${Math.max(0, minPresent - state.present)} more people`;
}

function barLabel(bar: Bar): string {
  return bar.deck !== null ? `${bar.deck} / slide ${bar.slide}` : `Slide ${bar.slide}`;
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
      return `<rect x="${x}" y="${y}" width="${barWidth}" height="${height}" fill="currentColor"><title>${escapeHtml(barLabel(bar))}: ${bar.distinctBrowsers}</title></rect><text x="${x + barWidth / 2}" y="${chartHeight - 4}" text-anchor="middle" font-size="12">${i + 1}</text>`;
    })
    .join("\n");
  return `
    <svg class="bar-chart" id="bars-chart" viewBox="0 0 ${chartWidth} ${chartHeight}" role="img" aria-label="Distinct people lost, per slide">
      ${rects}
    </svg>
    <table class="bars" id="bars-table">
      <thead><tr><th>Slide</th><th>People lost here</th></tr></thead>
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

function slideProgressLabel(lectureId: string, deck: DeckId, slide: number): string {
  const total = lectureId === "demo" ? ` of ${deckSlideCount(deck)}` : "";
  return `<p id="slide-label">Slide ${slide}${total}</p>`;
}

// A plain <select>, submitting via its own tiny no-JS form — picking a deck
// always lands on that deck's slide 1, same as following a link does. The
// enhancement script intercepts `change` to switch client-side instead of
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
// slides client-side instead. "Back to live" always returns to the live
// deck's live slide in one step, regardless of which deck was being viewed
// — ADR 004's amendment: browsing is now how a tap records an earlier
// slide, replacing the old grace-window reconciliation outright. Only
// rendered for the demo — a created lecture has no deck content in the app
// to browse, just a number the lecturer advances, so there's nothing here
// for a student to flip between.
function slideNavHtml(
  lectureId: string,
  viewedDeck: DeckId,
  viewedSlide: number,
  liveDeck: DeckId,
  liveSlide: number,
): string {
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
  const onLive = viewedDeck === liveDeck && viewedSlide === liveSlide;
  const backToLiveHtml = !onLive ? `<a href="${base}" id="back-to-live-link">Back to live</a>` : "";
  return `
    <nav id="slide-nav" aria-label="Slide navigation">
      ${prevHtml}
      ${nextHtml}
      ${backToLiveHtml}
    </nav>
  `;
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

  const { id: browserId, minted } = ensureBrowserId(req.headers.get("cookie"));
  logAction("page_view", id, browserId);

  const liveSlide = currentSlideIndex(lecture);
  const params = new URL(req.url).searchParams;
  const requestedDeckRaw = params.get("deck");
  const requestedSlideRaw = params.get("slide");
  const requestedDeck = requestedDeckRaw !== null && isDeckId(requestedDeckRaw) ? requestedDeckRaw : undefined;
  const requestedSlideNumber = requestedSlideRaw !== null ? Number(requestedSlideRaw) : NaN;

  // Omitting deck (and slide) means "the live deck's live slide" — following
  // a Previous/Next link always names both, so this only matters for the
  // bare /l/demo request. Naming a deck but no slide lands on that deck's
  // slide 1, same as the menu switching decks does.
  const viewedDeck: DeckId = requestedDeck ?? LIVE_DECK;
  const viewedSlide =
    requestedDeck === undefined && requestedSlideRaw === null
      ? liveSlide
      : Number.isFinite(requestedSlideNumber) && isValidSlide(lecture, viewedDeck, requestedSlideNumber)
        ? requestedSlideNumber
        : 1;

  const state = computeState(id, browserId) ?? {
    present: 0,
    shown: false as const,
    slide: liveSlide,
    bars: [] as Bar[],
    yourTapCount: 0,
    youAreCounted: false,
  };
  const gaugeText = gaugeMessage(state, lecture.min_present);

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
  const buttonHtml = `<button class="tap-button" id="tap-button" type="submit"${youAreCountedNow ? " disabled" : ""}>${youAreCountedNow ? "You're already counted" : "I'm lost"}</button>
       <p id="tap-countdown"${youAreCountedNow ? "" : " hidden"}>${liveForMsNow !== undefined ? escapeHtml(unlockTimeLabel(liveForMsNow)) : ""}</p>
       <form method="post" action="/l/${encodeURIComponent(id)}/resolve" id="resolve-form"${youAreCountedNow ? "" : " hidden"}>
         <button type="submit">I get it now</button>
       </form>`;

  // Below min_present, "Total taps" isn't rendered at all — not blanked,
  // not zeroed, just absent — since a hidden gauge still leaking the real
  // total in a sibling element would defeat the point of hiding it.
  const tapCountHtml = state.shown ? `<p id="tap-count">Total taps: ${state.totalTaps}</p>` : "";
  const topReasonHtml =
    "topReason" in state && state.topReason !== undefined
      ? `<p id="top-reason">Most people here say: ${escapeHtml(state.topReason)}</p>`
      : "";

  const body = `
    <h1>${escapeHtml(lecture.title)}</h1>
    ${deckMenuHtml(id, viewedDeck)}
    ${slideProgressLabel(id, viewedDeck, viewedSlide)}
    ${slideNavHtml(id, viewedDeck, viewedSlide, LIVE_DECK, liveSlide)}
    ${slideSectionHtml(id, viewedDeck, viewedSlide)}
    <section id="gauge" aria-live="polite">${escapeHtml(gaugeText)}</section>
    ${topReasonHtml}
    <form method="post" action="/l/${encodeURIComponent(id)}/tap" id="tap-form">
      <input type="hidden" name="deck" id="deck-input" value="${viewedDeck}">
      <input type="hidden" name="slide" id="slide-input" value="${viewedSlide}">
      ${buttonHtml}
    </form>
    <p id="tap-hint">Other tabs in this browser count as you.</p>
    ${reasonButtonsHtml(id, state.youAreCounted)}
    ${noteFormHtml(id, id === "demo" ? viewedDeck : undefined, viewedSlide, state.youAreCounted)}
    <p id="tap-feedback" aria-live="polite"></p>
    ${tapCountHtml}
    <div id="bars">${barsHtml(state.bars)}</div>
    <p id="your-count">You've said you're lost ${state.yourTapCount} time${state.yourTapCount === 1 ? "" : "s"} in this lecture</p>
    <script>
      (function () {
        var minPresent = ${JSON.stringify(lecture.min_present)};
        var deckSlideCounts = ${JSON.stringify(
          id === "demo" ? Object.fromEntries(DECK_IDS.map((d) => [d, deckSlideCount(d)])) : undefined,
        )};
        var liveDeck = ${JSON.stringify(LIVE_DECK)};
        var gauge = document.getElementById("gauge");
        var form = document.getElementById("tap-form");
        var button = document.getElementById("tap-button");
        var feedback = document.getElementById("tap-feedback");
        var tapCount = document.getElementById("tap-count");
        var yourCount = document.getElementById("your-count");
        var slideInput = document.getElementById("slide-input");
        var deckInput = document.getElementById("deck-input");
        var deckSelect = document.getElementById("deck-select");
        var deckForm = document.getElementById("deck-form");

        // Kept separate: the deck/slide this browser is looking at (what a
        // tap records, what the arrows move), and the live deck/slide the
        // shared clock is on (what "Back to live" returns to in one step).
        // Browsing away from live never changes the live slide for anyone.
        var viewedDeck = ${JSON.stringify(viewedDeck)};
        var viewedSlide = ${JSON.stringify(viewedSlide)};
        var liveSlide = ${JSON.stringify(liveSlide)};

        function maxSlideFor(deck) {
          return deckSlideCounts ? deckSlideCounts[deck] : undefined;
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
          var label = document.getElementById("slide-label");
          if (label) {
            label.textContent = "Slide " + slide + (maxSlide ? " of " + maxSlide : "");
          }
          var prevLink = document.getElementById("slide-prev-link");
          var nextLink = document.getElementById("slide-next-link");
          var backLink = document.getElementById("back-to-live-link");
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
          if (backLink) {
            var onLive = deck === liveDeck && slide === liveSlide;
            backLink.style.display = onLive ? "none" : "";
          }
          attachNavHandlers();
        }

        function attachNavHandlers() {
          var prevLink = document.getElementById("slide-prev-link");
          var nextLink = document.getElementById("slide-next-link");
          var backLink = document.getElementById("back-to-live-link");
          if (prevLink && prevLink.tagName === "A") {
            prevLink.addEventListener("click", function (event) {
              event.preventDefault();
              showSlide(viewedDeck, viewedSlide - 1);
            });
          }
          if (nextLink && nextLink.tagName === "A") {
            nextLink.addEventListener("click", function (event) {
              event.preventDefault();
              showSlide(viewedDeck, viewedSlide + 1);
            });
          }
          if (backLink) {
            backLink.addEventListener("click", function (event) {
              event.preventDefault();
              showSlide(liveDeck, liveSlide);
            });
          }
        }
        attachNavHandlers();

        if (deckSelect && deckForm) {
          deckSelect.addEventListener("change", function (event) {
            event.preventDefault();
            showSlide(deckSelect.value, 1);
          });
        }

        document.addEventListener("keydown", function (event) {
          var active = document.activeElement;
          var tag = active && active.tagName;
          if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
          var maxSlide = maxSlideFor(viewedDeck);
          if (event.key === "ArrowLeft" && viewedSlide > 1) showSlide(viewedDeck, viewedSlide - 1);
          if (event.key === "ArrowRight" && (!maxSlide || viewedSlide < maxSlide)) showSlide(viewedDeck, viewedSlide + 1);
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
            var label = bar.deck ? bar.deck + " / slide " + bar.slide : "Slide " + bar.slide;
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
            text.setAttribute("font-size", "12");
            text.textContent = String(i + 1);
            svg.appendChild(text);
          });
          var table = document.createElement("table");
          table.className = "bars";
          var thead = document.createElement("thead");
          thead.innerHTML = "<tr><th>Slide</th><th>People lost here</th></tr>";
          var tbody = document.createElement("tbody");
          sorted.forEach(function (bar) {
            var label = bar.deck ? bar.deck + " / slide " + bar.slide : "Slide " + bar.slide;
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
          liveSlide = state.slide;
          var backLink = document.getElementById("back-to-live-link");
          var onLive = viewedDeck === liveDeck && viewedSlide === liveSlide;
          if (backLink) backLink.style.display = onLive ? "none" : "";
          if (state.shown) {
            gauge.textContent = state.present + " people here, " + state.live + " lost right now";
            if (!tapCount) {
              tapCount = document.createElement("p");
              tapCount.id = "tap-count";
              feedback.insertAdjacentElement("afterend", tapCount);
            }
            tapCount.textContent = "Total taps: " + state.totalTaps;
          } else {
            gauge.textContent = "Waiting for " + Math.max(0, minPresent - state.present) + " more people";
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
            button.disabled = true;
            button.textContent = "You're counted";
            if (countdownEl2) countdownEl2.hidden = false;
            if (resolveFormEl) resolveFormEl.hidden = false;
            if (typeof state.liveForMs === "number") startCountdown(state.liveForMs);
          } else {
            button.disabled = false;
            button.textContent = "I'm lost";
            stopCountdown();
            if (countdownEl2) {
              countdownEl2.hidden = true;
              countdownEl2.textContent = "";
            }
            if (resolveFormEl) resolveFormEl.hidden = true;
          }
          renderReasonsAndNote(state.youAreCounted);
        }

        var source = new EventSource(${JSON.stringify(`/l/${encodeURIComponent(id)}/events`)});
        source.onmessage = function (event) {
          render(JSON.parse(event.data));
        };

        form.addEventListener("submit", function (event) {
          event.preventDefault();
          feedback.textContent = "";
          button.disabled = true;
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
              button.disabled = false;
              button.textContent = "I'm lost";
              feedback.textContent = "Couldn't send. Try again.";
            });
        });
      })();
    </script>
  `;

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
  return new Response(page(lecture.title, body), { status: 200, headers });
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
  const submittedDeck = submittedDeckRaw !== null && submittedDeckRaw !== "" ? submittedDeckRaw : undefined;
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

  const deckParam = submittedDeck !== undefined ? `deck=${submittedDeck}&` : "";
  return new Response(null, {
    status: 303,
    headers: { location: `/l/${encodeURIComponent(id)}?${deckParam}slide=${submittedSlide}` },
  });
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
    headers: { location: `/l/${encodeURIComponent(id)}` },
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
  resolveTap(id, browserId, since);
  logAction("tap_resolved", id, browserId);
  broadcast(id);
  broadcastToLecturer(id);

  return new Response(null, {
    status: 303,
    headers: { location: `/l/${encodeURIComponent(id)}` },
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
  const submittedDeck = submittedDeckRaw !== null && submittedDeckRaw !== "" ? submittedDeckRaw : undefined;
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

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  addConnection(id, browserId, res);
  logAction("stream_open", id, browserId);
  broadcast(id);
  scheduleFade(id);
  scheduleSlideAdvance(id);

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
  broadcastToLecturer(id);

  req.on("close", () => {
    removeLecturerConnection(id, res);
    logAction("stream_close", id, browserId);
  });
}

function lecturerLoginForm(id: string, error?: string): string {
  return `
    <h1>Lecturer view</h1>
    ${error ? `<p>${escapeHtml(error)}</p>` : ""}
    <form method="post" action="/l/${encodeURIComponent(id)}/lecturer">
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
      const label = entry.deck !== null ? `${entry.deck} / slide ${entry.slide}` : `Slide ${entry.slide}`;
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
function notesHtml(lectureId: string, notes: DashboardNote[]): string {
  if (notes.length === 0) return "";
  const sorted = [...notes].sort(
    (a, b) =>
      (a.deck ?? "").localeCompare(b.deck ?? "") ||
      a.slide - b.slide ||
      b.created_at.localeCompare(a.created_at),
  );
  const base = `/l/${encodeURIComponent(lectureId)}`;
  const items = sorted
    .map((note) => {
      const label = note.deck !== null ? `${note.deck} / slide ${note.slide}` : `Slide ${note.slide}`;
      return `<li class="note" data-note-id="${note.id}">
        <p class="note-slide">${escapeHtml(label)}</p>
        <p class="note-text">${escapeHtml(note.text)}</p>
        <form method="post" action="${base}/lecturer/note/${note.id}/hide" class="hide-note-form">
          <button type="submit">Hide</button>
        </form>
      </li>`;
    })
    .join("\n");
  return `
    <section id="notes">
      <h2>What didn't make sense</h2>
      <ul id="notes-list">${items}</ul>
    </section>
  `;
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
  const slideControlsHtml =
    id === "demo"
      ? `<p id="slide-label">Slide ${state.slide}</p>`
      : `
    <p id="slide-label">Slide ${state.slide}</p>
    <form method="post" action="/l/${encodeURIComponent(id)}/lecturer/slide/prev" id="slide-prev-form">
      <button type="submit">Previous slide</button>
    </form>
    <form method="post" action="/l/${encodeURIComponent(id)}/lecturer/slide/next" id="slide-next-form">
      <button type="submit">Next slide</button>
    </form>`;

  return `
    <h1>Lecturer view</h1>
${slideControlsHtml}
    <section id="gauge" aria-live="polite">${escapeHtml(gaugeMessage(state, minPresent))}</section>
${tapCountHtml}
    <div id="bars">${barsHtml(state.bars)}</div>
    <div id="reason-counts-container">${reasonCountsHtml(state.reasonCounts)}</div>
${notesHtml(id, state.notes)}
    <script>
      (function () {
        var minPresent = ${JSON.stringify(minPresent)};
        var gauge = document.getElementById("gauge");

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
            var label = bar.deck ? bar.deck + " / slide " + bar.slide : "Slide " + bar.slide;
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
            text.setAttribute("font-size", "12");
            text.textContent = String(i + 1);
            svg.appendChild(text);
          });
          var table = document.createElement("table");
          table.className = "bars";
          var thead = document.createElement("thead");
          thead.innerHTML = "<tr><th>Slide</th><th>People lost here</th></tr>";
          var tbody = document.createElement("tbody");
          sorted.forEach(function (bar) {
            var label = bar.deck ? bar.deck + " / slide " + bar.slide : "Slide " + bar.slide;
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
            var label = entry.deck ? entry.deck + " / slide " + entry.slide : "Slide " + entry.slide;
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

        // A hidden note is removed from the DOM entirely on the next
        // broadcast, not just visually hidden — same privacy discipline as
        // every other gated element on this page.
        function renderNotes(notes) {
          var existing = document.getElementById("notes");
          if (!notes || notes.length === 0) {
            if (existing) existing.remove();
            return;
          }
          var sorted = notes.slice().sort(function (a, b) {
            return (
              (a.deck || "").localeCompare(b.deck || "") ||
              a.slide - b.slide ||
              b.created_at.localeCompare(a.created_at)
            );
          });
          var list = document.createElement("ul");
          list.id = "notes-list";
          sorted.forEach(function (note) {
            var label = note.deck ? note.deck + " / slide " + note.slide : "Slide " + note.slide;
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
            hideForm.action = ${JSON.stringify(`/l/${encodeURIComponent(id)}/lecturer/note/`)} + note.id + "/hide";
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
          if (existing) {
            existing.querySelector("#notes-list").replaceWith(list);
          } else {
            var section = document.createElement("section");
            section.id = "notes";
            var heading = document.createElement("h2");
            heading.textContent = "What didn't make sense";
            section.appendChild(heading);
            section.appendChild(list);
            document.querySelector("main").appendChild(section);
          }
          attachHideNoteHandlers();
        }

        function render(state) {
          var slideLabel = document.getElementById("slide-label");
          if (slideLabel) slideLabel.textContent = "Slide " + state.slide;
          if (state.shown) {
            gauge.textContent = state.present + " people here, " + state.live + " lost right now";
            var tapCount = document.getElementById("tap-count");
            if (!tapCount) {
              tapCount = document.createElement("p");
              tapCount.id = "tap-count";
              gauge.insertAdjacentElement("afterend", tapCount);
            }
            tapCount.textContent = "Total taps: " + state.totalTaps;
          } else {
            gauge.textContent = "Waiting for " + Math.max(0, minPresent - state.present) + " more people";
            var oldTapCount = document.getElementById("tap-count");
            if (oldTapCount) oldTapCount.remove();
          }
          renderBars(state.bars);
          renderReasonCounts(state.reasonCounts);
          renderNotes(state.notes);
        }

        var source = new EventSource(${JSON.stringify(`/l/${encodeURIComponent(id)}/lecturer/events`)});
        source.onmessage = function (event) {
          render(JSON.parse(event.data));
        };
      })();
    </script>
  `;
}

async function handleLecturerGet(id: string, req: Request): Promise<Response> {
  const lecture = getLecture(id);
  if (!lecture) return notFoundResponse();

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
  return new Response(page("Lecturer view", lecturerDashboard(id, state, lecture.min_present)), {
    status: 200,
    headers,
  });
}

async function handleLecturerPost(id: string, req: Request): Promise<Response> {
  const lecture = getLecture(id);
  if (!lecture) return notFoundResponse();

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

  if (!checkLoginRateLimit(id)) {
    logAction("lecturer_login_failed", id, browserId);
    return new Response(page("Lecturer view", lecturerLoginForm(id, "Too many attempts. Try again in a minute.")), {
      status: 429,
      headers,
    });
  }

  const body = await req.text();
  const code = new URLSearchParams(body).get("code") ?? "";

  if (!verifyCode(code, lecture.code_hash, lecture.code_salt)) {
    recordFailedLogin(id);
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

  const newSlide = Math.max(1, lecture.current_slide + direction);
  setCurrentSlide(id, newSlide);
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
    ${error ? `<p>${escapeHtml(error)}</p>` : ""}
    <form method="post" action="/new">
      <label for="title">Lecture title</label>
      <input id="title" name="title" required>
      <button type="submit">Create</button>
    </form>
  `;
}

async function handleNewGet(): Promise<Response> {
  return new Response(page("Start a lecture", newLectureForm()), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function handleNewPost(req: Request): Promise<Response> {
  const body = await req.text();
  const title = new URLSearchParams(body).get("title")?.trim();
  if (!title) {
    return new Response(page("Start a lecture", newLectureForm("A title is required.")), {
      status: 400,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  const id = randomBytes(4).toString("hex");
  const code = generateAccessCode();
  createLecture(id, title, 5, hashCode(code));
  logAction("lecture_created", id, undefined);

  const studentUrl = `/l/${id}`;
  const lecturerUrl = `/l/${id}/lecturer`;
  const bodyHtml = `
    <h1>Lecture created</h1>
    <p>Student link: <a href="${studentUrl}">${studentUrl}</a></p>
    <p>Lecturer code (shown once, write it down): <strong>${escapeHtml(code)}</strong></p>
    <p><a href="${lecturerUrl}">Go to the lecturer view</a></p>
  `;
  return new Response(page("Lecture created", bodyHtml), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
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
  if (method === "GET" && pathname === "/new") return handleNewGet();
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

const server = createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (err) {
    console.error(JSON.stringify({ time: new Date().toISOString(), action: "error", error: String(err) }));
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    }
    res.end("Internal server error");
  }
});

startHeartbeat();
scheduleSlideAdvance("demo");

server.listen(PORT, "0.0.0.0", () => {
  console.log(`listening on 0.0.0.0:${PORT}`);
});
