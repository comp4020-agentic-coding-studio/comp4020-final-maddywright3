# Hands Down: consistency audit (main @ 0bc55cd)

Read-only. Nothing in the repo was changed, no test was run, and neither the live site nor Fly was touched. Every verdict below comes from reading the code and specs at 0bc55cd. Whether the tests currently pass was not checked.

**pnpm check scope.** `pnpm typecheck && pnpm test`. vitest.config.ts includes `spec/**/*.test.ts` with `fileParallelism: false`. A grep of spec/ for `.skip`, `.todo`, `.only`, `skipIf`, `runIf`, `xit`, `.fails` and `ctx.skip` found nothing. The only `.each` uses are `describe.each`/`it.each` in spec/browser.test.ts (parametrised tests, not skips). No test sits behind an environment-variable condition: the only `process.env` read in spec/ is `APP_URL` in global-setup.ts. **No test named below is skipped.**

---

## 1. README claims and their tests

### 1a. "What's enforced and what's judged" table (README.md:32-40)

| # | Claim (word for word) | README says it's held by | Tests that actually check it | Verdict |
|---|---|---|---|---|
| 1 | "No tap data below the threshold" | "spec/ test on the data" (status "live") | spec/identity.test.ts `it("below min_present, no tap data (live count, total, or timeline) leaves the server")`; spec/slides.test.ts `it("no gated field (live, total, or any bar below its own threshold) appears below the thresholds")`, `it("a slide below min_present distinct browsers sends no bar for it")`; spec/notes.test.ts `it("a note on a slide below min_present distinct browsers never appears in any lecturer payload")`; spec/dashboard.test.ts `it("the share tile and the hardest slide are absent below the threshold, in the payload and the HTML")` | **WRONG.** The tests check `live`, `totalTaps`, bars, notes and dashboard tiles. None of them checks `activityLog`. `computeLecturerState` (src/realtime.ts:441) puts `activityLog` on the `shown:false` branch, and `activityLog()` (src/activity.ts:86-140) emits one line for every press, with no min_present gate. spec/activity.test.ts `it("one tap gives one line, Person 1, with an AEST time in a <time datetime>")` asserts this on a created lecture with one browser (min_present 5). Below the threshold, then, each tap does reach the lecturer, as "Person N said they're lost on Slide S" with a time to the second. The identity test above even fetches the lecturer page after its single tap and only asserts that there is no `Total taps: \d+` and no `<table class="bars"`, so it passes while the activity line is on the page. |
| 2 | "A tap reaches every page within a second" | spec/events.test.ts | spec/events.test.ts `it("a tap shows up on an open /events stream within 1 second")` (waitFor 1000 ms); spec/browser.test.ts `it("two people: a tap in one browser reaches the other within a second")` (poll timeout 1000 ms, both viewports) | **PARTLY.** Held for student pages and streams. For a *tap*, the lecturer page/stream has no 1 s bound. spec/activity.test.ts `it("the lecturer page and stream carry the log live; …")` allows 3 s (frameFrom deadline), and spec/dashboard.test.ts `it("the dashboard updates live: …")` has no explicit bound. spec/reasons.test.ts `it("a reason change is visible in the lecturer's stream within a second")` is about a reason, not a tap, and its waitFor is 2000 ms. |
| 3 | "A tap fades after 60 seconds, or 20 in the demo" | "test, run in full" | spec/events.test.ts `it("a demo tap fades out of \`live\` 20 seconds after it was made")` (asserts 19,000-25,000 ms); `it("a created lecture's tap fades out of \`live\` 60 seconds after it was made")` (59,000-65,000 ms); `it("once a tap's window has ended, no frame still counts it as live")`; spec/fade-timer.test.ts `it("the fade timer fires only once the tap it waits for no longer counts as live")`, `it("a timer for a tap already past its window fires at once, never waits")` | **HELD.** All of these run in full, with real waits and no skip. |
| 4 | "One \"I'm lost\" per browser per slide; tabs count once" | spec/identity.test.ts | spec/identity.test.ts `it("a second tap on the same slide from the same browser is ignored, however much later")`, `it("a tap on another slide, or the same slide number in the other deck, counts exactly once more")`, `it("a created lecture (no deck) also takes one tap per browser per slide")`, `it("two different browser cookies count as two present; two streams on the same cookie count as one")`; also spec/concurrency.test.ts `it("ten taps at once from one browser on one slide count once")`, spec/reasons.test.ts `it("ten I'm lost presses at once on a resolved slide reopen it once and add no rows")`, `it("I'm lost again after I get it now reopens the same tap: …")` | **HELD.** Two caveats. (a) "however much later" in the title is not actually exercised: the test never waits past a live window. The unique index `taps_one_per_slide` (src/db.ts:158-162) is what holds it regardless of time. (b) The comment at identity.test.ts:175, "After 'I get it now' the slide is still used up for this browser", is stale since e229acc. The re-tap now *reopens* the tap, and `live` counts the browser again. The test only asserts `totalTaps` is unchanged, which is still true. |
| 5 | "No response holds another browser's ID" | spec/identity.test.ts | spec/identity.test.ts `it("no student page, lecturer page, or stream ever contains a browser ID other than the requester's own")` covers the demo student page, a student stream frame and the demo lecturer page. The lecturer *stream* is covered elsewhere: spec/dashboard.test.ts `it("no dashboard payload or page contains a browser ID, a hash of one, or any per-student grouping")` and spec/activity.test.ts `it("no log line or payload holds a browser id, its sha256, or the first 8 hex of it")` | **HELD.** The file the README names covers pages and the student stream only; the lecturer stream is held by the other two files. |
| 6 | "Lecturer view needs the code" | spec/identity.test.ts | spec/identity.test.ts `it("/l/demo/lecturer shows the gauge only with the DEMO code")` (page only: no session, wrong code, right code). Lecturer actions are covered elsewhere: spec/slides.test.ts `it("slide change without a lecturer session is rejected")`, spec/notes.test.ts `it("Hide requires a lecturer session")`, spec/runs.test.ts `it("starting a fresh run needs that lecture's lecturer session")`, spec/help-link.test.ts `it("editing the help link needs that lecture's lecturer session")`, spec/new-lecture.test.ts `it("Start lecture needs the lecture's own lecturer session")` | **PARTLY.** No test opens `/l/:id/lecturer/events` without a session and expects 403. All 15 uses in spec/ send a valid lsess. The code does reject it (src/server.ts:2066-2070, `handleLecturerEvents`), but that is not tested. The named test also only covers the demo, not a created lecture's code. |
| 7 | "Logs hold only a hashed pseudonym" | "CLAUDE.md rule, read in flyctl logs" (judged) | None. Server logs aren't reachable over HTTP. | **JUDGED**, as claimed. The code agrees: `logAction` (src/logging.ts:44-53) and `logServerError` (src/server.ts:3415-3434) both log `who()` = sha256(browserId).slice(0,8). `logServerError` also logs `error: String(err)`; I can't tell statically what an arbitrary error string might contain. One misleading neighbour: spec/notes.test.ts `it("a note's text never appears anywhere in the server's log output")` doesn't read any log. It only checks that the home page HTML lacks the note text, and its own comment admits this. |
| 8 | "Taps survive a restart" | "by hand: tap, restart, reload" (status "live") | None in spec/. scripts/persistence-check.ts (`pnpm persist`) exists but isn't part of pnpm check. | **BY HAND**, as claimed. |
| 9 | "It's calm, and a lecturer would slow down" | "mock lecture with friends" (status "not yet run") | Partial automatic coverage of "calm": spec/calm-ui.test.ts `it("has a dark theme, and short transitions that stop under reduced motion")` (no `@keyframes`, transitions under 150 ms, `animation: none` under reduced motion) and `it("the only colours are the six named ones, being lost is violet, and nothing is red")` | **JUDGED.** The "lecturer would slow down" part is correctly not tested. But the status "not yet run" contradicts docs/feedback/finish.md:9 and :41-43 ("## Mock lecture / It worked, and people liked that they couldn't spam") and ADR 004:91 ("In the mock lecture, people liked…"). See 3.12. |

