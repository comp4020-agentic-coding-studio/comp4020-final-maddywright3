
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
