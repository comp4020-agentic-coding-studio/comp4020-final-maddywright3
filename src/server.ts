import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { marked } from "marked";
import { createLecture, getLecture, tapCount, tapIfNotRecentlyTapped } from "./db.ts";
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
  startHeartbeat,
} from "./realtime.ts";

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

function gaugeMessage(state: { present: number; live: number; shown: boolean }, minPresent: number): string {
  if (state.shown) {
    return `${state.present} people here, ${state.live} lost right now`;
  }
  return `Waiting for ${Math.max(0, minPresent - state.present)} more people`;
}

async function handleLecture(id: string, req: Request): Promise<Response> {
  const lecture = getLecture(id);
  if (!lecture) return notFoundResponse();

  const { id: browserId, minted } = ensureBrowserId(req.headers.get("cookie"));
  logAction("page_view", id, browserId);

  const state = computeState(id, browserId) ?? {
    present: 0,
    live: 0,
    shown: false,
    totalTaps: tapCount(id),
    yourTapCount: 0,
    youAreCounted: false,
  };
  const gaugeText = gaugeMessage(state, lecture.min_present);

  const buttonHtml = state.youAreCounted
    ? `<button class="tap-button" id="tap-button" type="submit" disabled>You're already counted</button>`
    : `<button class="tap-button" id="tap-button" type="submit">I'm lost</button>`;

  const body = `
    <h1>${escapeHtml(lecture.title)}</h1>
    <section id="gauge" aria-live="polite">${escapeHtml(gaugeText)}</section>
    <form method="post" action="/l/${encodeURIComponent(id)}/tap" id="tap-form">
      ${buttonHtml}
    </form>
    <p id="tap-feedback" aria-live="polite"></p>
    <p id="tap-count">Total taps: ${state.totalTaps}</p>
    <p id="your-count">You've said you're lost ${state.yourTapCount} time${state.yourTapCount === 1 ? "" : "s"} in this lecture</p>
    <script>
      (function () {
        var minPresent = ${JSON.stringify(lecture.min_present)};
        var gauge = document.getElementById("gauge");
        var form = document.getElementById("tap-form");
        var button = document.getElementById("tap-button");
        var feedback = document.getElementById("tap-feedback");
        var tapCount = document.getElementById("tap-count");
        var yourCount = document.getElementById("your-count");

        function render(state) {
          if (state.shown) {
            gauge.textContent = state.present + " people here, " + state.live + " lost right now";
          } else {
            gauge.textContent = "Waiting for " + Math.max(0, minPresent - state.present) + " more people";
          }
          tapCount.textContent = "Total taps: " + state.totalTaps;
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
          fetch(form.action, { method: "POST" })
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

  const since = new Date(Date.now() - LIVE_WINDOW_MS).toISOString();
  const inserted = tapIfNotRecentlyTapped(id, browserId, since);
  if (inserted) {
    broadcast(id);
    scheduleFade(id);
    logAction("tap", id, browserId);
  } else {
    logAction("tap_ignored", id, browserId);
  }

  return new Response(null, {
    status: 303,
    headers: { location: `/l/${encodeURIComponent(id)}` },
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
  state: { present: number; live: number; shown: boolean; totalTaps: number; timeline: { minute: string; count: number }[] },
  minPresent: number,
): string {
  const formatter = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    dateStyle: "short",
    timeStyle: "short",
  });
  const rows = state.timeline
    .map(
      (bucket) =>
        `<tr><td>${escapeHtml(formatter.format(new Date(bucket.minute)))}</td><td>${bucket.count}</td></tr>`,
    )
    .join("\n");
  return `
    <h1>Lecturer view</h1>
    <section id="gauge" aria-live="polite">${escapeHtml(gaugeMessage(state, minPresent))}</section>
    <p id="tap-count">Total taps: ${state.totalTaps}</p>
    <table class="timeline" id="timeline">
      <thead><tr><th>Minute (Sydney time)</th><th>Taps</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
    <script>
      (function () {
        var minPresent = ${JSON.stringify(minPresent)};
        var gauge = document.getElementById("gauge");
        var tapCount = document.getElementById("tap-count");
        var tbody = document.querySelector("#timeline tbody");
        var formatter = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", dateStyle: "short", timeStyle: "short" });

        function render(state) {
          if (state.shown) {
            gauge.textContent = state.present + " people here, " + state.live + " lost right now";
          } else {
            gauge.textContent = "Waiting for " + Math.max(0, minPresent - state.present) + " more people";
          }
          tapCount.textContent = "Total taps: " + state.totalTaps;
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
    live: 0,
    shown: false,
    totalTaps: tapCount(id),
    timeline: [],
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
  if (method === "GET" && lecturerMatch) return handleLecturerGet(decodeURIComponent(lecturerMatch[1]), req);
  if (method === "POST" && lecturerMatch) return handleLecturerPost(decodeURIComponent(lecturerMatch[1]), req);

  const lectureMatch = pathname.match(/^\/l\/([^/]+)$/);
  if (method === "GET" && lectureMatch) return handleLecture(decodeURIComponent(lectureMatch[1]), req);

  const tapMatch = pathname.match(/^\/l\/([^/]+)\/tap$/);
  if (method === "POST" && tapMatch) return handleTap(decodeURIComponent(tapMatch[1]), req);

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

const server = createServer(async (req, res) => {
  const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
  const { pathname } = new URL(url);

  const lecturerEventsMatch = req.method === "GET" && pathname.match(/^\/l\/([^/]+)\/lecturer\/events$/);
  if (lecturerEventsMatch) {
    handleLecturerEvents(decodeURIComponent(lecturerEventsMatch[1]), req, res);
    return;
  }

  const eventsMatch = req.method === "GET" && pathname.match(/^\/l\/([^/]+)\/events$/);
  if (eventsMatch) {
    handleEvents(decodeURIComponent(eventsMatch[1]), req, res);
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
});

startHeartbeat();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`listening on 0.0.0.0:${PORT}`);
});