### 1b. "What good means here" bullets (README.md:22-26)

| Claim (word for word) | Held by (README) | Tests that check it | Verdict |
|---|---|---|---|
| "*Safety in numbers.* Below the threshold, no tap data leaves the server, not even to the lecturer." (README:22) | table row 1 | as row 1 | **WRONG.** The per-press activity log reaches the lecturer below min_present (src/realtime.ts:429,441; src/activity.ts). spec/activity.test.ts asserts it does. ADR 006:85 admits it: "the min_present guarantee no longer covers the log". From the log, the lecturer can also reconstruct the total and the live count below the threshold, by counting "said they're lost" lines (all of them, or those within the window). |
| "*It's about now.* A tap counts for 60 seconds, then fades." (README:23) | table row 3 | as row 3 | **WRONG for the demo, held for created lectures.** `liveWindowMs` (src/slides.ts:15-17) returns 20,000 ms for "demo" and 60,000 ms otherwise. README:8 and README:34 already say 20 s in the demo; this bullet was not updated. Also, a reopen (src/db.ts:519-528) resets `created_at`, so a reopened tap counts for another full window. |
| "*One browser, one voice.* Taps don't stack, and five tabs are one person." (README:24) | table row 4 | as row 4 | **HELD.** One row per (lecture, run, deck, slide, browser), and a reopen updates that same row (no new row; `yourTapCount`, `totalTaps` and bars unchanged; tested in reasons.test.ts as above). Presence counts distinct browsers (`presentCount`, src/realtime.ts:305-307). "Don't stack" means per slide: one browser can still add to the total once on each slide, and once more per slide in each new run. |
| "*No trail back to you.* No names or accounts. The lecturer sees counts per minute, never who." (README:25) | none named | spec/activity.test.ts checks only that the labels aren't browser IDs or hashes | **WRONG**, on two counts. (a) There are no per-minute counts. ADR 004:28 removed the per-minute timeline, and the lecturer sees counts per slide. (b) The lecturer now sees a per-press trail, "Person N" with second-resolution AEST times (src/activity.ts), from the first press. ADR 006:85 says "a lecturer watching the room can match Person N to someone by timing, and then read that person's later presses". "No names or accounts" still holds. |
| "*It's calm.* No sound or flashing." (README:26) | table row 9 (judged) | spec/calm-ui.test.ts as in row 9 (no keyframes, short transitions, reduced motion) | **PARTLY / JUDGED.** "Flashing" is partly checked (no `@keyframes`, transitions under 150 ms). No test checks for sound. A grep of src/server.ts and src/style.css found no `audio`, `sound` or `vibrate`. |

