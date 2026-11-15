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

## Amendment, 16 November 2026: a timeline, one tap per slide, and a lecturer dashboard

The hand checks, the stranger test, the mock lecture and the lecturer view are in [docs/feedback/finish.md](../feedback/finish.md).

### A lecture timeline

Given only the URL, the stranger didn't realise the demo was replaying a live lecture. They suggested a progress bar like a video player, with times for each part. In my own Phase 1 check, nothing showed how far through the lecture we were.

Options considered:

1. *"Slide 6 of 10" as it is.* Already on the page, and the stranger still missed it.
2. *A per-minute timeline of taps.* ADR 004 removed it: a minute with one tap in it is a confession.
3. *A timeline like a video scrubber:* a segment per slide labelled with its start time, a Live marker that moves, and a You marker when you browse away. Segments are shaded where people got lost.

Decision: option 3. Shading uses exactly the bars' threshold, so a segment below it is unshaded, not zero. Segments are links, so it works without JavaScript, and clicking one moves only your own view. A lecture made at /new gets a segment per slide reached so far, with the time the lecturer moved to it, and no total length, because nobody knows how long a real lecture will run.

What it costs:
- *A slide a few people were lost on looks the same as one nobody was lost on.*
- *The server keeps when the lecturer moved to each slide.* It's a time per slide, nothing about students.
- *The demo's times are a loop,* so 0:00 comes round again every few minutes.
- *Ten segments at phone width are small targets.*

### One "I'm lost" per browser per slide

In the mock lecture, people liked that they couldn't spam "I'm lost". Their suggestion was one per slide.

Options considered:

1. *One live tap per browser per 60 seconds, as now.* One person can tap again every minute, so the total grows with how long a slide stays up.
2. *One tap per browser per slide, ever.* It still counts as live for 60 seconds or until "I get it now".
3. *One tap per browser per lecture.* Too few: lost on slide 3 and lost on slide 8 are different facts.

Decision: option 2, in the same single SQL statement as now, so two taps at the same moment still count once. The countdown is replaced by "You've said you're lost on this slide."

What it costs:
- *A student who is lost again on the same slide later can't say so.* After "I get it now", that slide is done for them.
- *A tap on a slide you browsed back to uses that slide up too.*
- *"One browser, one voice" changes meaning,* from one live tap to one tap per slide, so its wording and its enforced test change with it.
- *A private window still beats it* (ADR 003's cost stands).

### A lecturer dashboard

The lecturer view showed only the slide, people here, lost right now and the total. No reasons, no notes, and nothing saying why. The threshold was hiding them, but the lecturer couldn't tell that from the page. I wanted real statistics and notes I could filter by slide.

Options considered:

1. *Show the lecturer counts below the threshold.* The lecturer is exactly who mustn't learn who tapped, and a count of one next to a note is a confession.
2. *Keep the view and add a line about the threshold.* Cheap, but still no statistics.
3. *A dashboard of aggregates only:* the current slide first, summary tiles, bars per slide with reasons inside, what helped, and notes grouped by slide and filterable by deck and slide. Every part that's empty or below its threshold says why, with the lecture's real number: "Shows once 2 people have chosen a reason on this slide."

Decision: option 3. Charts are SVG drawn on the server, with no chart library, and each has a text alternative. Nothing is labelled, numbered or grouped by student.

What it costs:
- *A lecturer sees nothing for slides below the threshold,* only a message saying why. In a real lecture, a slide four people were lost on stays blank.
- *Each tile needs its own threshold too,* so early in a lecture most of the dashboard says "not yet".
- *Everything is drawn twice,* once by the server and once by the script for live updates, and the two must stay in step.

### No per-student log or email: a help link the student chooses

I also wanted a way to help students who are very lost.

Options considered:

1. *Label students ("Student 1") with their own history.* A pseudonym with a history is a profile a lecturer can match to a person.
2. *Email very lost students.* Emailing someone means knowing who they are, which needs the accounts ADR 003 rejected.
3. *A help link the student sees themselves.* The lecturer sets a link. Once a browser has said it's lost on three or more slides, that browser alone sees "Want a hand with this? Your lecturer offers help here." It's worked out for that browser only, never sent to the lecturer, never logged and never counted.

Decision: option 3. The student reaches out, and the lecturer never learns who.

What it costs:
- *The lecturer can't reach the student who needs it most,* only offer a link.
- *Three slides is a guess.* A student lost on two slides sees nothing.
- *Nobody can tell if it helps,* because nothing counts who saw it or followed it.
- *Following the link leaves the app.* Whatever the linked site knows about the student, this app can't control.
- *A new window or cleared cookies resets the count.*
