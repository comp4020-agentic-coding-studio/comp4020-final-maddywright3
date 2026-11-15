import { randomBytes } from "node:crypto";
import {
  browserExists,
  insertBrowser,
  insertLecturerSession,
  lecturerSessionValid,
} from "./db.ts";
import { parseCookies } from "./cookies.ts";

export const BROWSER_COOKIE = "bid";
export const LECTURER_COOKIE = "lsess";

export interface BrowserIdResult {
  id: string;
  minted: boolean;
}

// Mints a new browser ID when the cookie is missing or unknown. Used only by
// GET handlers that render a page — tap/events must not silently adopt a new
// identity, so they use validateBrowserId instead.
export function ensureBrowserId(cookieHeader: string | null | undefined): BrowserIdResult {
  const cookies = parseCookies(cookieHeader);
  const existing = cookies[BROWSER_COOKIE];
  if (existing && browserExists(existing)) {
    return { id: existing, minted: false };
  }
  const id = randomBytes(16).toString("hex");
  insertBrowser(id);
  return { id, minted: true };
}

// Lookup only: returns undefined for a missing or unknown cookie, so the
// caller can reject (403) rather than mint a fresh identity for a tap/stream.
export function validateBrowserId(cookieHeader: string | null | undefined): string | undefined {
  const cookies = parseCookies(cookieHeader);
  const candidate = cookies[BROWSER_COOKIE];
  if (candidate && browserExists(candidate)) return candidate;
  return undefined;
}

// The raw cookie value, valid or not — used only for logging a rejected
// request, so a forged attempt still hashes to something traceable (never
// logged in the clear) while a genuinely absent cookie stays distinguishable.
export function rawBrowserCookie(cookieHeader: string | null | undefined): string | undefined {
  return parseCookies(cookieHeader)[BROWSER_COOKIE];
}

export function createLecturerSession(lectureId: string): string {
  const token = randomBytes(16).toString("hex");
  insertLecturerSession(token, lectureId);
  return token;
}

const LECTURER_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export function validateLecturerSession(
  lectureId: string,
  cookieHeader: string | null | undefined,
): boolean {
  const cookies = parseCookies(cookieHeader);
  const token = cookies[LECTURER_COOKIE];
  if (!token) return false;
  const since = new Date(Date.now() - LECTURER_SESSION_MAX_AGE_MS).toISOString();
  return lecturerSessionValid(token, lectureId, since);
}

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;
const failedAttempts = new Map<string, number[]>();

// Keyed by browser+lecture, not lecture alone — a per-lecture limit means
// ten wrong guesses from any one browser locks every browser out of that
// lecture's lecturer view for a minute (ADR 003's own "what it costs" list).
// Keying by the pair confines a lockout to the browser that earned it.
function rateLimitKey(lectureId: string, browserId: string | undefined): string {
  return `${lectureId}:${browserId ?? "no-cookie"}`;
}

// Rejects without even checking the code once this browser has hit the
// limit for this lecture — avoids needless scrypt cost under hammering.
// Both outcomes (rate-limited, wrong code) look identical to the caller, so
// this isn't a timing oracle.
export function checkLoginRateLimit(lectureId: string, browserId: string | undefined): boolean {
  const key = rateLimitKey(lectureId, browserId);
  const now = Date.now();
  const attempts = (failedAttempts.get(key) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  failedAttempts.set(key, attempts);
  return attempts.length < RATE_LIMIT_MAX;
}

export function recordFailedLogin(lectureId: string, browserId: string | undefined): void {
  const key = rateLimitKey(lectureId, browserId);
  const attempts = failedAttempts.get(key) ?? [];
  attempts.push(Date.now());
  failedAttempts.set(key, attempts);
}

const CREATE_LECTURE_WINDOW_MS = 60 * 60 * 1000;
const CREATE_LECTURE_MAX = 3;
const lectureCreations = new Map<string, number[]>();

// Max 3 lectures per browser per hour — a sliding window, same shape as the
// login rate limiter above, keyed by browser alone (there's no lecture yet
// to also key by, unlike a login attempt).
export function checkCreateLectureRateLimit(browserId: string): boolean {
  const now = Date.now();
  const attempts = (lectureCreations.get(browserId) ?? []).filter((t) => now - t < CREATE_LECTURE_WINDOW_MS);
  lectureCreations.set(browserId, attempts);
  return attempts.length < CREATE_LECTURE_MAX;
}

export function recordLectureCreation(browserId: string): void {
  const attempts = lectureCreations.get(browserId) ?? [];
  attempts.push(Date.now());
  lectureCreations.set(browserId, attempts);
}
