# Finishing stage prompt (Claude Code)

Read CLAUDE.md, README.md, all of docs/adr/ (especially 004), docs/feedback/c10.md,
and the current src/ and spec/ before planning.

This is the finishing stage of the final project. It answers the C10 feedback with
the design in ADR 004 and fixes the other review findings. The README's one idea,
"you can admit you're lost without being the one who admitted it", decides every
trade-off. Work in the phases below. After each phase: run pnpm check twice, commit
in small steps with messages saying why, then STOP and show me a short summary and
what I should try by hand. Don't start the next phase until I say go.
Ask before adding any dependency, deploying, pushing or tagging.

PHASE 0 - harness first
- Save this prompt word for word to docs/prompts/finish.md (its own commit).
- Add to CLAUDE.md, as its own commit:
  - Privacy: live numbers (live, total, reasons) only leave the server when present >=
    min_present. A history bar for a slide is only sent once >= min_present distinct
    browsers have tapped on that slide. A browser may always see its own counts.
    (Refined in ADR 004 so a returning visitor still sees history.)
  - Never add free-text input for students. Reasons come from a fixed list checked
    on the server.
  - Never load anything from a third party (embeds, fonts, analytics, CDNs).
  - Every page must work without JavaScript.

PHASE 1 - a lecture to be lost in
- Slides as data: slides/demo.md, slides separated by a line with ---, rendered on the
  server with marked. Draft an 8-slide, first-year mini-lecture on recursion. Make
  slide 5 deliberately rushed (two steps skipped) so there's somewhere to get lost.
  Diagrams as inline SVG with text alternatives. No images from outside the repo.
- Shared clock for the demo: each slide shows for 40 seconds, looping. The current
  slide is worked out on the server from the time, so every visitor sees the same
  slide with no stored state. Send the slide index in the stream and push on change.
- Real lectures (/new): no slide content. lectures.current_slide (default 1). The
  lecturer view gets Previous and Next buttons (server-checked, lecturer session only)
  that broadcast the change. Students see "Slide N".
- Migration: taps.slide (nullable for old rows; treat old rows as slide 1). Each tap
  records the current slide.
- Tests: two streams see the same slide index; a slide change reaches open streams
  within a second; only a lecturer session can change slides.

PHASE 2 - where the room got lost
- Bars per slide, counting distinct browsers who tapped on that slide, shown to
  students and the lecturer. Server-rendered SVG so it works without JS, updated
  live, with a text table alternative for screen readers.
- Apply the refined privacy rule from Phase 0 exactly, on the server.
- Remove the per-minute timeline and its code.
- Tests: tap, undo, tap again on one slide counts once; a slide with fewer than
  min_present distinct browsers sends no bar; a returning browser with nobody else
  present still gets bars for slides that qualify, and its own count; none of this
  data appears in any payload below the thresholds.

PHASE 3 - your own tap
- After "I'm lost", show optional one-tap reasons: Too fast, Missed a step, Notation,
  Can't see or hear. A reason attaches to your live tap and can be changed while it's
  live. The server rejects anything not on the list.
- The lecturer sees reason counts per slide (same thresholds). Students see the
  current slide's most common reason once it qualifies.
- Countdown: "You're counted. You can tap again in 0:42", from a liveUntil time the
  server sends for your own tap only. Without JS, show the time it unlocks.
- "I get it now": ends your live tap at once (taps.resolved_at), so live drops within
  a second. Bars still count you, because you were lost on that slide.
- Small hint under the button: "Other tabs in this browser count as you."
- Tests: unknown reason rejected; reason change updates the lecturer within a second;
  "I get it now" drops live by one within a second; liveUntil is only in your own payload.

PHASE 4 - review findings
- aria-live: announce only when the lost count changes or the gauge appears or
  disappears. People arriving and leaving update visually, not out loud.
- Show "Reconnecting..." when the stream drops (EventSource error) and clear it on
  the next message.
