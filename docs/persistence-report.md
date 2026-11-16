# Persistence report

Ran on commit `0bc55cd` against https://comp4020-final-maddywright3.fly.dev, lecture `5b9e5716` ("Persistence check").
5 browsers each tapped slides 1 and 2, chose the same reason and left a note on both.

| Event | Time (UTC) |
|---|---|
| Recorded before | 2026-11-16T12:43:15.830Z |
| Machine seen stopped | never; gave up at 2026-11-16T13:03:25.458Z |
| Machine started by the next request | not reached |
| Redeployed and compared | 2026-11-16T13:04:17.137Z |

Fields marked expected are meant to change: nobody is connected after a stop (present, shown) and taps stop counting as live (live, youAreCounted, liveForMs, topReason).

## After the machine stopped and started

Not reached.

## After a redeploy

No field changed.

## Result

Nothing that should persist changed.

Screenshots in docs/screenshots/persistence/: 1-before-student-1.png and 1-before-lecturer.png, then 3-after-redeploy-student-1.png and 3-after-redeploy-lecturer.png. There are no after-stop screenshots because the machine never stopped.

## Why the machine didn't stop

The script closed every stream and page by 12:43:19. Fly stops an idle machine only when nothing is connected through its proxy, and the app's log shows two demo streams (who 926e1fce and 42bbe8ac) reconnecting the moment the redeploy finished, so they had stayed open through the whole wait. They belong to browsers left open on the live demo, not to this script, so the stop and start couldn't be tested. The redeploy check stands: it restarts the app process and the machine, and every field that should persist was unchanged.

The raw before and after JSON snapshots aren't committed: they hold the lecturer's note text, which CLAUDE.md keeps out of logs and files.
