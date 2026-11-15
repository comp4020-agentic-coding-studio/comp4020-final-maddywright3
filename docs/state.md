# What survives a restart

Everything a user would notice losing — tap counts, reasons, notes,
lecture/browser/lecturer-session records, slide positions for a created
lecture — lives in SQLite (`$DATA_DIR/meter.db`) and survives a restart or
redeploy intact. This is the in-memory state that doesn't: every entry below
is lost on restart, and accepted as a cost rather than persisted, because
none of it is something a user would notice as missing data — only as a
brief reconnect.

## `src/realtime.ts`

- **`connections`** — `Map<lectureId, Map<browserId, Set<ServerResponse>>>`,
  every open student SSE stream. Lost on restart: every open `EventSource`
  reconnects on its own within a few seconds (the browser's native retry),
  and the reconnect's first frame recomputes `present`/`shown`/etc. correctly
  from the database, so nothing is wrong, just briefly absent.
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
- **`slideTimers`** — `Map<lectureId, NodeJS.Timeout>`, the demo's "advance
  to the next slide" timer. Same shape as `fadeTimers`: lost, re-armed on the
  next student stream open, and `currentSlideIndex`'s shared-clock
  computation is always correct from `lectures.created_at` regardless of
  whether a timer was running to push it.

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
