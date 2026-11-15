# Confusion meter

A button for the moment you stop following a lecture. Nobody sees who pressed it. Everybody sees how many did.

## Try it

Open [/l/demo](/l/demo) in Chrome, then open the same link in an incognito window. Press "I'm lost" in one and the other updates within a second. A real lecture keeps its gauge blank until five people are there. The demo uses two, so you can try it with two browsers. A lecturer view, unlocked with a code, is being built next.

## Who it's for

A first-year lecture of 100 to 300 people. Most people who get lost never put their hand up. Asking means admitting it in front of everyone, and you're never sure if it's just you. So the lecturer finds out in the exam.

## What good means here

One idea: *you can admit you're lost without being the one who admitted it.*

That only works with other people in the room. One tap on its own is a confession. Twenty taps in the same minute is a fact about the lecture, and it tells everyone, including you, that it isn't just you. So the meter is built around the crowd:

- *Safety in numbers.* The gauge stays blank until enough people are here.
- *It's about now.* A tap counts for 60 seconds, then fades, so the gauge shows the room as it is.
- *One browser, one voice.* Pressing again doesn't stack, and five tabs are still one person.
- *No trail back to you.* No names or accounts, and the lecturer sees counts per minute, never who tapped.
- *It's calm.* No sound or flashing. The lecturer looks when they choose to.

## What's enforced and what's judged

| Claim | How it's held | Status |
|---|---|---|
| Gauge blank below the threshold | test in spec/events.test.ts | live |
| A tap reaches every open page within a second | test in spec/events.test.ts | live |
| A tap fades after 60 seconds | test, run in full every time | live |
| Taps survive a restart | checked by hand: tap, flyctl machine restart, reload | live |
| One live tap per browser, people counted by browser | test | next milestone |
| The lecturer never receives browser IDs | test | next milestone |
| It's calm, and a lecturer would actually slow down | judged in a mock lecture with friends | not yet run |

## What I read

Robin Sloan's "An app can be a home-cooked meal" argues for software made for a handful of people you know, instead of software made to scale. That's why this is built for one room, not every university.

Clay Shirky's "Situated Software" describes software built for a particular group, which leans on what that group already shares. A lecture already shares a room, so the app needs no profiles or chat. The crowd itself is the feature.

## What I chose not to build

- *Names or accounts.* Being identified is what stops people asking.
- *Typed questions.* Tools like Slido already do this, and writing a question takes the same courage as asking one.
- *Upvotes and reactions.* They turn confusion into a popularity contest.
- *A list of who tapped when.* The lecturer should know when the room was lost, never who was.
