# Rules for this repo

## Stack (see docs/adr/001-stack.md)
- Node 24 + TypeScript run directly, node:http, node:sqlite. No frameworks or new dependencies without asking me first.
- Serve HTTP on 0.0.0.0:$PORT.
- All persistent data lives under DATA_DIR (/data on Fly, ./data locally). Nothing that must survive a restart goes anywhere else.

## Never
- Never change fly.toml settings, spec/invariants.test.ts or the shipped CI checks.
- Never commit mise.local.toml or any secret.
- Never write README.md, PROCESS.md or reflections/. I write those.
- Never loosen an assertion to make a test pass. Find the cause first. (Added in C10, when an exact +1 was relaxed to >= before the real cause, parallel test files, was found.)
- Never rm -rf. Test a fresh database with a temporary DATA_DIR.
- Never use emoji in any file or commit message. (Added after an emoji replaced ":[" in a pasted payload in docs/feedback/finish.md.)

## Every change
- /readme/ renders README.md on the server, so headings are in the HTML before any script runs.
- Works at 390x844 and 1920x1080, and with the keyboard alone.
- Every behaviour change comes with a test in spec/. Run pnpm check before saying it's done.
- When I correct you, suggest a rule for this file or a test in spec/ so it can't happen again.
- If README.md says a claim is enforced, its test must run in pnpm check. Never skip it. (Added in C9, when the fade test was skipped while the README called it enforced.)
- Anything on a page that can change must update live in every open session. (Added in C9, when the total stayed stale after a tap.)

## Privacy (from the README's one idea)
- No page, stream, JSON response or log line contains a raw browser ID, cookie, lecture code or session token. Logs use the first 8 hex characters of sha256.
- Exception: the demo lecture's code, DEMO, is public on purpose and may be shown on the demo's pages only. No other lecture code is ever shown after it's created. (ADR 003: markers need to get in.)
- No per-person history is ever shown. Taps are shown as counts per slide, by distinct browser.
- Lecturer and student state travel on separate routes.
- live and totalTaps only leave the server when present >= min_present, in any page, stream or response. Hiding it on screen isn't enough. (Added after C10, when the gauge text was hidden but the stream still carried the live count and total.)
- A slide's bar, its reason counts, and its notes are each gated on their own distinct-browser count (>= min_present), independent of present/shown — a lone returning visitor still sees a slide's history once it individually qualifies. (Refined in ADR 004 so a returning visitor still sees history.) A browser may always see its own counts.
- Any derived number (a share, a ranking, the hardest slide) appears only when every count behind it is at least min_present. (Added for the lecturer dashboard: a share reveals its numerator.)
- Student text (notes) is lecturer-only: never shown to students, never logged, never sent to a third party. Reasons come from a fixed list checked on the server; never add free-text input for students. (Changed in the ADR 004 amendment.)
- Never load anything from a third party (embeds, fonts, analytics, CDNs).
- Every page must work without JavaScript.

## Ask first
- Ask before any deploy, machine restart, push or tag, even if a plan mentions it. (Added after C8, when the agent did all four unasked.)
- Commit in small steps, one change each, with a message saying why.
- Rules live in this file, not in agent memory.
