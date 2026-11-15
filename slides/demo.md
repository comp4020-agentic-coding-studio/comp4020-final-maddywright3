# Recursion

A function that calls itself. That's the whole idea — the rest of today is what makes it safe to use.

---

## Why bother?

Some problems are naturally defined in terms of smaller versions of themselves: a folder containing files and other folders, a sentence containing clauses that contain clauses, a family tree. Recursion lets the code mirror that structure directly, instead of flattening it into a loop with a manual stack.

---

## The two parts every recursive function needs

1. **A base case** — the smallest input, answered directly, with no further call.
2. **A recursive case** — a call on a smaller piece of the problem, trusting it to come back with the right answer.

Skip either one and you get an infinite loop (no base case) or you've just written an ordinary function (no recursive case).

<svg viewBox="0 0 320 90" role="img" aria-label="Two boxes: base case leads to an answer directly; recursive case leads to a smaller problem, which loops back into the function.">
  <title>Base case vs recursive case</title>
  <rect x="10" y="10" width="130" height="70" fill="none" stroke="currentColor" rx="6"></rect>
  <text x="75" y="35" text-anchor="middle" font-size="12">Base case</text>
  <text x="75" y="55" text-anchor="middle" font-size="11">answer directly</text>
  <rect x="180" y="10" width="130" height="70" fill="none" stroke="currentColor" rx="6"></rect>
  <text x="245" y="35" text-anchor="middle" font-size="12">Recursive case</text>
  <text x="245" y="55" text-anchor="middle" font-size="11">smaller problem</text>
  <line x1="245" y1="80" x2="245" y2="85" stroke="currentColor"></line>
</svg>

---

## A worked example: factorial

```
factorial(n):
  if n == 0:            # base case
    return 1
  return n * factorial(n - 1)   # recursive case
```

`factorial(4)` calls `factorial(3)`, which calls `factorial(2)`, which calls `factorial(1)`, which calls `factorial(0)` — and `factorial(0)` is the base case, so the chain finally stops and starts returning values back up.

---

## Tracing it by hand

`factorial(4)` = `4 * factorial(3)`
`factorial(3)` = `3 * factorial(2)`

...and so on down to `factorial(0)` = `1`, which gives us `24` once everything unwinds back up.

---

## The call stack

Each call to `factorial` waits for the one it made, so the computer has to remember all of them at once, stacked up, until the base case is hit and they can start resolving. This is why too much recursion without a base case causes a stack overflow, not just a slow program — each pending call takes up space.

<svg viewBox="0 0 320 130" role="img" aria-label="A stack of five call frames, factorial of 4 down to factorial of 0, with factorial of 0 at the bottom as the base case.">
  <title>The call stack during factorial(4)</title>
  <rect x="100" y="10" width="120" height="22" fill="none" stroke="currentColor"></rect>
  <text x="160" y="25" text-anchor="middle" font-size="11">factorial(4)</text>
  <rect x="100" y="34" width="120" height="22" fill="none" stroke="currentColor"></rect>
  <text x="160" y="49" text-anchor="middle" font-size="11">factorial(3)</text>
  <rect x="100" y="58" width="120" height="22" fill="none" stroke="currentColor"></rect>
  <text x="160" y="73" text-anchor="middle" font-size="11">factorial(2)</text>
  <rect x="100" y="82" width="120" height="22" fill="none" stroke="currentColor"></rect>
  <text x="160" y="97" text-anchor="middle" font-size="11">factorial(1)</text>
  <rect x="100" y="106" width="120" height="22" fill="none" stroke="currentColor"></rect>
  <text x="160" y="121" text-anchor="middle" font-size="11">factorial(0) — base case</text>
</svg>

---

## Fibonacci, where it gets expensive

```
fib(n):
  if n <= 1:
    return n
  return fib(n - 1) + fib(n - 2)
```

Looks like factorial, but each call makes *two* recursive calls instead of one. `fib(5)` calls `fib(4)` and `fib(3)`; `fib(4)` calls `fib(3)` and `fib(2)` — notice `fib(3)` just got computed twice, and that doubling compounds at every level. The shape of the recursion, not just the base case, decides how expensive it is.

---

## When to reach for it, and when not to

Recursion earns its place when the data is itself recursive — trees, nested structures, anything defined in terms of smaller copies of itself. For a plain list processed front to back, a loop is usually clearer and doesn't risk a stack overflow on a long input. Knowing which one you're looking at is most of the skill.
