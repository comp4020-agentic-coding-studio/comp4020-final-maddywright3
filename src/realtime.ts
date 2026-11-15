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
import type { Lecture } from "./db.ts";
import { clearDeckClock, currentSlideIndex, msUntilNextSlideChange, startDeckClock } from "./slides.ts";
import type { DeckId } from "./slides.ts";

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
// `deck` (demo only) names the deck whose live slide `slide` is: each demo
// stream watches one deck, and each deck runs its own clock.
export type MeterState =
  | {
      present: number;
      shown: false;
      deck?: DeckId;
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
      deck?: DeckId;
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
// Each stream remembers the deck it's watching (null for a created lecture,
// which has no decks), so the same map answers both "how many people are
// here" (distinct browsers, any deck) and "is anyone watching this deck"
// (distinct browsers with a stream on it) — one source of truth, nothing
// separate to drift out of step with it.
const connections = new Map<string, Map<string, Map<ServerResponse, DeckId | null>>>();
// Lecturer-observer connections: kept entirely separate so a lecturer (or a
// grader) opening the dashboard never counts as a student in presence, and
// never counts as watching a deck (so never starts or holds a deck clock).
const lecturerConnections = new Map<string, Set<ServerResponse>>();
const fadeTimers = new Map<string, NodeJS.Timeout>();
// Keyed `${lectureId}:${deck}`: one advance timer per running deck clock.
const slideTimers = new Map<string, NodeJS.Timeout>();

function browsersFor(lectureId: string): Map<string, Map<ServerResponse, DeckId | null>> {
  let byBrowser = connections.get(lectureId);
  if (!byBrowser) {
    byBrowser = new Map();
    connections.set(lectureId, byBrowser);
  }
  return byBrowser;
}

function isWatched(lectureId: string, deck: DeckId): boolean {
  const byBrowser = connections.get(lectureId);
  if (!byBrowser) return false;
  for (const streams of byBrowser.values()) {
    for (const watching of streams.values()) {
      if (watching === deck) return true;
    }
  }
  return false;
}

function slideTimerKey(lectureId: string, deck: DeckId): string {
  return `${lectureId}:${deck}`;
}

// A student stream opening on a deck nobody is watching starts that deck's
// clock now, so this viewer is on slide 1 rather than mid-lecture in an
// empty room; anyone already watching means the clock keeps running and
// the newcomer joins wherever it is.
export function addConnection(
  lectureId: string,
  browserId: string,
  res: ServerResponse,
  deck: DeckId | null,
): void {
  if (deck !== null && !isWatched(lectureId, deck)) {
    startDeckClock(lectureId, deck);
    scheduleSlideAdvance(lectureId, deck);
  }
  const byBrowser = browsersFor(lectureId);
  let streams = byBrowser.get(browserId);
  if (!streams) {
    streams = new Map();
    byBrowser.set(browserId, streams);
  }
  streams.set(res, deck);
}

// The last viewer of a deck leaving stops its clock, so the next arrival
// (a refresh while alone included) starts it again from slide 1.
export function removeConnection(lectureId: string, browserId: string, res: ServerResponse): void {
  const byBrowser = connections.get(lectureId);
  if (!byBrowser) return;
  const streams = byBrowser.get(browserId);
  if (!streams) return;
  const deck = streams.get(res);
  if (deck === undefined) return;
  streams.delete(res);
  if (streams.size === 0) {
    byBrowser.delete(browserId);
    if (byBrowser.size === 0) connections.delete(lectureId);
  }
  if (deck !== null && !isWatched(lectureId, deck)) {
    clearDeckClock(lectureId, deck);
    const key = slideTimerKey(lectureId, deck);
    clearTimeout(slideTimers.get(key));
    slideTimers.delete(key);
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

// The part of MeterState shared by every viewer of a given deck of a given
// lecture at a given moment — everything except the per-browser
// yourTapCount/youAreCounted/liveForMs. Computed once per deck per
// broadcast() call rather than once per connected browser (the fix for the
// full per-browser recompute: previously every field here, shared or not,
// was recomputed from scratch for each browser in the broadcast loop).
interface SharedMeterState {
  present: number;
  shown: boolean;
  deck?: DeckId;
  slide: number;
  bars: Bar[];
  topReason?: string;
  live?: number;
  totalTaps?: number;
  since: string;
}

// The per-browser part, computed once per browser per broadcast however
// many decks (tabs) that browser has open.
interface YourState {
  yourTapCount: number;
  youAreCounted: boolean;
  liveForMs?: number;
}

function computeSharedState(lecture: Lecture, deck: DeckId | null): SharedMeterState {
  const lectureId = lecture.id;
  const since = new Date(Date.now() - LIVE_WINDOW_MS).toISOString();
  const present = presentCount(lectureId);
  const shown = present >= lecture.min_present;
  const slide = deck !== null ? currentSlideIndex(lecture, deck) : currentSlideIndex(lecture);
  const bars = gatedBars(lectureId, lecture.min_present);
  const gatedReasons = gatedReasonCounts(lectureId, lecture.min_present);
  const topReason = topReasonFor(gatedReasons, deck, slide);
  const base = {
    present,
    shown,
    ...(deck !== null ? { deck } : {}),
    slide,
    bars,
    since,
    ...(topReason !== undefined ? { topReason } : {}),
  };
  if (!shown) return base;
  const { count: live } = liveTapInfo(lectureId, since);
  return { ...base, live, totalTaps: tapCount(lectureId) };
}

function yourStateFor(lectureId: string, browserId: string, since: string): YourState {
  const liveTap = liveTapFor(lectureId, browserId, since);
  return {
    yourTapCount: yourTapCount(lectureId, browserId),
    youAreCounted: liveTap !== undefined,
    ...(liveTap !== undefined
      ? { liveForMs: Math.max(0, new Date(liveTap.created_at).getTime() + LIVE_WINDOW_MS - Date.now()) }
      : {}),
  };
}

// Merges a browser's own fields onto an already-computed shared state.
function meterStateFor(shared: SharedMeterState, yours: YourState): MeterState {
  const deck = shared.deck !== undefined ? { deck: shared.deck } : {};
  const topReason = shared.topReason !== undefined ? { topReason: shared.topReason } : {};
  if (!shared.shown) {
    return { present: shared.present, shown: false, ...deck, slide: shared.slide, bars: shared.bars, ...yours, ...topReason };
  }
  return {
    present: shared.present,
    shown: true,
    ...deck,
    slide: shared.slide,
    bars: shared.bars,
    live: shared.live!,
    totalTaps: shared.totalTaps!,
    ...yours,
    ...topReason,
  };
}

// `deck` is the deck this viewer is watching (demo only; null otherwise).
export function computeState(lectureId: string, browserId: string, deck: DeckId | null): MeterState | undefined {
  const lecture = getLecture(lectureId);
  if (!lecture) return undefined;
  const shared = computeSharedState(lecture, deck);
  return meterStateFor(shared, yourStateFor(lectureId, browserId, shared.since));
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

// At most one student broadcast and one lecturer broadcast per lecture per
// BROADCAST_WINDOW_MS (ADR 005). Leading edge: if nothing went out in the
// last window, send now, so a single tap in a quiet room has no added delay.
// Otherwise one trailing send at the window's end covers every change in it,
// so a burst of 50 taps is 2 frames per stream, not 50. Each send reads the
// state fresh when it fires and there's never more than one pending per
// lecture, so frames can't arrive out of order. Every trigger (taps,
// reasons, resolve, notes, slide changes, connects, disconnects, fades)
// comes through broadcast() or broadcastToLecturer(), so all are covered.
export const BROADCAST_WINDOW_MS = 50;

interface Throttle {
  lastSentAt: number;
  trailing: NodeJS.Timeout | undefined;
}

function makeThrottle(send: (lectureId: string) => void): (lectureId: string) => void {
  const throttles = new Map<string, Throttle>();
  return (lectureId) => {
    let t = throttles.get(lectureId);
    if (!t) {
      t = { lastSentAt: -Infinity, trailing: undefined };
      throttles.set(lectureId, t);
    }
    if (t.trailing) return;
    const waitMs = t.lastSentAt + BROADCAST_WINDOW_MS - performance.now();
    const fire = () => {
      t.trailing = undefined;
      t.lastSentAt = performance.now();
      send(lectureId);
    };
    if (waitMs <= 0) {
      fire();
      return;
    }
    t.trailing = setTimeout(() => {
      fire();
      // Nothing pending and the window has passed: drop the entry so a
      // lecture nobody is using holds no memory.
      setTimeout(() => {
        const current = throttles.get(lectureId);
        if (current && !current.trailing && performance.now() - current.lastSentAt >= BROADCAST_WINDOW_MS) {
          throttles.delete(lectureId);
        }
      }, BROADCAST_WINDOW_MS).unref();
    }, waitMs);
    t.trailing.unref();
  };
}

export const broadcast = makeThrottle((lectureId) => {
  sendToStudents(lectureId);
  broadcastToLecturer(lectureId);
});

export const broadcastToLecturer = makeThrottle(sendToLecturers);

// A stream that has just opened gets its own first frame at once, not up to
// a window later: it has nothing to show until then.
export function sendInitialState(lectureId: string, browserId: string, res: ServerResponse, deck: DeckId | null): void {
  const state = computeState(lectureId, browserId, deck);
  if (state) res.write(`data: ${JSON.stringify(state)}\n\n`);
}

export function sendInitialLecturerState(lectureId: string, res: ServerResponse): void {
  const state = computeLecturerState(lectureId);
  if (state) res.write(`data: ${JSON.stringify(state)}\n\n`);
}

// Each stream gets the live slide of the deck it's watching. The shared
// state is computed lazily once per deck, the per-browser part once per
// browser, and the JSON once per (browser, deck) — never once per stream.
function sendToStudents(lectureId: string): void {
  const byBrowser = connections.get(lectureId);
  const lecture = byBrowser && byBrowser.size > 0 ? getLecture(lectureId) : undefined;
  if (byBrowser && lecture) {
    const sharedByDeck = new Map<DeckId | null, SharedMeterState>();
    const sharedFor = (deck: DeckId | null): SharedMeterState => {
      let shared = sharedByDeck.get(deck);
      if (!shared) {
        shared = computeSharedState(lecture, deck);
        sharedByDeck.set(deck, shared);
      }
      return shared;
    };
    for (const [browserId, streams] of byBrowser) {
      let yours: YourState | undefined;
      const payloadByDeck = new Map<DeckId | null, string>();
      for (const [res, deck] of streams) {
        let payload = payloadByDeck.get(deck);
        if (payload === undefined) {
          const shared = sharedFor(deck);
          yours ??= yourStateFor(lectureId, browserId, shared.since);
          payload = `data: ${JSON.stringify(meterStateFor(shared, yours))}\n\n`;
          payloadByDeck.set(deck, payload);
        }
        res.write(payload);
      }
    }
  }
}

function sendToLecturers(lectureId: string): void {
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
// scheduleFade's shape, but one timer per running deck clock: armed when the
// clock starts (addConnection), for exactly when its slide will next change,
// re-arming itself after it fires, and cleared with the clock when the
// deck's last viewer leaves (removeConnection). No clock, no timer.
function scheduleSlideAdvance(lectureId: string, deck: DeckId): void {
  const key = slideTimerKey(lectureId, deck);
  if (slideTimers.has(key)) return;
  const delay = msUntilNextSlideChange(lectureId, deck);
  if (delay === undefined) return;
  const timer = setTimeout(() => {
    slideTimers.delete(key);
    broadcast(lectureId);
    scheduleSlideAdvance(lectureId, deck);
  }, delay);
  timer.unref();
  slideTimers.set(key, timer);
}

export function startHeartbeat(): void {
  const timer = setInterval(() => {
    for (const byBrowser of connections.values()) {
      for (const streams of byBrowser.values()) {
        for (const res of streams.keys()) res.write(": heartbeat\n\n");
      }
    }
    for (const set of lecturerConnections.values()) {
      for (const res of set) res.write(": heartbeat\n\n");
    }
  }, HEARTBEAT_MS);
  timer.unref();
}
