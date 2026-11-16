
## Before Phase 1: two design changes

*Real slides.* The plan had a deck written for the demo. I switched to a run of slides from the course's own Week 4 lecture, copied in under its CC BY-NC-SA licence, so the demo has something real to be lost in. Students get arrows to go back to the slide where they lost the thread.

*Notes on what didn't make sense.* Testers wanted to say which part lost them, not just why. I'd ruled out free text, then looked at it again: the courage problem comes from an audience, not from typing. Notes now go to the lecturer only, and appear per slide only once enough people have written one.

I also considered AI moderation and dropped it. The course key can't be reached from the Fly machine, a personal key would send anonymous notes to a third party, and a model's judgement can't be tested in spec/. See the ADR 004 amendment.

## Hand checks, Phases 1 to 5

- *Phase 1:* Previous and Next change only my own window. Switching decks works. Both windows start on slide 1. Missing: nothing shows how far through the live lecture we are.
- *Phase 2:* bars appear per slide once enough browsers have tapped.
- *Phase 3:* after "I get it now", the "what kind of lost" reasons stayed on screen, but they no longer apply. Better to ask what helped. I also couldn't find the lecturer view from the student page and had to ask how to log in.
- *Phase 4:* "Reconnecting..." appears offline and clears when back online.
- *Phase 5:* keyboard only, both viewports, light and dark all looked good.

## Stranger test

Given only the URL, they didn't realise it was replaying a live lecture. They suggested a progress bar like a video player, with times for each part of the lecture.

## Mock lecture

It worked, and people liked that they couldn't spam "I'm lost". Their suggestion was one "I'm lost" per slide.

## What I'm changing

| Finding | Change |
|---|---|
| No sense of a live lecture | A lecture timeline under the slide: a segment per slide with timestamps, a Live marker, a You marker when browsing, and segments shaded where people got lost (same privacy threshold as the bars) |
| Lecturer view hard to find | A "Lecturer view" link on every lecture page. The demo shows its code, DEMO |
| Reasons stay after "I get it now" | "Glad it clicked. You're no longer counted as lost.", then "What helped it click?" with a fixed list |
| Spam, and one tap per slide | One "I'm lost" per browser per slide. The countdown is replaced by "You've said you're lost on this slide" |

## Lecturer view

It showed only the slide, people here, lost right now and the total. No reasons, no notes, no explanation of why. Most likely the privacy threshold was hiding them, but the lecturer couldn't tell that from the page. Wanted: a dashboard with real statistics, notes filterable by slide, and a way to help students who are very lost. Also, after choosing a reason, the other reasons should grey out.

I considered labelling students ("Student 1") with their own history, and emailing very lost students. I rejected both: a pseudonym with a history is a profile a lecturer can match to a person, and emailing someone means knowing who they are. Instead, a student who is lost on three or more slides sees the lecturer's help link themselves, so the student reaches out and the lecturer never learns who.

## Phase 5, completed: what the checks found

*Nested form.* "I get it now" was a form nested inside the tap form. Browsers drop a nested form, so the button sent a tap instead of resolving one. Found while restyling. It now sits beside the tap form ([`f2872ad`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/f2872ad)).

*Focus lost after a tap.* The Playwright keyboard test caught it. After Enter on "I'm lost" the script disabled the focused button, and after "I get it now" it hid the focused form, so focus dropped to the top of the page. The button now uses aria-disabled and stays focusable, and focus moves to "I'm lost" when the control holding it is hidden ([`dc66e58`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/dc66e58)). With the old line put back, the test fails again.

*9px of overflow.* The README's claims table was 399px wide on a 390px phone, because a path like spec/events.test.ts can't break inside a table cell. Caught by the browser overflow check, fixed with overflow-wrap on cells ([`6a731b0`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/6a731b0)).

## Lecturer view: diagnosis

Two browsers tapped the same slide, chose the same reason and each wrote a note. The lecturer stream then carried everything (note text left out here):

