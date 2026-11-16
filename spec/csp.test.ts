import { expect, inject, it } from "vitest";
import { newBrowserCookie } from "./test-helpers.ts";

// Every response sends a Content-Security-Policy, so the browser itself
// refuses anything from another site, an inline script without this
// response's nonce, or framing by another page (CLAUDE.md: "Every page sends
// the CSP header. Never weaken it to make something work.").
const baseUrl = inject("baseUrl");

const NONCE = /script-src 'nonce-([A-Za-z0-9+/=]+)'/;

function expectPolicy(csp: string | null, path: string): string {
  expect(csp, `${path} has no Content-Security-Policy`).not.toBeNull();
  const directives = csp!.split(";").map((d) => d.trim());
  expect(directives).toEqual([
    "default-src 'self'",
    "img-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    expect.stringMatching(/^script-src 'nonce-[A-Za-z0-9+/=]{22,}'$/),
  ]);
  expect(csp).not.toContain("unsafe-inline");
  expect(csp).not.toContain("unsafe-eval");
  return csp!.match(NONCE)![1];
}

async function lecturerCookie(): Promise<string> {
  const cookie = await newBrowserCookie("demo");
  const res = await fetch(new URL("/l/demo/lecturer", baseUrl), {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: "code=DEMO",
    redirect: "manual",
  });
  const lsess = res.headers.getSetCookie().find((c) => c.startsWith("lsess="))!.split(";")[0];
  return `${cookie}; ${lsess}`;
}

it("every page, the 404 and the stylesheet send the policy", async () => {
  const lecturer = await lecturerCookie();
  const cases: [string, string | undefined, number][] = [
    ["/", undefined, 200],
    ["/readme/", undefined, 200],
    ["/l/demo", undefined, 200],
    ["/l/demo/lecturer", undefined, 200],
    ["/l/demo/lecturer", lecturer, 200],
    ["/new", undefined, 200],
    ["/no-such-page", undefined, 404],
    ["/style.css", undefined, 200],
  ];
  for (const [path, cookie, status] of cases) {
    const res = await fetch(new URL(path, baseUrl), { headers: cookie ? { cookie } : {} });
    expect(res.status, path).toBe(status);
    expectPolicy(res.headers.get("content-security-policy"), path);
  }
});

it("redirects and form errors send the policy too", async () => {
  const cookie = await newBrowserCookie("demo");
  const tap = await fetch(new URL("/l/demo/tap", baseUrl), {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: "deck=week-4&slide=1",
    redirect: "manual",
  });
  expect(tap.status).toBe(303);
  expectPolicy(tap.headers.get("content-security-policy"), "POST /l/demo/tap");

  const badNew = await fetch(new URL("/new", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "title=",
  });
  expect(badNew.status).toBe(400);
  expectPolicy(badNew.headers.get("content-security-policy"), "POST /new (error)");
});

it("each response gets a different nonce", async () => {
  const nonces = new Set<string>();
  for (let i = 0; i < 5; i++) {
    const res = await fetch(new URL("/l/demo", baseUrl));
    nonces.add(expectPolicy(res.headers.get("content-security-policy"), "/l/demo"));
  }
  expect(nonces.size).toBe(5);
});

it("every inline script carries this response's nonce, and no page has inline styles", async () => {
  const lecturer = await lecturerCookie();
  for (const [path, cookie] of [
    ["/l/demo", undefined],
    ["/l/demo/lecturer", lecturer],
    ["/", undefined],
    ["/new", undefined],
  ] as [string, string | undefined][]) {
    const res = await fetch(new URL(path, baseUrl), { headers: cookie ? { cookie } : {} });
    const nonce = expectPolicy(res.headers.get("content-security-policy"), path);
    const html = await res.text();
    const scriptTags = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    for (const tag of scriptTags) expect(tag, path).toBe(`<script nonce="${nonce}">`);
    // Nothing would satisfy style-src 'self' except /style.css.
    expect(html, path).not.toMatch(/<style\b/);
    expect(html, path).not.toMatch(/\sstyle="/);
    // Event-handler attributes are inline script too, and carry no nonce.
    expect(html, path).not.toMatch(/\son[a-z]+="/);
  }
  const demo = await (await fetch(new URL("/l/demo", baseUrl))).text();
  expect(demo).toMatch(/<script nonce="/);
});
