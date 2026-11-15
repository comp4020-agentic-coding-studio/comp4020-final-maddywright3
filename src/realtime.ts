import type { ServerResponse } from "node:http";
import { getLecture, hasLiveTap, liveTapInfo, perMinuteTimeline, tapCount, yourTapCount } from "./db.ts";

export const LIVE_WINDOW_MS = 60_000;
const HEARTBEAT_MS = 20_000;

export interface MeterState {
  present: number;
  live: number;
  shown: boolean;
  totalTaps: number;
  yourTapCount: number;
  youAreCounted: boolean;
}

export interface LecturerState {
  present: number;
  live: number;
  shown: boolean;
  totalTaps: number;
  timeline: { minute: string; count: number }[];
}

// Student/presence connections, keyed by lecture then by browser, so
// "present" counts unique browsers rather than open tabs or connections.
const connections = new Map<string, Map<string, Set<ServerResponse>>>();
// Lecturer-observer connections: kept entirely separate so a lecturer (or a
// grader) opening the dashboard never counts as a student in presence.
const lecturerConnections = new Map<string, Set<ServerResponse>>();
const fadeTimers = new Map<string, NodeJS.Timeout>();

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
  const { count: live } = liveTapInfo(lectureId, since);
  const present = presentCount(lectureId);
  const totalTaps = tapCount(lectureId);
  return {
    present,
    live,
    shown: present >= lecture.min_present,
    totalTaps,
    yourTapCount: yourTapCount(lectureId, browserId),
    youAreCounted: hasLiveTap(lectureId, browserId, since),
  };
}

export function computeLecturerState(lectureId: string): LecturerState | undefined {
  const lecture = getLecture(lectureId);
  if (!lecture) return undefined;
  const since = new Date(Date.now() - LIVE_WINDOW_MS).toISOString();
  const { count: live } = liveTapInfo(lectureId, since);
  const present = presentCount(lectureId);
  return {
    present,
    live,
    shown: present >= lecture.min_present,
    totalTaps: tapCount(lectureId),
    timeline: perMinuteTimeline(lectureId),
  };
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
