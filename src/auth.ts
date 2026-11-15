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

export function validateLecturerSession(
  lectureId: string,
  cookieHeader: string | null | undefined,
): boolean {
  const cookies = parseCookies(cookieHeader);
  const token = cookies[LECTURER_COOKIE];
  if (!token) return false;
  return lecturerSessionValid(token, lectureId);
}

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;
const failedAttempts = new Map<string, number[]>();

// Rejects without even checking the code once a lecture has hit the limit —
// avoids needless scrypt cost under hammering. Both outcomes (rate-limited,
// wrong code) look identical to the caller, so this isn't a timing oracle.
export function checkLoginRateLimit(lectureId: string): boolean {
  const now = Date.now();
  const attempts = (failedAttempts.get(lectureId) ?? []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS,
  );
  failedAttempts.set(lectureId, attempts);
  return attempts.length < RATE_LIMIT_MAX;
}

export function recordFailedLogin(lectureId: string): void {
  const attempts = failedAttempts.get(lectureId) ?? [];
  attempts.push(Date.now());
  failedAttempts.set(lectureId, attempts);
}
