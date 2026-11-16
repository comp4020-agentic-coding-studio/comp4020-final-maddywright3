# Walkthrough: how a tap reaches every open page

A linear read of the path from pressing "I'm lost" to every open page
updating, entry point first. Each section says what the part is *for*; the
code says what it does. Files: `src/server.ts` (routes and pages),
`src/db.ts` (the write), `src/realtime.ts` (who gets told what, and when),
`src/slides.ts` (clocks and live windows), `src/activity.ts` and
`src/aest.ts` (the lecturer's activity log).

## 0. Before any tap: the database at startup (`src/db.ts`)

WAL mode with `synchronous=NORMAL`, set at the top of `src/db.ts`; startup
throws if `PRAGMA journal_mode` doesn't read back `wal`. That cut a tap's
insert from about 7.5 ms (a full disk sync per write) to about 0.1 ms. The
costs (ADR 005): a power loss can drop the last moment of taps, and
`meter.db-wal` and `meter.db-shm` sit beside `meter.db` under `DATA_DIR`
and must be kept with it.

## 1. The button: the tap form and its script (`src/server.ts`, `handleLecture`)

The student page renders "I'm lost" as a plain `<form method="post">` to
`/l/:id/tap`, with hidden `deck` (demo only) and `slide` fields holding the
slide the viewer is looking at. That's what makes it work without
JavaScript: the form posts, and the server redirects (303) back to that
slide.

With JavaScript, the inline script catches `submit`, shows "Sending..."
and posts the same fields with `fetch`. `setTapEnabled` uses
`aria-disabled`, not `disabled`, so a keyboard user keeps focus. The script
changes no counts itself: everything comes back over the stream (section
9), so every open page, this one included, updates the same way.

## 2. Entry point: `handleTap` (`src/server.ts`)

The route the form posts to. Three jobs, in order:

1. **Identify the browser.** `validateBrowserId` (`src/auth.ts`) looks the
   `bid` cookie up in the `browsers` table and rejects with 403 if it's
   missing or unknown. A tap must never mint a fresh identity the way a
   page view does.
2. **Validate the slide.** The body names the deck and slide the viewer's
   own page was showing, not whatever the server thinks is current (ADR 004:
   flicking back to an earlier slide and tapping there is normal).
   `deckFor` drops any deck sent for a created lecture, and `isValidSlide`
   (`src/slides.ts`) checks the slide exists. A bad one is a 400, never
   silently replaced.
3. **Write, then tell everyone.** Two single statements, tried in order
   (section 3). If `tapOncePerSlide` inserted a row, `handleTap` calls
   `broadcast(id)` (section 5) and `scheduleFade(id)` (section 8) and logs
   `tap`. Otherwise, if `reopenResolvedTap` reopened a resolved row, it does
   the same and logs `tap_reopened`. If neither changed anything (the tap
   is still open), it logs `tap_ignored` and broadcasts nothing. Every log
   line carries only the hashed browser ID (`who` in `src/logging.ts`).

## 3. The write: `tapOncePerSlide` and `reopenResolvedTap` (`src/db.ts`)

`tapOncePerSlide` is one `INSERT ... ON CONFLICT DO NOTHING` against the
unique index `taps_one_per_slide` on (lecture, run, `COALESCE(deck, '')`,
slide, browser). That's what makes "one 'I'm lost' per browser per slide"
hold when two requests arrive at the same moment: the index decides, not a
SELECT beforehand. `COALESCE` matters because SQLite treats every NULL as
distinct, and a created lecture's taps have no deck. Rows marked
`legacy_duplicate` by the one-time migration are outside the index.

When that inserts nothing, `reopenResolvedTap` is one `UPDATE` that clears
`resolved_at` and resets `created_at` to now, and only matches a row whose
`resolved_at IS NOT NULL`. So "I'm lost" after "I get it now" reopens the
same tap with a fresh live window; it never adds a second row, so
`yourTapCount`, `totalTaps` and the bars don't stack, and ten presses at
once reopen it once. A tap that's still open is left alone.

**Runs.** Both statements write to the lecture's current run (the highest
`runs.number`), so a fresh run (ADR 006) can take the same slide again.
Every live read does the same: `getLecture` returns it as `lecture.run`,
`computeSharedState` and `computeLecturerState` pass that to every query,
and queries with an optional run default to `currentRun`.

