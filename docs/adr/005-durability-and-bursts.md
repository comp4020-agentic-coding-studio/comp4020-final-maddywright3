# ADR 005: Durability and bursts

Status: accepted, 16 November 2026 (finishing stage)

## Context

The brief asks for a tap to reach every open page "within about a second". The 50-browser load test on Fly took 1.49 s for all 50 taps to reach all 50 streams (lecture `98f1f2ea`, recorded in `ec21b00`). Locally it took about 800 ms.

I measured one tap before changing anything (local, 50 browsers, median per tap):

| Step | Per tap | Of the ~800 ms for 50 taps |
|---|---|---|
| Insert, with SQLite's default journal and a full disk sync | 7.5 ms | ~380 ms |
| Broadcast to all 50 streams | 4.5 ms | ~230 ms |
| …the shared state | 0.2 ms | |
| …each browser's own part (two queries, 50 times) | 0.07 ms × 50 | most of the broadcast |
| …writing to the streams | 0.004 ms × 50 | ~0 |

The rest is HTTP handling. The taps table had 150 rows, so the insert wasn't slow because of a lookup. It was the disk sync. Every tap also caused a full broadcast, so 50 taps meant 2,500 frames.

## Options

1. *A: WAL mode* (`journal_mode=WAL`, `synchronous=NORMAL`). Local: about 390 ms. The insert drops to 0.1 ms, and the broadcast becomes the main cost.
2. *B: at most one broadcast per lecture per 50 ms.* On its own this leaves the 7.5 ms sync per tap.
3. *A and B.* Local: 75 to 150 ms. 50 broadcasts become one or two.

For A, `synchronous` could stay FULL instead of NORMAL. FULL keeps today's guarantee but gains far less, because the sync was the slow part.

An index on taps wouldn't help yet: the time was the sync, not the lookup.

## Decision

A and B, with `synchronous=NORMAL`.

- `src/db.ts` turns on WAL at startup and refuses to start if the database isn't in WAL mode afterwards.
- `broadcast()` and `broadcastToLecturer()` are throttled per lecture with a leading edge. If nothing went out in the last 50 ms, the update goes out at once, so a single tap in a quiet room has no added delay. Otherwise one trailing update goes at the end of the window. Every trigger goes through these two functions: taps, reasons, "I get it now", notes, slide changes, connects, disconnects and fades.
- Each update is read fresh when it's sent, and only one is ever pending per lecture, so updates can't arrive out of order.
- A stream that has just opened is sent its own first frame at once, rather than waiting for the throttled update.
- spec/broadcast.test.ts checks:
  - a burst of 50 taps sends at most 2 updates per stream (without the throttle, each stream got 50);
  - a quiet tap arrives within 25 ms of its response (a trailing-only throttle fails this);
  - live only ever rises during a run of taps.

## What it costs

- *A power loss can drop the last moment of taps.* With NORMAL, a committed tap survives the app crashing, but not the machine losing power or its disk before the next checkpoint. The database isn't corrupted, and the lost taps are at most the last second or so. For a confusion meter, that's an acceptable loss.
- *Three files in /data, kept together.* `meter.db-wal` and `meter.db-shm` sit beside `meter.db`. A copy of `meter.db` alone, taken while the app runs, can be missing recent taps. All three are under DATA_DIR, so the volume keeps them together.
- *Up to 50 ms of batching during bursts.* Ten taps inside one window arrive as one jump of +10, not ten steps of +1. A quiet room sees no delay.
- *More code in the broadcast path:* a timer per busy lecture, listed in docs/state.md.
