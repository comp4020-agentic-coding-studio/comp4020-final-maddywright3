#!/usr/bin/env node
// Full-page screenshots of /l/demo and the demo lecturer view at 390x844 and
// 1920x1080, for the Phase 5 before/after comparison of the calm UI:
//
//   APP_URL=http://localhost:8092 node scripts/screenshots.ts docs/screenshots/before
//
// No dependencies: drives a headless Chrome over the DevTools protocol with
// Node's own fetch and WebSocket. Nothing here loads from a third party; the
// only page Chrome opens is the app at APP_URL.
//
// Written for WSL2, where the Chrome is the Windows install. In WSL's default
// NAT networking, Windows can reach a server inside WSL on localhost, but WSL
// can't reach anything listening on Windows: Chrome binds its DevTools port
// to 127.0.0.1 whatever --remote-debugging-address says, and the Windows
// firewall drops the NAT side anyway. What does cross is a Windows child
// process's stdin/stdout, so each DevTools connection is relayed through a
// tiny powershell.exe that copies bytes between its stdio and Chrome's
// loopback port. Set CHROME to a Linux Chrome to skip the relay.
//
// The page needs two people present before the gauge shows anything (the
// demo's min_present is 2), so two extra "people" are made here over plain
// HTTP: each opens a stream, taps the live slide, picks a reason and writes a
// note. That puts every gated part of both pages on screen.

import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";

const baseUrl = process.env.APP_URL ?? "http://localhost:8080";
const outDir = resolve(process.argv[2] ?? "docs/screenshots/after");
const WINDOWS_CHROME = "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe";
const chromePath = process.env.CHROME ?? WINDOWS_CHROME;
const viaWindows = chromePath.endsWith(".exe");

const VIEWPORTS = [
  { name: "390x844", width: 390, height: 844, mobile: true },
  { name: "1920x1080", width: 1920, height: 1080, mobile: false },
];

async function newBrowserCookie(lectureId: string): Promise<string> {
  const res = await fetch(new URL(`/l/${lectureId}`, baseUrl));
  const bid = res.headers.getSetCookie().find((c) => c.startsWith("bid="));
  if (!bid) throw new Error("no bid cookie minted");
  return bid.split(";")[0];
}

async function lecturerCookie(bidCookie: string): Promise<string> {
  const res = await fetch(new URL("/l/demo/lecturer", baseUrl), {
    method: "POST",
    headers: { cookie: bidCookie, "content-type": "application/x-www-form-urlencoded" },
    body: "code=DEMO",
    redirect: "manual",
  });
  const lsess = res.headers.getSetCookie().find((c) => c.startsWith("lsess="));
  if (!lsess) throw new Error("lecturer login with DEMO failed");
  return lsess.split(";")[0];
}

// One extra person: a stream held open (so they count as present) and the
// live slide read from its first frame.
async function openPerson(): Promise<{ cookie: string; slide: number; close: () => void }> {
  const cookie = await newBrowserCookie("demo");
  const controller = new AbortController();
  const res = await fetch(new URL("/l/demo/events", baseUrl), { signal: controller.signal, headers: { cookie } });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!buffer.includes("\n\n")) {
    const { value, done } = await reader.read();
    if (done) throw new Error("stream closed before its first frame");
    buffer += decoder.decode(value, { stream: true });
  }
  const data = buffer.split("\n").find((line) => line.startsWith("data: "));
  const slide = Number(JSON.parse(data!.slice("data: ".length)).slide);
  return { cookie, slide, close: () => controller.abort() };
}

async function post(path: string, cookie: string, body: string): Promise<void> {
  await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body,
    redirect: "manual",
  });
}

function windowsTempDir(): string {
  return execFileSync("cmd.exe", ["/c", "echo %TEMP%"], { cwd: "/mnt/c", encoding: "utf8" }).trim();
}

// Starts Chrome and resolves with the DevTools port it printed.
function launchChrome(): Promise<{ chrome: ChildProcess; port: number; browserPath: string }> {
  const profile = viaWindows
    ? `${windowsTempDir()}\\confusion-meter-screenshots`
    : join(process.env.TMPDIR ?? "/tmp", "confusion-meter-screenshots");
  const chrome = spawn(
    chromePath,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--hide-scrollbars",
      "about:blank",
    ],
    { cwd: viaWindows ? "/mnt/c" : undefined, stdio: ["ignore", "ignore", "pipe"] },
  );
  return new Promise((resolvePromise, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`Chrome didn't start:\n${stderr}`)), 30_000);
    chrome.stderr!.on("data", (chunk) => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on ws:\/\/[^:]+:(\d+)(\/devtools\/browser\/[\w-]+)/);
      if (match) {
        clearTimeout(timer);
        resolvePromise({ chrome, port: Number(match[1]), browserPath: match[2] });
      }
    });
    chrome.on("exit", (code) => reject(new Error(`Chrome exited (${code}):\n${stderr}`)));
  });
}