---

## 2. "Try it" steps (README.md:7-10)

**Step 1.** "Open /l/demo in Chrome and again in an incognito window. Each window is one person, and the demo needs two."
**Does what it says.** `handleLecture` → `ensureBrowserIdentity`/`ensureBrowserId` (src/auth.ts:21-30) mints a 128-bit `bid` per cookie jar, so incognito is a second browser. Each page opens `/l/demo/events`. `handleEvents` (src/server.ts:2015-2054) → `addConnection` keys connections by browser, and `presentCount` = number of distinct browsers. The demo's `min_present` is forced to 2 (src/db.ts:264). Below that, the gauge reads "Waiting for N more person/people" (`gaugeWords`, src/server.ts:304-311). One caveat: on the live site, other visitors on the demo also count toward "two".

**Step 2.** "Press "I'm lost" in one. Both update within a second. A tap counts for 20 seconds in the demo."
**Does what it says.** `handleTap` (src/server.ts:1673-1730) → `tapOncePerSlide` (src/db.ts:500-509) → `broadcast` (leading-edge throttle, `BROADCAST_WINDOW_MS` = 50, src/realtime.ts:498-542) → `sendToStudents`. Both windows get `live`/`totalTaps`, because present (2) >= min_present (2). `liveWindowMs("demo")` = `DEMO_LIVE_WINDOW_MS` = 20,000 (src/slides.ts:11,15-17). The fade is pushed by `scheduleFade`, which now fires at `created_at + window + 1 ms` (`fadeDelayMs`, src/realtime.ts:605-621, changed in 0bc55cd). After the fade, the tapper's button reads "Counted on this slide" (`TAP_BUTTON_TEXT.said`, src/server.ts:692-696). The tap stays recorded and still counts toward bars and the total.

**Step 3.** "With both still open, open /l/demo/lecturer in a new tab and enter DEMO. The lecturer isn't counted as a person."
**Does what it says.** `handleLecturerPost` (src/server.ts:2857-2894) verifies the code and sets a path-scoped `lsess`. The lecturer page's script opens `/l/demo/lecturer/events` (src/server.ts:2543). `handleLecturerEvents` (src/server.ts:2056-2084) → `addLecturerConnection` adds to the separate `lecturerConnections` set, which `presentCount` never reads. Nor does it start a deck clock (`isWatched` reads only `connections`). Implicitly tested: spec/help-link.test.ts waits for `present === 1` on a lecturer stream with one student, and spec/slides.test.ts checks that "a lecturer stream never counts as watching". If the new tab is in the same Chrome as one student window, that browser is still counted once, for its student tab. Not mentioned in the step: the demo lecturer view now shows the per-press "Person N" activity trail.

