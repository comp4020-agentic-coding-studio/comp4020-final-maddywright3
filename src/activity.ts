// The lecturer's activity log (ADR 006, finish.md round 2 item 4). Worked out
// again from stored taps and visible notes on every lecturer update, with no
// table of its own, so it survives a restart and a hidden note drops out of
// it at once.
//
// The one rule (CLAUDE.md): every line covers at least min_present actions,
// and no line is ever one student's action. A line is added only when a
// slide's distinct-browser count reaches a new multiple of min_present, so
// each line is about exactly min_present more people, and it sits at the row
// that made the count reach that multiple. Lines name a slide, never a time
// finer than that, and carry no browser id, hash or label: the browser ids
// read here are only ever counted, never returned.
import { activityNoteRows, activityTapRows } from "./db.ts";
import type { ActivityTapRow, Lecture } from "./db.ts";
import { isDeckId, slideName } from "./slides.ts";
import type { DeckId } from "./slides.ts";

export type ActivityKind = "lost" | "notes" | "helped";

// What travels in the lecturer stream (as `activityLog`, newest first) and
// what the page renders. Lecturer-only: never in MeterState.
export interface ActivityLine {
  deck: string | null;
  slide: number;
  kind: ActivityKind;
  text: string;
}

// The run the log covers: the lecture's current run, for taps and notes.
export function currentRunId(lecture: Lecture): number {
  return lecture.run;
}

interface Positioned {
  line: ActivityLine;
  // Where the line sits: the crossing row's id within its own table, and
  // its created_at to interleave the tap and note tables. Never sent.
  id: number;
  at: string;
}

const key = (deck: string | null, slide: number): string => `${deck ?? ""}\u0000${slide}`;

// "Slide 5" reads as "slide 5" mid-sentence; "Week 4, slide 5" is unchanged.
function slideInSentence(deck: string | null, slide: number): string {
  const name = slideName(deck, slide);
  return name.startsWith("Slide ") ? `s${name.slice(1)}` : name;
}

// Walks rows in id order, counting distinct browsers per (deck, slide), and
// calls `onCross` at each row whose browser takes its slide's count to a new
// multiple of minPresent.
function crossings<R extends { id: number; deck: string | null; slide: number; browser_id: string }>(
  rows: R[],
  minPresent: number,
  onCross: (row: R, seenOnSlide: R[]) => void,
): void {
  const seen = new Map<string, { browsers: Set<string>; rows: R[] }>();
  for (const row of rows) {
    const k = key(row.deck, row.slide);
    let entry = seen.get(k);
    if (!entry) {
      entry = { browsers: new Set(), rows: [] };
      seen.set(k, entry);
    }
    entry.rows.push(row);
    if (entry.browsers.has(row.browser_id)) continue;
    entry.browsers.add(row.browser_id);
    if (entry.browsers.size % minPresent === 0) onCross(row, entry.rows);
  }
}

// The answers this line's people gave (reasons on a lost line, what helped
// on a what-helped line), as they stand now: a reason or answer can come in
// after the tap. Counted by distinct browser among `people`, and an answer
// is listed only once at least minPresent of them gave it, so no count is
// ever one or two people; the rest are left out, never shown small.
function breakdown(
  rows: ActivityTapRow[],
  people: Set<string>,
  pick: (row: ActivityTapRow) => string | null,
  minPresent: number,
): string {
  const by = new Map<string, Set<string>>();
  for (const row of rows) {
    const answer = pick(row);
    if (answer === null || !people.has(row.browser_id)) continue;
    let set = by.get(answer);
    if (!set) {
      set = new Set();
      by.set(answer, set);
    }
    set.add(row.browser_id);
  }
  return [...by]
    .map(([answer, set]) => ({ answer, count: set.size }))
    .filter((a) => a.count >= minPresent)
    .sort((a, b) => b.count - a.count || a.answer.localeCompare(b.answer))
    .map((a) => `${a.answer} ${a.count}`)
    .join(", ");
}

// The browsers this line is about: the minPresent new ones, in row order,
// that took the slide's count to this multiple.
function lineBrowsers(rowsSoFar: { browser_id: string }[], minPresent: number): Set<string> {
  const ordered: string[] = [];
  for (const row of rowsSoFar) if (!ordered.includes(row.browser_id)) ordered.push(row.browser_id);
  return new Set(ordered.slice(-minPresent));
}

