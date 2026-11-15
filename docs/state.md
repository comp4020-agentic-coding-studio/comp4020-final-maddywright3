# What survives a restart

Everything a user would notice losing — tap counts, reasons, notes,
lecture/browser/lecturer-session records, slide positions for a created
lecture — lives in SQLite (`$DATA_DIR/meter.db`) and survives a restart or
redeploy intact. This is the in-memory state that doesn't: every entry below
is lost on restart, and accepted as a cost rather than persisted, because
none of it is something a user would notice as missing data — only as a
brief reconnect.

## `src/realtime.ts`

- **`connections`** — `Map<lectureId, Map<browserId, Map<ServerResponse,
  deck | null>>>`, every open student SSE stream and the demo deck it's
  watching (null for a created lecture). Lost on restart: every open
  `EventSource` reconnects on its own within a few seconds (the browser's
  native retry), and the reconnect's first frame recomputes
  `present`/`shown`/etc. correctly from the database, so nothing is wrong,
  just briefly absent.
- **`lecturerConnections`** — `Map<lectureId, Set<ServerResponse>>`, every
  open lecturer SSE stream. Same cost as `connections`: lost, reconnects on
  its own, recomputed correctly.
- **`fadeTimers`** — `Map<lectureId, NodeJS.Timeout>`, the pending "a tap is
  about to age out of the 60s window" timer. Lost on restart, but
  `scheduleFade` is re-armed on the next stream open or tap, and because
  `live` is always computed fresh from `taps.created_at` (never cached), a
  tap that aged out during the gap is correctly excluded the moment anything
  queries it again — the timer is only what *pushes* the update proactively,
  not what makes it correct.
- **`slideTimers`** — `Map<"lectureId:deck", NodeJS.Timeout>`, one "advance
  to the next slide" timer per running demo deck clock. Armed when that
  deck's clock starts, re-armed after each advance, cleared with the clock
  when the deck's last viewer leaves. Lost on restart along with the clocks
  themselves (below), and armed again when the next viewer starts one. It
  only *pushes* the change; the live slide is always computed from the
  deck's start time, whether or not a timer is running.
- **broadcast throttles** — two `Map<lectureId, {lastSentAt, trailing}>`
  inside `makeThrottle`, one for student broadcasts and one for lecturer
  broadcasts (ADR 005). Each holds when that lecture last sent and, during a
  burst, the one pending 50ms trailing send. An entry is dropped once its
  window passes with nothing pending. Lost on restart, along with every
  pending send: harmless, because every open stream is gone too and each
  reconnect gets a fresh first frame computed from the database.

## `src/slides.ts`

- **`deckStarts`** — `Map<"lectureId:deck", number>`, when each demo deck's
  shared clock started: set when a student stream opens on a deck nobody is
  watching, deleted when its last viewer leaves. No entry means the live
  slide is 1. Lost on restart, which is exactly right rather than a cost: a
  restart closes every stream, so nobody is watching, and slide 1 is what
  the next arrival should see. Lecturer streams never set it.

## `src/auth.ts`

- **`failedAttempts`** — `Map<"lectureId:browserId", number[]>`, the
  lecturer-login rate limiter's sliding window. Lost on restart: every
  browser's failed-attempt count resets to zero. Accepted cost — a restart
  mid-lockout gives a (small) window back to someone guessing codes, but
  restarts aren't attacker-controlled on this deployment, and the window is
  60 seconds wide regardless.
- **`lectureCreations`** — `Map<browserId, number[]>`, the `/new`
  rate-limiter's per-browser sliding window (max 3/hour). Same cost as
  `failedAttempts`: resets on restart, same reasoning for accepting it.

## Not on this list

`lectures`, `taps`, `notes`, `browsers`, and `lecturer_sessions` are all
SQLite tables under `$DATA_DIR`, which is the one directory `fly.toml`
mounts a persistent volume at — none of that is in-memory state, so none of
it belongs on this list. A lecturer's session cookie, a browser's own tap
history, every note anyone wrote: all still there after a restart.
