import { inject } from "vitest";

const baseUrl = inject("baseUrl");

// Mints a fresh browser identity by hitting a lecture page with no cookie
// and reading the Set-Cookie response header — the same thing a real
// browser's first visit does. Call it again for a second, distinct "person".
export async function newBrowserCookie(lectureId: string): Promise<string> {
  const res = await fetch(new URL(`/l/${lectureId}`, baseUrl));
  const cookies = res.headers.getSetCookie();
  const bid = cookies.find((c) => c.startsWith("bid="));
  if (!bid) throw new Error("no bid cookie minted");
  return bid.split(";")[0];
}
