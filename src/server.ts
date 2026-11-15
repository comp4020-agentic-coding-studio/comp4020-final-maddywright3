import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { marked } from "marked";
import { addTap, getLecture, tapCount } from "./db.ts";
import {
  addConnection,
  broadcast,
  computeState,
  removeConnection,
  scheduleFade,
  startHeartbeat,
} from "./realtime.ts";

const PORT = Number(process.env.PORT ?? 8080);

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
  ul.taps {
    padding-left: 1.25rem;
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

async function handleHome(): Promise<Response> {
  const body = `
    <h1>Confusion meter</h1>
    <p>Tap "I'm lost" during a lecture, and the tap is saved so it's still there when anyone comes back.</p>
    <p><a href="/l/demo">Try the demo lecture</a> &middot; <a href="/readme/">About this app</a></p>
  `;
  return new Response(page("Confusion meter", body), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function handleLecture(id: string): Promise<Response> {
  const lecture = getLecture(id);
  if (!lecture) {
    return new Response(notFoundPage(), {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  const state = computeState(id) ?? { present: 0, live: 0, shown: false, totalTaps: tapCount(id), taps: [] };
  const gaugeText = gaugeMessage(state, lecture.min_present);
  const tapItems = state.taps.map((iso) => `<li>${escapeHtml(new Date(iso).toLocaleString())}</li>`).join("\n");

  const body = `
    <h1>${escapeHtml(lecture.title)}</h1>
    <section id="gauge" aria-live="polite">${escapeHtml(gaugeText)}</section>
    <form method="post" action="/l/${encodeURIComponent(id)}/tap" id="tap-form">
      <button class="tap-button" type="submit">I'm lost</button>
    </form>
    <p id="tap-count">Total taps: ${state.totalTaps}</p>
    <ul class="taps" id="tap-list">
${tapItems}
    </ul>
    <script>
      (function () {
        var minPresent = ${JSON.stringify(lecture.min_present)};
        var gauge = document.getElementById("gauge");
        var form = document.getElementById("tap-form");
        var tapCount = document.getElementById("tap-count");
        var tapList = document.getElementById("tap-list");

        function render(state) {
          if (state.shown) {
            gauge.textContent = state.present + " people here, " + state.live + " lost right now";
          } else {
            gauge.textContent = "Waiting for " + Math.max(0, minPresent - state.present) + " more people";
          }
          tapCount.textContent = "Total taps: " + state.totalTaps;
          tapList.innerHTML = "";
          state.taps.forEach(function (iso) {
            var li = document.createElement("li");
            li.textContent = new Date(iso).toLocaleString();
            tapList.appendChild(li);
          });
        }

        var source = new EventSource(${JSON.stringify(`/l/${encodeURIComponent(id)}/events`)});
        source.onmessage = function (event) {
          render(JSON.parse(event.data));
        };

        form.addEventListener("submit", function (event) {
          event.preventDefault();
          fetch(form.action, { method: "POST" });
        });
      })();
    </script>
  `;
  return new Response(page(lecture.title, body), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function handleTap(id: string): Promise<Response> {
  const lecture = getLecture(id);
  if (!lecture) {
    return new Response(notFoundPage(), {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  addTap(id);
  broadcast(id);
  scheduleFade(id);
  return new Response(null, {
    status: 303,
    headers: { location: `/l/${encodeURIComponent(id)}` },
  });
}

function gaugeMessage(state: { present: number; live: number; shown: boolean }, minPresent: number): string {
  if (state.shown) {
    return `${state.present} people here, ${state.live} lost right now`;
  }
  return `Waiting for ${Math.max(0, minPresent - state.present)} more people`;
}

function handleEvents(id: string, req: IncomingMessage, res: ServerResponse): void {
  const lecture = getLecture(id);
  if (!lecture) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  addConnection(id, res);
  broadcast(id);
  scheduleFade(id);

  req.on("close", () => {
    removeConnection(id, res);
    broadcast(id);
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
    return new Response(notFoundPage(), {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  try {
    const data = await readFile(resolved);
    const contentType = DOCS_CONTENT_TYPES[extname(resolved).toLowerCase()] ?? "application/octet-stream";
    return new Response(data, { status: 200, headers: { "content-type": contentType } });
  } catch {
    return new Response(notFoundPage(), {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
}

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;
  const method = req.method;

  if (method === "GET" && pathname === "/") return handleHome();
  if (method === "GET" && pathname === "/readme/") return handleReadme();

  const lectureMatch = pathname.match(/^\/l\/([^/]+)$/);
  if (method === "GET" && lectureMatch) return handleLecture(decodeURIComponent(lectureMatch[1]));

  const tapMatch = pathname.match(/^\/l\/([^/]+)\/tap$/);
  if (method === "POST" && tapMatch) return handleTap(decodeURIComponent(tapMatch[1]));

  if (method === "GET" && pathname.startsWith("/docs/")) return handleDocs(pathname);

  return new Response(notFoundPage(), {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

const server = createServer(async (req, res) => {
  const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
  const { pathname } = new URL(url);

  const eventsMatch = req.method === "GET" && pathname.match(/^\/l\/([^/]+)\/events$/);
  if (eventsMatch) {
    handleEvents(decodeURIComponent(eventsMatch[1]), req, res);
    return;
  }

  const request = new Request(url, { method: req.method });
  const response = await route(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
});

startHeartbeat();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`listening on 0.0.0.0:${PORT}`);
});
