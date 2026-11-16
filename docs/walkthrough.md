# Walkthrough: how a tap reaches every open page

A linear read of the path from pressing "I'm lost" to every open page
updating, in the order you'd need it to change that path. Entry point first.
Each section says what the part is *for*; the code says what it does line by
line. Files: `src/server.ts` (routes and pages), `src/db.ts` (the write),
`src/realtime.ts` (who gets told what, and when), `src/slides.ts` (clocks
and live windows).

## 1. The button: the tap form and its script (`src/server.ts`, `handleLecture`)

The student page renders "I'm lost" as a plain `<form method="post">` to
`/l/:id/tap`, with hidden `deck` and `slide` fields holding the slide the
viewer is looking at. That's what makes it work without JavaScript: the
form posts, and the server redirects back to that slide.

With JavaScript, the page's inline script catches the form's `submit`,
shows "Sending..." at once and posts the same fields with `fetch`.
`setTapEnabled` marks the button `aria-disabled` rather than `disabled`, so
a keyboard user who pressed Enter keeps their focus. The script doesn't
change any counts itself: everything the page shows comes back over the
stream (section 8), so every open page, this one included, updates the
same way.

## 2. Entry point: `handleTap` (`src/server.ts`)

The route the form posts to. Three jobs, in order:

1. **Identify the browser.** `validateBrowserId` looks the `bid` cookie up
   in the `browsers` table and rejects with 403 if it's missing or unknown.
   A tap must never mint a fresh identity the way a page view does.
2. **Validate the slide.** The body names the deck and slide the viewer's
   own page was showing, not whatever the server thinks is current (ADR 004:
   flicking back to an earlier slide and tapping there is normal).
   `deckFor` drops any deck sent for a created lecture, and `isValidSlide`
   (`src/slides.ts`) checks the slide exists. A bad one is a 400, never
   silently replaced.
3. **Write, then tell everyone.** `tapOncePerSlide` (section 3) is the only
   place the tap is stored. If it inserted a row, `handleTap` calls
   `broadcast(id)` (section 4) and `scheduleFade(id)` (section 7), and logs
   `tap` with the hashed browser ID. If not, it logs `tap_ignored` and
   broadcasts nothing, because nothing changed.

## 3. The write: `tapOncePerSlide` (`src/db.ts`)

One statement: `INSERT ... ON CONFLICT DO NOTHING`, against the unique
index `taps_one_per_slide` on (lecture, run, `COALESCE(deck, '')`, slide,
browser). That's what makes "one 'I'm lost' per browser per slide" hold
when two requests arrive at the same moment: the index decides, not a
SELECT beforehand. `COALESCE` matters because SQLite treats every NULL as
distinct, and a created lecture's taps have no deck. The run is filled in
from the `runs` table in the same statement, so a fresh run (ADR 006) can
take the same slide again. Rows marked `legacy_duplicate` by the one-time
migration are outside the index and never counted.

The database runs in WAL mode with `synchronous=NORMAL`, set at the top of
`src/db.ts`, and startup fails if WAL didn't take. That cut a tap's insert
from about 7.5 ms (a full disk sync per write) to about 0.1 ms, which is
what let 50 taps at once reach everyone within about a second on Fly. The
costs are in ADR 005: a power loss can drop the last moment of taps, and
`meter.db-wal` and `meter.db-shm` sit beside `meter.db` and must be kept
with it.

## 4. Deciding when to send: the throttle (`src/realtime.ts`, `makeThrottle`)

`broadcast` and `broadcastToLecturer` are both built by `makeThrottle`, so
every trigger goes through it: taps, reasons, "I get it now", notes, slide
changes, connects, disconnects and fades. It exists so that a burst of
taps costs a handful of frames, not one per tap per open page.

- **Leading edge.** If nothing went out for this lecture in the last
  `BROADCAST_WINDOW_MS` (50 ms), it sends at once. A single tap in a quiet
  room has no added delay.
- **One trailing send.** Inside a window, it arms one timer for the window's
  end, and every further call in that window does nothing. A burst of 50
  taps inside one window gives two frames per stream; a burst spread over
  two windows gives three (measured, and tested in
  `spec/broadcast.test.ts`).
- **Never out of order.** Each send reads the state fresh when it fires,
  and there's never more than one pending send per lecture, so a stale
  frame can't overtake a newer one.

The student throttle sends to students and then calls the lecturer's
throttle; the lecturer has its own, so its frames are rate-limited
separately.

## 5. What every viewer shares: `computeSharedState` (`src/realtime.ts`)

Called by `sendToStudents` once per deck being watched, not once per
browser, because almost everything in a frame is the same for everyone
watching that deck. It is where the privacy gates live, so a value that
mustn't leave the server is simply never put in the object:

