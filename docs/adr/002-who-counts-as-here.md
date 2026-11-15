# ADR 002: When the gauge shows, and who counts as "here"

Status: accepted, 13 November 2026 (C9 milestone)

## Context

README.md promises the meter "hides you in a crowd": the gauge stays blank until enough people have the lecture open, because in a room of two, a tap is a confession. The brief's real-time test points the other way. Markers open two browsers and expect a change in one to appear in the other within about a second. With a blank-below-five rule, they would see nothing happen.

C9 also has to decide who sees the gauge, and what someone sees when they reconnect.

## Options

1. *Always show the gauge.* Simplest, and markers see it work, but in a small room a tap can point to a person.
2. *Blank below five for every lecture.* Strongest privacy, but the demo looks broken to anyone testing with two browsers.
3. *A threshold per lecture: five by default, two for the demo.* Real lectures keep the protection, and the demo shows the real-time behaviour.

## Decision

Option 3. lectures.min_present defaults to 5, and the demo lecture is set to 2 ([`d87cd51`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/d87cd51)). Below the threshold, the page says how many more people are needed.

Students see the gauge too, not just the lecturer. The README's problem is "you're never sure if it's just you", and the gauge is the answer to that.

"Here" means an open live connection to the lecture page. The server keeps these in memory ([`6839824`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/6839824)) and sends the full state to every connection when anything changes, and to each new connection as soon as it opens. A student who drops out and reconnects sees the current gauge straight away, not a replay of what they missed.

## What it costs

- *The demo is less private than a real lecture.* With two people in the demo, a tap tells the other person it was you. The README says the demo uses two so it can be tried with two browsers.
- *It counts tabs, not people.* One person with five tabs open would unlock the five-person gauge. Fixing this needs a browser ID, which is C10's job.
- *A restart drops every connection.* The connection list lives in memory. Browsers reconnect on their own and get the full state again, so the cost is a second or two of a stale gauge.
- *Open pages keep the machine awake.* Fly can't auto-stop the machine while anyone has a lecture open. For a lecture-length session that's a few cents.
- *CI takes about a minute longer.* The 60-second fade is tested for real ([`0fb75fc`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/0fb75fc)) instead of being faked with a shorter window.
