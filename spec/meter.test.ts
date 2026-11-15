import { expect, inject, it } from "vitest";
import { newBrowserCookie } from "./test-helpers.ts";

// Covers the one behaviour this milestone adds: a tap on /l/demo is saved
// (the count goes up by one) and an unknown lecture answers 404. Persistence
// across a restart can't be checked over HTTP — see spec/README.md and the
// manual check in the plan this shipped from.
const baseUrl = inject("baseUrl");

const tapCountFrom = (html: string): number => {
  const match = html.match(/Total taps: (\d+)/);
  if (!match) throw new Error("couldn't find the tap count in the page");
  return Number(match[1]);
};

// "Total taps" is the whole lecture's shared total, which other spec files
// running concurrently also bump by tapping the same demo lecture — so only
// this browser's own count (C10's per-browser tracking) is safe to assert
// an exact before/after delta on.
const yourCountFrom = (html: string): number => {
  const match = html.match(/You've said you're lost (\d+) times?/);
  if (!match) throw new Error("couldn't find this browser's tap count in the page");
  return Number(match[1]);
};

it("/l/demo answers 200 and shows a tap count", async () => {
  const res = await fetch(new URL("/l/demo", baseUrl));
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(tapCountFrom(html)).toBeGreaterThanOrEqual(0);
});

it("posting a tap to /l/demo increases the count by one", async () => {
  // A fresh browser identity each run: C10 dedupes repeat taps from the same
  // browser within 60s, so reusing a cookie across test runs could make this
  // flaky depending on timing.
  const cookie = await newBrowserCookie("demo");
  const before = yourCountFrom(await (await fetch(new URL("/l/demo", baseUrl), { headers: { cookie } })).text());

  const res = await fetch(new URL("/l/demo/tap", baseUrl), { method: "POST", headers: { cookie } });
  expect(res.status).toBe(200); // fetch follows the 303 redirect by default
  const after = yourCountFrom(await res.text());

  expect(after).toBe(before + 1);
});

it("/l/does-not-exist answers 404", async () => {
  const res = await fetch(new URL("/l/does-not-exist", baseUrl));
  expect(res.status).toBe(404);
});
