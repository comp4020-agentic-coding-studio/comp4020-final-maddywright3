#!/usr/bin/env node
// Mints 50 browser cookies, opens 50 concurrent SSE connections to a fresh
// created lecture, fires 50 taps at once (all on slide 1, so all 50 count
// toward the same `live`), and reports two numbers: time until every one of
// the 50 streams has observed `present === 50`, and time until every one
// has observed `live === 50` — separately, since presence updates on
// connection while `live` only updates once the tap round-trips and the
// broadcast it triggers propagates, so the two can differ.
//
// Not part of pnpm check (see package.json's "load" script) — point it at a
// running app with APP_URL, same convention as spec/'s own baseUrl.

const baseUrl = process.env.APP_URL ?? "http://localhost:8080";
const BROWSER_COUNT = 50;

interface MeterState {
  present: number;
  shown: boolean;
  live?: number;
}

async function newBrowserCookie(lectureId: string): Promise<string> {
  const res = await fetch(new URL(`/l/${lectureId}`, baseUrl));
  const cookies = res.headers.getSetCookie();
  const bid = cookies.find((c) => c.startsWith("bid="));
  if (!bid) throw new Error("no bid cookie minted");
  return bid.split(";")[0];
}

async function createLecture(): Promise<{ id: string }> {
  const res = await fetch(new URL("/new", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "title=Load+test&slides=10&minutes=60",
  });
  const html = await res.text();
  const id = html.match(/Student link: <a href="\/l\/([a-f0-9]+)"/)?.[1];
  if (!id) throw new Error("couldn't parse the new lecture's id");
  return { id };
}

class SseStream {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private decoder = new TextDecoder();
  private buffer = "";
  private controller = new AbortController();
  private latest: MeterState | undefined;
  private latestAt = 0;
  private waiters: { predicate: (s: MeterState) => boolean; resolve: () => void }[] = [];

  private constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.reader = reader;
    void this.pump();
  }

  static async open(path: string, cookie: string): Promise<SseStream> {
    const stream = new SseStream(null as never);
    const res = await fetch(new URL(path, baseUrl), { signal: stream.controller.signal, headers: { cookie } });
    if (!res.body) throw new Error("no response body for SSE stream");
    stream.reader = res.body.getReader();
    void stream.pump();
    return stream;
  }

  private async pump(): Promise<void> {
    if (!this.reader) return;
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) return;
        this.buffer += this.decoder.decode(value, { stream: true });
        let sepIndex: number;
        while ((sepIndex = this.buffer.indexOf("\n\n")) !== -1) {
          const frame = this.buffer.slice(0, sepIndex);
          this.buffer = this.buffer.slice(sepIndex + 2);
          const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!dataLine) continue;
          const state = JSON.parse(dataLine.slice("data: ".length)) as MeterState;
          this.latest = state;
          this.latestAt = Date.now();
          this.waiters = this.waiters.filter((w) => {
            if (w.predicate(state)) {
              w.resolve();
              return false;
            }
            return true;
          });
        }
      }
    } catch {
      // connection closed/aborted — fine, callers waiting will just time out
    }
  }

  // `since` is the moment the action being measured was *initiated* (e.g.
  // "just before firing the 50 taps"), not the moment waitFor() happens to
  // be called — Promise.all on 50 concurrent requests only resolves once
  // every one has completed, by which point the relevant broadcasts may
  // already have landed, making a wait that starts its clock at call time
  // measure nothing. Passing a fixed `since` measures the real round trip.
  waitFor(predicate: (s: MeterState) => boolean, timeoutMs: number, since: number): Promise<number> {
    // A frame that already arrived counts from when it arrived, not from
    // now: otherwise every stream reports the moment the last of the 50
    // requests finished, and min, median and max all collapse to one value.
    if (this.latest && predicate(this.latest)) return Promise.resolve(this.latestAt - since);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out")), timeoutMs);
      this.waiters.push({
        predicate,
        resolve: () => {
          clearTimeout(timer);
          resolve(Date.now() - since);
        },
      });
    });
  }

  close(): void {
    this.controller.abort();
  }
}

function stats(label: string, values: number[]): void {
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const median = sorted[Math.floor(sorted.length / 2)];
  console.log(`${label}: min ${min}ms, median ${median}ms, max ${max}ms (n=${values.length})`);
}

async function main(): Promise<void> {
  console.log(`load test against ${baseUrl}: ${BROWSER_COUNT} browsers`);
  const { id: lectureId } = await createLecture();
  console.log(`created lecture ${lectureId}`);

  const cookies = await Promise.all(Array.from({ length: BROWSER_COUNT }, () => newBrowserCookie(lectureId)));
  console.log(`minted ${cookies.length} browser identities`);

  // Measured from the moment the first connection attempt is made, not from
  // whenever each individual waitFor() call happens to run.
  const connectStart = Date.now();
  const streams = await Promise.all(cookies.map((cookie) => SseStream.open(`/l/${lectureId}/events`, cookie)));
  console.log(`opened ${streams.length} SSE connections`);

  const presentLatencies = await Promise.all(
    streams.map((s) => s.waitFor((state) => state.present === BROWSER_COUNT, 30_000, connectStart)),
  );
  stats("time until present === 50 (from first connection attempt)", presentLatencies);

  const tapStart = Date.now();
  await Promise.all(
    cookies.map((cookie) =>
      fetch(new URL(`/l/${lectureId}/tap`, baseUrl), {
        method: "POST",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: "slide=1",
      }),
    ),
  );
  console.log(`fired ${cookies.length} taps`);

  const liveLatencies = await Promise.all(
    streams.map((s) => s.waitFor((state) => state.shown === true && state.live === BROWSER_COUNT, 30_000, tapStart)),
  );
  stats("time until live === 50 (from first tap sent)", liveLatencies);

  for (const s of streams) s.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
