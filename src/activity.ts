// The lecturer's activity log: one line per press, newest first (CLAUDE.md,
// changed by the user in b35eaa3, replacing ADR 006's min_present grouping).
// Worked out again from stored rows on every lecturer update, with no table
// of its own, so it survives a restart.
//
// Each line is labelled only "Person N": numbered per run, in order of each
// browser's first press in that run. The browser ids read here are used only
// as Map keys to hand out those numbers; nothing derived from them (no hash,
// no prefix) is ever returned. Note text is never read, so it can't appear.
//
// Reopened taps: pressing "I'm lost" again after "I get it now" reuses the
// same row, clearing resolved_at and moving created_at to the reopen time.
// The first press's time is then lost, so the log shows the reopen in its
// place (and a browser whose only press was that tap may be numbered by
// the later time). That's accepted; there's no history table behind it.
import { activityNoteRows, activityTapRows } from "./db.ts";
import type { Lecture } from "./db.ts";
import { formatAest } from "./aest.ts";
import { isDeckId, slideName } from "./slides.ts";
import type { DeckId } from "./slides.ts";

export type ActivityKind = "lost" | "reason" | "resolved" | "helped" | "note";

// What travels in the lecturer stream (as `activityLog`, newest first) and
// what the page renders. `text` and `time` are worked out here, once, and
// both the server render and the page script only place them, so the
// wording can't drift. Lecturer-only: never in MeterState.
export interface ActivityLine {
  deck: string | null;
  slide: number;
  kind: ActivityKind;
  text: string;
  // "10:42:07 AEST" (with the date when not today in AEST), or "time not
  // recorded"; iso is the stored instant for <time datetime>, "" if none.
  time: { text: string; iso: string };
}

export interface ActivityLog {
  lines: ActivityLine[];
  // True when more presses happened than ACTIVITY_LOG_MAX lines carry.
  capped: boolean;
}

export const ACTIVITY_LOG_MAX = 500;

interface Press {
  deck: string | null;
  slide: number;
  kind: ActivityKind;
  answer: string | null;
  at: string | null;
  browser: string;
  // Tie-breaks for presses at the same instant: table row id, then kind.
  id: number;
}

const KIND_ORDER: ActivityKind[] = ["lost", "reason", "resolved", "helped", "note"];

function lineText(person: number, press: Press): string {
  const who = `Person ${person}`;
  const where = slideName(press.deck, press.slide);
  switch (press.kind) {
    case "lost":
      return `${who} said they're lost on ${where}`;
    case "reason":
      return `${who} chose a reason on ${where}: ${press.answer}`;
    case "resolved":
      return `${who} said they get it now on ${where}`;
    case "helped":
      return `${who} said what helped on ${where}: ${press.answer}`;
    case "note":
      return `${who} wrote a note on ${where}`;
  }
}

// Oldest first. A press with no recorded time (a reason or what-helped from
// before reason_at/helped_at existed) sorts just after its own tap.
function compare(a: Press & { sortAt: string }, b: Press & { sortAt: string }): number {
  if (a.sortAt !== b.sortAt) return a.sortAt < b.sortAt ? -1 : 1;
  if (a.kind === "note" && b.kind !== "note") return 1;
  if (b.kind === "note" && a.kind !== "note") return -1;
  return a.id - b.id || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
}

