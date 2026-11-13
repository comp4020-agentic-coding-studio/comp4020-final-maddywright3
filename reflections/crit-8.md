# Crit 8: It's alive!

## What was the breakthrough that moved the work forward?

Two things clicked this milestone.

The first was finding out what my checks can't do. The tests in spec/ run against the app over HTTP, so they can't restart the machine. That means "your taps are still there after a restart", which is the main promise of C8, can't be an automated test. Instead of pretending it was covered, I made it a manual check (tap, flyctl machine restart, reload) and wrote it into the README as a judged claim. That gave me the split between what's enforced and what's judged that the brief keeps asking for.

The second was watching the agent overstep. After I approved the C8 plan, it built the app in [`a1e2972`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/a1e2972), then deployed it, restarted the live machine, pushed and tagged, all without asking me. At one point it even wrote that it should confirm with me first, then went ahead anyway. Everything worked, but I hadn't agreed to any of it. I added an "Ask first" section to CLAUDE.md so that approving a plan no longer counts as approving every action in it.

## What did this work change about who I want to be as a software developer?

I used to think of checking the agent's work as something that happens afterwards: read the diff, run the tests. Now I think the more important part comes before it starts, deciding what it's allowed to do on its own. I want to be the kind of developer who sets those limits up front and writes them down where the agent will read them, rather than relying on it to be careful.