**Step 4.** "Start your own lecture (/new). A real lecture waits for five people."
**True for the gauge; not true for the activity log.** `handleNewPost` → `validateNewLecture` (src/server.ts:3073-3125) always produces `pacing: "timed"`. It requires a title, a slide count (1-60) or pasted text, and either total minutes (5-180, pre-filled "60" by `EMPTY_NEW_LECTURE`, src/server.ts:2947-2954) or one per-slide minute value per slide. A user who fills in only the title gets "A lecture needs a number of slides, or pasted slide text." `createLecture(id, valid.title, 5, …)` (src/server.ts:3155) sets min_present to 5, and `gaugeWords` shows "Waiting for N more people" until 5 are present. The slides don't move until the lecturer presses Start lecture (`handleStartLecture`, src/server.ts:2975-3009). Each browser can create 3 lectures per hour (src/auth.ts:98-116), and the app holds at most 500 lectures (`LECTURE_TOTAL_CAP`). The lecturer's activity log does *not* wait for five people: it lists each press from the first (see 1a row 1). The step mentions neither the timing nor Start lecture.

---

## 3. Contradictions

**3.1 "No trail back to you" vs the per-press log.**
- README.md:25: "*No trail back to you.* No names or accounts. The lecturer sees counts per minute, never who."
- README.md:22: "Below the threshold, no tap data leaves the server, not even to the lecturer."
- CLAUDE.md:34: "The lecturer's activity log shows each press as its own line, labelled only "Person N" … (… README "No trail back to you" is the user's to revise.)"
- ADR 006:85: "the min_present guarantee no longer covers the log, so a lecturer watching the room can match Person N to someone by timing, and then read that person's later presses."
- Code: src/activity.ts:86-140; src/realtime.ts:429,441.
- **Out of date: README** (both bullets, and table row 1). CLAUDE.md flags it as the user's to fix.

Earlier decisions that also contradict it and haven't been amended:
- ADR 004:117: "Nothing is labelled, numbered or grouped by student."
- ADR 004:130: option 1, rejected: "*Label students ("Student 1") with their own history.* A pseudonym with a history is a profile a lecturer can match to a person."
- docs/feedback/finish.md:66: "I considered labelling students ("Student 1") with their own history … I rejected both".

The ADR 006 amendment (line 85) doesn't mention that it reverses ADR 004's rejected option. spec/dashboard.test.ts `it("no dashboard payload or page contains a browser ID, a hash of one, or any per-student grouping")` still passes, because its regexes match keys `/person/i` and HTML `/Student \d/`. The "Person N" text sits in values, under key `activityLog`, so the title's "any per-student grouping" is no longer true of the payload it checks.

**3.2 "60 seconds" vs the 20 s demo window.**
- README.md:23: "A tap counts for 60 seconds, then fades."
- README.md:8 ("A tap counts for 20 seconds in the demo") and README.md:34 ("60 seconds, or 20 in the demo") already disagree with it.
- src/slides.ts:11: `DEMO_LIVE_WINDOW_MS = 20_000`.
- ADR 006:27 anticipated this: "the README's claim and its enforced test change".
- **Out of date: README.md:23.**

Also stale:
- docs/state.md:23-24: "the pending "a tap is about to age out of the 60s window" timer". It's 20 s for the demo.
- ADR 004:96: "It still counts as live for 60 seconds".

**3.3 "Taps don't stack" vs one per slide plus undo.**
- README.md:24 is consistent with the code (one row per slide; a reopen updates that row; src/db.ts:519-528, src/server.ts:1714-1724).
- **Out of date: ADR 004:102**, "*A student who is lost again on the same slide later can't say so.* After "I get it now", that slide is done for them." Since e229acc, "I'm lost" after "I get it now" reopens the tap.
- **Out of date: spec/identity.test.ts:175** comment, "After "I get it now" the slide is still used up for this browser."

**3.4 "Counts per minute" vs counts per slide.**
- README.md:25: "counts per minute".
- ADR 004:28: "*The per-minute timeline is removed.* Bars per slide …"
- spec/identity.test.ts:421-426 records the per-minute test as removed.
- **Out of date: README.**

