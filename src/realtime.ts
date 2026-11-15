import type { ServerResponse } from "node:http";
import {
  getLecture,
  liveTapFor,
  liveTapInfo,
  reasonCounts as rawReasonCounts,
  slideNoteCounts,
  slideTapCounts,
  tapCount,
  visibleNotesForSlide,
  yourTapCount,
} from "./db.ts";
import { currentDeck, currentSlideIndex, msUntilNextSlideChange } from "./slides.ts";

export const LIVE_WINDOW_MS = 60_000;
const HEARTBEAT_MS = 20_000;

export interface Bar {
  deck: string | null;
  slide: number;
  distinctBrowsers: number;
}

export interface ReasonCountEntry {
  deck: string | null;
  slide: number;
  reason: string;
  count: number;
}

export interface NoteEntry {
  deck: string | null;
  slide: number;
  id: number;
  text: string;
  created_at: string;
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
// `liveForMs` and `topReason` are per-browser/per-slide extras: `liveForMs`
// only appears while `youAreCounted` (the caller's own live tap), never
// sent to anyone else's stream; `topReason` only appears once the current
// slide's top reason has itself cleared its own (deck, slide, reason) gate.
export type MeterState =
  | {
      present: number;
      shown: false;
      slide: number;
      bars: Bar[];
      yourTapCount: number;
      youAreCounted: boolean;
      liveForMs?: number;
      topReason?: string;
    }
  | {
      present: number;
      shown: true;
      slide: number;
      bars: Bar[];
      live: number;
      totalTaps: number;
      yourTapCount: number;
      youAreCounted: boolean;
      liveForMs?: number;
      topReason?: string;
    };

export type LecturerState =
  | { present: number; shown: false; slide: number; bars: Bar[]; reasonCounts: ReasonCountEntry[]; notes: NoteEntry[] }
  | {
      present: number;
      shown: true;
      slide: number;
      bars: Bar[];
      live: number;
      totalTaps: number;
      reasonCounts: ReasonCountEntry[];
      notes: NoteEntry[];
    };

// Bars are gated per (deck, slide) pair, independently of present/shown: a
// slide with fewer qualifying browsers is simply absent from the array —
// not zeroed, not hidden, absent — same discipline as the shown:false
// branch. A lone returning visitor still sees bars for any slide that
// individually cleared the threshold.
function gatedBars(lectureId: string, minPresent: number): Bar[] {
  return slideTapCounts(lectureId).filter((bar) => bar.distinctBrowsers >= minPresent);
}

// Reason counts are gated per (deck, slide, reason) triple, NOT inherited
// from the slide's own bar gate: a slide can clear the bar threshold (e.g.
// 20 distinct tappers) while one specific reason among them was picked by
// only one or two people — surfacing that reason's count would be exactly
// the one-person signal ADR 004 rules out ("no bar can ever be one
// person"), just nested inside an otherwise-qualifying slide.
function gatedReasonCounts(lectureId: string, minPresent: number): ReasonCountEntry[] {
  return rawReasonCounts(lectureId).filter((entry) => entry.count >= minPresent);
}

// The current slide's most common *qualifying* reason — drawn only from
// entries that already cleared the per-pair gate above, so this can never
// surface a reason picked by fewer than min_present distinct browsers even
// though it's reporting on just one slide rather than the whole gated list.
function topReasonFor(
  gatedReasons: ReasonCountEntry[],
  deck: string | null,
  slide: number,
): string | undefined {
  const forSlide = gatedReasons.filter((entry) => entry.deck === deck && entry.slide === slide);
  if (forSlide.length === 0) return undefined;
  return forSlide.reduce((top, entry) => (entry.count > top.count ? entry : top)).reason;
}

// Notes are gated per (deck, slide) pair, same two-step pattern as bars:
// slideNoteCounts decides which pairs clear min_present distinct (visible)
// browsers, and only for those does visibleNotesForSlide get called at all
// — a pair below threshold contributes nothing to the array, not an empty
// group. Lecturer-only: this is never called for MeterState.
function gatedNotes(lectureId: string, minPresent: number): NoteEntry[] {
  const qualifying = slideNoteCounts(lectureId).filter((count) => count.distinctBrowsers >= minPresent);
  return qualifying.flatMap((count) =>
    visibleNotesForSlide(lectureId, count.deck, count.slide).map((note) => ({
      deck: count.deck,
      slide: count.slide,
      ...note,
    })),
  );
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

// The part of MeterState shared by every viewer of a given lecture at a
// given moment — everything except the per-browser yourTapCount/
// youAreCounted/liveForMs. Computed once per broadcast() call rather than
// once per connected browser (the fix for the full per-browser recompute:
// previously every field here, shared or not, was recomputed from scratch
// for each browser in the broadcast loop).
interface SharedMeterState {
  present: number;
  shown: boolean;
  slide: number;
  bars: Bar[];
  topReason?: string;
  live?: number;
  totalTaps?: number;
  since: string;
}

function computeSharedState(lectureId: string): SharedMeterState | undefined {
  const lecture = getLecture(lectureId);
  if (!lecture) return undefined;
  const since = new Date(Date.now() - LIVE_WINDOW_MS).toISOString();
  const present = presentCount(lectureId);
  const shown = present >= lecture.min_present;
  const slide = currentSlideIndex(lecture);
  const deck = currentDeck(lecture);
  const bars = gatedBars(lectureId, lecture.min_present);
  const gatedReasons = gatedReasonCounts(lectureId, lecture.min_present);
  const topReason = topReasonFor(gatedReasons, deck, slide);
  const base = { present, shown, slide, bars, since, ...(topReason !== undefined ? { topReason } : {}) };
  if (!shown) return base;
  const { count: live } = liveTapInfo(lectureId, since);
  return { ...base, live, totalTaps: tapCount(lectureId) };
}

// Merges a browser's own fields onto an already-computed shared state —
// the genuinely per-recipient part (yourTapCount, youAreCounted, liveForMs).
function meterStateFor(shared: SharedMeterState, lectureId: string, browserId: string): MeterState {
  const liveTap = liveTapFor(lectureId, browserId, shared.since);
  const yours = {
    yourTapCount: yourTapCount(lectureId, browserId),
    youAreCounted: liveTap !== undefined,
    ...(liveTap !== undefined
      ? { liveForMs: Math.max(0, new Date(liveTap.created_at).getTime() + LIVE_WINDOW_MS - Date.now()) }
      : {}),
  };
  if (!shared.shown) {
    return { present: shared.present, shown: false, slide: shared.slide, bars: shared.bars, ...yours, ...(shared.topReason !== undefined ? { topReason: shared.topReason } : {}) };
  }
  return {
    present: shared.present,
    shown: true,
    slide: shared.slide,
    bars: shared.bars,
    live: shared.live!,
    totalTaps: shared.totalTaps!,
    ...yours,
    ...(shared.topReason !== undefined ? { topReason: shared.topReason } : {}),
  };
}

export function computeState(lectureId: string, browserId: string): MeterState | undefined {
  const shared = computeSharedState(lectureId);
  if (!shared) return undefined;
  return meterStateFor(shared, lectureId, browserId);
}

export function computeLecturerState(lectureId: string): LecturerState | undefined {
  const lecture = getLecture(lectureId);
  if (!lecture) return undefined;
  const present = presentCount(lectureId);
  const shown = present >= lecture.min_present;
  const slide = currentSlideIndex(lecture);
  const bars = gatedBars(lectureId, lecture.min_present);
  const reasonCounts = gatedReasonCounts(lectureId, lecture.min_present);
  const notes = gatedNotes(lectureId, lecture.min_present);
  if (!shown) return { present, shown, slide, bars, reasonCounts, notes };
  const since = new Date(Date.now() - LIVE_WINDOW_MS).toISOString();
  const { count: live } = liveTapInfo(lectureId, since);
  return { present, shown, slide, bars, live, totalTaps: tapCount(lectureId), reasonCounts, notes };
}

export function broadcast(lectureId: string): void {
  const byBrowser = connections.get(lectureId);
  if (byBrowser && byBrowser.size > 0) {
    const shared = computeSharedState(lectureId);
    if (shared) {
      for (const [browserId, set] of byBrowser) {
        const state = meterStateFor(shared, lectureId, browserId);
        const payload = `data: ${JSON.stringify(state)}\n\n`;
        for (const res of set) res.write(payload);
      }
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
