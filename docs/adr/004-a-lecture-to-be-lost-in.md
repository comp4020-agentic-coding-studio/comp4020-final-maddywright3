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
