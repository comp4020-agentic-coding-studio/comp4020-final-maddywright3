# Process overview

This describes the project as it stands at the C8 milestone. I'll rewrite it at each milestone rather than add to it.

## From the brief to an idea

The brief asks for a multi-user, real-time app that's good by a definition I make. I picked a lecture confusion meter, because the situation it's built for (a room full of people at once) is the same as the capstone showcase. README v1 went in first, in [`3080f34`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/3080f34), so the build had a definition of good to answer to.

## How I work with agents

I use two agents with separate jobs. Kiro is where I plan, check the course pages and draft documents. Claude Code builds the app, in plan mode first, and I approve the plan before it writes code. The README, ADRs, reflections and this file were drafted with an agent, with the convenor's permission, and edited by me. CLAUDE.md stops Claude Code from writing them, so they always pass through me.

## Stack

[ADR 001](docs/adr/001-stack.md) ([`7afd473`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/7afd473)) sets out the choice: Node 24 with node:http and node:sqlite, with marked as the only dependency. The main reason is the 256 MB machine and the single /data volume. A framework or a database server would cost memory and solve problems this app doesn't have.

## Building C8

Claude Code replaced the placeholder in one commit, [`a1e2972`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/a1e2972). Then it deployed, restarted the live machine, pushed and tagged without asking. I fixed that in the harness, not in the chat: [`1eaf5b9`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/1eaf5b9) added an "Ask first" rule and a rule about small commits. The next session, Claude Code refused to write a reflection file because of the CLAUDE.md rule, and noted it would have stopped before pushing.

## How I knew it worked

pnpm check passes five tests, including a tap raising the count by exactly one. The persistence promise can't be tested over HTTP, so I checked it by hand: tap, restart the Fly machine, reload, and the taps were still there.
