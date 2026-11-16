# What survives a restart

Everything a user would notice losing (taps, reasons, what helped, notes,
runs, lectures and their pasted slides, browsers, lecturer sessions, a
created lecture's slide position and a timed lecture's clock) lives in
SQLite under `$DATA_DIR` and survives a restart or redeploy. This file lists
the in-memory state that doesn't: every entry below is lost on restart, and
accepted as a cost rather than persisted, because none of it is something a
user would notice as missing data, only as a brief reconnect or a reset
rate limit.

## `src/realtime.ts`

- **`connections`**: `Map<lectureId, Map<browserId, Map<ServerResponse,
  deck | null>>>`, every open student SSE stream and the demo deck it's
  watching (null for a created lecture). It is also what `presentCount`
  and "is anyone watching this deck" read. Lost on restart: every open
  `EventSource` reconnects on its own, and the reconnect's first frame
  (`sendInitialState`) recomputes `present` and everything else from the
  database, so nothing is wrong, just briefly absent.
- **`lecturerConnections`**: `Map<lectureId, Set<ServerResponse>>`, every
  open lecturer SSE stream. Same cost: lost, reconnects on its own,
  recomputed by `sendInitialLecturerState`.
- **`fadeTimers`**: `Map<lectureId, NodeJS.Timeout>`, the one pending "the
  earliest live tap is about to leave its window" timer per lecture. The
  window is `liveWindowMs`: 20 s on the demo, 60 s on a created lecture;
  the timer fires 1 ms after it ends (`fadeDelayMs`). Lost on restart, but
  `scheduleFade` is re-armed on the next tap or student stream open, and
  `live` is always computed fresh from `taps.created_at` and
  `taps.resolved_at`, so a tap that aged out during the gap is excluded the
  next time anything asks. The timer only pushes the update.
- **`slideTimers`**: `Map<"lectureId:deck", NodeJS.Timeout>`, one "advance
  to the next slide" timer per running demo deck clock. Armed when that
  deck's clock starts, re-armed after each advance, cleared with the clock
  when the deck's last viewer leaves. Lost on restart along with the clocks
  themselves (`deckStarts`, below), and armed again when the next viewer
  starts one.
- **`timedTimers`**: `Map<lectureId, NodeJS.Timeout>`, one "next slide"
  timer per started timed lecture (made at /new with timed pacing). Armed
  by Start lecture and whenever any student or lecturer stream opens on
  the lecture, re-armed by `rescheduleTimedAdvance` after the lecturer's
  Previous/Next, and not re-armed once nobody is connected or the last
  slide is reached. Lost on restart, but the clock itself
  (`lectures.started_at` and `slide_durations_ms`) is in the database, so
  the slide is still right and the first stream to reconnect re-arms it.
- **The two broadcast throttles**: `broadcast` and `broadcastToLecturer`
  are each built by `makeThrottle`, which closes over its own
  `Map<lectureId, {lastSentAt, trailing}>` (ADR 005). Each entry holds when
  that lecture last sent and, during a burst, the one pending trailing send
  for the end of the 50 ms window (`BROADCAST_WINDOW_MS`). An entry is
  dropped once its window passes with nothing pending. Lost on restart,
  along with every pending send: harmless, because every open stream is
  gone too and each reconnect gets a fresh first frame.
- **The heartbeat interval**: `startHeartbeat` (called once at startup from
  `src/server.ts`) runs one `setInterval` every 20 s (`HEARTBEAT_MS`) that
  writes a comment line to every open stream. Its handle isn't kept; a
  restart simply starts a new one.

## `src/slides.ts`

- **`deckStarts`**: `Map<"lectureId:deck", number>`, when each demo deck's
  shared clock started: set when a student stream opens on a deck nobody is
  watching, deleted when its last viewer leaves. No entry means the live
  slide is 1. Lost on restart, which is right rather than a cost: a restart
  closes every stream, so nobody is watching, and slide 1 is what the next
  arrival should see. Lecturer streams never set it.

## `src/auth.ts`

- **`failedAttempts`**: `Map<"lectureId:browserId", number[]>` (the browser
  part is "no-cookie" without one), the lecturer-login rate limiter's
  sliding window: at most 10 failed attempts per 60 s. Lost on restart:
  every count resets to zero. Accepted: a restart mid-lockout gives a small
  window back to someone guessing codes, but restarts aren't
  attacker-controlled here, and the window is only 60 s wide anyway.
- **`lectureCreations`**: `Map<browserId, number[]>`, the `/new` rate
  limiter's per-browser sliding window (at most 3 per hour). Same cost and
  reasoning as `failedAttempts`.

## Not state that a restart can lose

- **`requestNonce`** (`src/server.ts`): an `AsyncLocalStorage<string>`
  holding the CSP nonce for the request in flight only. Nothing in it
  outlives a request, so a restart loses nothing a later request needs.
- **Loaded at startup**: the demo decks (`DECKS` in `src/slides.ts`), the
  stylesheet (`STYLESHEET` in `src/server.ts`) and the database connection
  (`db` in `src/db.ts`) are rebuilt from files on every start.

## Not on this list: what's on disk under `$DATA_DIR`

`$DATA_DIR` (`/data` on Fly, the one directory `fly.toml` mounts a
persistent volume at; `./data` locally) holds `meter.db` and, because the
database runs in WAL mode (ADR 005), its `meter.db-wal` and `meter.db-shm`
beside it. All three must be kept together. Its tables, from the
`CREATE TABLE` statements in `src/db.ts`:

- `lectures`: each lecture, its hashed code, `min_present`, help link,
  pacing, slide count and durations, and a timed lecture's `started_at`;
- `lecture_slides`: the markdown a lecturer pasted at /new, one row per
  slide;
- `taps`: every "I'm lost", with its run, deck, slide, browser, reason,
  `resolved_at`, what helped and their times (one per browser per slide per
  run, held by the `taps_one_per_slide` index);
- `notes`: student notes, one per browser per slide per run;
- `runs`: each run of a lecture and that run's current slide;
- `browsers`: every browser ID handed out;
- `lecturer_sessions`: lecturer login sessions.

None of that is in-memory state, so none of it belongs on the list above.
A lecturer's session, a browser's own taps, every note and every earlier
run are all still there after a restart.