## 4. The stream: `handleEvents` (`src/server.ts`)

`GET /l/:id/events` is a server-sent event stream, opened by every student
page. It checks the browser cookie (403 without one), registers the
connection with `addConnection` under the deck it's watching (`?deck=` for
the demo, null for a created lecture), and then:

- `sendInitialState` writes this stream its own first frame at once, so a
  new page never waits for a throttle window to show anything;
- `broadcast(id)` tells everyone else that one more person is here;
- `scheduleFade(id)` re-arms the fade timer if a restart lost it.

On close, `removeConnection` and another `broadcast`. A lecturer's browser
here counts as a student, on purpose: lecturer state has its own route.

## 5. Deciding when to send: the throttle (`src/realtime.ts`, `makeThrottle`)

`broadcast` and `broadcastToLecturer` are both built by `makeThrottle`, so
every trigger (taps, reopens, reasons, "I get it now", notes, slide
changes, connects, disconnects, fades) goes through it. A burst of taps
costs a handful of frames, not one per tap per open page.

- **Leading edge.** Nothing sent for this lecture in the last
  `BROADCAST_WINDOW_MS` (50 ms): send at once, no added delay.
- **One trailing send.** Inside a window, one timer for the window's end;
  further calls do nothing. 50 taps in one window give two frames per
  stream, over two windows three (`spec/broadcast.test.ts`).
- **State read fresh.** Each send computes the state when it fires, with
  at most one pending per lecture, so a stale frame can't overtake.

`broadcast` runs `sendToStudents`, then calls `broadcastToLecturer`, whose
own throttle runs `sendToLecturers`.

## 6. What every viewer shares: `computeSharedState` (`src/realtime.ts`)

Called by `sendToStudents` once per watched deck, not per browser. The
privacy gates live here: a value that mustn't leave the server is never
put in the object.

- `present` counts browsers with an open stream (`presentCount`), not tabs.
- `live` and `totalTaps` are only added when `present >= min_present`.
  Below that, the frame has no such keys at all, not zeros.
- `bars` come from `gatedBars`: a slide appears only once at least
  `min_present` distinct browsers have tapped it in this run, whoever is
  present now. `gatedReasonCounts` gates each (slide, reason) the same
  way, and `topReasonFor` picks only among those that qualified.
- `slide` and, for the demo, `lectureElapsedMs` are ungated: where the
  lecture is says nothing about anyone.
- `live` counts distinct browsers with an unresolved tap inside the live
  window (`liveTapInfo`). `liveWindowMs` (`src/slides.ts`) is 20 s for the
  condensed demo and 60 s for a created lecture.

## 7. What only this browser gets: `yourStateFor` and `meterStateFor` (`src/realtime.ts`)

Run once per browser per send, then merged onto the shared state by
`meterStateFor`: the fields a browser may always see, because they're its
own. `yourSlides` (slides it tapped this run: live, resolved, reason or
"what helped" sent; flags only, never answer text), `yourTapCount`,
`youAreCounted`, and `helpUrl`, only once it has said it's lost on
`HELP_AFTER_SLIDES` (3) slides this run. So the help link reaches only that
browser's frame, never the shared state, the lecturer or a log line.
`sendToStudents` builds the JSON once per (browser, deck), not per tab.

## 8. Updates nothing else triggers: fade and slide timers (`src/realtime.ts`)

A tap stops being live, and slides move on, with no request to announce
it; without these, open pages would only catch up on the next event.

- `scheduleFade` arms one timer per lecture for when the earliest live tap
  leaves its window, broadcasts then, and re-arms for the next. The delay
  is `fadeDelayMs`, which fires 1 ms AFTER the window ends (commit
  0bc55cd): the live check is `created_at >= now - window`, so at exactly
  the boundary the tap still counts. Firing there sent a "still live" frame
  and re-armed with zero delay for the same tap, and under load the faded
  frame could be lost (`spec/fade-timer.test.ts`).
