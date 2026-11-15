# ADR 003: Who counts as a person, and who may see what

Status: accepted, 15 November 2026 (C10 milestone)

## Context

C9 counted open connections, so five tabs were five people, and one browser could tap as often as it liked. The README promises one browser, one voice, and that nobody, including the lecturer, learns who tapped. The C10 crit asks for what each person may see and change to be checked on the server, and for the logs to show who did what.

## Options for "a person"

1. *Accounts* (university login or email). Real people, but being identified is what stops people asking.
2. *A chosen pseudonym.* Still something others can link to you.
3. *An anonymous browser ID in a cookie.* No name, one per browser, never shown to anyone else. A new private window is a new person.
4. *IP address.* Stops private-window repeats, but a lecture theatre on campus wifi shares a few addresses, so a whole room would count as a handful of people.

## Options for the lecturer

1. *Accounts.* Too heavy for one lecture.
2. *A secret link.* Easy to forward, or leak in a screenshot of the address bar.
3. *A short code per lecture, stored hashed.* Can be read aloud to a co-lecturer, and can't be recovered from the database.

## Decision

Option 3 for people and option 3 for lecturers.

- A random 128-bit ID is created on a browser's first visit and stored in a browsers table ([`9b3e7da`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/9b3e7da), [`ef5c149`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/ef5c149)). A tap or stream with a missing or unknown ID is rejected, never given a fresh identity.
- "People here" counts browsers with an open stream, not connections ([`be4accc`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/be4accc)).
- One live tap per browser is enforced in a single SQL statement, so two requests at the same moment can't both get in.
- Lecture codes are hashed with scrypt and compared in constant time. A correct code creates a session cookie. The lecturer has a separate stream at /l/:id/lecturer/events ([`815d5ff`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/815d5ff)), so a lecturer who also opens the student page is counted as a student there.
- Each action logs one JSON line with the first 8 hex characters of a SHA-256 of the browser ID. The logs can tell people apart without holding anything that identifies them.
- Malformed URLs and cookies are rejected instead of crashing the single process ([`1ebde52`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/1ebde52)).

## What it costs

- *A private window beats it.* So could a script that loads the page before every tap. Accepted, because the alternative (IP) breaks the real use case.
- *Clearing cookies resets* "You've said you're lost N times".
- *The demo code is public* on purpose, so anyone can open the demo lecturer view.
- *Ten wrong codes lock everyone out* of that lecture's lecturer view for a minute, because the limit is per lecture.
- *Anyone can create a lecture* at /new, with no limit.
- *Lecturer sessions never expire.*
- *Hashed IDs are stable*, so the logs can follow one browser's actions. They can't be turned back into the cookie.
- *The Secure cookie flag trusts* Fly's proxy to set x-forwarded-proto.

## Found after acceptance

The threshold hid the gauge text but the stream still carried the live count and total. That was fixed after C10, with a test that checks the data itself, and a CLAUDE.md privacy rule.
