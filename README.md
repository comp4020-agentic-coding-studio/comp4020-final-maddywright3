# Confusion meter

A button for the moment you stop following a lecture. Nobody sees who pressed it. Everybody sees how many did.

## Try it

1. Open [/l/demo](/l/demo) in Chrome, and the same link in an incognito window. Each window is one person, and the demo needs two before it shows anything.
2. Press "I'm lost" in one. Both windows update within a second. Your tap counts for 60 seconds, then you can press again.
3. Keep both open. In a new tab, open [/l/demo/lecturer](/l/demo/lecturer) and enter the code DEMO. The lecturer doesn't count as a person, and sees nothing until two people are there.
4. [Start your own lecture](/new) to get a link and a code. A real lecture waits for five people.

## Who it's for

A first-year lecture of 100 to 300 people. Most people who get lost never put their hand up. Asking means admitting it in front of everyone, and you're never sure if it's just you. So the lecturer finds out in the exam.

## What good means here

One idea: *you can admit you're lost without being the one who admitted it.*

That only works with other people in the room. One tap on its own is a confession. Twenty taps in the same minute is a fact about the lecture, and it tells everyone, including you, that it isn't just you.

- *Safety in numbers.* Below the threshold, nothing about taps leaves the server, not even to the lecturer.
- *It's about now.* A tap counts for 60 seconds, then fades.
- *One browser, one voice.* Pressing again doesn't stack, and five tabs are one person.
- *No trail back to you.* No names or accounts. The lecturer sees counts per minute, never who tapped.
- *It's calm.* No sound or flashing.

## What's enforced and what's judged

| Claim | How it's held | Status |
|---|---|---|
| No tap data below the threshold, in pages and streams | test in spec/ | live |
| A tap reaches every open page within a second | spec/events.test.ts | live |
| A tap fades after 60 seconds | test, run in full every time | live |
| One live tap per browser; tabs count once | spec/identity.test.ts | live |
| No response holds another browser's ID | spec/identity.test.ts | live |
| Lecturer view needs the lecture's code | spec/identity.test.ts | live |
| Logs use a hashed pseudonym only | CLAUDE.md rule, checked by reading flyctl logs | judged |
| Taps survive a restart | by hand: tap, flyctl machine restart, reload | live |
| It's calm, and a lecturer would slow down | a mock lecture with friends | not yet run |

## What I read

Jane Caldwell's "Clickers in the large classroom" (2007) reviews studies of response systems in large classes. Anonymity comes up again and again as the reason students answer when they wouldn't raise a hand. Clickers only answer the lecturer's questions, though. This meter lets students raise the signal themselves, at the moment they need to.

Robin Sloan's "An app can be a home-cooked meal" argues for software made for a handful of people, instead of software made to scale. That's why this is built for one room.

Clay Shirky's "Situated Software" describes software that leans on what a group already shares. A lecture already shares a room, so the app needs no profiles or chat. The crowd is the feature.

## What I chose not to build

- *Names or accounts.* Being identified is what stops people asking.
- *Typed questions.* Slido already does this, and writing a question takes the same courage as asking one.
- *Upvotes and reactions.* They turn confusion into a popularity contest.
- *Limits by IP address.* They'd stop repeat taps from private windows, but a lecture theatre on campus wifi shares a few addresses, so a whole room would count as a handful of people.
