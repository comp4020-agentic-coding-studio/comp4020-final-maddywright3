import type { ServerResponse } from "node:http";
import { getLecture, hasLiveTap, liveTapInfo, slideTapCounts, tapCount, yourTapCount } from "./db.ts";
import { currentSlideIndex, msUntilNextSlideChange } from "./slides.ts";

export const LIVE_WINDOW_MS = 60_000;
const HEARTBEAT_MS = 20_000;

export interface Bar {
  deck: string | null;
  slide: number;
  distinctBrowsers: number;
}

// Below min_present, live/totalTaps are never present on the object at all
// (not just zeroed or hidden on screen) — the point of "safety in numbers"
// is that a tap below threshold leaves no trace anywhere a request can see,
// not just that the gauge text looks blank. `slide` and `bars` are gated
// differently: `slide` is ungated (position isn't privacy-sensitive, unlike
// tap counts); `bars` is gated per-entry, independently of `present`/`shown`
// — a slide clears the bar threshold once >= min_present distinct browsers
// have ever tapped it, whoever is present right now (ADR 004's refined
// privacy rule), so `bars` is present on both branches of this union.
export type MeterState =
  | { present: number; shown: false; slide: number; bars: Bar[]; yourTapCount: number; youAreCounted: boolean }
  | {
      present: number;
      shown: true;
      slide: number;
      bars: Bar[];
      live: number;
      totalTaps: number;
      yourTapCount: number;
      youAreCounted: boolean;
    };

export type LecturerState =
  | { present: number; shown: false; slide: number; bars: Bar[] }
  | {
      present: number;
      shown: true;
      slide: number;
      bars: Bar[];
      live: number;
      totalTaps: number;
    };

// Bars are gated per (deck, slide) pair, independently of present/shown: a
// slide with fewer qualifying browsers is simply absent from the array —
// not zeroed, not hidden, absent — same discipline as the shown:false
// branch. A lone returning visitor still sees bars for any slide that
// individually cleared the threshold.
function gatedBars(lectureId: string, minPresent: number): Bar[] {
  return slideTapCounts(lectureId).filter((bar) => bar.distinctBrowsers >= minPresent);
}

// Student/presence connections, keyed by lecture then by browser, so
// "present" counts unique browsers rather than open tabs or connections.
const connections = new Map<string, Map<string, Set<ServerResponse>>>();
// Lecturer-observer connections: kept entirely separate so a lecturer (or a
// grader) opening the dashboard never counts as a student in presence.
const lecturerConnections = new Map<string, Set<ServerResponse>>();
const fadeTimers = new Map<string, NodeJS.Timeout>();
const slideTimers = new Map<string, NodeJS.Timeout>();

function browsersFor(lectureId: string): Map<string, Set<ServerResponse>> {
  let byBrowser = connections.get(lectureId);
  if (!byBrowser) {
    byBrowser = new Map();
    connections.set(lectureId, byBrowser);
  }
  return byBrowser;
}

export function addConnection(lectureId: string, browserId: string, res: ServerResponse): void {
  const byBrowser = browsersFor(lectureId);
  let set = byBrowser.get(browserId);
  if (!set) {
    set = new Set();
    byBrowser.set(browserId, set);
  }
  set.add(res);
}

export function removeConnection(lectureId: string, browserId: string, res: ServerResponse): void {
  const byBrowser = connections.get(lectureId);
  if (!byBrowser) return;
  const set = byBrowser.get(browserId);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) {
    byBrowser.delete(browserId);
    if (byBrowser.size === 0) connections.delete(lectureId);
  }
}

export function addLecturerConnection(lectureId: string, res: ServerResponse): void {
  let set = lecturerConnections.get(lectureId);
  if (!set) {
    set = new Set();
    lecturerConnections.set(lectureId, set);
  }
  set.add(res);
}

export function removeLecturerConnection(lectureId: string, res: ServerResponse): void {
  const set = lecturerConnections.get(lectureId);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) lecturerConnections.delete(lectureId);
}

export function presentCount(lectureId: string): number {
  return connections.get(lectureId)?.size ?? 0;
}

