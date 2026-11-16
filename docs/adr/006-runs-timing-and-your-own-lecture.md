# ADR 006: Runs, timing, and your own lecture

Status: proposed, 16 November 2026 (finishing stage)

## Context

After the hand checks and the mock lecture ([docs/feedback/finish.md](../feedback/finish.md)), four things still didn't fit how a lecture works:

- Each demo slide lasts 40 seconds, whatever is on it. A slide with one heading lasts as long as one with a dense paragraph, and nothing says the demo stands in for a full lecture.
- A reason can be changed while a tap is live. With one tap per slide (ADR 004's amendment), an answer that keeps changing is noise, and so is a second answer to "what helped".
- A lecturer who wants to rehearse, or run the same lecture twice, has no way to start again except deleting data. Deleting would break "taps survive a restart", which markers check.
- /new asks only for a title. A lecturer arriving there doesn't learn what the app is for, how many slides it expects, or how it keeps time.

This ADR covers four changes: condensed demo timing, answers that lock once sent, a fresh run instead of a reset, and a /new that explains itself.

## 1. Condensed demo timing

Options considered:

1. *Keep 40 seconds a slide.* Simple, but a dense slide is gone before it's read, and the demo doesn't look like a lecture.
2. *Real lecture length, 60 minutes.* Honest, but no marker will wait an hour to see the slides move.
3. *A 60-minute lecture condensed 12x into about 5 minutes,* each slide given its own duration in the deck file, weighted by how much it covers. The page shows "Lecture time 1:20 / 5:00" and "Condensed 12x from a 60-minute lecture (real time 16:00)".

Decision: option 3. Durations live in the deck file next to the slides, so the content and its pacing change together. Timeline segments are sized by duration. A demo tap stays live for 20 seconds, scaled down like everything else: 60 seconds in a 40-second slide was longer than the slide itself. Lectures made at /new keep 60 seconds.

What it costs:
- *Two live windows to explain.* "A tap counts for 60 seconds" is now only true for real lectures, so the README's claim and its enforced test change.
- *A demo tap fades faster than people can talk about it.* 20 seconds is short in a room, but it's a stand-in for 4 real minutes.
- *Durations are my judgement.* Weighting by how much a slide covers is a guess about reading time.
- *The real-time figure is arithmetic,* not a recording of a real lecture's pacing.

## 2. Answers lock once sent

Options considered:

1. *Changeable while live, as now.* Lets someone fix a mis-tap, but a lecturer sees counts that shift for reasons nobody can explain.
2. *Lock once sent,* per (browser, deck, slide), checked on the server. The chosen answer stays marked (aria-pressed), the rest dim, and every button for that slide is disabled until you move to another slide.
3. *A short undo window.* Kinder to mis-taps, but adds a timer and a state nobody asked for.

Decision: option 2, for both "What kind of lost?" and the new "What helped your understanding?". After "I get it now", the page says "Glad you've got it now." and offers a fixed list: The next slide, Re-reading it, The example, Someone explained it, Worked it out myself. The server rejects a second answer, so no script can change it either.

What it costs:
- *A mis-tap can't be fixed.* One wrong reason stays counted.
- *The existing test that changes a reason now checks the opposite.* That's a behaviour change, written down here, not a loosened assertion.
- *"Someone explained it" can't say who,* on purpose.

## 3. A fresh run, never a delete

Options considered:

1. *A reset that deletes the lecture's taps, reasons and notes.* Clean, but data that's gone can't be checked, and a slip of the button loses a whole lecture.
2. *A new lecture each time.* Nothing is lost, but the code, link and help link all change, and students need the new link.
3. *Runs within a lecture.* "Start a fresh run", after a confirmation page, creates a new run. Taps, reasons, what helped and notes carry a run id. Everything live uses the current run, and earlier runs stay viewable, read-only, through a run picker on the dashboard.

Decision: option 3. Existing rows all go into run 1, so nothing changes for data already in /data. The one-tap-per-slide index includes the run id, so the same browser can tap the same slide again in a new run. The demo can't be reset: the server answers 403, and the page says "The shared demo keeps its history. Create your own lecture to try a fresh run." Its code is public, so anyone could wipe what markers came to see. Each new run logs run_started.

What it costs:
- *The database only grows.* Nothing is ever deleted, so a heavily rehearsed lecture keeps every run on the 1 GB volume.
- *Every query gains a run id,* and a query that forgets it mixes runs. Tests have to cover each one.
- *A run is not a new identity.* A browser that tapped in run 1 is the same browser in run 2. The lecturer still can't connect them, because nothing per browser is ever shown.
- *The demo's history grows forever,* because it can't be reset.

## 4. A lecture that explains itself

Options considered:

1. *Title only, as now.* Fast, but a lecturer has to guess what the app does and how slides are counted.
2. *Upload slide files* (PDF, PowerPoint). Closest to a real lecture, but parsing them is a new dependency and a large attack surface, and storing them uses the volume.
3. *A short form that says what the app is for:* "Run this beside your own slides. Students tap on the slide you're on, and you see where the room got lost." Then a title, a number of slides (1 to 60), pacing ("I'll press Next", or "Timed" with 5 to 180 minutes split evenly unless per-slide minutes are given), optional slide text pasted as markdown separated by --- (up to 50 KB), and the optional help link.

Decision: option 3. Pasted slides are rendered with marked, which is already a dependency. Raw HTML is escaped, images aren't rendered, and links render as links but only for http and https. Nothing loads from another site. If slide text is pasted, its count of slides wins over the number field. A timed lecture starts when the lecturer presses "Start lecture", not when the first student arrives, because a real lecturer starts on their own cue.

What it costs:
- *Pasted text is lecturer content shown to students.* Escaping and refusing images are the guardrails. A link can still point anywhere, and following it leaves the app.
- *No images or diagrams in pasted slides.* A lecturer's diagram has to stay on their own slides.
- *Timed pacing can drift from the room.* If the lecturer talks longer, slides move on anyway, and taps land on the slide the clock says.
- *50 KB of text per lecture,* stored and sent on every page view of that lecture.

## Amendment, 16 November 2026: every created lecture is timed

In my hand test I wanted every lecture to run on time, but still to be mine to steer. So /new no longer offers "I'll press Next": every lecture made there is timed, from total minutes (5 to 180, pre-filled 60) or from per-slide minutes. The lecturer keeps Previous and Next on a timed lecture. On a started lecture, pressing one moves the clock's origin (started_at) so the chosen slide starts now and the timer carries on from it. The slide is still computed only from started_at, so it survives a restart. Before Start, Previous and Next move the slide, and Start runs the clock from there. Lectures already stored with pacing "next" keep working as they did. Students now get Previous/Next links on a created lecture, as on the demo, and browsing moves only their own view.