- Lecturer code rate limit per browser and lecture, not per lecture. Lecturer sessions
  expire after 12 hours.
- /new: max 3 lectures per browser per hour, a hard cap of 500 lectures in total,
  title max 100 characters. Each limit gives a clear message.
- Performance: compute the shared state once per broadcast, then add each browser's
  own fields, not a full recompute per browser.
- Load test: scripts/load-test.ts (pnpm load, not part of pnpm check) that mints 50
  browsers, opens 50 streams, taps from all 50 at once, and reports how long until
  every stream has seen all 50. Run it locally and report the numbers.
- Tests for each limit, and that people arriving doesn't change the aria-live text.

PHASE 5 - accessibility and hardening
- Propose two ways to add automated accessibility checks: axe-core run in jsdom
  (light, but can't check colour contrast or layout), or Playwright with axe in
  Chromium (heavier, needs a CI step, but can also test keyboard use and both
  viewports, 390x844 and 1920x1080). Give me the cost of each and wait for my choice.
- Then make sure: visible focus on every control, everything reachable by keyboard,
  nothing breaks when the window is resized mid-tap, and no horizontal scroll at 390x844.

Not in scope: accounts, names, free text, editing or deleting lectures, anything third-party.
Show me the plan for all phases first.

## Amendment: from the lectures

Add these to the plan for Phases 4 and 5, from the course lectures. Append this
message word for word to docs/prompts/finish.md under "## Amendment: from the
lectures" (its own commit). Then carry on with the current phase.

Show your work (Week 5)
- Never report "it works" without the artefact. For every hand check you claim,
  paste the response body, status code, console output or a screenshot.
- Every Playwright test also fails if the browser console logs any error or
  failed request on any page. A page can look fine and throw anyway.

Two people at once (Week 10)
- Add a test where two browsers act on the same thing at the same moment:
  the lecturer hides a note while its author replaces it, and two lecturers
  press Next at once. Decide what should win, say why in the commit message,
  and test it.
- Log every server error with enough context to reproduce it (route, lecture,
  hashed who, error message), never request bodies or note text.

What survives a restart (Week 7)
- List every piece of in-memory state (open streams, rate limits, the /new limit,
  fade timers) and what happens to it on a restart or redeploy. Write the list to
  docs/state.md. Anything a user would notice losing goes in the database instead,
  or into the list as an accepted cost.

Owning the code (Week 12)
- At the end of Phase 4, do a deduplication pass with the tests underneath. For
  example, browser-cookie minting is repeated in handleLecture, handleLecturerGet
  and handleLecturerPost. Behaviour must not change, and pnpm check must pass
  before and after. Its own commit.
- Then write docs/walkthrough.md: a linear walkthrough of src/realtime.ts and
  src/server.ts in the order I'd need to read them to change how a tap reaches
  every open page. Entry point first, and what each part is there for.

Harness hygiene (Weeks 4 and 6)
- CLAUDE.md must stay under 200 lines. At the end of Phase 5, remove anything
  stale or superseded, and merge duplicate rules. Keep every bracketed reason.
  Show me the diff before committing.
- Every commit message says why, not just what.

The README's second job (Week 12)
- /readme/ is also the usage guide, because markers start there with only the URL.
  At the end of Phase 5, check that every step in "Try it" works exactly as written
  in two fresh Chrome profiles, and tell me which steps needed changes.

Ask before any dependency, CI change, deploy, push or tag.

## Slide 1 on entry

Right now the demo decks land on slide 5 or 7, because the shared clock runs from
the lecture's created_at. Change it so a deck starts at slide 1 when the first
person arrives:
- Keep a start time per (lecture, deck). When a stream opens on a deck nobody else
  is watching, set the start time to now, so that viewer is on slide 1.
- A page render for a deck nobody is watching shows slide 1.
- Anyone joining while someone else is watching gets the current live slide, the
  same as everyone already there.
- When the last viewer leaves, the next arrival starts again at slide 1. That
  includes refreshing while alone.
- Lecturer viewers don't count as watching. /new lectures are unchanged (the
  lecturer drives them).
