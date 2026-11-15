# Crit 9: All at once

## What was the breakthrough that moved the work forward?

The tests passed and the app was still wrong, twice.

First, reading Claude Code's transcript against my README, I saw the README called the 60-second fade "enforced by tests" while that test was skipped by default. I had it run for real in [`0fb75fc`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/0fb75fc), which exposed a timing problem between the stream tests, fixed in [`783fcc4`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/783fcc4). Then I added a rule in [`af2abdf`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/af2abdf): if the README says a claim is enforced, its test has to run.

Second, my own test with two tabs. Tapping updated the gauge in both, but "Total taps" stayed stuck at 2, because only the gauge was live. Every check was green because no test looked at the total. [`a3c54db`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/a3c54db) pushed the total and tap list over the same stream, and [`e27d30e`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/e27d30e) added a rule that anything on a page that can change must update live everywhere.

The same test showed one browser could press "I'm lost" over and over and keep raising the count. That's the core of C10: one browser, one live tap, and "people here" counting browsers rather than tabs.

## What did this work change about who I want to be as a software developer?

I'd been treating a green run as proof. Now I check which tests actually ran, and I use the app myself in two windows before I believe it works. A test only checks what someone thought to write down, and clicking around found the bugs the suite couldn't.
