Slides adapted from COMP4020/COMP8020 Agentic Coding Studio, Week 4:
Context engineering, by Swift, B. (2026). ANU School of Computing.
Licensed CC BY-NC-SA 4.0. <https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/lectures/week-4/>
Cite as: Swift, B. (2026). _COMP4020/COMP8020 Agentic Coding Studio_ [Course materials]. ANU School of Computing. https://doi.org/10.5281/zenodo.21395760

---

# context: the agent's working memory

---

## the window is a budget

the **context window** is everything the model reads on a turn: system prompt,
tool definitions, `CLAUDE.md`, skill descriptions, then the conversation so far
([Claude Code docs](https://code.claude.com/docs/en/context-window))

each model has a hard limit (e.g. 1M tokens), but early instructions slip well
before it

(the name is the field's, from mid-2025: Karpathy's "filling the context window
with just the right information for the next step")

---

## `/context`, before the first prompt

```text
Model: claude-opus-5-5   Tokens: 10.1k / 1m (1%)

System prompt               1.5k
System tools (deferred)     8.1k
Memory files                1.9k   ~/.claude/CLAUDE.md
Skills                      6.6k   one description per skill
Free space                956.9k
Autocompact buffer         33k
```

all of that is re-sent on **every** turn; your messages and tool results pile on
top

(Ben's setup in an empty directory, Claude Code 2.1.305, trimmed and annotated;
run it in yours)

---

## what to include?

**too little**: it guesses at a convention your repo already follows

**too much**: unrelated history and every test file crowd out the part you asked
about

the levers for that trade-off: `/clear`, caching, compaction, skills

---

## one task per session

keep going while the workstream is coherent; `/clear` when the job changes

a failed approach in the window can inform the next attempt — four of them bias
the fifth towards the same error

`/resume` to re-load the context from a previous session (sometimes)

---

## prompt caching

after the first turn the prefix is cached, so each re-send of it reads back at a
tenth of the input price

writing it costs 2x once, reading it back 0.1x every turn after

**an hour**: the idle window before it expires, and the next turn is billed for
writing the whole thing again

---

## Claude Code cheatsheet

`/clear` starts a fresh conversation in the same directory — `CLAUDE.md` stays,
everything else goes

`/resume` reopens an earlier session, context and all

`@filename.md` pulls a whole file into the context

`/model` and `/effort` are the two cost levers

---

## compaction

near the limit (or on `/compact`) the history is replaced by a summary of it

**re-loaded**: system prompt, root `CLAUDE.md`, skills, up to five files it read
or edited
([docs](https://code.claude.com/docs/en/context-window#what-survives-compaction))

**summarised away**: everything else you said, and what it tried

so write a `plan.md`, `/clear`, then `@plan.md`

---

## skills vs claude files

**`CLAUDE.md`**: loaded every session, so it costs tokens every turn

a **skill**: its description is loaded every session; the rest of the file only
when it's invoked

([skills docs](https://code.claude.com/docs/en/skills))