~
{"present":2,"shown":true,"slide":1,
 "bars":[{"deck":"week-4","slide":3,"distinctBrowsers":2}],
 "live":2,"totalTaps":2,
 "reasonCounts":[{"deck":"week-4","slide":3,"reason":"Missed a step","count":2}],
 "notes": [ two notes on week-4 slide 3 ]}
~

So it was the threshold, not a bug. With the two browsers on different slides, nothing cleared min_present, and the page showed nothing at all: no heading, no table, no message. The lecturer saw a blank screen with no reason given. "Slide 6" was also week 4's clock with no deck named, while each student tapped whatever slide they were viewing.

*A real bug found on the way.* Without JavaScript, choosing a reason or "I get it now" redirected to a bare /l/demo, so the next note was filed against the live slide instead of the one tapped. The failing test went in first (commit link added after merge).

## Load test, 50 browsers

Each run creates its own lecture titled "Load test". The demo is never used. Times are min / median / max over the 50 streams.

| Run | Lecture | Every stream sees present = 50 | Every stream sees live = 50 after 50 taps | Peak memory |
|---|---|---|---|---|
| Local | 082d92db | 149 / 150 / 151 ms | 757 / 758 / 759 ms | |
| Local | 5508aa86 | 151 / 152 / 154 ms | 752 / 753 / 754 ms | |
| Local | 2ca6374e | 156 / 157 / 158 ms | 788 / 788 / 789 ms | 153 MB (97 MB idle) |
| Fly, 256 MB | 98f1f2ea | 230 / 231 / 233 ms | 1487 / 1488 / 1489 ms | 122.6 MB (118.4 MB before) |

Once the server sends an update, all 50 streams have it within 5ms of each other. The time goes on writing the 50 taps one at a time, not on broadcasting. On Fly that's about twice as slow on the shared CPU, and memory stays under half the 256 MB limit.

*This misses the brief's "within about a second"* for a burst of 50 at once on Fly. Next step: faster tap writes and fewer broadcasts during a burst, then a re-run.

The script had a bug of its own at first. Every stream reported the same time, because frames that had already arrived were timed when the script got round to checking them. It now times each frame on arrival ([`57955ae`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/57955ae)). The runs are recorded in [`ec21b00`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/ec21b00).

## CI

The last push ([`df9276f`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/df9276f)) passed every check and deployed. It predates the Chromium step and the browser tests ([`09125e3`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/09125e3), [`6681449`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/6681449)), whose first CI run is the next push.

## Agent reports I didn't take at their word

An agent saying something is done isn't evidence that it is. In each case I asked for the artefact behind the claim:

- *"The colour agent has finished."* It hadn't. It had just stopped committing for a while. Checking its branch for uncommitted work and new commits showed it was still running, and the report was corrected.
- *"The load test is done."* It was, nine times, when I'd approved one run. The report admitted it, and the rule is now in CLAUDE.md ([`ae9e31d`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/ae9e31d)).
- *"The lecturer view works."* I asked for the payload the lecturer stream actually sent. That showed the data was there once two people tapped the same slide, and that the page gave no reason when it wasn't.
- *"The persistence check works."* Only after it caught a snapshot I'd deliberately damaged.

What I ask for each time is something I can check myself: a CI run, a commit hash, a response body, a screenshot, or a test that fails with the old code put back.

## Limits I accepted

These are known and written down, not missed:

- *A private window is a second person.* One person can tap twice with two browsers. Stopping it would need accounts or IP limits, and both break the README's idea (ADR 003).
- *A power cut can lose the last second of taps.* That's the cost of WAL with synchronous=NORMAL, which made bursts fast enough (ADR 005). An app crash loses nothing.
- *A small class never clears the threshold.* With fewer than five people on a slide, the lecturer sees nothing about it. That's the price of nobody being singled out.
- *Notes can still be recognised.* A lecturer who knows a student's writing might guess a note's author. Batching makes it harder, not impossible.
- *Batching delays the first notes.* A lecturer can't react to a note until enough people have written one on that slide.
- *Real lectures depend on the lecturer pressing Next.* If they forget, taps land on the wrong slide.