// The whole log for one run of a lecture, newest first, capped.
export function activityLog(lecture: Lecture, run: number = lecture.run, now: Date = new Date()): ActivityLog {
  const presses: (Press & { sortAt: string })[] = [];
  for (const row of activityTapRows(lecture.id, run)) {
    const base = { deck: row.deck, slide: row.slide, browser: row.browser_id, id: row.id };
    presses.push({ ...base, kind: "lost", answer: null, at: row.created_at, sortAt: row.created_at });
    if (row.reason !== null) {
      presses.push({ ...base, kind: "reason", answer: row.reason, at: row.reason_at, sortAt: row.reason_at ?? row.created_at });
    }
    if (row.resolved_at !== null) {
      presses.push({ ...base, kind: "resolved", answer: null, at: row.resolved_at, sortAt: row.resolved_at });
    }
    if (row.helped !== null) {
      presses.push({
        ...base,
        kind: "helped",
        answer: row.helped,
        at: row.helped_at,
        sortAt: row.helped_at ?? row.resolved_at ?? row.created_at,
      });
    }
  }
  for (const row of activityNoteRows(lecture.id, run)) {
    presses.push({
      deck: row.deck,
      slide: row.slide,
      browser: row.browser_id,
      id: row.id,
      kind: "note",
      answer: null,
      at: row.created_at,
      sortAt: row.created_at,
    });
  }
  presses.sort(compare);

  // Person N by first press in the run, over every press, not just the
  // lines shown, so N stays the same as the log grows past the cap.
  const people = new Map<string, number>();
  for (const press of presses) if (!people.has(press.browser)) people.set(press.browser, people.size + 1);

  const newest = presses.slice(-ACTIVITY_LOG_MAX).reverse();
  return {
    capped: presses.length > ACTIVITY_LOG_MAX,
    lines: newest.map((press) => {
      const person = people.get(press.browser)!;
      return {
        deck: press.deck,
        slide: press.slide,
        kind: press.kind,
        text: lineText(person, press),
        time: formatAest(press.at, now),
      };
    }),
  };
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

const EMPTY_TEXT = "No presses yet in this run.";
const CAPPED_TEXT = `Showing the latest ${ACTIVITY_LOG_MAX}.`;

function lineHtml(line: ActivityLine): string {
  return `<li class="activity-line"><time datetime="${escapeHtml(line.time.iso)}">${escapeHtml(line.time.text)}</time> ${escapeHtml(line.text)}</li>`;
}

// The whole <section id="activity-log">: heading, a GET filter form that
// works with no script (demo only), and the lines. The page script
// (activityClientJs) re-renders only the list, so the filter stays as the
// lecturer set it.
export function activityLogHtml(lecture: Lecture, log: ActivityLog, filter: ActivityFilter): string {
  const base = `/l/${encodeURIComponent(lecture.id)}/lecturer`;
  const shown = log.lines.filter((line) => matches(filter, line));
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
  return `
    <section id="activity-log" class="card" aria-labelledby="activity-log-heading">
      <h3 id="activity-log-heading">Activity</h3>
      ${filterForm}
      <p id="activity-empty"${shown.length > 0 ? " hidden" : ""}>${EMPTY_TEXT}</p>
      <p id="activity-capped"${log.capped ? "" : " hidden"}>${CAPPED_TEXT}</p>
      <ul id="activity-lines" class="activity-lines">${shown.map(lineHtml).join("\n")}</ul>
    </section>`;
}

// The browser half: places `state.activityLog` from each lecturer frame
// into the list, keeping the filter the page was loaded with. It only puts
// the server's text and time into elements, never words of its own. Rebuilt
// only when the visible lines change, so focus elsewhere isn't disturbed.
export function activityClientJs(filter: ActivityFilter): string {
  return `
        var activityFilter = ${JSON.stringify(filter)};
        var activitySig = null;
        function renderActivity(log, capped) {
          var list = document.getElementById("activity-lines");
          var empty = document.getElementById("activity-empty");
          var cappedNote = document.getElementById("activity-capped");
          if (!list || !log) return;
          if (cappedNote) cappedNote.hidden = !capped;
          var shown = log.filter(function (line) {
            return activityFilter.deck === undefined || line.deck === activityFilter.deck;
          });
          var sig = JSON.stringify(shown.map(function (line) { return [line.time.iso, line.time.text, line.text]; }));
          if (sig === activitySig) return;
          activitySig = sig;
          list.innerHTML = "";
          shown.forEach(function (line) {
            var li = document.createElement("li");
            li.className = "activity-line";
            var time = document.createElement("time");
            time.setAttribute("datetime", line.time.iso);
            time.textContent = line.time.text;
            li.appendChild(time);
            li.appendChild(document.createTextNode(" " + line.text));
            list.appendChild(li);
          });
          if (empty) empty.hidden = shown.length > 0;
        }
`;
}
