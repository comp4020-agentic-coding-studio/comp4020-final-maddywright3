import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { marked } from "marked";
import { createLecture, getLecture, setCurrentSlide, tapIfNotRecentlyTapped } from "./db.ts";
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
import { currentSlideIndex, demoCreditHtml, demoSlideCount, demoSlides, isValidSlide } from "./slides.ts";

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
  table.timeline {
    border-collapse: collapse;
    width: 100%;
  }
  table.timeline th, table.timeline td {
    border-bottom: 1px solid #ccc;
    padding: 0.25rem 0.5rem;
    text-align: left;
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

// The demo lecture has its own deck, rendered entirely server-side so a
// no-JS visitor sees whatever slide the request asked for (or the live one,
// with no request) — the script below only toggles `hidden`, it never
// fetches slide content over the wire. A created (/new) lecture has no deck
// of its own, just a number the lecturer advances, so there's no content to
// show here at all.
function slideSectionHtml(lectureId: string, viewedSlide: number): string {
  if (lectureId !== "demo") return "";
  const sections = demoSlides
    .map((html, i) => {
      const slideNumber = i + 1;
      const hidden = slideNumber === viewedSlide ? "" : " hidden";
      return `<section class="slide" data-slide="${slideNumber}"${hidden}>${html}</section>`;
    })
    .join("\n");
  return `<div id="slides">\n${sections}\n</div>\n<footer id="slide-credit">${demoCreditHtml}</footer>`;
}

function slideProgressLabel(lectureId: string, slide: number): string {
  const total = lectureId === "demo" ? ` of ${demoSlideCount()}` : "";
  return `<p id="slide-label">Slide ${slide}${total}</p>`;
}

// Previous/Next as plain links (?slide=N) work with no JS at all, each a
// full page load; the script below intercepts clicks to switch slides
// client-side instead. "Back to live" only appears while browsing away from
// the live slide, and returns to it. ADR 004's amendment: browsing is now
// how a tap records an earlier slide, replacing the old grace-window
// reconciliation outright. Only rendered for the demo — a created lecture
// has no deck content in the app to browse, just a number the lecturer
// advances, so there's nothing here for a student to flip between.
function slideNavHtml(lectureId: string, viewedSlide: number, liveSlide: number): string {
  if (lectureId !== "demo") return "";
  const base = `/l/${encodeURIComponent(lectureId)}`;
  const maxSlide = demoSlideCount();
  const prevSlide = viewedSlide - 1;
  const nextSlide = viewedSlide + 1;
  const prevHtml =
    prevSlide >= 1
      ? `<a href="${base}?slide=${prevSlide}" id="slide-prev-link">Previous slide</a>`
      : `<span id="slide-prev-link" aria-disabled="true">Previous slide</span>`;
  const nextHtml =
    nextSlide <= maxSlide
      ? `<a href="${base}?slide=${nextSlide}" id="slide-next-link">Next slide</a>`
      : `<span id="slide-next-link" aria-disabled="true">Next slide</span>`;
  const backToLiveHtml =
    viewedSlide !== liveSlide ? `<a href="${base}" id="back-to-live-link">Back to live</a>` : "";
  return `
    <nav id="slide-nav" aria-label="Slide navigation">
      ${prevHtml}
      ${nextHtml}
      ${backToLiveHtml}
    </nav>
  `;
}

async function handleLecture(id: string, req: Request): Promise<Response> {
  const lecture = getLecture(id);
  if (!lecture) return notFoundResponse();

  const { id: browserId, minted } = ensureBrowserId(req.headers.get("cookie"));
  logAction("page_view", id, browserId);

  const liveSlide = currentSlideIndex(lecture);
  const requestedSlideRaw = new URL(req.url).searchParams.get("slide");
  const requestedSlideNumber = requestedSlideRaw !== null ? Number(requestedSlideRaw) : NaN;
  const viewedSlide =
    Number.isFinite(requestedSlideNumber) && isValidSlide(lecture, requestedSlideNumber)
      ? requestedSlideNumber
      : liveSlide;

  const state = computeState(id, browserId) ?? {
    present: 0,
    shown: false as const,
    slide: liveSlide,
    yourTapCount: 0,
    youAreCounted: false,
  };
  const gaugeText = gaugeMessage(state, lecture.min_present);

  const buttonHtml = state.youAreCounted
    ? `<button class="tap-button" id="tap-button" type="submit" disabled>You're already counted</button>`
    : `<button class="tap-button" id="tap-button" type="submit">I'm lost</button>`;

  // Below min_present, "Total taps" isn't rendered at all — not blanked,
  // not zeroed, just absent — since a hidden gauge still leaking the real
  // total in a sibling element would defeat the point of hiding it.
  const tapCountHtml = state.shown ? `<p id="tap-count">Total taps: ${state.totalTaps}</p>` : "";

  const body = `
    <h1>${escapeHtml(lecture.title)}</h1>
    ${slideProgressLabel(id, viewedSlide)}
    ${slideNavHtml(id, viewedSlide, liveSlide)}
    ${slideSectionHtml(id, viewedSlide)}
    <section id="gauge" aria-live="polite">${escapeHtml(gaugeText)}</section>
    <form method="post" action="/l/${encodeURIComponent(id)}/tap" id="tap-form">
      <input type="hidden" name="slide" id="slide-input" value="${viewedSlide}">
      ${buttonHtml}
    </form>
    <p id="tap-feedback" aria-live="polite"></p>
    ${tapCountHtml}
    <p id="your-count">You've said you're lost ${state.yourTapCount} time${state.yourTapCount === 1 ? "" : "s"} in this lecture</p>
    <script>
      (function () {
        var minPresent = ${JSON.stringify(lecture.min_present)};
        var maxSlide = ${JSON.stringify(id === "demo" ? demoSlideCount() : undefined)};
        var gauge = document.getElementById("gauge");
        var form = document.getElementById("tap-form");
        var button = document.getElementById("tap-button");
        var feedback = document.getElementById("tap-feedback");
        var tapCount = document.getElementById("tap-count");
        var yourCount = document.getElementById("your-count");
        var slideInput = document.getElementById("slide-input");

        // Two numbers, kept separate: the slide this browser is looking at
        // (what a tap records, what the arrows move), and the live slide the
        // shared clock or lecturer is on (what "Back to live" returns to).
        // Browsing away from live never changes the live slide for anyone.
        var viewedSlide = ${JSON.stringify(viewedSlide)};
        var liveSlide = ${JSON.stringify(liveSlide)};

        function showSlide(slide) {
          viewedSlide = slide;
          if (slideInput) slideInput.value = String(slide);
          var slides = document.querySelectorAll("#slides .slide");
          for (var i = 0; i < slides.length; i++) {
            slides[i].hidden = Number(slides[i].dataset.slide) !== slide;
          }
          var label = document.getElementById("slide-label");
          if (label) {
            label.textContent = "Slide " + slide + (maxSlide ? " of " + maxSlide : "");
          }
          var prevLink = document.getElementById("slide-prev-link");
          var nextLink = document.getElementById("slide-next-link");
          var backLink = document.getElementById("back-to-live-link");
          if (prevLink) {
            if (slide > 1) {
              prevLink.outerHTML = '<a href="?slide=' + (slide - 1) + '" id="slide-prev-link">Previous slide</a>';
            } else {
              prevLink.outerHTML = '<span id="slide-prev-link" aria-disabled="true">Previous slide</span>';
            }
          }
          if (nextLink) {
            if (!maxSlide || slide < maxSlide) {
              nextLink.outerHTML = '<a href="?slide=' + (slide + 1) + '" id="slide-next-link">Next slide</a>';
            } else {
              nextLink.outerHTML = '<span id="slide-next-link" aria-disabled="true">Next slide</span>';
            }
          }
          if (backLink) {
            if (slide !== liveSlide) {
              backLink.style.display = "";
            } else {
              backLink.style.display = "none";
            }
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
              showSlide(viewedSlide - 1);
            });
          }
          if (nextLink && nextLink.tagName === "A") {
            nextLink.addEventListener("click", function (event) {
              event.preventDefault();
              showSlide(viewedSlide + 1);
            });
          }
          if (backLink) {
            backLink.addEventListener("click", function (event) {
              event.preventDefault();
              showSlide(liveSlide);
            });
          }
        }
        attachNavHandlers();

        document.addEventListener("keydown", function (event) {
          var active = document.activeElement;
          var tag = active && active.tagName;
          if (tag === "INPUT" || tag === "TEXTAREA") return;
          if (event.key === "ArrowLeft" && viewedSlide > 1) showSlide(viewedSlide - 1);
          if (event.key === "ArrowRight" && (!maxSlide || viewedSlide < maxSlide)) showSlide(viewedSlide + 1);
        });

        function render(state) {
          liveSlide = state.slide;
          var backLink = document.getElementById("back-to-live-link");
          if (backLink) backLink.style.display = viewedSlide !== liveSlide ? "" : "none";
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
          yourCount.textContent = "You've said you're lost " + state.yourTapCount + " time" + (state.yourTapCount === 1 ? "" : "s") + " in this lecture";
          if (state.youAreCounted) {
            button.disabled = true;
            button.textContent = "You're counted";
          } else {
            button.disabled = false;
            button.textContent = "I'm lost";
          }
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
          fetch(form.action, { method: "POST", body: new URLSearchParams({ slide: slideInput ? slideInput.value : "" }) })
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

  // A tap always records the slide the viewer says they're looking at — no
  // reconciliation against a "current" slide, since browsing to an earlier
  // one is now a normal, expected thing to do (ADR 004's amendment). An
  // out-of-range or missing value can only mean a malformed request, so it's
  // rejected rather than silently substituted.
  const body = await req.text();
  const submittedSlideRaw = new URLSearchParams(body).get("slide");
  const submittedSlide = submittedSlideRaw !== null ? Number(submittedSlideRaw) : NaN;
  if (!isValidSlide(lecture, submittedSlide)) {
    logAction("tap_rejected", id, browserId);
    return new Response("Invalid slide", {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const since = new Date(Date.now() - LIVE_WINDOW_MS).toISOString();
  const inserted = tapIfNotRecentlyTapped(id, browserId, since, submittedSlide);
  if (inserted) {
    broadcast(id);
    scheduleFade(id);
    logAction("tap", id, browserId);
  } else {
    logAction("tap_ignored", id, browserId);
  }

  return new Response(null, {
    status: 303,
    headers: { location: `/l/${encodeURIComponent(id)}?slide=${submittedSlide}` },
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

function lecturerDashboard(
  id: string,
  state:
    | { present: number; shown: false; slide: number }
    | {
        present: number;
        shown: true;
        slide: number;
        live: number;
        totalTaps: number;
        timeline: { minute: string; count: number }[];
      },
  minPresent: number,
): string {
  const formatter = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    dateStyle: "short",
    timeStyle: "short",
  });

  // Below min_present, the total and the timeline aren't rendered at all —
  // not blanked, not empty placeholders — so there's nothing in the markup
  // for a curious viewer to read past a merely-hidden gauge. The script
  // creates/removes the same elements on each live update, rather than
  // ever having them present-but-empty in the DOM.
  const extrasHtml = state.shown
    ? `
    <p id="tap-count">Total taps: ${state.totalTaps}</p>
    <table class="timeline" id="timeline">
      <thead><tr><th>Minute (Sydney time)</th><th>Taps</th></tr></thead>
      <tbody>
${state.timeline
  .map((bucket) => `<tr><td>${escapeHtml(formatter.format(new Date(bucket.minute)))}</td><td>${bucket.count}</td></tr>`)
  .join("\n")}
      </tbody>
    </table>`
    : "";

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
${extrasHtml}
    <script>
      (function () {
        var minPresent = ${JSON.stringify(minPresent)};
        var gauge = document.getElementById("gauge");
        var formatter = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", dateStyle: "short", timeStyle: "short" });

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
            var table = document.getElementById("timeline");
            if (!table) {
              table = document.createElement("table");
              table.className = "timeline";
              table.id = "timeline";
              table.innerHTML = "<thead><tr><th>Minute (Sydney time)</th><th>Taps</th></tr></thead><tbody></tbody>";
              tapCount.insertAdjacentElement("afterend", table);
            }
            var tbody = table.querySelector("tbody");
            tbody.innerHTML = "";
            state.timeline.forEach(function (bucket) {
              var tr = document.createElement("tr");
              var tdMinute = document.createElement("td");
              tdMinute.textContent = formatter.format(new Date(bucket.minute));
              var tdCount = document.createElement("td");
              tdCount.textContent = String(bucket.count);
              tr.appendChild(tdMinute);
              tr.appendChild(tdCount);
              tbody.appendChild(tr);
            });
          } else {
            gauge.textContent = "Waiting for " + Math.max(0, minPresent - state.present) + " more people";
            var oldTapCount = document.getElementById("tap-count");
            if (oldTapCount) oldTapCount.remove();
            var oldTable = document.getElementById("timeline");
            if (oldTable) oldTable.remove();
          }
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
