# Confusion meter

A button for the moment you stop following a lecture, and a gauge that shows the lecturer how many people are lost with you.

## Try it

Open [/l/demo](/l/demo) on your phone and press "I'm lost". In a second browser (or an incognito window), open [/l/demo/lecturer](/l/demo/lecturer) and enter the code DEMO to see the gauge. Two separate browsers count as two people.

## Who it's for

A first-year lecture of 100 to 300 people. Most people who get lost never put their hand up. Asking means admitting it in front of everyone, and you're never sure if it's just you. So the lecturer finds out in the exam. The confusion meter is for the minute between getting lost and giving up.

## What good means here

1. *Saying "I'm lost" costs nothing.* One tap, no typing, no name. Nobody, including the lecturer, can see who tapped.
2. *It's about now.* A tap counts on the live gauge for 60 seconds and then fades, so the gauge shows how lost the room is right now, not how lost it's been all day.
3. *One person, one voice.* A browser holds one live tap at a time. Pressing again doesn't stack.
4. *It hides you in a crowd.* The gauge stays blank until at least five people have the lecture open, because in a room of two, a tap is a confession.
5. *It's still useful afterwards.* Every tap is kept with its time, so the lecturer can look back and find the slide where the room got lost.
6. *It's calm.* No sound, no flashing, nothing that interrupts the lecture.

The meter only works because other people are using it at the same time. One tap means little. Twenty taps in the same minute means stop and explain it again.

## What's enforced and what's judged

Enforced by tests in spec/: the lecturer view never receives student IDs (1), taps drop off the gauge after 60 seconds (2), a second tap from the same browser doesn't add to the count (3), and the gauge shows nothing below five people (4). Persistence (5) is checked by hand: tap, run flyctl machine restart, reload, and the taps are still there.

Judged: whether it's calm (6), and whether a lecturer would actually change pace because of it. I judge these by running a mock lecture with friends, one acting as lecturer, and asking what they did when the gauge went up.

## What I read

Robin Sloan's "An app can be a home-cooked meal" argues for software made for a handful of people you know, instead of software made to scale. That's why this is built for one room, not every university.

Clay Shirky's "Situated Software" describes software built for a particular group, which leans on what that group already shares. A lecture is that kind of group. Everyone is in the same room, so the app doesn't need profiles or chat, because the room already provides the context.

## What I chose not to build

- *Names or accounts.* Being identified is the thing that stops people asking.
- *Typed questions.* Tools like Slido already do this, and writing a question takes the same courage as asking one.
- *Upvotes and reactions.* They turn confusion into a popularity contest.
- *Per-student history.* The lecturer should know when the room was lost, never who was.
- *Notifications.* The lecturer looks when they choose to.
