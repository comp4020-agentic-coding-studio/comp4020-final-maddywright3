Slides adapted from COMP4020/COMP8020 Agentic Coding Studio, Week 6:
Evidence of practice, by Swift, B. (2026). ANU School of Computing.
Licensed CC BY-NC-SA 4.0. <https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/lectures/week-6/>
Cite as: Swift, B. (2026). _COMP4020/COMP8020 Agentic Coding Studio_ [Course materials]. ANU School of Computing. https://doi.org/10.5281/zenodo.21395760

---

<!-- duration: 22 -->
## continuous integration

a series of checks that runs on every push, on a machine that isn't yours

GitHub Actions in our case, configured by `.github/workflows/checks.yml` in your
repo; the idea is [decades older](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/topics/github-actions-basics/)

---

<!-- duration: 10 -->
## one push, one run

---

<!-- duration: 10 -->
# which box does what?

---

<!-- duration: 32 -->
## the same checks at two distances

**local**: `pnpm check` in seconds, while the agent still holds the context that
produced the mistake

**the runner**: the same command on a clean machine, which tests whether the
code works anywhere other than the machine it was written on

if CI gives different results to local dev, then...

---

<!-- duration: 30 -->
## runner-only failures

```text
✓ check   in 29s
✗ deploy  in 19s
    ✗ Run actions/configure-pages@v6
##[error] Get Pages site failed. Please verify that the
repository has Pages enabled and configured to build
using GitHub Actions
```

the demo repo's first day, for real: every check green, and the deploy still
failed

---

<!-- duration: 42 -->
## reading a red run

```text
$ gh run view 37084179269
X deploy in 2m32s (ID 111090928068)
  ✓ Verify the deployed site is online
  X Verify the LiveView socket upgrades
$ gh run view 37084179269 --log-failed
the LiveView socket did not upgrade (HTTP 400).
If it is 403, the app thinks it is serving some
other host: check PHX_HOST and FLY_APP_NAME …
##[error]Process completed with exit code 1.
```

the failing step's output gives the agent somewhere to look (lecture-demos, 3
October; trimmed)

---

<!-- duration: 31 -->
## always-red checks

week 3's fourth property was **trustworthy**: you learn to scroll past a check
that's always red, and then the real failure goes unnoticed too

e.g. the crit template's link check skips outbound links, because someone else's
rate limiter or outage would turn every build red (see the comment in
`checks.yml`)

---

<!-- duration: 33 -->
## green when the sweep runs

[the crit sweep](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/topics/studio-crit-model/#in-crit-prototype-marks) starts
fifteen minutes after your cutoff: pushed, live at its URL, reflection in the
folder — and then it reads your checks

**green**: the full shipping mark

**red, still running, or no checks**: half

those fifteen minutes are settling time — push early enough that the run
finishes

---

<!-- duration: 90 -->
## One push, one GitHub Actions run

<div class="diagram-actions-run">
<svg viewBox="0 0 1160 520" role="img" aria-labelledby="actions-run-title actions-run-desc"> <title id="actions-run-title">One push, one GitHub Actions run</title> <desc id="actions-run-desc">
You run git push from your laptop. GitHub starts a fresh ubuntu-latest
      virtual machine with nothing of yours on it. The check job's steps run in
      order: checkout, mise-action to install the pinned node and pnpm, pnpm
      install with the frozen lockfile, pnpm check, pnpm check:evidence, a link
      check over dist, and a secret scan. The result comes back to the commit on
      GitHub as a tick or a cross, readable with gh run view, and the virtual
      machine is discarded.
</desc> <defs> <marker id="actions-run-head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"> <path class="head" d="M 0 0 L 10 5 L 0 10 z"></path> </marker> </defs> <!-- your laptop --> <text class="title" x="40" y="40">your laptop</text> <rect class="window you" x="40" y="60" width="340" height="440" rx="12"></rect> <rect class="block you" x="56" y="76" width="308" height="44" rx="6"></rect> <text class="code" x="72" y="105">git push</text> <text class="note" x="72" y="156">node_modules, your .env,</text> <text class="note" x="72" y="184">your global tools:</text> <text class="note" x="72" y="212">none of it leaves</text> <!-- 1: a fresh machine starts --> <g> <text class="title" x="640" y="40">a fresh runner VM</text> <rect class="window runner" x="640" y="60" width="480" height="440" rx="12"></rect> <text class="note" x="656" y="96">ubuntu-latest, nothing of yours on it</text> <path class="arrow msg" d="M 364 98 C 470 70, 540 70, 632 90"></path> <text class="label msg" x="500" y="58" text-anchor="middle">push event</text> </g> <!-- 2: the check job's steps, in order --> <g>  <rect class="block step" x="656" y="112" width="448" height="40" rx="6"></rect> <text class="code" x="672" y="139"> actions/checkout </text>  <rect class="block step" x="656" y="160" width="448" height="40" rx="6"></rect> <text class="code" x="672" y="187"> mise-action (node, pnpm) </text>  <rect class="block step" x="656" y="208" width="448" height="40" rx="6"></rect> <text class="code" x="672" y="235"> pnpm install --frozen-lockfile </text>  <rect class="block step" x="656" y="256" width="448" height="40" rx="6"></rect> <text class="code" x="672" y="283"> pnpm check </text>  <rect class="block step" x="656" y="304" width="448" height="40" rx="6"></rect> <text class="code" x="672" y="331"> pnpm check:evidence </text>  <rect class="block step" x="656" y="352" width="448" height="40" rx="6"></rect> <text class="code" x="672" y="379"> linkinator ./dist </text>  <rect class="block step" x="656" y="400" width="448" height="40" rx="6"></rect> <text class="code" x="672" y="427"> trufflehog (secrets) </text>  </g> <!-- 3: the result lands on the commit; the VM is discarded --> <g> <rect class="block msg" x="56" y="300" width="308" height="84" rx="6"></rect> <text class="label" x="72" y="334">✓ or ✗ on the commit</text> <text class="code" x="72" y="368">gh run view</text> <path class="arrow msg" d="M 632 440 C 520 440, 460 400, 372 350"></path> <text class="label msg" x="500" y="470" text-anchor="middle">
status
</text> <text class="note" x="1104" y="490" text-anchor="end">
then the VM is thrown away
</text> </g> </svg>

</div>

You run `git push` from your laptop. GitHub starts a fresh `ubuntu-latest`
virtual machine with nothing of yours on it. The check job's steps run in
order: checkout, mise-action to install the pinned node and pnpm, `pnpm
install` with the frozen lockfile, `pnpm check`, `pnpm check:evidence`, a
link check over `dist`, and a secret scan. The result comes back to the
commit on GitHub as a tick or a cross, readable with `gh run view`, and the
virtual machine is discarded.
