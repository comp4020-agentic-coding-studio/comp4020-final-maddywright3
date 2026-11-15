export function parseCookies(header: string | null | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    try {
      // A malformed percent-encoding (e.g. a lone %E0) throws rather than
      // just failing to decode — treat it as if this cookie weren't sent,
      // not as a reason to take the whole request down.
      cookies[name] = decodeURIComponent(value);
    } catch {
      // skip this one cookie; the caller sees it as missing/unknown
    }
  }
  return cookies;
}

export interface CookieOptions {
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  path?: string;
  secure?: boolean;
  maxAgeSeconds?: number;
}

export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path ?? "/"}`);
  if (opts.maxAgeSeconds !== undefined) parts.push(`Max-Age=${opts.maxAgeSeconds}`);
  if (opts.httpOnly) parts.push("HttpOnly");
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}