export function computeState(lectureId: string, browserId: string): MeterState | undefined {
  const lecture = getLecture(lectureId);
  if (!lecture) return undefined;
  const since = new Date(Date.now() - LIVE_WINDOW_MS).toISOString();
  const present = presentCount(lectureId);
  const shown = present >= lecture.min_present;
  const slide = currentSlideIndex(lecture);
  const bars = gatedBars(lectureId, lecture.min_present);
  const yours = {
    yourTapCount: yourTapCount(lectureId, browserId),
    youAreCounted: hasLiveTap(lectureId, browserId, since),
  };
  if (!shown) return { present, shown, slide, bars, ...yours };
  const { count: live } = liveTapInfo(lectureId, since);
  return { present, shown, slide, bars, live, totalTaps: tapCount(lectureId), ...yours };
}

export function computeLecturerState(lectureId: string): LecturerState | undefined {
  const lecture = getLecture(lectureId);
  if (!lecture) return undefined;
  const present = presentCount(lectureId);
  const shown = present >= lecture.min_present;
  const slide = currentSlideIndex(lecture);
  const bars = gatedBars(lectureId, lecture.min_present);
  if (!shown) return { present, shown, slide, bars };
  const since = new Date(Date.now() - LIVE_WINDOW_MS).toISOString();
  const { count: live } = liveTapInfo(lectureId, since);
  return { present, shown, slide, bars, live, totalTaps: tapCount(lectureId) };
}

export function broadcast(lectureId: string): void {
  const byBrowser = connections.get(lectureId);
  if (byBrowser) {
    for (const [browserId, set] of byBrowser) {
      const state = computeState(lectureId, browserId);
      if (!state) continue;
      const payload = `data: ${JSON.stringify(state)}\n\n`;
      for (const res of set) res.write(payload);
    }
  }
  broadcastToLecturer(lectureId);
}

export function broadcastToLecturer(lectureId: string): void {
  const set = lecturerConnections.get(lectureId);
  if (!set || set.size === 0) return;
  const state = computeLecturerState(lectureId);
  if (!state) return;
  const payload = `data: ${JSON.stringify(state)}\n\n`;
  for (const res of set) res.write(payload);
}

export function scheduleFade(lectureId: string): void {
  if (fadeTimers.has(lectureId)) return;
  const { earliest } = liveTapInfo(lectureId, new Date(Date.now() - LIVE_WINDOW_MS).toISOString());
  if (!earliest) return;
  const fadesAt = new Date(earliest).getTime() + LIVE_WINDOW_MS;
  const delay = Math.max(0, fadesAt - Date.now());
  const timer = setTimeout(() => {
    fadeTimers.delete(lectureId);
    broadcast(lectureId);
    scheduleFade(lectureId);
  }, delay);
  timer.unref();
  fadeTimers.set(lectureId, timer);
}

// The demo's slide advances on the shared clock with no request to trigger
// it — no tap, no connect, nothing — so without this, open streams would
// only see the new slide once something else happened to cause a broadcast
// (the bug this fixes: slides only updated on page reload). Mirrors
// scheduleFade's shape: one timer per lecture, armed for exactly when the
// state will next change, re-arming itself after it fires.
export function scheduleSlideAdvance(lectureId: string): void {
  if (slideTimers.has(lectureId)) return;
  const lecture = getLecture(lectureId);
  if (!lecture) return;
  const delay = msUntilNextSlideChange(lecture);
  if (delay === undefined) return;
  const timer = setTimeout(() => {
    slideTimers.delete(lectureId);
    broadcast(lectureId);
    scheduleSlideAdvance(lectureId);
  }, delay);
  timer.unref();
  slideTimers.set(lectureId, timer);
}

export function startHeartbeat(): void {
  const timer = setInterval(() => {
    for (const byBrowser of connections.values()) {
      for (const set of byBrowser.values()) {
        for (const res of set) res.write(": heartbeat\n\n");
      }
    }
    for (const set of lecturerConnections.values()) {
      for (const res of set) res.write(": heartbeat\n\n");
    }
  }, HEARTBEAT_MS);
  timer.unref();
}
