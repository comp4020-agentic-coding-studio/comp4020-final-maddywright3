# Hands Down

A confusion meter for lectures. Nobody sees who pressed it. Everybody sees how many did.

## Try it

1. Open [/l/demo](https://comp4020-final-maddywright3.fly.dev/l/demo) in Chrome and in an incognito window. Each window is one person. It replays a COMP4020 lecture, condensed 12 times.
2. Press "I'm lost" in one. Both update within a second, and the tap counts for 20 seconds. Say why, or which part lost you. When it clicks, press "I get it now".
3. Open [/l/demo/lecturer](https://comp4020-final-maddywright3.fly.dev/l/demo/lecturer) with the code DEMO. A slide's data shows once two people have tapped it.
4. [Create your own lecture](https://comp4020-final-maddywright3.fly.dev/new). Real lectures wait for five people.

## Who it's for

First-year lectures of 100 to 300 people. In first year I was lost on a Java slide the rest of the lecture built on, and didn't ask. Later I learned many others were stuck there too, and the lecturer wished someone had said.

## What good means here

*You can admit you're lost without being the one who admitted it.*

One tap is a confession. Twenty on one slide is a fact about the lecture, and tells everyone it isn't just them.

- *Safety in numbers.* Nothing about what others pressed leaves the server until enough are there.
- *One voice.* One "I'm lost" per slide. Five tabs are one person.
- *Anonymous, not invisible.* The lecturer's log says "Person 3", numbered afresh each run, never a name or a note's text.
- *An audience of one.* Notes reach only the lecturer.
- *Reach out, not in.* Once you've said you're lost on three slides, you see where to get help. The lecturer never learns who.
- *Calm.* No sound, no flashing, nothing loaded from another site.

## Enforced and judged

| Claim | Held by |
|---|---|
| Nothing others pressed, below the threshold | tests on the data sent |
| A tap reaches every student page within a second | tests; a burst of 50 takes about 1.35 s on Fly |
| One "I'm lost" per browser per slide | test and a unique index |
| Notes reach only the lecturer | tests |
| Nothing loads from another site | CSP header, browser test |
| Keyboard, phone, slow connections | browser tests in CI |
| Survives a redeploy | scripted check on Fly |
| Calm, and works in a room | judged in a mock lecture, which led to one tap per slide |

## What I read

Jane Caldwell's review "Clickers in the large classroom" (2007) reports that students liked anonymity, and "the reassurance that they're not alone even when they're wrong". Clickers only answer the lecturer's questions; this lets students raise it themselves. Robin Sloan's "An app can be a home-cooked meal" argues for software made for a few people, so this is built for one room. Clay Shirky's "Situated Software" leans on what a group already shares: here, a room, so no profiles or chat.

Demo slides adapted from Swift, B. (2026), COMP4020/COMP8020 Agentic Coding Studio, ANU, CC BY-NC-SA 4.0.

## What I didn't build

- *Names or accounts.* Being identified is what stops people asking.
- *Public questions.* In front of everyone, writing takes the courage asking does.
- *Emailing lost students.* That means knowing who they are.
- *AI moderation.* It sends anonymous notes to a third party.
- *Deleting data.* A fresh run keeps the old one.
