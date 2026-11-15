# Crit 10: Fly by instruments

## What was the breakthrough that moved the work forward?

Watching two people use the app from the URL alone while I read the logs. The logs did their job. Each person showed up as a different short hash, 5cbf9db8 and 926e1fce, and I could say who viewed, who tapped and who logged in as lecturer without knowing who either of them was. That's the README's idea holding on the server side, backed by the privacy rules in [`ae11de5`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-maddywright3/commit/ae11de5).

What they told me mattered more. A button and a number in two windows didn't show what the app is for. They wanted an actual lecture to tap against, a graph of how many others were lost and where, and a way to say why. In my own two-tab test, "You're counted" also gave no sign of when I could tap again.

A review of the build afterwards found a bigger problem. Below the threshold, the gauge text was hidden, but the stream still carried the live count and the total, so anyone watching the total could see a tap happen. The promise held on screen and failed in the data.

## What did this work change about who I want to be as a software developer?

I want to test promises where they can actually break, in the data that leaves the server, not in what the page happens to show. I also want to watch real people use what I build before deciding it's good. Every check passed while the app still didn't show the situation it exists for.
