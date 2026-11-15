# ADR 004: A lecture to be lost in

Status: accepted, 15 November 2026 (after C10)

## Context

The C10 feedback ([docs/feedback/c10.md](../feedback/c10.md)) found that two windows with a button and a number don't show what the app is for. Testers wanted a lecture to tap against, to see where other people got lost, and a way to say why. In my own test, "You're counted" gave no sign of when it would unlock. The brief asks for a design built around co-presence, for a marker who arrives with only the URL.

## Options for the lecture

1. *Embed a YouTube lecture.* Real content, but it sets third-party tracking cookies, which breaks "no trail back to you", and it needs copyright permission.
2. *A self-hosted video.* No tracking, but heavy on a 256 MB machine and a 1 GB volume, and slow on a weak connection.
3. *A short slide deck of my own,* served as text and simple diagrams, advancing on a shared clock. Light, readable, accessible, and nothing third-party.

For real lectures, the lecturer's own slides stay where they are. The lecturer view gets Next and Previous buttons, so each tap is recorded against the current slide number.

## Options for saying why

1. *Free-text comments.* Richer, but they contradict the README ("writing a question takes the same courage as asking one"), writing style can identify people, and a room of strangers needs moderation.
2. *One-tap reasons from a fixed list:* Too fast, Missed a step, Notation, Can't see or hear. No typing, nothing identifying, nothing to moderate.

## Decision

The slide deck (option 3), one-tap reasons (option 2), bars per slide shown to students as well as the lecturer, a countdown on your own tap, and an "I get it now" button that ends your live tap.

*The privacy rule, refined.* Live numbers still need at least min_present people here now. History works differently: a slide's bar appears only once at least min_present different browsers have tapped on that slide, whoever is here now. A marker returning alone the next day still sees the history, and no bar can ever be one person. Bars count distinct browsers per slide, so tapping, undoing and tapping again can't inflate them.

*The per-minute timeline is removed.* Bars per slide answer the lecturer's real question, which slide lost the room, and a minute with one tap in it is a confession.

## What it costs

- *The demo is a recorded lecture, not a live one.* It loops every few minutes, so a marker may wait up to 40 seconds for the slide to change.
- *Real lectures depend on the lecturer pressing Next.* If they forget, taps land on the wrong slide.
- *A fixed list will miss some reasons.* There's no free-text "Other", on purpose.
- *One person in two browsers still counts twice* (ADR 003's cost stands).
- *More moving parts on one small machine,* so this needs a load test.

## Amendment, 15 November 2026: real slides, and notes on what didn't make sense

### Real course slides instead of my own deck

A deck I wrote myself would be a stand-in. The course's own lectures publish a markdown version, with slides separated by ---, under CC BY-NC-SA 4.0. The demo now uses a run of slides from COMP4020 Week 4, "Context engineering", copied into the repo with credit and the same licence. They're copied, not embedded, because an embedded page is a third-party load and can't tell the app which slide it's on.

Students can also move back and forward through the slides with arrows, and rejoin the shared clock with "Back to live". A tap records the slide the student is looking at, which is how real people use slides: you flick back to the one where you lost the thread.

The shared clock now starts when the first person arrives, so a visitor never lands mid-lecture in an empty room.

### Notes on what didn't make sense

The fixed reasons say what kind of lost. They can't say where: "the bit where the budget suddenly included tool output". Testers wanted that. I had rejected free text because writing a question takes the same courage as asking one. That's true when other people can read it. It's much less true when only the lecturer can, and only alongside other people's notes.

Options considered:

1. *No text at all.* Keeps the design simplest, but loses the one thing a lecturer needs to fix a slide.
2. *Public questions, as in Slido.* Everyone sees them, so writing one is a performance, and upvotes turn it into a popularity contest.
3. *AI moderation.* The course key only works from the ANU network, and the Fly machine isn't on it. A personal key would send anonymous notes to a third party, and an AI's judgement can't be tested in spec/.
4. *Lecturer-only notes, released per slide in batches.* Nobody but the lecturer reads them, so there's no audience to perform for, and a slide's notes only appear once at least min_present different browsers have written one, so no note can be matched to the one person who just tapped.

Decision: option 4. After tapping, a student can answer one optional question, "What part of this didn't make sense?", in up to 200 characters. Notes containing a link, an email address or a phone number are rejected, which also stops people identifying themselves by accident. The lecturer can hide a note. Note text is never logged, and never sent to students.

What it costs:
- *A lecturer with fewer than five people commenting on a slide sees no notes for it.*
- *Batching delays notes* until enough people have written, so a lecturer can't react to the first one.
- *Nothing checks tone.* The guardrails are an audience of one and the batch threshold, not a filter for rudeness.
- *Writing style can still identify someone* to a lecturer who knows them well. Batching makes that harder, not impossible.
