# Walkthrough: how a tap reaches every open page

A linear read of `src/server.ts` and `src/realtime.ts`, in the order needed
to change how a tap reaches every open page — entry point first. Each
section says what that part is *for*; the code itself already says what it
does line by line.

## 1. Entry point: `handleTap` (`src/server.ts`)

The route a browser's "I'm lost" form actually posts to. Three jobs, in
order:

1. **Identify the browser.** `validateBrowserId` looks the cookie up against
   the `browsers` table and rejects (403) if it's missing or unknown — a tap
   must never silently mint a fresh identity the way a page *view* does.
2. **Validate the slide.** The POST body names a `deck` and `slide` — the
   slide the viewer's own page was showing when they tapped, not whatever
   the server currently thinks is "current" (ADR 004's amendment: browsing
   to an earlier slide and tapping there is normal, not a race to reconcile
   against). `isValidSlide` (`src/slides.ts`) checks it's a real index for
   that lecture's deck; an invalid one is rejected (400), not silently
   substituted.
3. **Try to insert, then tell the world.** `tapIfNotRecentlyTapped`
   (`src/db.ts`) is the one place the actual write happens — everything
   above this point is validation, everything after is notification.

## 2. The write: `tapIfNotRecentlyTapped` (`src/db.ts`)

A single atomic `INSERT ... WHERE NOT EXISTS (...)` statement, not a
separate SELECT-then-INSERT — this is what makes "one live tap per browser"
actually hold under concurrent requests, the same discipline `stepCurrentSlide`
later uses for the Previous/Next race. The `WHERE NOT EXISTS` clause also
excludes resolved taps (`resolved_at IS NULL`), so "I get it now" can't
leave a phantom block on a fresh re-tap in the same 60-second window — this
is the fix for a regression that would otherwise have shipped silently (see
`spec/reasons.test.ts`'s "after I get it now" test).

Returns whether a row was actually inserted. If not — the browser already
has a live tap on this lecture — `handleTap` logs `tap_ignored` and stops
there: no broadcast, because nothing changed.

## 3. Telling every open page: `broadcast` / `broadcastToLecturer` (`src/realtime.ts`)

If the insert succeeded, `handleTap` calls `broadcast(id)` and
`scheduleFade(id)` (more on the latter in §6). `broadcast` is the fan-out
point — every other route that changes shared state (`handleReason`,
`handleResolve`, `handleNote`, `handleSlideChange`, stream open/close) also
ends by calling `broadcast` or `broadcastToLecturer`.

`broadcast`'s shape matters: it computes the **shared** state once per call
(`computeSharedState`), then loops over every connected browser for this
lecture and merges each one's own fields onto that shared base
(`meterStateFor`). This replaced a full per-browser recompute — the
`getLecture`/`presentCount`/`shown`/`bars`/etc. queries used to run once per
*connection*, not once per *broadcast*, which is wasteful at any real
audience size. If you're changing what gets broadcast, the shared/per-browser
split is the first thing to understand: shared fields go in
`computeSharedState`, genuinely per-recipient fields (only
`yourTapCount`/`youAreCounted`/`liveForMs` today) go in `meterStateFor`.

`broadcastToLecturer` is the lecturer-side equivalent, simpler because
there's no per-browser merge — every lecturer viewing the same lecture sees
identical state (`computeLecturerState`).

## 4. Deciding what's actually in the payload: the gate functions (`src/realtime.ts`)

Three functions decide what a given lecture's broadcast actually contains,
and each follows the same two-step shape: compute raw counts in `db.ts`,
then filter by `min_present` here. If you're adding a new piece of
per-slide data that needs the same privacy treatment, copy one of these,
don't invent a new pattern:

- **`gatedBars`** — distinct browsers per `(deck, slide)`, filtered to
  `>= min_present`. A slide below threshold is simply absent from the
  array, not zeroed — "safety in numbers" means a tap below threshold
  leaves no trace anywhere a request can see, not that the number shown is 0.
- **`gatedReasonCounts`** — same shape, one level more specific: gated per
  `(deck, slide, reason)` triple, *not* inherited from the slide's own bar
  gate. A slide can clear its bar threshold while one specific reason among
  its tappers was picked by only one or two people; surfacing that would be
  exactly the one-person signal the bar gate exists to prevent.
- **`gatedNotes`** — same two-step shape as bars (`slideNoteCounts` decides
  which `(deck, slide)` pairs qualify; only for those does
  `visibleNotesForSlide` get called at all), but lecturer-only: it is never
  called when building `MeterState`, so student state has no path by which
  note text could leak — not filtered out, never computed for that code
  path in the first place.

`topReasonFor` is a small helper layered on top of `gatedReasonCounts`,
picking the current slide's highest count among entries that already
cleared the gate — it can never surface an under-threshold reason, because
it only ever looks at the already-filtered list.

## 5. Reaching the connection: the student/lecturer connection registries (`src/realtime.ts`)

`connections` (`Map<lectureId, Map<browserId, Set<ServerResponse>>>`) and
`lecturerConnections` (`Map<lectureId, Set<ServerResponse>>>`) are the two
places an open SSE connection actually lives, entirely in memory (see
`docs/state.md` for what that costs on a restart). The nesting in
`connections` is what makes "present" count distinct browsers rather than
open tabs or connections — `presentCount` is just `byBrowser.size`.

`addConnection`/`removeConnection` and `addLecturerConnection`/
`removeLecturerConnection` are called from `handleEvents`/
`handleLecturerEvents` (back in `server.ts`) on stream open/close — those
are the two places a `ServerResponse` enters or leaves these maps, which is
also where a `broadcast` gets triggered so a newly-connected browser's
first frame, and everyone else's updated `present`, land immediately.

## 6. Pushing an update with nothing new to trigger it: the fade and slide timers (`src/realtime.ts`)

Two timers exist because two kinds of state change *without* a new request
ever arriving: a tap aging out of the 60-second live window, and the demo's
slide advancing on its own shared clock. Both follow the same shape —
`scheduleFade`/`scheduleSlideAdvance` arm a single `setTimeout` per lecture
for exactly when the next change will happen, and when it fires: broadcast,
then re-arm for the *next* change. Neither keeps the process alive
(`.unref()`), and both recompute their delay from the database rather than
from any state the timer itself is tracking, so a timer lost on restart is
simply re-armed correctly the next time anything touches that lecture.

If you're adding a new kind of state that can change without a request —
the pattern here is the one to copy, not a new polling loop.

## 7. The client side: `render(state)` in each page's inline script (`src/server.ts`)

Every SSE payload lands in one of two `render(state)` functions — one
inlined into `handleLecture`'s student page, one into `lecturerDashboard`'s
lecturer page. Both do the same kind of thing: update the gauge
(`gauge-present` plain, `gauge-lost` aria-live — see the aria-live
discipline note in `server.ts`), then call a handful of smaller
`render*`/`attach*` functions for each gated section (`renderBars`,
`renderReasonCounts`, `renderNotes`, `renderReasonsAndNote`). Each of those
follows the same create-or-remove-the-DOM-node discipline the gate
functions above imply: a section with nothing to show removes its element
entirely, it doesn't hide it — the same "no trace left anywhere a request
can see" rule that governs the payload also governs what ends up in the
DOM.

This is the last stop: from here, what the payload contains (§4) is what a
real person sees.