- `scheduleSlideAdvance` arms one timer per running demo deck clock for the
  next slide change. A deck's clock (`startDeckClock`) and timer start when
  its first viewer connects (`addConnection`) and are cleared when its last
  viewer leaves (`removeConnection`).
- `scheduleTimedAdvance` does the same for a timed lecture made at /new.
  Its clock is the lecture's `started_at`, set by Start lecture, so it
  survives a restart; the timer is re-armed when any stream opens, and
  `rescheduleTimedAdvance` re-arms it after the lecturer's Previous/Next.

They only push, so a lost timer makes a value late, never wrong.

## 9. The page catching up: `render(state)` (`src/server.ts`, student page script)

`source.onmessage` calls `render(state)`, which places the server's state
without the page deciding anything:

- the live slide, the "Live" marker and "Back to live" (`updateLiveState`),
  and the lecture clock (`syncLectureClock`), ignoring a frame about a deck
  the page has switched away from;
- `renderGauge`, shared with the lecturer page through `GAUGE_CLIENT_JS`,
  which only touches the aria-live node when the lost count changes or the
  gauge appears or disappears;
- "Total taps", only when the frame is `shown`;
- the bars and the timeline shading (`renderBars`, `markTimeline`), straight
  from the gated `bars`, and the top reason;
- this browser's own controls: `renderHelpOffer`, then `updateTapControls`
  (the button's words, "You've said you're lost on this slide.", the
  reasons and "what helped").

`source.onerror` shows "Reconnecting..." until the next frame (section 4).

## 10. The lecturer's state: `computeLecturerState` (`src/realtime.ts`)

Applies the same gates for the current run and adds what only the lecturer
sees: gated reason and "what helped" counts (`gatedHelpedCounts`) and notes
(`gatedNotes`, each slide's only once enough people have written one). The
dashboard travels already rendered: `computeDashboard` (`src/dashboard.ts`)
returns `dashboardHtml`, the fragments `tiles`, `graphLost`,
`graphReasons`, `graphHelped`, `graphResolved`, `ranking` and `lostNow`,
built from the same gated counts, so the first page render and a live
update can't format a number differently.

The activity log (`activityLog` in `src/activity.ts`) is ONLY present when
`present >= min_present` (commit 0085a6d), like `live` and `totalTaps`.
Below that, `activityLog` and `activityLogCapped` are absent from the
frame, and the page says "The activity log shows once N people are here."
When present, it is one line per press (lost, reason, "I get it now", what
helped, note), newest first, at most `ACTIVITY_LOG_MAX` (500). Each line
is labelled only "Person N", numbered per run by each browser's first
press; browser IDs are only Map keys and never leave the function. Times
come from `formatAest` (`src/aest.ts`): "10:42:07 AEST", with the day and
month when not today. Nothing per browser and never the help link.

## 11. The lecturer's stream and page (`handleLecturerEvents`, `renderActivity`)

The lecturer page uses its own route, `/l/:id/lecturer/events`, behind the
lecturer session (`validateLecturerSession`), so lecturer state never
travels on a student stream. It registers with `addLecturerConnection`,
gets `sendInitialLecturerState` at once, then frames via
`broadcastToLecturer` and `sendToLecturers`.

On the page, `source.onmessage` reloads if the frame's `run` changed,
otherwise calls its own `render(state)`: slide label, `renderGauge`, total
taps, `renderNow`, `renderDashboard` (places the `dashboardHtml`
fragments) and `renderActivity(state.activityLog, state.activityLogCapped)`.
`renderActivity` (from `activityClientJs`) only places the server's text
and times; with no log in the frame it clears the lines and shows the
waiting message. Without JavaScript, `activityLogHtml` renders the same
section on the server.

## Where to start a change

- What the gauge says: `gaugeWords` and `lostText` in `src/server.ts`, and
  their browser copy in `GAUGE_CLIENT_JS`. Change both.
- How often pages update: `BROADCAST_WINDOW_MS` in `src/realtime.ts`.
- How long a tap counts: `liveWindowMs` in `src/slides.ts`.
- Who may see a number: the gate functions in `src/realtime.ts`, and
  CLAUDE.md's Privacy rules first.
