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

## Lecturer dashboard and after the hand checks

Start a NEW subagent, separate from the Phase 5 UI agent that's still running. Don't
touch that agent's branch or worktree.
- New git worktree, branch lecture-features off the current main.
- PORT=8083, APP_URL=http://localhost:8083, DATA_DIR=/tmp/meter-c.
- Styling is the UI agent's job. Add class names and markup only; don't restyle
  pages or edit its stylesheet. Once its branch merges, use its tokens.
- No new dependencies and no CI changes. If you need one, stop and tell me.
- When both are done: merge the UI branch first, rebase lecture-features onto main,
  resolve conflicts, run pnpm check twice, and show me the merged diff before merging.
  Ask before any push or deploy.

First, save this message word for word to docs/prompts/finish.md under
"## Lecturer dashboard and after the hand checks" (its own commit). Then add an
ADR 004 amendment covering the timeline, one tap per slide, the dashboard, and the
rejected per-student log and email, with options and costs (its own commit).
Show me the plan, then wait for go.

0. Diagnose first
   The lecturer view on /l/demo/lecturer showed only "Slide 6", "2 people here,
   0 lost right now" and the total, with no reasons or notes. Reproduce it with two
   browsers tapping the same slide, choosing the same reason, and each writing a
   note. Paste the actual lecturer stream payload. Tell me whether the threshold hid
   them or it's a bug. If it's a bug, commit a failing test first.

1. Lecturer dashboard (aggregates only, never per student)
   - Current slide first: the live gauge, its reasons, its notes, readable on a projector.
   - Summary tiles: people here, lost right now, distinct browsers lost this lecture,
     the share of lost taps resolved with "I get it now", and the hardest slide.
   - Bars per slide with reasons stacked inside, and "what helped" per slide.
   - Notes feed grouped by slide, newest first, filterable by deck and slide. Each note
     has a Hide button. No student labels, numbers or grouping by student anywhere.
   - Every empty or hidden part says why, e.g. "Shows once 2 people have chosen a
     reason on this slide", using the lecture's real threshold.
   - Server-rendered SVG, no chart library. Text alternatives for every chart.
     Works without JS, updates live.

2. A help link the student chooses to use
   - /new gets an optional "Where students can get help" link (https only, max 300
     characters). The lecturer can edit it from the lecturer view (session checked).
     The demo uses the course page:
     https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/
   - Once a browser has said it's lost on 3 or more slides in a lecture, that browser
     alone sees "Want a hand with this? Your lecturer offers help here." with the link.
   - This is worked out for that browser only. Never send it to the lecturer, never
     log who saw it, never count it.

3. Reasons grey out
   - The chosen reason shows as selected (aria-pressed="true"). The others dim but
     stay clickable so the answer can be changed while the tap is live. Contrast still
     passes axe.