**3.5 docs/state.md is missing in-memory state.**
- **Missing:** `timedTimers` (src/realtime.ts:651, `Map<lectureId, NodeJS.Timeout>`), the timed-lecture advance timer. It's armed by `scheduleTimedAdvance` from `addConnection`, `addLecturerConnection`, Start and Previous/Next, and lost on restart. docs/state.md lists `fadeTimers` and `slideTimers` but not this one. docs/walkthrough.md:138-141 does describe it.
- **Present and accurate:** the broadcast throttles (state.md:37-43), `failedAttempts`, `lectureCreations`, `deckStarts`.
- **Minor:** state.md:68-69 "Not on this list" names `lectures, taps, notes, browsers, lecturer_sessions` but omits the persistent `runs` and `lecture_slides` tables (src/db.ts:80, 225). The text "60s window" at state.md:24 is stale for the demo (3.2).
- **Out of date: docs/state.md.**

**3.6 docs/walkthrough.md vs the code.**
- walkthrough.md:38-42: "If it inserted a row, `handleTap` calls `broadcast(id)` … and `scheduleFade(id)` …, and logs `tap` … If not, it logs `tap_ignored` and broadcasts nothing, because nothing changed." The code has a third branch, `reopenResolvedTap`, which broadcasts, schedules the fade and logs `tap_reopened` (src/server.ts:1718-1721). Section 3 (lines 44-54) also describes only the INSERT. **Out of date: walkthrough.**
- walkthrough.md:132-133: "`scheduleFade` arms one timer per lecture for the moment the earliest live tap leaves its window". Since 0bc55cd it fires 1 ms *after* the window's last counted millisecond (`fadeDelayMs`, src/realtime.ts:600-607), because firing on the edge sent a "still live" frame and re-armed with zero delay. The wording is loose rather than wrong, but the walkthrough doesn't mention the boundary rule the code comment and spec/fade-timer.test.ts now pin down. **Walkthrough is imprecise.**
- walkthrough.md:143: "Both only push." The section lists three timers. Minor.
- walkthrough.md:189-190: "the activity log (`src/activity.ts`, one line per `min_present` more people, never one person)". The code emits one line per press (src/activity.ts). **Out of date: walkthrough.**

**3.7 ADR 006's status line and its amendments.**
- ADR 006:3: "Status: proposed, 16 November 2026 (finishing stage)". All four sections and both amendments are built, merged to main and deployed. ADRs 001-005 say "accepted". **Out of date: ADR 006's status line.**
- The amendment "every created lecture is timed" (ADR 006:81) matches the code: `validateNewLecture` is always timed and minutes are pre-filled 60; `handleSlideChange` moves `started_at` via `timedOriginFor` when started and steps `current_slide` before Start (src/server.ts:2918-2924); Start runs the clock from `current_slide` (src/server.ts:2999); students get Previous/Next links on created lectures.
- The amendment "per-press trail" (ADR 006:85) says "each "I'm lost", reason, "I get it now", what helped and note is its own line". CLAUDE.md:34 says "shows each press as its own line". **That overstates what was built:**
  - A reopen overwrites the tap row's `created_at` and clears `resolved_at` (src/db.ts:519-528). The first "I'm lost" line and the "I get it now" line disappear, replaced by one "lost" line at the reopen time. src/activity.ts:11-15 documents this as accepted.
  - A replaced note keeps one row with a new `created_at` (`setNote`, src/db.ts:853-861), so the earlier note press is gone.
  - Hidden notes are excluded (`activityNoteRows`, `hidden_at IS NULL`, src/db.ts:968).
  - Out of date: ADR 006:85 and CLAUDE.md:34 against the code. The code comment is the accurate one.
- The "min_present grouping of ADR 006" (CLAUDE.md:34; ADR 006:85, "replaced the grouped activity log") **was never recorded in ADR 006.** `git show ee9d799` and ff5b75e contain no activity-log section. The grouping existed only as the CLAUDE.md rule added in 2e70f47 ("(ADR 006.)") and in code (a58923e, d1cb362). The reference points at a decision the ADR never recorded.

