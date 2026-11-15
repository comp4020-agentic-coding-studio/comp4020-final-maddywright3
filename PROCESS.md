# Process overview

This describes the project as it stands after the C10 milestone. I rewrite it at each milestone rather than adding to it, so earlier versions live in the history ([`4a82219`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/4a82219) v1, [`fa3d4fd`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/fa3d4fd) v2).

I ran C8, C9 and C10 as self-run milestones under an extension, so the feedback at each one came from testing the deployed app myself and with two friends, not from a crit session. The README, ADRs, reflections and this file were drafted with an agent, with the convenor's permission, then edited by me.

## From the brief to an idea

I considered four ideas: a shared story, a garden that only grows with company, a shared poster, and a lecture confusion meter. I picked the meter because its situation, a room full of people at once, is the one the brief says to design for. "Good" also had a built-in tension: the app is only useful if it's honest about the room, and only safe if it never points at a person. README v1 went in first ([`3080f34`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/3080f34)) so the build had something to answer to. By v2 ([`e9413ba`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/e9413ba)) I'd cut six claims down to one idea: you can admit you're lost without being the one who admitted it.

## Stack

[ADR 001](docs/adr/001-stack.md) ([`7afd473`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/7afd473)) sets out the choice: Node 24 running TypeScript directly, node:http, node:sqlite on the /data volume, and marked as the only runtime dependency. On a 256 MB machine with one volume, a framework or a database server would cost memory for problems this app doesn't have. The price is hand-written routing and migrations, and a database API still marked experimental, which the pinned Node version contains.

For real-time I chose server-sent events. Updates flow one way, from the server to every open page, and taps go up as ordinary POSTs. SSE needs no dependency, and the browser reconnects on its own. WebSockets would add two-way messaging I don't need, and polling every second from a full lecture theatre means hundreds of requests a second for nothing.

## How I work

Claude Code builds, always from a plan I approve first. A second agent reviews each transcript against the README before I push, and I test the deployed app by hand. CLAUDE.md is the harness: whenever something went wrong, the rule that would have prevented it went in as its own commit, with the reason in brackets. Prompts are kept word for word in [docs/prompts/](docs/prompts/) ([`a967a9e`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/a967a9e)). CLAUDE.md also stops Claude Code writing the README, PROCESS.md or reflections, and in C8 it refused to write a reflection because of that rule.

## The milestones

- *C8, it's alive.* The placeholder became a working meter in one commit, [`a1e2972`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/a1e2972). Persistence can't be tested over HTTP, so I checked it by restarting the Fly machine.
- *C9, all at once.* The live gauge arrived in small commits, [`4a82219...e27d30e`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/compare/4a82219...e27d30e). [ADR 002](docs/adr/002-who-counts-as-here.md) records the one multi-person decision: a per-lecture threshold of five, set to two for the demo so two browsers can see it work.
- *C10, fly by instruments.* Anonymous browser IDs, one live tap per browser, a hashed lecturer code, and logs that use an 8-character hash ([`bf5e114...ae11de5`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/compare/bf5e114...ae11de5)). [ADR 003](docs/adr/003-who-may-see-what.md) records why a cookie beat accounts and IP addresses. In the two-person test I could narrate who did what from flyctl logs without knowing who either person was.

## Corrections that landed in the harness

| Problem | Found by | Fix | Harness change |
|---|---|---|---|
| Deployed, restarted, pushed and tagged unasked | transcript review | none needed | [`1eaf5b9`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/1eaf5b9) ask first |
| Fade test skipped while the README called it enforced | transcript review | [`0fb75fc`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/0fb75fc), [`783fcc4`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/783fcc4) | [`af2abdf`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/af2abdf) enforced claims must run |
| Total stuck at its page-load value | my two-tab test | [`a3c54db`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/a3c54db) | [`e27d30e`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/e27d30e) anything that changes updates live |
| Lecturer cookie took over the student stream | code review | [`815d5ff`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/815d5ff) | separate routes, [`ae11de5`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/ae11de5) |
| A malformed URL could crash the only process | code review | [`1ebde52`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/1ebde52) | test written first |
| An exact +1 loosened to >= before the cause was found | code review | [`09212fe`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/09212fe) | never loosen an assertion, [`ae11de5`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/ae11de5) |
| Threshold hid the text but still sent the data | code review | [`1fee710`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/1fee710), then [`a549405`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/a549405) | [`69187c2`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/69187c2) hiding isn't the same as not sending |

The last row is the one I'd point to. The failing test went in on its own first, so the history shows the gap was real before the fix.

## How I knew it was right

pnpm check runs every enforced claim against the running app, including the real 60-second fade, not a faked shorter one. When the repo went public, CI ran the same checks against the Docker image with an empty /data, and they passed on the first run. What tests can't reach, I checked by hand and wrote down as judged: persistence across a restart, the phone viewport, and the logs during the two-person test.

## My position on the reading

Sloan's home-cooked app is built for people who already know and trust each other. A lecture theatre is the opposite: a few hundred strangers sharing a room. So I take Sloan's scale but not his reason. Trust here can't come from knowing each other. It has to come from the design, which is why the thresholds matter more than any feature. Shirky's situated software fits better, because the room supplies the context and the app can drop profiles and chat. Caldwell's clicker research supports the premise that anonymity is what gets students to respond, but clickers wait for the lecturer to ask. My bet is that confusion is most useful when students can signal it unprompted.

## What's next

The C10 feedback showed that a button and a number don't show the situation. [ADR 004](docs/adr/004-a-lecture-to-be-lost-in.md) plans a lecture to be lost in: slides on a shared clock, bars per slide, one-tap reasons instead of free text, and an "I get it now" button.