// A local TCP port whose every connection is piped, byte for byte, through a
// powershell.exe child to Chrome's loopback DevTools port on Windows.
function startRelay(chromePort: number): Promise<{ port: number; close: () => void }> {
  const script =
    `$c=New-Object Net.Sockets.TcpClient('127.0.0.1',${chromePort});$n=$c.GetStream();` +
    `$i=[Console]::OpenStandardInput();$o=[Console]::OpenStandardOutput();` +
    `$t=$n.CopyToAsync($o);$u=$i.CopyToAsync($n);[void][Threading.Tasks.Task]::WaitAny(@($t,$u));$c.Close()`;
  const children: ChildProcess[] = [];
  const server = createServer((socket) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { cwd: "/mnt/c" });
    children.push(child);
    socket.pipe(child.stdin);
    child.stdout.pipe(socket);
    socket.on("close", () => child.kill());
    socket.on("error", () => child.kill());
    child.on("exit", () => socket.destroy());
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      resolvePromise({
        port: (server.address() as AddressInfo).port,
        close: () => {
          server.close();
          children.forEach((c) => c.kill());
        },
      });
    });
  });
}

class Cdp {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners: ((msg: any) => void)[] = [];

  private ws: WebSocket;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id !== undefined) {
        const waiter = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) waiter?.reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else waiter?.resolve(msg.result);
      } else {
        this.listeners.forEach((listener) => listener(msg));
      }
    });
  }

  static connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    return new Promise((resolvePromise, reject) => {
      ws.addEventListener("open", () => resolvePromise(new Cdp(ws)));
      ws.addEventListener("error", () => reject(new Error(`couldn't open ${url}`)));
    });
  }

  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolvePromise, reject) => this.pending.set(id, { resolve: resolvePromise, reject }));
  }

  waitFor(method: string, sessionId: string, timeoutMs = 30_000): Promise<any> {
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), timeoutMs);
      const listener = (msg: any): void => {
        if (msg.method === method && msg.sessionId === sessionId) {
          clearTimeout(timer);
          this.listeners = this.listeners.filter((l) => l !== listener);
          resolvePromise(msg.params);
        }
      };
      this.listeners.push(listener);
    });
  }

  close(): void {
    this.ws.close();
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function capture(
  cdp: Cdp,
  sessionId: string,
  path: string,
  viewport: (typeof VIEWPORTS)[number],
  file: string,
): Promise<void> {
  await cdp.send(
    "Emulation.setDeviceMetricsOverride",
    { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile },
    sessionId,
  );
  const loaded = cdp.waitFor("Page.loadEventFired", sessionId);
  await cdp.send("Page.navigate", { url: new URL(path, baseUrl).href }, sessionId);
  await loaded;
  await sleep(1500); // the first stream frame, and any live update it causes
  const { cssContentSize } = await cdp.send("Page.getLayoutMetrics", {}, sessionId);
  const height = Math.max(viewport.height, Math.ceil(cssContentSize.height));
  const { data } = await cdp.send(
    "Page.captureScreenshot",
    {
      format: "png",
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: viewport.width, height, scale: 1 },
    },
    sessionId,
  );
  writeFileSync(join(outDir, file), Buffer.from(data, "base64"));
  console.log(`wrote ${join(outDir, file)}`);
}

async function main(): Promise<void> {
  mkdirSync(outDir, { recursive: true });

  const people = [await openPerson(), await openPerson()];
  for (const person of people) {
    await post("/l/demo/tap", person.cookie, `deck=week-4&slide=${person.slide}`);
  }
  // Reason counts and notes are each gated on min_present distinct browsers
  // too, so both people give the same reason and both write a note.
  const notes = ["where the skill body goes after it loads", "why the listing costs tokens every turn"];
  for (const [i, person] of people.entries()) {
    await post("/l/demo/reason", person.cookie, "reason=Missed+a+step");
    await post("/l/demo/note", person.cookie, `deck=week-4&slide=${person.slide}&text=${encodeURIComponent(notes[i])}`);
  }

  const bid = await newBrowserCookie("demo");
  const lsess = await lecturerCookie(bid);

  const { chrome, port, browserPath } = await launchChrome();
  const relay = viaWindows ? await startRelay(port) : undefined;
  const cdp = await Cdp.connect(`ws://127.0.0.1:${relay?.port ?? port}${browserPath}`);
  try {
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Network.enable", {}, sessionId);
    const [name, value] = bid.split("=");
    await cdp.send("Network.setCookie", { name, value, url: baseUrl, path: "/", httpOnly: true, sameSite: "Lax" }, sessionId);
    const [lname, lvalue] = lsess.split("=");
    await cdp.send(
      "Network.setCookie",
      { name: lname, value: lvalue, url: baseUrl, path: "/l/demo/lecturer", httpOnly: true, sameSite: "Strict" },
      sessionId,
    );

    for (const viewport of VIEWPORTS) {
      await capture(cdp, sessionId, "/l/demo", viewport, `demo-${viewport.name}.png`);
      await capture(cdp, sessionId, "/l/demo/lecturer", viewport, `lecturer-${viewport.name}.png`);
    }
    await cdp.send("Browser.close").catch(() => {});
  } finally {
    cdp.close();
    relay?.close();
    chrome.kill();
    people.forEach((p) => p.close());
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
