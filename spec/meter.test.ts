import { expect, inject, it } from "vitest";

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

it("/l/demo answers 200 and shows a tap count", async () => {
  const res = await fetch(new URL("/l/demo", baseUrl));
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(tapCountFrom(html)).toBeGreaterThanOrEqual(0);
});

it("posting a tap to /l/demo increases the count by one", async () => {
  const before = tapCountFrom(await (await fetch(new URL("/l/demo", baseUrl))).text());

  const res = await fetch(new URL("/l/demo/tap", baseUrl), { method: "POST" });
  expect(res.status).toBe(200); // fetch follows the 303 redirect by default
  const after = tapCountFrom(await res.text());

  expect(after).toBe(before + 1);
});

it("/l/does-not-exist answers 404", async () => {
  const res = await fetch(new URL("/l/does-not-exist", baseUrl));
  expect(res.status).toBe(404);
});