**3.8 CLAUDE.md: rules vs code, internal tension, duplication, length.**
- **Length:** 44 lines (`wc -l`), well under 200.
- **CLAUDE.md:29 vs :34 (internal tension).** :29 says "live and totalTaps only leave the server when present >= min_present, in any page, stream or response. Hiding it on screen isn't enough." Under :34 the lecturer stream carries every press below the threshold, so both the total (count of "said they're lost" lines) and the live count (those lines within the window) can be derived from it. The field names are gated; the information isn't.
- **CLAUDE.md:31 vs :34.** :31 says "Any derived number (a share, a ranking, the hardest slide) appears only when every count behind it is at least min_present." "Person 3" is itself a count of distinct browsers that pressed in this run, shown below min_present. Whether a label counts as a "derived number" is a judgement; I'm flagging it, not ruling on it.
- **CLAUDE.md:27 vs :30 (wording).** :27 says "Students never see anyone's history". :30 says "a lone returning visitor still sees a slide's history". These use "history" in two senses (per person vs per-slide aggregate). Not a code conflict, but the two rules read as contradicting each other.
- **CLAUDE.md:24 heading, "Privacy (from the README's one idea)".** The README's one idea (README:18, "you can admit you're lost without being the one who admitted it") is what ADR 006:85 says the per-press log weakens.
- **Duplication / overlap:** :30 and :31 both gate on min_present per count, and could be one rule. :35 ("nothing loaded from elsewhere" for slide text), :36 (no third party) and :37 (CSP enforces it) overlap, though :37 says it enforces :36. :41 and :42 overlap (both are "ask first" for live-app actions). None of these contradict each other.
- **CLAUDE.md:9, "Never change … the shipped CI checks".** 09125e3 added one step to .github/workflows/checks.yml (Chromium install). The commit message says it was approved and "every shipped step is unchanged". Consistent with the letter of the rule; noted only for completeness.
- **CLAUDE.md:14 (no emoji).** U+2713/U+2717 check marks appear in scripts/check-evidence.ts (from the course's Initial commit 18265db) and slides/week-6.md (copied course content). These are dingbats, not emoji, and neither file was written under the rule. I can't tell whether the rule means to cover them.
- **Rules checked and found consistent with the code:** :17 (`handleReadme` renders server-side), :25 (`who()` = first 8 hex of sha256), :26 (only the demo shows its code; spec/new-lecture.test.ts), :28 (separate routes), :32 (notes never in student payloads; reasons from a fixed list), :33 (runs, demo 403), :35, :37 (spec/csp.test.ts).

**3.9 ADR 004 statements the code no longer matches.**
- ADR 004:32: "a marker may wait up to 40 seconds for the slide to change". Demo durations are now 10-90 s per slide (slides/week-6.md's last slide is 90 s, week-4's is 76 s; each deck totals 300 s).
- ADR 004:33: "*Real lectures depend on the lecturer pressing Next.*" Every created lecture is now timed (ADR 006 amendment).
- ADR 004:81: "A lecture made at /new gets a segment per slide reached so far, with the time the lecturer moved to it". ADR 004:85: "*The server keeps when the lecturer moved to each slide.*" The code doesn't do this. `timelineSegments` (src/timeline.ts:54-58) gives created lectures equal-width segments labelled only `slideName(null, n)`, with no time, and no per-slide move time is stored anywhere I could find in src/db.ts. Timed lectures also don't use their stored durations for the timeline.
- These are superseded by ADR 006 but not marked. ADR 004's status line (line 3) is still a plain "accepted".

**3.10 ADR 003's "What it costs" vs the code.** ADR 003's status line (line 3) is a plain "accepted", not marked partly superseded.
- ADR 003:37: "*Ten wrong codes lock everyone out* … because the limit is per lecture." Code: per lecture *and browser* (src/auth.ts:71-79).
- ADR 003:38: "*Anyone can create a lecture* at /new, with no limit." Code: 3 per browser per hour plus a cap of 500 (src/auth.ts:98-116; src/server.ts:3061).
- ADR 003:39: "*Lecturer sessions never expire.*" Code: 12 h (`LECTURER_SESSION_MAX_AGE_MS`, src/auth.ts:54).
- ADR 003:30: "One live tap per browser". Superseded by one per slide (ADR 004 amendment).

**3.11 Earlier wording in feedback notes.** docs/feedback/finish.md:58 plans "Glad it clicked. You're no longer counted as lost." and "What helped it click?". The code and ADR 006:40 use "Glad you've got it now." (src/server.ts:650) and "What helped your understanding?" (src/server.ts:653). This is a plan record, so low priority.

**3.12 Mock lecture status.**
- README.md:40: "| It's calm, and a lecturer would slow down | mock lecture with friends | not yet run |"
- docs/feedback/finish.md:9 and :41-43 and ADR 004:91 record a mock lecture that was run.
- Either the README status is out of date, or the recorded mock lecture didn't test this claim. I can't tell which from the repo.

**3.13 Minor wording drift.** ADR 004:19 and :50 quote the README as "writing a question takes the same courage as asking one". README.md:53 now reads "writing a question takes the courage asking does". No change in meaning.