export function activityLog(lecture: Lecture): ActivityLine[] {
  const minPresent = Math.max(1, lecture.min_present);
  const taps = activityTapRows(lecture.id, currentRunId(lecture));

  const tapLines: Positioned[] = [];
  crossings(taps, minPresent, (row, soFar) => {
    const reasons = breakdown(soFar, lineBrowsers(soFar, minPresent), (r) => r.reason, minPresent);
    tapLines.push({
      line: {
        deck: row.deck,
        slide: row.slide,
        kind: "lost",
        text: `${slideName(row.deck, row.slide)}: ${minPresent} more people lost${reasons ? `. Reasons: ${reasons}` : ""}`,
      },
      id: row.id,
      at: row.created_at,
    });
  });
  crossings(
    taps.filter((row) => row.helped !== null),
    minPresent,
    (row, soFar) => {
      const helped = breakdown(soFar, lineBrowsers(soFar, minPresent), (r) => r.helped, minPresent);
      tapLines.push({
        line: {
          deck: row.deck,
          slide: row.slide,
          kind: "helped",
          text: `${minPresent} people said what helped on ${slideInSentence(row.deck, row.slide)}${helped ? `: ${helped}` : ""}`,
        },
        id: row.id,
        at: row.created_at,
      });
    },
  );

  const noteLines: Positioned[] = [];
  crossings(activityNoteRows(lecture.id, currentRunId(lecture)), minPresent, (row) => {
    noteLines.push({
      line: {
        deck: row.deck,
        slide: row.slide,
        kind: "notes",
        text: `${minPresent} new notes on ${slideInSentence(row.deck, row.slide)}`,
      },
      id: row.id,
      at: row.created_at,
    });
  });

  // Each table is ordered by row id; the two are interleaved by when their
  // crossing rows were written. Then newest first.
  tapLines.sort((a, b) => a.id - b.id);
  noteLines.sort((a, b) => a.id - b.id);
  const merged: Positioned[] = [];
  let t = 0;
  let n = 0;
  while (t < tapLines.length || n < noteLines.length) {
    if (n >= noteLines.length || (t < tapLines.length && tapLines[t].at <= noteLines[n].at)) merged.push(tapLines[t++]);
    else merged.push(noteLines[n++]);
  }
  return merged.reverse().map((p) => p.line);
}

// The log filters by deck only (the demo's two decks); each line already
// names its slide. A created lecture has no decks, so no filter.
export interface ActivityFilter {
  deck?: DeckId;
}

// ?logDeck=week-4 on the lecturer page. Anything that isn't a real deck
// (demo only) is ignored.
export function parseActivityFilter(lecture: Lecture, params: URLSearchParams): ActivityFilter {
  const filter: ActivityFilter = {};
  const deck = params.get("logDeck");
  if (lecture.id === "demo" && deck !== null && isDeckId(deck)) filter.deck = deck;
  return filter;
}

function matches(filter: ActivityFilter, line: ActivityLine): boolean {
  return filter.deck === undefined || line.deck === filter.deck;
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function emptyText(minPresent: number): string {
  return `Lines appear each time ${minPresent} more people do something on a slide.`;
}

// The whole <section id="activity-log">: heading, a GET filter form that
// works with no script, and the lines. The page script (ACTIVITY_CLIENT_JS)
// re-renders only the list, so the filter stays as the lecturer set it.
export function activityLogHtml(lecture: Lecture, lines: ActivityLine[], filter: ActivityFilter): string {
  const base = `/l/${encodeURIComponent(lecture.id)}/lecturer`;
  const shown = lines.filter((line) => matches(filter, line));
  const filterForm =
    lecture.id === "demo"
      ? `<form method="get" action="${base}" class="activity-filter inline-form">
        <label for="log-deck">Deck</label>
        <select id="log-deck" name="logDeck">
          <option value="">Every deck</option>
          <option value="week-4"${filter.deck === "week-4" ? " selected" : ""}>Week 4</option>
          <option value="week-6"${filter.deck === "week-6" ? " selected" : ""}>Week 6</option>
        </select>
        <button type="submit">Filter</button>
        ${filter.deck !== undefined ? `<a href="${base}">Show every deck</a>` : ""}
      </form>`
      : "";
  const items = shown.map((line) => `<li class="activity-line">${escapeHtml(line.text)}</li>`).join("\n");
  return `
    <section id="activity-log" class="card" aria-labelledby="activity-log-heading">
      <h3 id="activity-log-heading">Activity</h3>
      ${filterForm}
      <p id="activity-empty"${shown.length > 0 ? " hidden" : ""}>${escapeHtml(emptyText(lecture.min_present))}</p>
      <ul id="activity-lines" class="activity-lines">${items}</ul>
    </section>`;
}

// The browser half: renders `state.activityLog` from each lecturer frame
// into the list, keeping the filter the page was loaded with. Rebuilt only
// when the visible lines change, so focus elsewhere isn't disturbed.
export function activityClientJs(filter: ActivityFilter): string {
  return `
        var activityFilter = ${JSON.stringify(filter)};
        var activitySig = null;
        function renderActivity(log) {
          var list = document.getElementById("activity-lines");
          var empty = document.getElementById("activity-empty");
          if (!list || !log) return;
          var shown = log.filter(function (line) {
            return activityFilter.deck === undefined || line.deck === activityFilter.deck;
          });
          var sig = JSON.stringify(shown.map(function (line) { return line.text; }));
          if (sig === activitySig) return;
          activitySig = sig;
          list.innerHTML = "";
          shown.forEach(function (line) {
            var li = document.createElement("li");
            li.className = "activity-line";
            li.textContent = line.text;
            list.appendChild(li);
          });
          if (empty) empty.hidden = shown.length > 0;
        }
`;
}
