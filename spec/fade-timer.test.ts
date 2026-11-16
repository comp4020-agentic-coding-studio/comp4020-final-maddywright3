import { expect, it } from "vitest";
import { fadeDelayMs } from "../src/realtime.ts";

// A tap counts as live while created_at >= now - window (src/db.ts,
// liveTapInfo). The fade timer used to be armed for exactly
// created_at + window, the last millisecond the tap still counted: its
// frame said "still live" and it re-armed with zero delay for the same tap
// (27 to 29 times in one full pnpm check), and under load the faded frame
// that should follow could be lost, so the README-enforced fade test failed
// now and then, including once in CI. The timer must fire only once the tap
// is already outside the window.
const WINDOW = 60_000;
const isLive = (createdAt: number, now: number): boolean => createdAt >= now - WINDOW;

it("the fade timer fires only once the tap it waits for no longer counts as live", () => {
  const createdAt = Date.parse("2026-11-16T11:11:36.702Z");
  for (const now of [createdAt, createdAt + 1, createdAt + 30_000, createdAt + WINDOW - 1]) {
    const firesAt = now + fadeDelayMs(createdAt, WINDOW, now);
    expect(isLive(createdAt, firesAt), `armed at +${now - createdAt} ms, fires at +${firesAt - createdAt} ms`).toBe(false);
  }
});

it("a timer for a tap already past its window fires at once, never waits", () => {
  const createdAt = Date.parse("2026-11-16T11:11:36.702Z");
  expect(fadeDelayMs(createdAt, WINDOW, createdAt + WINDOW + 500)).toBe(0);
});
