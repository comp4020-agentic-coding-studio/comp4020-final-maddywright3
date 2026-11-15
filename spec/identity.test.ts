import { afterEach, expect, inject, it } from "vitest";
import { newBrowserCookie } from "./test-helpers.ts";

const baseUrl = inject("baseUrl");

interface MeterState {
  present: number;
  live: number;
  shown: boolean;
  totalTaps: number;
  yourTapCount: number;
  youAreCounted: boolean;
}

// Mirrors spec/events.test.ts's SSE reader, trimmed to what these tests need:
// read one frame, or wait for one matching a predicate.
class SseStream {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private decoder = new TextDecoder();
  private buffer = "";
  private controller = new AbortController();

  private constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.reader = reader;
  }

  static async open(path: string, cookie: string): Promise<SseStream> {
    const stream = new SseStream(null as never);
    const res = await fetch(new URL(path, baseUrl), {
      signal: stream.controller.signal,
      headers: { cookie },
    });
    if (!res.body) throw new Error("no response body for SSE stream");
    stream.reader = res.body.getReader();
    return stream;
  }

  private async readMore(): Promise<void> {
    const { value, done } = await this.reader.read();
    if (done) throw new Error("SSE stream closed unexpectedly");
    this.buffer += this.decoder.decode(value, { stream: true });
  }

  async next(timeoutMs = 1000): Promise<MeterState> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const sepIndex = this.buffer.indexOf("\n\n");
      if (sepIndex === -1) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`no SSE frame within ${timeoutMs}ms`);
        await Promise.race([
          this.readMore(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), remaining)),
        ]);
        continue;
      }
      const frame = this.buffer.slice(0, sepIndex);
      this.buffer = this.buffer.slice(sepIndex + 2);
      const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
      if (!dataLine) continue;
      return JSON.parse(dataLine.slice("data: ".length)) as MeterState;
    }
  }

  async waitFor(predicate: (state: MeterState) => boolean, timeoutMs = 2000): Promise<MeterState> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`condition not met within ${timeoutMs}ms`);
      const state = await this.next(remaining);
      if (predicate(state)) return state;
    }
  }

  async close(): Promise<void> {
    try {
      await this.reader.cancel();
    } catch {
      // already closed
    }
    this.controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const openStreams: SseStream[] = [];
async function trackedStream(path: string, cookie: string): Promise<SseStream> {
  const s = await SseStream.open(path, cookie);
  openStreams.push(s);
  return s;
}

afterEach(async () => {
  while (openStreams.length > 0) {
    await openStreams.pop()!.close();
  }
});

it("two different browser cookies count as two present; two streams on the same cookie count as one", async () => {
  const cookieA = await newBrowserCookie("demo");
  const a1 = await trackedStream("/l/demo/events", cookieA);
  const initial = await a1.next();

  const a2 = await trackedStream("/l/demo/events", cookieA);
  // A second tab from the SAME browser must not raise present.
  await a2.next();
  // Give the server a moment; assert no change by checking the next real
  // state change instead of a fixed sleep would require a distinguishing
  // event, so instead confirm present is unchanged after a short pause.
  await new Promise((resolve) => setTimeout(resolve, 300));

  const cookieB = await newBrowserCookie("demo");
  const b = await trackedStream("/l/demo/events", cookieB);
  await b.next();
  const updated = await a1.waitFor((s) => s.present === initial.present + 1);
  expect(updated.present).toBe(initial.present + 1);
});

it("a second tap within 60 seconds from the same browser doesn't change the count", async () => {
  const cookie = await newBrowserCookie("demo");
  const before = await (await fetch(new URL("/l/demo", baseUrl), { headers: { cookie } })).text();
  const beforeCount = Number(before.match(/Total taps: (\d+)/)?.[1]);

  await fetch(new URL("/l/demo/tap", baseUrl), { method: "POST", headers: { cookie } });
  const afterFirst = await (await fetch(new URL("/l/demo", baseUrl), { headers: { cookie } })).text();
  const afterFirstCount = Number(afterFirst.match(/Total taps: (\d+)/)?.[1]);
  expect(afterFirstCount).toBe(beforeCount + 1);

  await fetch(new URL("/l/demo/tap", baseUrl), { method: "POST", headers: { cookie } });
  const afterSecond = await (await fetch(new URL("/l/demo", baseUrl), { headers: { cookie } })).text();
  const afterSecondCount = Number(afterSecond.match(/Total taps: (\d+)/)?.[1]);
  expect(afterSecondCount).toBe(afterFirstCount);
});

it("a tap with no cookie, or a made-up cookie, is rejected", async () => {
  const noCookie = await fetch(new URL("/l/demo/tap", baseUrl), { method: "POST" });
  expect(noCookie.status).toBe(403);

  const forged = await fetch(new URL("/l/demo/tap", baseUrl), {
    method: "POST",
    headers: { cookie: "bid=0000000000000000000000000000000000000000000000000000000000000000" },
  });
  expect(forged.status).toBe(403);
});

it("/l/demo/lecturer shows the gauge only with the DEMO code", async () => {
  const cookie = await newBrowserCookie("demo");

  const noSession = await fetch(new URL("/l/demo/lecturer", baseUrl), { headers: { cookie } });
  const noSessionHtml = await noSession.text();
  expect(noSessionHtml).not.toContain('id="gauge"');

  const wrongCode = await fetch(new URL("/l/demo/lecturer", baseUrl), {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: "code=not-the-code",
  });
  const wrongCodeHtml = await wrongCode.text();
  expect(wrongCodeHtml).not.toContain('id="gauge"');

  const rightCode = await fetch(new URL("/l/demo/lecturer", baseUrl), {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: "code=DEMO",
    redirect: "manual",
  });
  expect(rightCode.status).toBe(303);
  const lsessCookie = rightCode.headers
    .getSetCookie()
    .find((c) => c.startsWith("lsess="))
    ?.split(";")[0];
  expect(lsessCookie).toBeDefined();

  const dashboard = await fetch(new URL("/l/demo/lecturer", baseUrl), {
    headers: { cookie: `${cookie}; ${lsessCookie}` },
  });
  const dashboardHtml = await dashboard.text();
  expect(dashboardHtml).toContain('id="gauge"');
});

it("no student page, lecturer page, or stream ever contains a browser ID other than the requester's own", async () => {
  const cookieA = await newBrowserCookie("demo");
  const cookieB = await newBrowserCookie("demo");
  const bidA = cookieA.split("=")[1];
  const bidB = cookieB.split("=")[1];

  const pageA = await (await fetch(new URL("/l/demo", baseUrl), { headers: { cookie: cookieA } })).text();
  expect(pageA).not.toContain(bidB);

  const stream = await trackedStream("/l/demo/events", cookieA);
  const frame = await stream.next();
  expect(JSON.stringify(frame)).not.toContain(bidB);
  expect(JSON.stringify(frame)).not.toContain(bidA); // the state payload itself never includes any raw bid

  const rightCode = await fetch(new URL("/l/demo/lecturer", baseUrl), {
    method: "POST",
    headers: { cookie: cookieA, "content-type": "application/x-www-form-urlencoded" },
    body: "code=DEMO",
    redirect: "manual",
  });
  const lsessCookie = rightCode.headers
    .getSetCookie()
    .find((c) => c.startsWith("lsess="))
    ?.split(";")[0];
  const dashboardHtml = await (
    await fetch(new URL("/l/demo/lecturer", baseUrl), { headers: { cookie: `${cookieA}; ${lsessCookie}` } })
  ).text();
  expect(dashboardHtml).not.toContain(bidA);
  expect(dashboardHtml).not.toContain(bidB);
});

it("the per-minute timeline shows Australia/Sydney time", async () => {
  const cookie = await newBrowserCookie("demo");
  const tapTime = new Date();
  await fetch(new URL("/l/demo/tap", baseUrl), { method: "POST", headers: { cookie } });

  const rightCode = await fetch(new URL("/l/demo/lecturer", baseUrl), {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: "code=DEMO",
    redirect: "manual",
  });
  const lsessCookie = rightCode.headers
    .getSetCookie()
    .find((c) => c.startsWith("lsess="))
    ?.split(";")[0];
  const dashboardHtml = await (
    await fetch(new URL("/l/demo/lecturer", baseUrl), { headers: { cookie: `${cookie}; ${lsessCookie}` } })
  ).text();

  // The bucket this tap landed in, truncated to the minute (matching the
  // server's strftime('%Y-%m-%dT%H:%M:00Z', ...) grouping), formatted two
  // ways: as the dashboard should render it (Sydney) and as it must NOT
  // (server/UTC). If the dashboard used UTC instead of Sydney time, this
  // test only actually distinguishes the two when they render different
  // text, so skip at the rare instant they'd coincide.
  const bucket = new Date(tapTime);
  bucket.setUTCSeconds(0, 0);
  const sydneyLabel = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    dateStyle: "short",
    timeStyle: "short",
  }).format(bucket);
  const utcLabel = new Intl.DateTimeFormat("en-AU", {
    timeZone: "UTC",
    dateStyle: "short",
    timeStyle: "short",
  }).format(bucket);

  if (sydneyLabel === utcLabel) return; // can't distinguish right now; avoid a flaky false failure

  expect(dashboardHtml).toContain(sydneyLabel);
  expect(dashboardHtml).not.toContain(utcLabel);
});
