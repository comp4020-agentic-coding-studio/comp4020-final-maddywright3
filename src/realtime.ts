import type { ServerResponse } from "node:http";
import { getLecture, liveTapInfo, tapCount, tapsNewestFirst } from "./db.ts";

const LIVE_WINDOW_MS = 60_000;
const HEARTBEAT_MS = 20_000;

export interface MeterState {
  present: number;
  live: number;
  shown: boolean;
  totalTaps: number;
  taps: string[];
}

const connections = new Map<string, Set<ServerResponse>>();
const fadeTimers = new Map<string, NodeJS.Timeout>();

function connectionsFor(lectureId: string): Set<ServerResponse> {
  let set = connections.get(lectureId);
  if (!set) {
    set = new Set();
    connections.set(lectureId, set);
  }
  return set;
}

export function addConnection(lectureId: string, res: ServerResponse): void {
  connectionsFor(lectureId).add(res);
}

export function removeConnection(lectureId: string, res: ServerResponse): void {
  const set = connections.get(lectureId);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) connections.delete(lectureId);
}

export function presentCount(lectureId: string): number {
  return connections.get(lectureId)?.size ?? 0;
}

export function computeState(lectureId: string): MeterState | undefined {
  const lecture = getLecture(lectureId);
  if (!lecture) return undefined;
  const since = new Date(Date.now() - LIVE_WINDOW_MS).toISOString();
  const { count: live } = liveTapInfo(lectureId, since);
  const present = presentCount(lectureId);
  const totalTaps = tapCount(lectureId);
  const taps = tapsNewestFirst(lectureId).map((t) => t.created_at);
  return { present, live, shown: present >= lecture.min_present, totalTaps, taps };
}

export function broadcast(lectureId: string): void {
  const state = computeState(lectureId);
  if (!state) return;
  const payload = `data: ${JSON.stringify(state)}\n\n`;
  for (const res of connections.get(lectureId) ?? []) {
    res.write(payload);
  }
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
    for (const set of connections.values()) {
      for (const res of set) res.write(": heartbeat\n\n");
    }
  }, HEARTBEAT_MS);
  timer.unref();
}
