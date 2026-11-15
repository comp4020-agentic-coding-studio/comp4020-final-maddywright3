# Confusion meter

A button for the moment you stop following a lecture. Nobody sees who pressed it. Everybody sees how many did.

## Try it

1. Open [/l/demo](/l/demo) in Chrome and again in an incognito window. Each window is one person, and the demo needs two.
2. Press "I'm lost" in one. Both update within a second. A tap counts for 20 seconds in the demo.
3. With both still open, open [/l/demo/lecturer](/l/demo/lecturer) in a new tab and enter DEMO. The lecturer isn't counted as a person.
4. [Start your own lecture](/new). A real lecture waits for five people.

## Who it's for

A first-year lecture of 100 to 300 people. Most people who get lost never put their hand up. Asking means admitting it in front of everyone, and you're never sure if it's just you. So the lecturer finds out in the exam.

## What good means here

One idea: *you can admit you're lost without being the one who admitted it.*

One tap on its own is a confession. Twenty in the same minute is a fact about the lecture, and it tells everyone, including you, that it isn't just you. So:

- *Safety in numbers.* Below the threshold, no tap data leaves the server, not even to the lecturer.
- *It's about now.* A tap counts for 60 seconds, then fades.
- *One browser, one voice.* Taps don't stack, and five tabs are one person.
- *No trail back to you.* No names or accounts. The lecturer sees counts per minute, never who.
- *It's calm.* No sound or flashing.

## What's enforced and what's judged

| Claim | Held by | Status |
|---|---|---|
| No tap data below the threshold | spec/ test on the data | live |
| A tap reaches every page within a second | spec/events.test.ts | live |
| A tap fades after 60 seconds, or 20 in the demo | test, run in full | live |
| One "I'm lost" per browser per slide; tabs count once | spec/identity.test.ts | live |
| No response holds another browser's ID | spec/identity.test.ts | live |
| Lecturer view needs the code | spec/identity.test.ts | live |
| Logs hold only a hashed pseudonym | CLAUDE.md rule, read in flyctl logs | judged |
| Taps survive a restart | by hand: tap, restart, reload | live |
| It's calm, and a lecturer would slow down | mock lecture with friends | not yet run |

## What I read

Jane Caldwell's "Clickers in the large classroom" (2007) reviews studies of response systems in large classes, where anonymity keeps coming up as the reason students answer when they wouldn't raise a hand. But clickers only answer the lecturer's questions. This lets students raise the signal themselves, when they need to.

Robin Sloan's "An app can be a home-cooked meal" argues for software made for a handful of people, not for scale. So this is built for one room.

Clay Shirky's "Situated Software" describes software that leans on what a group already shares. A lecture already shares a room, so there are no profiles or chat. The crowd is the feature.

## What I chose not to build

- *Names or accounts.* Being identified is what stops people asking.
- *Typed questions.* Slido does this, and writing a question takes the courage asking does.
- *Upvotes.* They make confusion a popularity contest.
- *IP limits.* On campus wifi a whole lecture theatre shares a few addresses, so the room would count as a handful of people.
