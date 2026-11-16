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

// The run the log covers. Every tap is run 1 until runs land; when they do,
// this is the one place that changes to read the lecture's current run.
// Notes have no run in this branch, so they aren't scoped yet.
export function currentRunId(_lecture: Lecture): number {
  return 1;
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

// "mostly X" only when X was itself chosen by at least minPresent distinct
// browsers on this slide up to this line, and strictly more than any other
// such reason. A tie names no reason rather than picking one.
function mostly(rowsSoFar: ActivityTapRow[], minPresent: number): string | undefined {
  const byReason = new Map<string, Set<string>>();
  for (const row of rowsSoFar) {
    if (row.reason === null) continue;
    let set = byReason.get(row.reason);
    if (!set) {
      set = new Set();
      byReason.set(row.reason, set);
    }
    set.add(row.browser_id);
  }
  const qualifying = [...byReason].map(([reason, set]) => ({ reason, count: set.size })).filter((r) => r.count >= minPresent);
  if (qualifying.length === 0) return undefined;
  qualifying.sort((a, b) => b.count - a.count);
  if (qualifying.length > 1 && qualifying[0].count === qualifying[1].count) return undefined;
  return qualifying[0].reason;
}

export function activityLog(lecture: Lecture): ActivityLine[] {
  const minPresent = Math.max(1, lecture.min_present);
  const taps = activityTapRows(lecture.id, currentRunId(lecture));

  const tapLines: Positioned[] = [];
  crossings(taps, minPresent, (row, soFar) => {
    const reason = mostly(soFar, minPresent);
    tapLines.push({
      line: {
        deck: row.deck,
        slide: row.slide,
        kind: "lost",
        text: `${slideName(row.deck, row.slide)}: ${minPresent} more people lost${reason !== undefined ? `, mostly ${reason}` : ""}`,
      },
      id: row.id,
      at: row.created_at,
    });
  });
  crossings(
    taps.filter((row) => row.helped !== null),
    minPresent,
    (row) => {
      tapLines.push({
        line: {
          deck: row.deck,
          slide: row.slide,
          kind: "helped",
          text: `${minPresent} people said what helped on ${slideInSentence(row.deck, row.slide)}`,
        },
        id: row.id,
        at: row.created_at,
      });
    },
  );

  const noteLines: Positioned[] = [];
  crossings(activityNoteRows(lecture.id), minPresent, (row) => {
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

export interface ActivityFilter {
  deck?: DeckId;
  slide?: number;
}

// ?logDeck=week-4&logSlide=5 on the lecturer page. Anything that isn't a
// real deck (demo only) or a positive whole slide number is ignored.
export function parseActivityFilter(lecture: Lecture, params: URLSearchParams): ActivityFilter {
  const filter: ActivityFilter = {};
  const deck = params.get("logDeck");
  if (lecture.id === "demo" && deck !== null && isDeckId(deck)) filter.deck = deck;
  const slideRaw = params.get("logSlide");
  if (slideRaw !== null && /^\d{1,4}$/.test(slideRaw) && Number(slideRaw) >= 1) filter.slide = Number(slideRaw);
  return filter;
}

function matches(filter: ActivityFilter, line: ActivityLine): boolean {
  return (filter.deck === undefined || line.deck === filter.deck) && (filter.slide === undefined || line.slide === filter.slide);
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
  const filtered = filter.deck !== undefined || filter.slide !== undefined;
  const deckField =
    lecture.id === "demo"
      ? `<label for="log-deck">Deck</label>
        <select id="log-deck" name="logDeck">
          <option value="">Every deck</option>
          <option value="week-4"${filter.deck === "week-4" ? " selected" : ""}>Week 4</option>
          <option value="week-6"${filter.deck === "week-6" ? " selected" : ""}>Week 6</option>
        </select>`
      : "";
  const items = shown.map((line) => `<li class="activity-line">${escapeHtml(line.text)}</li>`).join("\n");
  return `
    <section id="activity-log" class="card" aria-labelledby="activity-log-heading">
      <h2 id="activity-log-heading">Activity</h2>
      <form method="get" action="${base}" class="activity-filter inline-form">
        ${deckField}
        <label for="log-slide">Slide</label>
        <input id="log-slide" name="logSlide" type="number" min="1" step="1" inputmode="numeric" value="${filter.slide ?? ""}">
        <button type="submit">Filter</button>
        ${filtered ? `<a href="${base}">Show every slide</a>` : ""}
      </form>
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
            return (activityFilter.deck === undefined || line.deck === activityFilter.deck) &&
              (activityFilter.slide === undefined || line.slide === activityFilter.slide);
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
