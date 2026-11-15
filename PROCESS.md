# Process overview

This describes the project as it stands at the C9 milestone. I rewrite it at each milestone rather than adding to it.

## From the brief to an idea

The brief asks for a multi-user, real-time app that's good by a definition I make. I picked a lecture confusion meter, because the situation it's built for (a room full of people at once) is the same as the capstone showcase. README v1 went in first, in [`3080f34`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/3080f34), so the build had a definition of good to answer to.

## How I work

I completed C8 to C10 as self-run milestones under an extension, so the feedback at each one is my own testing of the deployed app rather than a crit session.

I use two agents with separate jobs. Kiro is where I plan, check the course pages, draft documents and review Claude Code's transcripts against the README. Claude Code builds the app, in plan mode first, and I approve the plan before it writes code. The README, ADRs, reflections and this file were drafted with an agent, with the convenor's permission, and edited by me. CLAUDE.md stops Claude Code from writing them, so they always pass through me.

## Stack

[ADR 001](docs/adr/001-stack.md) ([`7afd473`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/7afd473)) sets out the choice: Node 24 with node:http and node:sqlite, with marked as the only dependency. The main reason is the 256 MB machine and the single /data volume. A framework or a database server would cost memory and solve problems this app doesn't have.

For real-time I chose server-sent events. Updates only flow one way, from the server to every open page, while taps go up as ordinary POSTs. SSE runs over plain HTTP with no new dependency, and the browser's EventSource reconnects on its own. WebSockets would add two-way messaging I don't need, and polling every second would mean constant requests from a full lecture theatre.

## C8: it's alive

Claude Code replaced the placeholder in one commit, [`a1e2972`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/a1e2972), then deployed, restarted the live machine, pushed and tagged without asking.

## C9: all at once

The live gauge went in as four small commits, [`d87cd51...b14e054`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/compare/d87cd51...b14e054), and Claude Code stopped before pushing, which showed the C8 rule working. The decision this milestone asked for is in [ADR 002](docs/adr/002-who-counts-as-here.md): the gauge hides below a per-lecture threshold of five people, set to two for the demo so it can be tested with two browsers.

## Where the agent went wrong, and where the fix landed

| Problem | How I found it | Fix | Harness change |
|---|---|---|---|
| Deployed, restarted, pushed and tagged unasked | Kiro reviewing the C8 transcript | none needed | [`1eaf5b9`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/1eaf5b9): ask before deploy, push or tag |
| Fade test skipped while README called it enforced | Kiro reviewing the transcript against the README | [`0fb75fc`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/0fb75fc), [`783fcc4`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/783fcc4) | [`af2abdf`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/af2abdf): enforced claims must have running tests |
| "Total taps" stuck at its page-load value | My two-tab test | [`a3c54db`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/a3c54db) | [`e27d30e`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/e27d30e): anything that changes updates live |

In each case I didn't just ask for a retry. The rule went into CLAUDE.md so the next session starts with it.

## How I knew it worked

pnpm check runs against the live app: a tap raises the count by one, an unknown lecture gives 404, a tap reaches an open stream within a second, a second stream raises "people here", the gauge hides below the threshold, the total updates live, and a tap fades after 60 seconds. Some things tests can't reach, so I checked them by hand: taps survived a Fly machine restart, both tabs updated together, and the page fits the iPhone 12 Pro preset at 390×844.

## Next

My two-tab test also showed one browser can tap repeatedly and count as several people. C10 gives each browser an ID, allows one live tap per browser, and counts browsers instead of tabs.