- The start time can live in memory. A restart means nobody is watching, so slide 1
  is right. Add it to docs/state.md.
- Tests: the first viewer of an empty deck gets slide 1; a second viewer who joins
  later gets the same slide as the first; after every viewer closes, the next one
  gets slide 1; watching one deck doesn't restart the other.
Add a line to the ADR 004 amendment: the shared clock now starts when the first
person arrives, so a visitor never lands mid-lecture in an empty room.
Commit in small steps. Ask before pushing or deploying.

## Phase 5, completed

Phase 5 isn't finished. The HD bar for the artefact is "holds up under use it wasn't
designed for: the keyboard, a resize mid-interaction, a slow connection", and the
README claims "it's calm", which only the look of the page can show. jsdom can't
check contrast, layout, keyboard flow or throttling. Save this message word for word
to docs/prompts/finish.md under "## Phase 5, completed" (its own commit).

1. Ask me before adding Playwright as a dev dependency. Keep axe-core, and run axe
   through Playwright in Chromium too so contrast is checked. Add a CI step that
   installs Chromium. Keep every shipped CI step as it is, and show me the workflow
   diff before committing.

2. BEFORE changing any styles, take screenshots of /l/demo and the lecturer view
   (logged in with DEMO) at 390x844 and 1920x1080 into docs/screenshots/before/.
   Its own commit.

3. Playwright tests, at both viewports, against /, /readme/, /l/demo,
   /l/demo/lecturer, /new and the 404 page:
   - axe finds no violations, contrast included
   - no horizontal scroll (scrollWidth <= clientWidth)
   - the console logs no errors and no failed requests
   - every request goes to the page's own origin (no third parties)
   - keyboard only: Tab to "I'm lost", Enter, pick a reason, write and send a note,
     "I get it now", arrow keys to change slide, "Back to live". Focus is always
     visible and never lost after a live update
   - resize mid-tap: tap at 1920x1080, resize to 390x844 while "Sending..." shows,
     the tap still counts and nothing overflows
   - Slow 4G (CDP throttling): "Sending..." appears within 100 ms and the tap counts
   - two browser contexts: a tap in one appears in the other within a second

4. A calm UI:
   - One stylesheet at /style.css with design tokens as CSS custom properties
     (colours, spacing, type scale). No inline styles left.
   - System font stack, no web fonts. Fluid type with clamp(), body at least 1rem,
     lines about 65ch at most.
   - A muted palette with one accent. No red or warning colours for "lost": being
     lost is normal, not an alarm. Contrast at least 4.5:1.
   - Light and dark themes with prefers-color-scheme.
   - Only short transitions, none with prefers-reduced-motion. Numbers change in
     place, no flashing or counting up.
   - Phone: the slide on top, "I'm lost" in a sticky bar at the bottom within thumb
     reach, at least 48px tall. Reasons and the note open below it after a tap.
   - Desktop: the slide on the left at about two thirds of the width, with the
     gauge, your own tap and the bars on the right.
   - The gauge as a quiet horizontal bar with words beside it, like
     "4 of 23 people are lost right now".
   - A clear marker: "Live", or "You're on slide 3. The lecture is on slide 6."
   - Lecturer view readable on a projector: large type, the current slide's bar
     and notes first.
   - /readme/, /new and the 404 page use the same styles.

5. Take the same screenshots into docs/screenshots/after/. Its own commit.

6. Run pnpm load locally and report min, median and max time for every stream to
   see live reach 50, plus peak memory. Then ask me before running it once against
   the deployed app, and report the same numbers. Put both runs in the commit message.

Commit in small steps with messages saying why. Ask before any dependency, CI change,
deploy, push or tag.