- `present` counts browsers with an open stream (`presentCount`), not tabs.
- `live` and `totalTaps` are only added when `present >= min_present`.
  Below that, the frame has no such keys at all, not zeros (CLAUDE.md:
  hiding it on screen isn't enough).
- `bars` come from `gatedBars`: each slide appears only once at least
  `min_present` distinct browsers have tapped it in this run, whoever is
  present now, so a lone returning visitor still sees history but no bar is
  ever one person. `gatedReasonCounts` gates each (slide, reason) the same
  way, and `topReasonFor` picks only among those that qualified.
- `slide` and, for the demo, `lectureElapsedMs` are ungated: where the
  lecture is says nothing about anyone. The demo's live slide comes from
  that deck's clock in `src/slides.ts`, which starts when the deck's first
  viewer arrives.
- `live` counts distinct browsers with a tap inside the live window.
  `liveWindowMs` (`src/slides.ts`) is 20 s for the condensed demo and 60 s
  for a created lecture.

## 6. What only this browser gets: `yourStateFor` and `meterStateFor` (`src/realtime.ts`)

Run once per browser per send, then merged onto the shared state. These are
the fields a browser may always see, because they're its own:
`yourSlides` (the slides it tapped in this run, each with whether it's still
live, resolved, and whether a reason or "what helped" was sent; flags only,
never the answer text), `yourTapCount`, `youAreCounted`, and `helpUrl`,
which is only present once this browser has said it's lost on
`HELP_AFTER_SLIDES` (3) slides in this run. Because it's worked out here,
the help link only ever reaches that one browser's own frame: never the
shared state, the lecturer, a log line or a count.

`sendToStudents` then writes one `data:` line per (browser, deck) to every
open stream for that browser, building the JSON once per pair, not per tab.

## 7. Updates nothing else triggers: fade and slide timers (`src/realtime.ts`)

A tap stops being live with no request to announce it, and the demo's slide
moves on with nobody clicking. Without these timers, open pages would only
catch up the next time something else happened.

- `scheduleFade` arms one timer per lecture for the moment the earliest
  live tap leaves its window, broadcasts then, and re-arms for the next.
- `scheduleSlideAdvance` arms one timer per running demo deck clock for
  the next slide change. It's started when a
  deck's first viewer connects (`addConnection`) and cleared, with the
  clock, when its last viewer leaves (`removeConnection`).

Both only push. The values are always computed from the database and the
clock, so a lost timer (a restart, say) never makes a value wrong, only
late (`docs/state.md`).

## 8. The stream: `handleEvents` (`src/server.ts`)

`GET /l/:id/events` is a server-sent event stream. It checks the browser
cookie (403 without one), registers the connection with `addConnection`
under the deck it's watching (`?deck=` for the demo), and then:

- `sendInitialState` writes this stream its own first frame at once, so a
  new page never waits for a throttle window to show anything;
- `broadcast(id)` tells everyone else that one more person is here.

When the browser goes away, `removeConnection` and another `broadcast`
update everyone's people count. A lecturer's browser connecting here counts
as a student, on purpose: lecturer state has its own route (section 10).

## 9. The page catching up: `render(state)` (`src/server.ts`, student page script)

`source.onmessage` parses each frame and calls `render(state)`. It's for
turning the server's state into the page without the page deciding
anything itself:

- the live slide, the "Live" marker and "Back to live", and the lecture
  clock (`syncLectureClock`), ignoring a frame about a deck the page has
  switched away from;
- `renderGauge`, shared with the lecturer page, which only touches the
  aria-live node when the lost count changes or the gauge appears or
  disappears, so people arriving don't get announced;
- the bars and the timeline shading (`renderBars`, `markTimeline`), straight
  from the gated `bars`;
- this browser's own controls (`updateTapControls`): "You've said you're
  lost on this slide.", the locked reasons and "what helped", and the help
  offer (`renderHelpOffer`).

`source.onerror` shows "Reconnecting..." until the next frame clears it.
The browser's EventSource reconnects by itself, and the new stream gets its
own first frame (section 8).

## 10. The lecturer's copy (`handleLecturerEvents`, `sendToLecturers`)

The lecturer's page uses its own route, `/l/:id/lecturer/events`, behind
the lecturer session, so lecturer state never travels on a student stream.
`computeLecturerState` applies the same gates and adds what only the
lecturer sees: the gated reason and "what helped" counts, notes (each
slide's only once enough people have written one), and the activity log
(`src/activity.ts`, one line per `min_present` more people, never one
person). It sends through its own throttle, `broadcastToLecturer`. Nothing
per browser is in it, and never the help link.

## Where to start a change

- What the gauge says: `gaugeWords` and `lostText` in `src/server.ts`, and
  their browser copy in `GAUGE_CLIENT_JS`. Change both.
- How often pages update: `BROADCAST_WINDOW_MS` in `src/realtime.ts`.
- How long a tap counts: `liveWindowMs` in `src/slides.ts`.
- Who may see a number: the gate functions in `src/realtime.ts`, and
  CLAUDE.md's Privacy rules first.
