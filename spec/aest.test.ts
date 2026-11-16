import { expect, it } from "vitest";
import { formatAest } from "../src/aest.ts";

// The activity log stamps each press in AEST (Australia/Brisbane, UTC+10, no
// daylight saving): time only for today, with the date for any other day.
// A pure function, so these don't need the running app.
const NOW_16_NOV_AEST = new Date("2026-11-16T03:00:00Z"); // 13:00 AEST, 16 Nov

it("a time on the same AEST day is shown as time only, 24-hour, zero-padded", () => {
  expect(formatAest("2026-11-16T00:42:07.000Z", NOW_16_NOV_AEST)).toEqual({
    text: "10:42:07 AEST",
    iso: "2026-11-16T00:42:07.000Z",
  });
});

it("a time on a different AEST day carries the date", () => {
  expect(formatAest("2026-11-15T00:42:07.000Z", NOW_16_NOV_AEST)).toEqual({
    text: "15 Nov, 10:42:07 AEST",
    iso: "2026-11-15T00:42:07.000Z",
  });
  expect(formatAest("2026-11-16T00:42:07.000Z", new Date("2026-11-17T01:00:00Z")).text).toBe("16 Nov, 10:42:07 AEST");
});

it("the day is AEST's, not UTC's: 14:30 UTC on 15 Nov is 00:30 on 16 Nov in AEST", () => {
  expect(formatAest("2026-11-15T14:30:00Z", NOW_16_NOV_AEST)).toEqual({
    text: "00:30:00 AEST",
    iso: "2026-11-15T14:30:00Z",
  });
  // And now late on 16 Nov AEST (still 16 Nov) gives the same.
  expect(formatAest("2026-11-15T14:30:00Z", new Date("2026-11-16T13:59:59Z")).text).toBe("00:30:00 AEST");
});

it("null, empty or unparseable input says the time wasn't recorded", () => {
  for (const input of [null, "", "not a date", "2026-13-45T99:00:00Z"]) {
    expect(formatAest(input, NOW_16_NOV_AEST)).toEqual({ text: "time not recorded", iso: "" });
  }
});