4. Lecture timeline (stranger test: it didn't look like a live lecture)
   - Under the slide: a horizontal timeline like a video scrubber, one segment per
     slide labelled with its start time (0:00, 0:40, ...), and "Lecture time 3:20 / 6:00".
   - A "Live" marker that moves in real time, and a "You" marker when browsing away.
     Clicking a segment browses to that slide for this browser only.
   - Segments shaded by distinct browsers lost there, with exactly the bars' threshold.
     Below it, unshaded, not zero.
   - /new lectures: a segment per slide reached so far, with the time the lecturer
     moved to it, and no total length.
   - Works without JS (segments are links), keyboard reachable, text alternative,
     no horizontal scroll at 390x844, no animation with prefers-reduced-motion.

5. Lecturer view link
   - A small "Lecturer view" link on every lecture page. On the demo only, show
     "Code: DEMO" next to it.

6. After "I get it now"
   - Show "Glad it clicked. You're no longer counted as lost." and hide the reasons.
   - Then ask "What helped it click?" with a fixed list, checked on the server:
     The next slide, Re-reading it, The example, Worked it out myself.
   - Stored on the resolved tap. The lecturer sees counts per slide, gated per
     (slide, answer) like reasons. Never in a student payload.

7. One "I'm lost" per browser per slide (mock lecture: stop spam)
   - One tap per (lecture, deck, slide) per browser, ever, in the same single SQL
     statement as now. Still live for 60 seconds or until "I get it now".
   - Replace the countdown with "You've said you're lost on this slide."
   - Update the README-enforced test and the CLAUDE.md "one browser, one voice"
     wording to match, as its own commit.

Tests: no dashboard payload ever contains a browser ID, hash or per-student grouping;
each empty state shows its threshold message; the help link only reaches a browser
lost on 3+ slides and never the lecturer stream or the logs; an unknown "what helped"
answer is rejected; timeline shading respects the threshold; clicking a segment doesn't
move anyone else; a second tap on the same slide is ignored, a tap on another slide
counts, and two parallel taps on one slide count once. Playwright once the UI branch
has merged: the dashboard and timeline at both viewports, keyboard only, no overflow.
Commit in small steps with messages saying why.

## Colour and layout

Start a NEW subagent in its own git worktree, branch colour-and-layout off the
current main. PORT=8084, APP_URL=http://localhost:8084, DATA_DIR=/tmp/meter-d.
The lecture-features agent is working separately. Don't touch its branch. You own
/style.css, the page header, the home page and the lecturer page layout shell. It
owns behaviour and the SVG graph markup. No new dependencies.
Save this message word for word to docs/prompts/finish.md under
"## Colour and layout" (its own commit). Take screenshots into
docs/screenshots/before-colour/ at 390x844 and 1920x1080 before changing anything.

The UI is too plain and has no colour. Make it calm but engaging. Being lost is
normal, so never use red or alarm colours for it.

1. Design tokens in /style.css, with exactly these names (the other agent uses them):
   Light:
   --paper #F6F1E7   --surface #FFFDF8   --ink #1E2733   --ink-muted #5A6370
   --line #E2DACB    --accent #2F6F5E (eucalypt: links, focus, Live marker)
   --lost #6A4BB5 (violet: the I'm lost button, gauge, lost bars)
   --clicked #C98A12 (wattle: "I get it now" and what helped)
   --sky #3B78B5     --on-colour #FFFFFF
   Dark (prefers-color-scheme):
   --paper #12171E   --surface #1B222C   --ink #ECE7DC   --ink-muted #A7AFBA
   --line #2C3542    --accent #6CC3A6    --lost #A68DF0   --clicked #E9B949
   --sky #7FB2E5     --on-colour #12171E
   Categorical order for graphs: --lost, --accent, --clicked, --sky.
   Check contrast with axe: 4.5:1 for text, 3:1 for graph marks and borders. If a value
   fails, adjust its lightness only, and tell me what changed.
   Colour is never the only signal: every bar and segment also has a label.

2. Feel:
   - Cards on --surface over --paper, radius 14px, a 1px --line border and a very soft
     shadow. Spacing on an 8px grid.
   - System font stack. Headings weight 650. Numbers use tabular-nums.
   - The I'm lost button: a full-width violet pill, at least 56px tall, white text,
     sticky at the bottom on phones.
   - The gauge: a thick rounded track in --line with a --lost fill, and the words beside it.
   - Slide card: large readable text, a small chip "Week 4 · slide 3 of 9", and a
     "LIVE" pill in --accent when on the live slide.
   - Transitions under 150ms, none with prefers-reduced-motion.

3. Header and home on every page:
   - A header with the app name (links home) and nav: Home, Join the demo,
     Lecturer view, Create a lecture, How it works (/readme/). Keyboard reachable,
     collapses neatly at 390px.
   - Home page: three cards: "I'm a student" (join the demo), "I'm a lecturer"
     (the demo lecturer view with code DEMO, or create your own), and
     "How it works" (/readme/). One short line on each.

4. Lecturer layout (it's currently far too zoomed in):
   - Normal type size by default, max width about 1200px.
   - A row of stat tiles at the top. Below it, a 2x2 grid of empty graph slots with ids
     graph-lost, graph-reasons, graph-helped, graph-resolved. A right column for the live
     slide and notes. A full-width activity log section (id activity-log) at the bottom.
     Stacks to one column at 390px.
   - A "Projector mode" link (?projector=1, works without JS) that scales type 1.5x.

Keep every existing test green, and add Playwright checks: no overflow at either
viewport, the header nav reachable by keyboard, axe passing in light and dark.
Then take screenshots into docs/screenshots/after-colour/. Commit in small steps.

## Lecture features, round 2

After one tap per slide, these replace the rest of your plan where they overlap
(timeline, dashboard, after "I get it now"). Save this message word for word to
docs/prompts/finish.md under "## Lecture features, round 2" (its own commit). Write
docs/adr/006-runs-timing-and-your-own-lecture.md covering items 1, 2, 5 and 6 with
options and costs (its own commit), and add the CLAUDE.md rules listed at the end
(its own commit). Show me the plan, then wait for go.

The colour-and-layout agent owns /style.css and the page shell. Use its tokens
(--lost, --accent, --clicked, --sky, --ink, --ink-muted, --line, --surface) through
CSS classes, and fill its slots graph-lost, graph-reasons, graph-helped,
graph-resolved and activity-log. Don't restyle pages. No chart library, no new
dependencies.

1. Condensed demo timing
   - Each demo deck runs about 5 minutes in total, standing in for a 60-minute lecture
     condensed 12x. Give each slide a duration in seconds in the deck file, weighted by
     how much it covers (dense slides longer), summing to about 300.
   - Show "Lecture time 1:20 / 5:00" and, beside it, "Condensed 12x from a 60-minute
     lecture (real time 16:00)".
   - Timeline segments are sized by duration and labelled with their start time.
   - The live window for demo taps is 20 seconds. /new lectures keep 60. Tests cover both,
     and the README-enforced fade test must still run in full.

2. Reasons and "what helped" lock once sent
   - Choosing a reason marks it selected (aria-pressed) and dims the rest. Once sent,
     every reason button for that slide is disabled until you're on another slide.
     The server rejects a second reason for the same (browser, deck, slide).
   - After "I get it now": show "Glad you've got it now." and ask "What helped your
     understanding?" with a fixed list: The next slide, Re-reading it, The example,
     Someone explained it, Worked it out myself. It locks once sent, the same way.
   - Change the old test that let a reason be changed into one that checks it locks.

3. Lecturer dashboard (aggregates only, every number gated as CLAUDE.md says)
   - Stat tiles: people here, lost right now, distinct people lost this run, share
     who said "I get it now", hardest slide.
   - Four SVG graphs, each with a table alternative and its threshold message when empty:
     graph-lost: distinct people lost per slide.
     graph-reasons: why they were lost, stacked per slide.
     graph-helped: what helped, per slide.
     graph-resolved: still lost against "I get it now" per slide.
   - Notes grouped by slide, filterable by deck and slide, each with Hide.

4. Activity log (never per action)
   - A live, filterable (deck, slide) log. A line is added only when a slide's count
     crosses a new multiple of min_present, e.g. "Week 4, slide 5: 3 more people lost,
     mostly Missed a step", "2 new notes on slide 5", "4 people said what helped on
     slide 5". No times finer than the slide, no student labels.
   - Worked out from stored data, so it survives restarts. Students never see it.

5. Reset as a fresh run, never a delete
   - A lecturer-only "Start a fresh run" button with a confirmation page. It creates a
     new run. Taps, reasons, what helped and notes carry a run id, and everything live
     uses the current run. Earlier runs stay viewable read-only in the dashboard
     through a run picker.
   - The demo can't be reset (403, with a message on the page: "The shared demo keeps
     its history. Create your own lecture to try a fresh run.").
   - The UNIQUE index for one tap per slide includes the run id. The migration is safe
     on existing rows (put them all in run 1).
   - Log run_started. Tests: reset deletes no rows; the old run is still viewable;
     a browser can tap the same slide again in a new run; resetting the demo is rejected.

6. Create a lecture that explains itself
   - /new opens with: "Run this beside your own slides. Students tap on the slide you're
     on, and you see where the room got lost."
   - Fields: title; number of slides (1 to 60); pacing, either "I'll press Next" or
     "Timed" with total minutes (5 to 180) split evenly unless per-slide minutes are
     given; optional slide text pasted as markdown separated by --- (max 50 KB); the
     optional help link.
   - Pasted slides: raw HTML is escaped, images are not rendered, links render as links.
     Nothing loads from another site. If pasted slides are given, their count wins.
   - Timed lectures start when the lecturer presses "Start lecture", not when the first
     student arrives.
   - Tests: a <script> in pasted slides comes back escaped; an image line loads nothing;
     the slide count and timing limits reject; a timed lecture moves slides on its clock.

7. Home link on every page (if the colour agent's header isn't merged yet, keep a plain
   "Home" link and remove it once the header lands).

CLAUDE.md rules to add:
- "Reset never deletes. It starts a new run, and earlier runs stay viewable. The demo
  can't be reset. (ADR 006: the demo's code is public, and markers check persistence.)"
- "Every activity log line covers at least min_present actions. Never log or show a
  single student's action to the lecturer. (ADR 006.)"
- "Lecturer-supplied slide text is escaped. No raw HTML, no images, nothing loaded
  from elsewhere."
When both branches are done: merge whichever finishes first, rebase the other, run
pnpm check twice, and show me the merged diff before merging. Commit in small steps.
Ask before pushing or deploying.
