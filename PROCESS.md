# Process overview

This describes the project at submission. Earlier versions are in the history ([`4a82219`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/4a82219) at C8, [`fa3d4fd`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/fa3d4fd) at C9). I ran C8 to C10 as self-run milestones under an extension, so feedback came from my own testing, friends, a stranger and a mock lecture. The README, ADRs, reflections and this file were drafted with an agent, with the convenor's permission, and edited by me.

## From the brief to an idea

In a first-year Java lecture I was lost on a slide everything after it depended on, and didn't ask. At a drop-in session I found many others had been stuck there, the fix took a minute, and the lecturer wished someone had told him. README v1 went in before any code ([`3080f34`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/3080f34)). By v2 ([`e9413ba`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/e9413ba)) six claims had become one idea: you can admit you're lost without being the one who admitted it.

## Stack

[ADR 001](docs/adr/001-stack.md) ([`7afd473`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/7afd473)): Node 24 running TypeScript directly, `node:http`, `node:sqlite` on the /data volume, and `marked` as the only runtime dependency. On a 256 MB machine, a framework or database server costs memory for problems this app doesn't have. The price is hand-written routing and migrations. Server-sent events carry updates, because they only flow out, and taps go up as ordinary POSTs. WebSockets add two-way messaging I don't need, and polling wastes requests.

Under load, 50 simultaneous taps took 1.49 s on Fly. Measuring one tap showed SQLite syncing to disk after each insert, so [ADR 005](docs/adr/005-durability-and-bursts.md) moved to WAL and at most one update per lecture every 50 ms. That gave 580 to 670 ms ([`10a14f9`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/10a14f9)), at the cost of the last second of taps in a host power cut. Later features pushed the burst back to about 1.35 s. Single taps still arrive well inside a second, and I accepted that rather than optimise again before submission.

## How I work

Claude Code builds from a plan I approve, and every prompt is saved word for word in [docs/prompts/](docs/prompts/) ([`a967a9e`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/a967a9e)). A second agent reviews each transcript against the README before I push, and I test the deployed app by hand. CLAUDE.md is the harness: each rule is its own commit, with its reason in brackets.

In the finishing stage, a subagent reviewed the plan against the code first ([plan review](docs/feedback/finish.md)) and caught that "I get it now" would block re-tapping. The rest ran as five main slices, with up to seven agents at once in separate worktrees, merged as each finished. One stalled, so I restarted its work on main and left its branch unmerged. I checked agent reports against their branches, and when one approved load test became nine, that became a rule ([`ae9e31d`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/ae9e31d)).

## The milestones

- *C8:* a working meter ([`a1e2972`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/a1e2972)).
- *C9:* the live gauge ([`4a82219...e27d30e`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/compare/4a82219...e27d30e)). [ADR 002](docs/adr/002-who-counts-as-here.md) sets a threshold of five, two for the demo.
- *C10:* anonymous browser IDs, a hashed lecturer code and hashed logs ([`bf5e114...ae11de5`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/compare/bf5e114...ae11de5)). [ADR 003](docs/adr/003-who-may-see-what.md) says why a cookie beat accounts and IP addresses.
- *Finishing:* friends said a button and a number didn't show what the app was for, so [ADR 004](docs/adr/004-a-lecture-to-be-lost-in.md) went in before the code. I threw away my drafted deck ([`4cf2a17`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/4cf2a17)) for real course slides ([`fee4f65`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/fee4f65)), dropped a grace rule once students could browse back ([`6e1da59`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/6e1da59)), and allowed lecturer-only notes after first ruling out free text ([`61b8da0`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/61b8da0)). The stranger test led to the timeline, the mock lecture to one tap per slide, and a blank lecturer view to the dashboard. I rejected AI moderation, and reversed my rejection of numbering students: the log shows "Person N", reset each run, only once enough people are present ([ADR 006](docs/adr/006-runs-timing-and-your-own-lecture.md)).

## Corrections that landed in the harness

| Problem | Found by | Fix | Harness change |
|---|---|---|---|
| Deployed and tagged unasked | transcript review | none | [`1eaf5b9`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/1eaf5b9) ask first |
| Fade test skipped but called enforced | transcript review | [`0fb75fc`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/0fb75fc) | [`af2abdf`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/af2abdf) enforced claims run |
| Total stuck at its page-load value | two-tab test | [`a3c54db`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/a3c54db) | [`e27d30e`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/e27d30e) everything updates live |
| Threshold hid the text, sent the data | code review | [`1fee710`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/1fee710), [`a549405`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/a549405) | [`69187c2`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/69187c2) hiding isn't not sending |
| Without JS, a note on the wrong slide | diagnosis | [`77b741c`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/77b741c), [`e0b6a72`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/e0b6a72) | test first |
| Focus lost after a tap | keyboard test | [`dc66e58`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/dc66e58) | fails with the old line restored |
| Log sent below the threshold | consistency check | [`7538165`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/7538165), [`0085a6d`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/0085a6d) | covered by safety in numbers |
| Pasted text became emoji | non-ASCII grep | line corrected | [`6dd4b20`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/6dd4b20) no emoji |

Where a fix has two commits, the first is the failing test, committed on its own, so the history shows the problem was real before I accepted the fix.

## How I knew it was right

`pnpm check` runs 256 tests against the running app, including real fade times. CI runs them against the Docker image with an empty /data, plus Chromium tests at both viewports. On the live site, 39 of 39 checks passed with no axe violations ([docs/checks/](docs/checks/)). The load test had its own timing bug ([`57955ae`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/57955ae)), and the persistence check ([`df1d7cb`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/df1d7cb)) only counted once it caught a snapshot I'd deliberately damaged. Every field survived a redeploy ([report](docs/persistence-report.md), [`8885ce4`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/8885ce4)). Open demo tabs blocked the scripted machine stop, so I checked that by hand.

## Reading the code myself

I traced the gauge sentence ("2 of 3 people are lost right now"), expecting one place, and found four: a comment, the server render, the browser script that rebuilds it on every update, and a test. The screen-reader sentence was separate, and I kept it short. I changed the wording to "people here" ([`3ea713b`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/3ea713b)), with the exact lines worked out with an agent, then checked in two windows that it survived a live update. What surprised me was that the browser rebuilds the sentence itself, so missing either copy brings the old wording back after one tap.

## My position on the reading

Sloan's home-cooked app serves people who already trust each other. A lecture theatre is strangers, so I take his scale but not his reason, and trust has to come from the thresholds. Shirky's situated software fits better: the room supplies the context. Caldwell backs the premise that students value anonymity and seeing they're not alone. Where I depart is who starts the signal: clickers wait for the lecturer, but confusion is most useful raised by students, on the slide where it happened.
