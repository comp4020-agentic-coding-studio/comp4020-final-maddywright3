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

// Below demo's min_present (2), "Total taps" isn't rendered at all — see the
// privacy test in spec/identity.test.ts — so these tests need enough
// otherwise-unused presence connections open to cross that threshold before
// they can read it.
async function openPresenceConnection(lectureId: string): Promise<() => void> {
  const cookie = await newBrowserCookie(lectureId);
  const controller = new AbortController();
  const res = await fetch(new URL(`/l/${lectureId}/events`, baseUrl), {
    signal: controller.signal,
    headers: { cookie },
  });
  const reader = res.body!.getReader();
  await reader.read(); // wait for the initial frame, so presence is registered
  return () => controller.abort();
}

async function openPresenceConnections(lectureId: string, count: number): Promise<() => void> {
  const closers = await Promise.all(Array.from({ length: count }, () => openPresenceConnection(lectureId)));
  return () => closers.forEach((close) => close());
}

it("/l/demo answers 200 and shows a tap count", async () => {
  const close = await openPresenceConnections("demo", 2); // demo's min_present is 2
  try {
    const res = await fetch(new URL("/l/demo", baseUrl));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(tapCountFrom(html)).toBeGreaterThanOrEqual(0);
  } finally {
    close();
  }
});

it("posting a tap to /l/demo increases the count by one", async () => {
  const close = await openPresenceConnections("demo", 2); // demo's min_present is 2
  try {
    // A fresh browser identity each run: a browser taps each slide once,
    // ever, so reusing a cookie across test runs would make the second run
    // count nothing. Spec files run one at a time (see
    // vitest.config.ts), so the shared total is stable to assert an exact
    // delta on again.
    const cookie = await newBrowserCookie("demo");
    const before = tapCountFrom(await (await fetch(new URL("/l/demo", baseUrl), { headers: { cookie } })).text());

    const res = await fetch(new URL("/l/demo/tap", baseUrl), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: "deck=week-4&slide=1",
    });
    expect(res.status).toBe(200); // fetch follows the 303 redirect by default
    const after = tapCountFrom(await res.text());

    expect(after).toBe(before + 1);
  } finally {
    close();
  }
});

it("/l/does-not-exist answers 404", async () => {
  const res = await fetch(new URL("/l/does-not-exist", baseUrl));
  expect(res.status).toBe(404);
});
