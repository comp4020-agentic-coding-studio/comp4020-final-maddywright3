# Automated browser checks on the live site

- Site: https://comp4020-final-maddywright3.fly.dev (deployed commit 0bc55cd, as stated in the request; not independently verified)
- Run: one run, 2026-11-16T12:39:43.179Z to 2026-11-16T12:41:14.091Z (UTC), Playwright Chromium headless, axe-core injected via page.evaluate
- Lecture created for this run: **d1d1e8df** (title "Live check", 6 slides, 5 minutes), student page /l/d1d1e8df, lecturer page /l/d1d1e8df/lecturer
- Screenshots: /tmp/live-shots-20261116-233942/
- Browser contexts left open at end: 0
- Demo lecture: only viewed (/l/demo, and /l/demo/lecturer after logging in with DEMO). No tap, reason, note, "I get it now" or run was sent to the demo.

## Result: 44/44 functional checks passed; 32 page checks (8 pages x 2 viewports x 2 schemes)

## Page checks (390x844 and 1920x1080, light and dark)

| Page | Viewport | Scheme | Status | No h-scroll (scrollWidth/clientWidth) | axe violations | Console errors | Failed requests | Other-origin requests |
|---|---|---|---|---|---|---|---|---|
| / | 390x844 | light | 200 | PASS (390/390) | 0 | 0 | 0 | 0 |
| / | 390x844 | dark | 200 | PASS (390/390) | 0 | 0 | 0 | 0 |
| / | 1920x1080 | light | 200 | PASS (1920/1920) | 0 | 0 | 0 | 0 |
| / | 1920x1080 | dark | 200 | PASS (1920/1920) | 0 | 0 | 0 | 0 |
| /readme/ | 390x844 | light | 200 | PASS (390/390) | 0 | 0 | 0 | 0 |
| /readme/ | 390x844 | dark | 200 | PASS (390/390) | 0 | 0 | 0 | 0 |
| /readme/ | 1920x1080 | light | 200 | PASS (1920/1920) | 0 | 0 | 0 | 0 |
| /readme/ | 1920x1080 | dark | 200 | PASS (1920/1920) | 0 | 0 | 0 | 0 |
| /l/demo | 390x844 | light | 200 | PASS (390/390) | 0 | 0 | 0 | 0 |
| /l/demo | 390x844 | dark | 200 | PASS (390/390) | 0 | 0 | 0 | 0 |
| /l/demo | 1920x1080 | light | 200 | PASS (1920/1920) | 0 | 0 | 0 | 0 |
| /l/demo | 1920x1080 | dark | 200 | PASS (1920/1920) | 0 | 0 | 0 | 0 |
| /l/demo/lecturer (logged in) | 390x844 | light | 200 | PASS (390/390) | 0 | 0 | 0 | 0 |
| /l/demo/lecturer (logged in) | 390x844 | dark | 200 | PASS (390/390) | 0 | 0 | 0 | 0 |
| /l/demo/lecturer (logged in) | 1920x1080 | light | 200 | PASS (1920/1920) | 0 | 0 | 0 | 0 |
| /l/demo/lecturer (logged in) | 1920x1080 | dark | 200 | PASS (1920/1920) | 0 | 0 | 0 | 0 |
| /new | 390x844 | light | 200 | PASS (390/390) | 0 | 0 | 0 | 0 |
| /new | 390x844 | dark | 200 | PASS (390/390) | 0 | 0 | 0 | 0 |
| /new | 1920x1080 | light | 200 | PASS (1920/1920) | 0 | 0 | 0 | 0 |
| /new | 1920x1080 | dark | 200 | PASS (1920/1920) | 0 | 0 | 0 | 0 |
| 404 (/no-such-page-live-check) | 390x844 | light | 404 | PASS (390/390) | 0 | 1 (expected: the 404 document's own status) | 0 | 0 |
| 404 (/no-such-page-live-check) | 390x844 | dark | 404 | PASS (390/390) | 0 | 1 (expected: the 404 document's own status) | 0 | 0 |
| 404 (/no-such-page-live-check) | 1920x1080 | light | 404 | PASS (1920/1920) | 0 | 1 (expected: the 404 document's own status) | 0 | 0 |
| 404 (/no-such-page-live-check) | 1920x1080 | dark | 404 | PASS (1920/1920) | 0 | 1 (expected: the 404 document's own status) | 0 | 0 |
| /l/d1d1e8df | 390x844 | light | 200 | PASS (390/390) | 0 | 0 | 0 | 0 |
| /l/d1d1e8df | 390x844 | dark | 200 | PASS (390/390) | 0 | 0 | 0 | 0 |
| /l/d1d1e8df | 1920x1080 | light | 200 | PASS (1920/1920) | 0 | 0 | 0 | 0 |
| /l/d1d1e8df | 1920x1080 | dark | 200 | PASS (1920/1920) | 0 | 0 | 0 | 0 |
| /l/d1d1e8df/lecturer | 390x844 | light | 200 | PASS (390/390) | 0 | 0 | 0 | 0 |
| /l/d1d1e8df/lecturer | 390x844 | dark | 200 | PASS (390/390) | 0 | 0 | 0 | 0 |
| /l/d1d1e8df/lecturer | 1920x1080 | light | 200 | PASS (1920/1920) | 0 | 0 | 0 | 0 |
| /l/d1d1e8df/lecturer | 1920x1080 | dark | 200 | PASS (1920/1920) | 0 | 0 | 0 | 0 |

Notes:
- axe: **0 violations on every page, viewport and scheme**, including color-contrast.
- axe "incomplete" color-contrast (needs a human look, not a violation): /l/demo has 3 SVG `<text>` nodes in the bar chart ('content too short to determine'), and /l/demo/lecturer has 6 SVG `<text>` nodes in the graphs ('background could not be determined'), in both schemes and both viewports. No other page had incomplete contrast items.
- 404 page: the one console error on each 404 combination is Chromium's 'Failed to load resource: the server responded with a status of 404' for the page document itself, which is the expected status. No subresource failed.
- The long-lived interactive contexts (lecturer + 5 students) also logged no console errors, no 4xx/5xx and no other-origin requests: lecturer []/[]/[]; students [[], [], [], [], []].

## Demo login (view only)

- **PASS**: Log in to /l/demo/lecturer with code DEMO. Evidence: lecturer view rendered

## /new and timing

- **PASS**: No "I'll press Next" on /new. Evidence: text not present in page body
- **PASS**: Minutes pre-filled 60. Evidence: #minutes value = "60"
- **PASS**: No pacing radio choice on /new. Evidence: 0 radio inputs
- **PASS**: Create lecture via /new (Live check, 6 slides, 5 minutes). Evidence: h1="Lecture created", lecture id=d1d1e8df, code shown=true
- **PASS**: No "I'll press" on the created page. Evidence: checked body text
- **PASS**: "Start lecture" button on the lecturer page. Evidence: button count 1; #timed-status: "Timed, 5 minutes. The slides move on their own once you press Start lecture. Previous and Next still work, and the timer carries on from the slide you choose."
- **PASS**: Start lecture starts the timer. Evidence: before: button count 1; after: "Timed, 5 minutes. Started, and the slides move on their own. Previous and Next still work, and the timer carries on from the slide you choose.", start form count 0
- **PASS**: Next/Prev on the started lecture move the slide (lecturer and student, live). Evidence: {"lecturerBefore": "Slide 1 (live)", "afterNext": "Slide 2 (live)", "studentAfterNext": "Slide 2 (live)", "studentMarker": "Live", "afterPrev": "Slide 1 (live)", "studentAfterPrev": "Slide 1 (live)"}

## Dashboard (5 browsers, min_present 5)

- **PASS**: People here reaches 5 with 5 browser contexts (live, no reload). Evidence: #present-value = "5"
- **PASS**: 5 browsers tap slide 1 and choose 'Too fast'. Evidence: You're counted | You're counted | You're counted | You're counted | You're counted
- **PASS**: Stat tile: Lost this run = 5. Evidence: #lost-run-value="5"
- **PASS**: Lost right now = 5. Evidence: #lost-now-value="5"
- **PASS**: Stat tile: Hardest slide = Slide 1. Evidence: #hardest-value="Slide 1"
- **PASS**: Taps this lecture: Total taps 5. Evidence: #tap-count="Total taps: 5"
- **PASS**: Stat tiles text (evidence). Evidence: PEOPLE HERE /  / 5 /  / LOST THIS RUN /  / 5 /  / different people, on any slide /  / SAID “I GET IT NOW” /  / Shows once 5 people have said “I get it now” and 5 are still lost /  / HARDEST SLIDE /  / Slide 1 /  / 5 people lost, of slides with enough taps to show /  / TAPS THIS LECTURE /  / Total taps: 5
- **PASS**: Graph 'Lost, per slide' shows Slide 1 with 5. Evidence: {"text": "Lost, per slide\nSlide 1\n5\nLost per slide, as a table", "svg": 1, "table": 1}
- **PASS**: Graph 'What kind of lost' shows Too fast 5. Evidence: {"text": "What kind of lost\n Too fast\nSlide 1\nWhy, as a table", "svg": 1, "table": 1}
- **PASS**: Graph 'What helped' (no one resolved yet: waiting text). Evidence: {"text": "What helped\n\nShows once 5 people have said the same thing helped on a slide.", "svg": 0, "table": 0}
- **PASS**: Graph 'Got it now' (no one resolved yet: waiting text). Evidence: {"text": "Got it now\n\nShows once a slide has 5 people still lost and 5 who said “I get it now”.", "svg": 0, "table": 0}
- **PASS**: Activity log: 'Person N' lines with AEST times. Evidence: {"lines": 10, "persons": ["1", "2", "3", "4", "5"], "nowBrisbane": "22:40:33", "maxSkewSeconds": 2, "sample": ["22:40:33 AEST Person 5 chose a reason on Slide 1: Too fast", "22:40:33 AEST Person 5 said they're lost on Slide 1", "22:40:32 AEST Person 4 chose a reason on Slide 1: Too fast", "22:40:32 AEST Person 4 said they're lost on Slide 1", "22:40:32 AEST Person 3 chose a reason on Slide 1: Too fast", "22:40:32 AEST Person 3 said they're lost on Slide 1", "22:40:32 AEST Person 2 chose a reason on Slide 1: Too fast", "22:40:32 AEST Person 2 said they're lost on Slide 1", "22:40:31 AEST Person 1 chose a reason on Slide 1: Too fast", "22:40:31 AEST Person 1 said they're lost on Slide 1"]}
- **PASS**: 'Live now' block shows the live slide. Evidence: LIVE NOW / Slide 1
- **PASS**: On the live slide section shows Too fast: 5. Evidence: On the live slide: Slide 1 /  / 5 people have said they were lost here /  / Too fast: 5
- **PASS**: Live slide / Whole lecture groups. Evidence: {"liveH": "Live slide", "lecH": "Whole lecture", "liveGroupHas": [true, true, true], "wholeLectureHas": [["#stat-tiles", true], ["#ranking", true], ["#graph-lost", true], ["#graph-reasons", true], ["#graph-helped", true], ["#graph-resolved", true], ["#activity-log", true], ["#notes", true]]}

## "I'm lost" and "I get it now"

- **PASS**: After 'I get it now', the 'I'm lost' button is back and enabled. Evidence: #tap-button="I'm lost", enabled=true, helped fieldset visible=true
- **PASS**: Pressing 'I'm lost' again reopens the same tap, count unchanged. Evidence: before: "You've said you're lost 1 time in this lecture"; button after press: "You're counted"; after: "You've said you're lost 1 time in this lecture"
- **PASS**: Lecturer total taps stays 5 after the reopen. Evidence: #tap-count="Total taps: 5"

## Reset statistics: fresh run

- **PASS**: Confirmation page. Evidence: h1="Reset statistics?"; Reset statistics? /  / Every count, graph and note starts from zero in run 2. It starts on slide 1, every open student page moves to it, and each student can say they're lost on each slide again. /  / Run 1 stays exactly as it is, and you can still view it, read-only, from the Runs box. Nothing is deleted. /  / Reset statistics: start run 2 /  / Cancel, back to the lecturer view
- **PASS**: New run at zero. Evidence: {"runCurrent": "The current run is run 2.", "present": "5", "lostNow": "0", "tapCount": "Total taps: 0", "activityEmptyVisible": true, "activityLines": 0, "tiles": "PEOPLE HERE\n\n5\n\nLOST THIS RUN\n\nShows once 5 people have been lost\n\nSAID “I GET IT NOW”\n\nShows once 5 people have said “I get it now” and 5 are still lost\n\nHARDEST SLIDE\n\nShows once 5 people have been lost on a slide\n\nTAPS THIS LECTURE\n\nTotal taps: 0", "lostGraph": "Lost, per slide\n\nShows once 5 people have been lost on a slide."}
- **PASS**: Open student page resets to 'I'm lost' on the new run (live). Evidence: student 1 #tap-button="I'm lost"
- **PASS**: Run picker lists Run 1 and Run 2 (live). Evidence: {"picker": ["Run 1", "Run 2 (live) on screen"], "run1Href": "/l/d1d1e8df/lecturer?run=1"}
- **PASS**: Old run viewable via the run picker (?run=1). Evidence: {"runLabel": "You're viewing Run 1, read-only.", "total": "Total taps in run 1: 5", "bars": "1\nSlide People lost here\nSlide 1 5", "reasons": "Slide Reason Count\nSlide 1 Too fast 5", "activityLines": 10}

## "Lectures, most confusing first"

- **PASS**: Ranking lists Run 1 (live): 5 people lost while run 1 is live. Evidence: {"before": "Each run of this lecture counts as one lecture here. Ranked by how many different people said they were lost, on any slide.\n\nLectures appear here once each has had 5 people lost.", "after": "Each run of this lecture counts as one lecture here. Ranked by how many different people said they were lost, on any slide.Run 1 (live): 5 people lostOnly runs with at least 5 people lost are listed."}
- **PASS**: 'Lectures, most confusing first': Run 1 listed with 5, Run 2 (2 people) not listed. Evidence: {"heading": "Lectures, most confusing first", "items": ["Run 1: 5 people lost"], "href": "/l/d1d1e8df/lecturer?run=1", "text": "Each run of this lecture counts as one lecture here. Ranked by how many different people said they were lost, on any slide.\n\nRun 1: 5 people lost\n\nOnly runs with at least 5 people lost are listed."}

## Timeline on the student page

- **PASS**: Timeline segments: one per slide reached so far (lecturer pressed Next to slide 3). Evidence: 3 links, 3 segment rects, 0 shaded, live slide label "Slide 3 (live)"; labels: ["Slide 1","Slide 2","Slide 3"]
- **PASS**: Live marker. Evidence: #live-marker="Live", .timeline-live elements=1
- **PASS**: Tab reaches a timeline segment (slide 1). Evidence: {"presses": 9, "inTimeline": true, "slide": "1", "label": "Slide 1"}
- **PASS**: Enter on the segment browses to slide 1 (live is slide 3). Evidence: #live-marker="You're on Slide 1. The lecture is on Slide 3.", #slide-input=1, url before=/l/d1d1e8df after=/l/d1d1e8df

## Students' Previous/Next and arrow keys

- **PASS**: Student Next/Previous slide links. Evidence: after Next: "You're on Slide 2. The lecture is on Slide 1." (slide 2); after Previous: "Live" (slide 1)
- **PASS**: Arrow keys browse (Right, Right, Left, Left). Evidence: → "You're on Slide 2. The lecture is on Slide 1."; → "You're on Slide 3. The lecture is on Slide 1."; ←← "Live"

## Help link

- **PASS**: Log in to own lecture's lecturer view. Evidence: lecturer view at /l/d1d1e8df/lecturer
- **PASS**: Set help link in lecturer view. Evidence: #help-url after save = "https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/topics/communication/"
- **PASS**: Browser with 3 slides tapped sees 'Want a hand with this?'. Evidence: {"taps": ["You're counted", "You're counted", "You're counted"], "offerBeforeThirdTap": 0, "liveText": "Want a hand with this? Your lecturer offers help here.", "href": "https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/topics/communication/", "afterReload": "Want a hand with this? Your lecturer offers help here."}
- **PASS**: Browser with 2 slides tapped does not. Evidence: {"taps": ["You're counted", "You're counted"], "helpOfferElements": 0, "slotText": "", "yourCount": "You've said you're lost 2 times in this lecture"}

## Observations (not failures)

- The timeline on a created lecture shows one segment per slide reached so far, not one per slide in the deck (src/timeline.ts says this is by design). At live slide 1 it had 1 segment. After the lecturer pressed Next to slide 3 it had 3 (Slide 1, Slide 2, Slide 3). So the timeline was checked after the slide-3 advance.
- In the dashboard screenshot, the stat tile numbers (People here, Lost this run, Hardest slide, Lost right now) render small, at body size. "Total taps: 5" in the Taps tile renders large. This is a visual inconsistency only, and every number was correct.
- After the reopen, the reason buttons still showed 'Too fast' as chosen (locked), which is consistent with the reopened tap being the same row.
- Lecture d1d1e8df was left started (timed, 5 minutes), so its slides advance on the server's own timer. No browser connection is left open.
- Before the live run, the script was dry-run against a local server on a temporary DATA_DIR (/tmp/hd-dry-data2, port 8137, stopped afterwards). A first attempt hit port 8091, which was already served by someone else's local `node src/server.ts` (not started by me, left running). That attempt only viewed pages and logged into the local demo, then stopped before creating anything.

## Screenshots

- /tmp/live-shots-20261116-233942/404-desktop-light.png
- /tmp/live-shots-20261116-233942/404-mobile-light.png
- /tmp/live-shots-20261116-233942/dashboard-run1-5-taps-desktop-light.png
- /tmp/live-shots-20261116-233942/dashboard-run2-zero-desktop-light.png
- /tmp/live-shots-20261116-233942/demo-lecturer-desktop-light.png
- /tmp/live-shots-20261116-233942/demo-lecturer-mobile-light.png
- /tmp/live-shots-20261116-233942/demo-student-desktop-light.png
- /tmp/live-shots-20261116-233942/demo-student-mobile-light.png
- /tmp/live-shots-20261116-233942/fresh-run-confirm-desktop-light.png
- /tmp/live-shots-20261116-233942/home-desktop-light.png
- /tmp/live-shots-20261116-233942/home-mobile-light.png
- /tmp/live-shots-20261116-233942/lecture-created-desktop-light.png
- /tmp/live-shots-20261116-233942/lecture-lecturer-desktop-dark.png
- /tmp/live-shots-20261116-233942/lecture-lecturer-desktop-light.png
- /tmp/live-shots-20261116-233942/lecture-lecturer-mobile-dark.png
- /tmp/live-shots-20261116-233942/lecture-lecturer-mobile-light.png
- /tmp/live-shots-20261116-233942/lecture-student-desktop-dark.png
- /tmp/live-shots-20261116-233942/lecture-student-desktop-light.png
- /tmp/live-shots-20261116-233942/lecture-student-mobile-dark.png
- /tmp/live-shots-20261116-233942/lecture-student-mobile-light.png
- /tmp/live-shots-20261116-233942/new-desktop-light.png
- /tmp/live-shots-20261116-233942/new-mobile-light.png
- /tmp/live-shots-20261116-233942/readme-desktop-light.png
- /tmp/live-shots-20261116-233942/readme-mobile-light.png
- /tmp/live-shots-20261116-233942/run1-readonly-desktop-light.png
- /tmp/live-shots-20261116-233942/student-after-get-it-mobile-light.png
- /tmp/live-shots-20261116-233942/student-help-offer-mobile-light.png
- /tmp/live-shots-20261116-233942/student-timeline-browsed-desktop-light.png
