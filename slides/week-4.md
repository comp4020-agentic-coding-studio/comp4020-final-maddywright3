Slides adapted from COMP4020/COMP8020 Agentic Coding Studio, Week 4:
Context engineering, by Swift, B. (2026). ANU School of Computing.
Licensed CC BY-NC-SA 4.0. <https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/lectures/week-4/>
Cite as: Swift, B. (2026). _COMP4020/COMP8020 Agentic Coding Studio_ [Course materials]. ANU School of Computing. https://doi.org/10.5281/zenodo.21395760

---

<!-- duration: 10 -->
# context: the agent's working memory

---

<!-- duration: 33 -->
## the window is a budget

the **context window** is everything the model reads on a turn: system prompt,
tool definitions, `CLAUDE.md`, skill descriptions, then the conversation so far
([Claude Code docs](https://code.claude.com/docs/en/context-window))

each model has a hard limit (e.g. 1M tokens), but early instructions slip well
before it

(the name is the field's, from mid-2025: Karpathy's "filling the context window
with just the right information for the next step")

---

<!-- duration: 33 -->
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

<!-- duration: 22 -->
## what to include?

**too little**: it guesses at a convention your repo already follows

**too much**: unrelated history and every test file crowd out the part you asked
about

the levers for that trade-off: `/clear`, caching, compaction, skills

---

<!-- duration: 26 -->
## one task per session

keep going while the workstream is coherent; `/clear` when the job changes

a failed approach in the window can inform the next attempt — four of them bias
the fifth towards the same error

`/resume` to re-load the context from a previous session (sometimes)

---

<!-- duration: 30 -->
## prompt caching

after the first turn the prefix is cached, so each re-send of it reads back at a
tenth of the input price

writing it costs 2x once, reading it back 0.1x every turn after

**an hour**: the idle window before it expires, and the next turn is billed for
writing the whole thing again

---

<!-- duration: 24 -->
## Claude Code cheatsheet

`/clear` starts a fresh conversation in the same directory — `CLAUDE.md` stays,
everything else goes

`/resume` reopens an earlier session, context and all

`@filename.md` pulls a whole file into the context

`/model` and `/effort` are the two cost levers

---

<!-- duration: 26 -->
## compaction

near the limit (or on `/compact`) the history is replaced by a summary of it

**re-loaded**: system prompt, root `CLAUDE.md`, skills, up to five files it read
or edited
([docs](https://code.claude.com/docs/en/context-window#what-survives-compaction))

**summarised away**: everything else you said, and what it tried

so write a `plan.md`, `/clear`, then `@plan.md`

---

<!-- duration: 20 -->
## skills vs claude files

**`CLAUDE.md`**: loaded every session, so it costs tokens every turn

a **skill**: its description is loaded every session; the rest of the file only
when it's invoked

([skills docs](https://code.claude.com/docs/en/skills))

---

<!-- duration: 76 -->
## When a skill's body loads

<div class="diagram-skill-loading">
<svg viewBox="0 0 1160 520" role="img" aria-labelledby="skill-loading-title skill-loading-desc"> <title id="skill-loading-title">When a skill's body loads</title> <desc id="skill-loading-desc">
The context window holds the system prompt and tools, CLAUDE.md, and a
      listing of four skill descriptions (start, preflight, ship, handbook),
      each an estimated 85 to 105 tokens. On disk, each skill's full SKILL.md
      body is an estimated 1,700 to 3,200 tokens. Typing /comp4020:preflight, or
      the agent matching the description, copies the preflight body (about 1,950
      tokens) into the context window, where it stays for the rest of the
      session.
</desc> <defs> <marker id="skill-loading-head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"> <path class="head" d="M 0 0 L 10 5 L 0 10 z"></path> </marker> </defs> <!-- the context window at the first turn --> <text class="title" x="40" y="40">the context window</text> <rect class="window ctx" x="40" y="60" width="440" height="440" rx="12"></rect> <rect class="block always" x="56" y="76" width="408" height="44" rx="6"></rect> <text class="label" x="72" y="106">system prompt and tools</text> <rect class="block always" x="56" y="128" width="408" height="44" rx="6"></rect> <text class="label" x="72" y="158">CLAUDE.md</text> <text class="note" x="448" y="158" text-anchor="end">every turn</text> <text class="note" x="72" y="206">skill listing: descriptions only</text>  <rect class="block listing" x="56" y="218" width="408" height="34" rx="6"></rect> <text class="code" x="72" y="241"> start </text> <text class="code dim" x="448" y="241" text-anchor="end"> ~105 </text>  <rect class="block listing" x="56" y="258" width="408" height="34" rx="6"></rect> <text class="code" x="72" y="281"> preflight </text> <text class="code dim" x="448" y="281" text-anchor="end"> ~100 </text>  <rect class="block listing" x="56" y="298" width="408" height="34" rx="6"></rect> <text class="code" x="72" y="321"> ship </text> <text class="code dim" x="448" y="321" text-anchor="end"> ~105 </text>  <rect class="block listing" x="56" y="338" width="408" height="34" rx="6"></rect> <text class="code" x="72" y="361"> handbook </text> <text class="code dim" x="448" y="361" text-anchor="end"> ~85 </text>  <!-- the skills on disk --> <text class="title" x="700" y="40">skills on disk</text> <rect class="window disk" x="700" y="60" width="420" height="440" rx="12"></rect>  <rect class="block body" x="716" y="76" width="388" height="60" rx="6"></rect> <text class="code" x="732" y="102"> start/SKILL.md
</text> <text class="note" x="732" y="126">
body ~3,200 tokens
</text>  <rect class="block body chosen" x="716" y="148" width="388" height="60" rx="6"></rect> <text class="code" x="732" y="174"> preflight/SKILL.md
</text> <text class="note" x="732" y="198">
body ~1,950 tokens
</text>  <rect class="block body" x="716" y="220" width="388" height="60" rx="6"></rect> <text class="code" x="732" y="246"> ship/SKILL.md
</text> <text class="note" x="732" y="270">
body ~3,000 tokens
</text>  <rect class="block body" x="716" y="292" width="388" height="60" rx="6"></rect> <text class="code" x="732" y="318"> handbook/SKILL.md
</text> <text class="note" x="732" y="342">
body ~1,700 tokens
</text>  <text class="note" x="716" y="400">estimates: tokens ≈ characters ÷ 4</text> <!-- 1: invoking it copies the body into the window --> <g> <text class="code msg" x="590" y="240" text-anchor="middle">/comp4020:</text> <text class="code msg" x="590" y="266" text-anchor="middle">preflight</text> <path class="arrow msg" d="M 712 170 C 640 300, 580 360, 472 400"></path> <rect class="block loaded" x="56" y="380" width="408" height="60" rx="6"></rect> <text class="label" x="72" y="408">preflight body</text> <text class="code" x="448" y="408" text-anchor="end"> ~1,950 </text> <text class="note" x="72" y="432">stays for the rest of the session</text> </g> </svg>

</div>

The context window holds the system prompt and tools, CLAUDE.md, and a
listing of four skill descriptions (start, preflight, ship, handbook), each
an estimated 85 to 105 tokens. On disk, each skill's full SKILL.md body is an
estimated 1,700 to 3,200 tokens. Typing `/comp4020:preflight`, or the agent
matching the description, copies the preflight body (about 1,950 tokens)
into the context window, where it stays for the rest of the session.
