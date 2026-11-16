// The lecturer dashboard (round 2 item 3): stat tiles, four graphs and the
// notes grouped by slide. Aggregates only. Everything here is built from
// counts the caller has already gated per (deck, slide) or per (deck,
// slide, answer), plus three raw totals this module gates itself, so every
// number on the page clears min_present on its own, and a derived number (a
// share, the hardest slide) appears only when every count behind it does.
//
// The same functions render the first page and every live update: the
// lecturer stream carries these fragments already rendered, so a live frame
// can't format anything differently from the page it updates.
import { distinctLostCount, resolvedTotals, slideResolvedCounts } from "./db.ts";
import type { HelpedCount, Lecture } from "./db.ts";
import { DECK_IDS, DECK_SHORT_NAMES, DECK_TITLES, isDeckId, slideName } from "./slides.ts";
import type { Bar, NoteEntry, ReasonCountEntry } from "./realtime.ts";

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

// Colour order for the stacked graphs: each answer keeps its series class
// whichever answers happen to qualify, so a colour always means the same
// answer (series-1..series-6 map to the colour branch's categorical order).
// These match the fixed lists the server checks; an answer not listed here
// (none today) would take the next free class rather than break.
export const REASON_ORDER = ["Too fast", "Missed a step", "Notation", "Can't see or hear"];
export const HELPED_ORDER = ["The next slide", "Re-reading it", "The example", "Someone explained it", "Worked it out myself"];

interface SlideKey {
  deck: string | null;
  slide: number;
}

const keyOf = (k: SlideKey): string => `${k.deck ?? ""}:${k.slide}`;
const bySlide = (a: SlideKey, b: SlideKey): number => (a.deck ?? "").localeCompare(b.deck ?? "") || a.slide - b.slide;

export interface ResolvedShare {
  resolved: number;
  stillLost: number;
  percent: number;
}

export interface Hardest {
  slides: SlideKey[];
  distinctBrowsers: number;
}

// Each optional field is absent, not zero, below its gate.
export interface DashboardStats {
  present: number;
  live?: number;
  lostThisRun?: number;
  resolvedShare?: ResolvedShare;
  hardest?: Hardest;
}

export interface ResolvedSplit extends SlideKey {
  stillLost: number;
  resolved: number;
}

export interface NoteGroup extends SlideKey {
  html: string;
}

export interface DashboardFragments {
  tiles: string;
  graphLost: string;
  graphReasons: string;
  graphHelped: string;
  graphResolved: string;
}

export interface Dashboard {
  stats: DashboardStats;
  resolvedSplit: ResolvedSplit[];
  dashboardHtml: DashboardFragments;
  noteGroups: NoteGroup[];
}

export interface DashboardInput {
  lecture: Lecture;
  present: number;
  // Only when present >= min_present, as everywhere else.
  live: number | undefined;
  bars: Bar[];
  reasonCounts: ReasonCountEntry[];
  helpedCounts: HelpedCount[];
  notes: NoteEntry[];
}

export function computeDashboard(input: DashboardInput): Dashboard {
  const { lecture } = input;
  const min = lecture.min_present;
  const stats = computeStats(input);
  const resolvedSplit = slideResolvedCounts(lecture.id)
    .filter((s) => s.stillLost >= min && s.resolved >= min)
    .sort(bySlide);
  return {
    stats,
    resolvedSplit,
    dashboardHtml: {
      tiles: tilesInnerHtml(stats, min),
      graphLost: graphLostHtml(input.bars, min),
      graphReasons: graphAnswersHtml("reasons", input.reasonCounts.map((r) => ({ ...r, answer: r.reason })), min),
      graphHelped: graphAnswersHtml("helped", input.helpedCounts.map((h) => ({ ...h, answer: h.helped })), min),
      graphResolved: graphResolvedHtml(resolvedSplit, min),
    },
    noteGroups: noteGroups(lecture.id, input.notes),
  };
}

function computeStats(input: DashboardInput): DashboardStats {
  const min = input.lecture.min_present;
  const stats: DashboardStats = { present: input.present };
  if (input.live !== undefined) stats.live = input.live;

  const lost = distinctLostCount(input.lecture.id);
  if (lost >= min) stats.lostThisRun = lost;

  // The share is of counted taps (one per browser per slide) that ended in
  // "I get it now". It shows only when the people behind each side, counted
  // as distinct browsers, are each at least min_present: a share reveals its
  // numerator and its complement alike.
  const totals = resolvedTotals(input.lecture.id);
  if (totals.resolvedBrowsers >= min && totals.stillLostBrowsers >= min) {
    const all = totals.resolvedTaps + totals.stillLostTaps;
    stats.resolvedShare = {
      resolved: totals.resolvedTaps,
      stillLost: totals.stillLostTaps,
      percent: Math.round((totals.resolvedTaps / all) * 100),
    };
  }

  // Ranked only among bars that already cleared their gate; ties all show.
  if (input.bars.length > 0) {
    const top = Math.max(...input.bars.map((b) => b.distinctBrowsers));
    stats.hardest = {
      slides: input.bars
        .filter((b) => b.distinctBrowsers === top)
        .sort(bySlide)
        .map((b) => ({ deck: b.deck, slide: b.slide })),
      distinctBrowsers: top,
    };
  }
  return stats;
}

// ---------- Stat tiles ----------

function tile(label: string, body: string): string {
  return `<div class="card stat-tile"><h2 class="tile-label">${escapeHtml(label)}</h2>${body}</div>`;
}

const value = (id: string, text: string): string => `<p class="tile-value" id="${id}">${escapeHtml(text)}</p>`;
const wait = (text: string): string => `<p class="tile-wait">${escapeHtml(text)}</p>`;
const detail = (text: string): string => `<p class="tile-detail">${escapeHtml(text)}</p>`;

function tilesInnerHtml(stats: DashboardStats, min: number): string {
  const here = tile("People here", value("present-value", String(stats.present)));
  const lostNow = tile(
    "Lost right now",
    stats.live !== undefined
      ? value("lost-now-value", String(stats.live))
      : wait(`Shows once ${min} people are here`),
  );
  const lostRun = tile(
    "Lost this run",
    stats.lostThisRun !== undefined
      ? value("lost-run-value", String(stats.lostThisRun)) + detail(`different ${plural(stats.lostThisRun, "person", "people")}, on any slide`)
      : wait(`Shows once ${min} people have been lost`),
  );
  const share = tile(
    "Said “I get it now”",
    stats.resolvedShare !== undefined
      ? value("share-value", `${stats.resolvedShare.percent}%`) +
          detail(
            `${stats.resolvedShare.resolved} of ${stats.resolvedShare.resolved + stats.resolvedShare.stillLost} lost taps`,
          )
      : wait(`Shows once ${min} people have said “I get it now” and ${min} are still lost`),
  );
  const hardest = tile(
    "Hardest slide",
    stats.hardest !== undefined
      ? value("hardest-value", stats.hardest.slides.map((s) => slideName(s.deck, s.slide)).join(", ")) +
          detail(
            `${stats.hardest.distinctBrowsers} ${plural(stats.hardest.distinctBrowsers, "person", "people")} lost, of slides with enough taps to show`,
          )
      : wait(`Shows once ${min} people have been lost on a slide`),
  );
  return here + lostNow + lostRun + share + hardest;
}

// ---------- Graphs ----------
//
// One horizontal bar per slide, the slide's name above it: names stay
// readable at 390px, and a long lecture grows down the page rather than
// across it. Sizes live in SVG attributes and the viewBox; colour comes
// only from class names (series-*), so the stylesheet owns every colour.
// Every graph has a table with the same numbers, and says what it's
// waiting for, with the lecture's real min_present, when it has nothing.

interface Segment {
  value: number;
  cls: string;
  title: string;
}

interface Row {
  label: string;
  segments: Segment[];
  // The number written at the end of the bar, if any.
  end?: string;
}

const VIEW_W = 400;
const LABEL_H = 20;
const BAR_H = 14;
const ROW_GAP = 12;
const ROW_H = LABEL_H + BAR_H + ROW_GAP;
const END_SPACE = 44;
const SEGMENT_GAP = 2;

function svgRows(rows: Row[], ariaLabel: string): string {
  const maxTotal = Math.max(1, ...rows.map((r) => r.segments.reduce((sum, s) => sum + s.value, 0)));
  const barMax = VIEW_W - END_SPACE;
  const height = rows.length * ROW_H;
  const marks = rows
    .map((row, i) => {
      const top = i * ROW_H;
      let x = 0;
      const rects = row.segments
        .filter((s) => s.value > 0)
        .map((s, j, shown) => {
          const full = (s.value / maxTotal) * barMax;
          const w = Math.max(1, round1(full - (j < shown.length - 1 ? SEGMENT_GAP : 0)));
          const rect = `<rect class="${s.cls}" x="${round1(x)}" y="${top + LABEL_H}" width="${w}" height="${BAR_H}" rx="2"><title>${escapeHtml(s.title)}</title></rect>`;
          x += full;
          return rect;
        })
        .join("");
      const end = row.end !== undefined ? `<text x="${round1(x + 6)}" y="${top + LABEL_H + BAR_H - 2}" font-size="13">${escapeHtml(row.end)}</text>` : "";
      return `<text x="0" y="${top + 15}" font-size="14">${escapeHtml(row.label)}</text>${rects}${end}`;
    })
    .join("");
  return `<svg class="graph" width="100%" viewBox="0 0 ${VIEW_W} ${height}" role="img" aria-label="${escapeHtml(ariaLabel)}">${marks}</svg>`;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

function tableHtml(caption: string, headers: string[], rows: (string | number)[][]): string {
  const head = headers.map((h) => `<th scope="col">${escapeHtml(h)}</th>`).join("");
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(String(c))}</td>`).join("")}</tr>`).join("\n");
  return `<details class="graph-table"><summary>${escapeHtml(caption)}</summary><table><thead><tr>${head}</tr></thead><tbody>\n${body}\n</tbody></table></details>`;
}

function legendHtml(items: { label: string; cat: number }[]): string {
  return `<ul class="graph-legend">${items
    .map((it) => `<li><span class="swatch cat-${it.cat}" aria-hidden="true"></span> ${escapeHtml(it.label)}</li>`)
    .join("")}</ul>`;
}

const emptyHtml = (text: string): string => `<p class="graph-empty">${escapeHtml(text)}</p>`;

function graphLostHtml(bars: Bar[], min: number): string {
  if (bars.length === 0) return emptyHtml(`Shows once ${min} people have been lost on a slide.`);
  const sorted = [...bars].sort(bySlide);
  const rows: Row[] = sorted.map((b) => ({
    label: slideName(b.deck, b.slide),
    segments: [{ value: b.distinctBrowsers, cls: "series-lost", title: `${slideName(b.deck, b.slide)}: ${b.distinctBrowsers} lost` }],
    end: String(b.distinctBrowsers),
  }));
  return (
    svgRows(rows, "Different people lost, per slide") +
    tableHtml(
      "Lost per slide, as a table",
      ["Slide", "People lost here"],
      sorted.map((b) => [slideName(b.deck, b.slide), b.distinctBrowsers]),
    )
  );
}

interface AnswerCount extends SlideKey {
  answer: string;
  count: number;
}

const ANSWER_GRAPHS = {
  reasons: {
    order: REASON_ORDER,
    aria: "Why people were lost, stacked per slide",
    caption: "Why, as a table",
    column: "Reason",
    empty: (min: number) => `Shows once ${min} people have chosen the same reason on a slide.`,
  },
  helped: {
    order: HELPED_ORDER,
    aria: "What helped, stacked per slide",
    caption: "What helped, as a table",
    column: "What helped",
    empty: (min: number) => `Shows once ${min} people have said the same thing helped on a slide.`,
  },
};

// Stacked per slide, one segment per answer that cleared its own (deck,
// slide, answer) gate. An answer below the gate is absent, never a zero.
function graphAnswersHtml(kind: keyof typeof ANSWER_GRAPHS, counts: AnswerCount[], min: number): string {
  const spec = ANSWER_GRAPHS[kind];
  if (counts.length === 0) return emptyHtml(spec.empty(min));
  const order = [...spec.order, ...[...new Set(counts.map((c) => c.answer))].filter((a) => !spec.order.includes(a)).sort()];
  const cat = (answer: string): number => (order.indexOf(answer) % 6) + 1;
  const slides = new Map<string, SlideKey>();
  for (const c of counts) slides.set(keyOf(c), { deck: c.deck, slide: c.slide });
  const sortedSlides = [...slides.values()].sort(bySlide);
  const rows: Row[] = sortedSlides.map((s) => {
    const name = slideName(s.deck, s.slide);
    const mine = counts.filter((c) => keyOf(c) === keyOf(s)).sort((a, b) => order.indexOf(a.answer) - order.indexOf(b.answer));
    return {
      label: name,
      segments: mine.map((c) => ({ value: c.count, cls: `series-${cat(c.answer)}`, title: `${name}, ${c.answer}: ${c.count}` })),
    };
  });
  const present = order.filter((a) => counts.some((c) => c.answer === a));
  const tableRows = [...counts]
    .sort((a, b) => bySlide(a, b) || b.count - a.count || order.indexOf(a.answer) - order.indexOf(b.answer))
    .map((c) => [slideName(c.deck, c.slide), c.answer, c.count]);
  return (
    legendHtml(present.map((a) => ({ label: a, cat: cat(a) }))) +
    svgRows(rows, spec.aria) +
    tableHtml(spec.caption, ["Slide", spec.column, "Count"], tableRows)
  );
}

// Still lost against "I get it now", only for slides where both clear the
// gate: either side alone would say how many are on the other.
function graphResolvedHtml(split: ResolvedSplit[], min: number): string {
  if (split.length === 0) {
    return emptyHtml(`Shows once a slide has ${min} people still lost and ${min} who said “I get it now”.`);
  }
  const rows: Row[] = split.map((s) => {
    const name = slideName(s.deck, s.slide);
    return {
      label: name,
      segments: [
        { value: s.stillLost, cls: "series-lost", title: `${name}: ${s.stillLost} still lost` },
        { value: s.resolved, cls: "series-resolved", title: `${name}: ${s.resolved} said I get it now` },
      ],
    };
  });
  return (
    legendHtml([
      { label: "Still lost", cat: 1 },
      { label: "“I get it now”", cat: 3 },
    ]) +
    svgRows(rows, "Still lost against I get it now, per slide") +
    tableHtml(
      "Still lost and I get it now, as a table",
      ["Slide", "Still lost", "I get it now"],
      split.map((s) => [slideName(s.deck, s.slide), s.stillLost, s.resolved]),
    )
  );
}

// ---------- Notes, grouped by slide ----------

// Groups by slide, the slide with the newest note first, and newest first
// within a slide. `notes` is already gated per (deck, slide) and holds only
// visible notes, with no browser attached to any of them.
function noteGroups(lectureId: string, notes: NoteEntry[]): NoteGroup[] {
  const groups = new Map<string, NoteEntry[]>();
  for (const n of notes) {
    const list = groups.get(keyOf(n)) ?? [];
    list.push(n);
    groups.set(keyOf(n), list);
  }
  const newestFirst = (a: NoteEntry, b: NoteEntry): number => b.created_at.localeCompare(a.created_at) || b.id - a.id;
  return [...groups.values()]
    .map((list) => list.sort(newestFirst))
    .sort((a, b) => newestFirst(a[0], b[0]))
    .map((list) => {
      const { deck, slide } = list[0];
      return { deck, slide, html: noteGroupHtml(lectureId, { deck, slide }, list) };
    });
}

function noteGroupHtml(lectureId: string, key: SlideKey, notes: NoteEntry[]): string {
  const name = slideName(key.deck, key.slide);
  const base = `/l/${encodeURIComponent(lectureId)}`;
  const items = notes
    .map(
      (note) => `<li class="note" data-note-id="${note.id}">
        <p class="note-slide">${escapeHtml(name)}</p>
        <p class="note-text">${escapeHtml(note.text)}</p>
        <form method="post" action="${base}/lecturer/note/${note.id}/hide" class="hide-note-form">
          <button type="submit">Hide</button>
        </form>
      </li>`,
    )
    .join("\n");
  return `<section class="note-group" data-slide-key="${escapeHtml(keyOf(key))}"><h3>${escapeHtml(name)}</h3><ul class="notes-list">${items}</ul></section>`;
}

export interface NotesFilter {
  deck?: string;
  slide?: number;
}

// Reads ?deck= and ?slide= from the dashboard URL. Anything that isn't a
// real deck of this lecture or a positive whole number is ignored.
export function parseNotesFilter(lecture: Lecture, params: URLSearchParams): NotesFilter {
  const filter: NotesFilter = {};
  const deck = params.get("deck");
  if (lecture.id === "demo" && deck !== null && isDeckId(deck)) filter.deck = deck;
  const slideRaw = params.get("slide");
  if (slideRaw !== null && /^\d{1,4}$/.test(slideRaw) && Number(slideRaw) >= 1) filter.slide = Number(slideRaw);
  return filter;
}

export function notesFilterQuery(filter: NotesFilter): string {
  const params = new URLSearchParams();
  if (filter.deck !== undefined) params.set("deck", filter.deck);
  if (filter.slide !== undefined) params.set("slide", String(filter.slide));
  const q = params.toString();
  return q === "" ? "" : `?${q}`;
}

export function matchesNotesFilter(filter: NotesFilter, key: SlideKey): boolean {
  return (filter.deck === undefined || key.deck === filter.deck) && (filter.slide === undefined || key.slide === filter.slide);
}

// What the notes section says when it has nothing to list: the threshold
// if no slide's notes qualify yet, otherwise that the filter matched none.
export function notesEmptyText(filter: NotesFilter, min: number): { none: string; filtered: string } {
  const where =
    filter.slide !== undefined
      ? slideName(filter.deck ?? null, filter.slide)
      : filter.deck !== undefined && isDeckId(filter.deck)
        ? DECK_SHORT_NAMES[filter.deck]
        : "";
  return {
    none: `Notes on a slide show once ${min} people have written one there.`,
    filtered: `No notes to show on ${where} yet.`,
  };
}

function notesFilterFormHtml(lecture: Lecture, filter: NotesFilter): string {
  const action = `/l/${encodeURIComponent(lecture.id)}/lecturer`;
  const deckField =
    lecture.id === "demo"
      ? `<label for="notes-filter-deck">Lecture</label>
        <select id="notes-filter-deck" name="deck">
          <option value=""${filter.deck === undefined ? " selected" : ""}>All</option>
          ${DECK_IDS.map((d) => `<option value="${d}"${filter.deck === d ? " selected" : ""}>${escapeHtml(DECK_TITLES[d])}</option>`).join("")}
        </select>`
      : "";
  const showAll =
    filter.deck !== undefined || filter.slide !== undefined ? `<a href="${action}#notes" id="notes-filter-clear">Show every slide</a>` : "";
  return `<form method="get" action="${action}" id="notes-filter" class="inline-form">
        ${deckField}
        <label for="notes-filter-slide">Slide</label>
        <input id="notes-filter-slide" name="slide" type="number" min="1" inputmode="numeric" value="${filter.slide ?? ""}">
        <button type="submit">Show notes</button>
        ${showAll}
      </form>`;
}

export function notesListInnerHtml(groups: NoteGroup[], filter: NotesFilter, min: number): string {
  const shown = groups.filter((g) => matchesNotesFilter(filter, g));
  if (shown.length > 0) return shown.map((g) => g.html).join("\n");
  const text = notesEmptyText(filter, min);
  return `<p class="notes-empty">${escapeHtml(groups.length === 0 ? text.none : text.filtered)}</p>`;
}

// ---------- The whole dashboard block, for the first page render ----------

export function dashboardSectionsHtml(lecture: Lecture, dashboard: Dashboard, filter: NotesFilter): string {
  const f = dashboard.dashboardHtml;
  const slot = (id: string, heading: string, body: string, bodyId: string): string => `
      <section id="${id}" class="card graph-slot" aria-labelledby="${id}-heading">
        <h2 id="${id}-heading">${heading}</h2>
        <div class="slot-body" id="${bodyId}">${body}</div>
      </section>`;
  return `
    <section id="stat-tiles" class="stat-tiles" aria-label="Summary">${f.tiles}</section>
    <div class="graph-grid">
      ${slot("graph-lost", "Lost, per slide", f.graphLost, "bars")}
      ${slot("graph-reasons", "Why they were lost", f.graphReasons, "graph-reasons-body")}
      ${slot("graph-helped", "What helped", f.graphHelped, "graph-helped-body")}
      ${slot("graph-resolved", "Still lost, and “I get it now”", f.graphResolved, "graph-resolved-body")}
    </div>
    <section id="notes" class="card" aria-labelledby="notes-heading">
      <h2 id="notes-heading">What didn't make sense, by slide</h2>
      ${notesFilterFormHtml(lecture, filter)}
      <div id="notes-groups">${notesListInnerHtml(dashboard.noteGroups, filter, lecture.min_present)}</div>
    </section>`;
}

// The browser half: swaps in each fragment the stream sends, only when it
// changed, and keeps an open table open. Notes are filtered with the
// page's own filter, from groups the server already rendered and gated.
export function dashboardClientJs(filter: NotesFilter, min: number): string {
  return `
        var dashFilter = ${JSON.stringify(filter)};
        var dashEmpty = ${JSON.stringify(notesEmptyText(filter, min))};
        var dashSlots = { tiles: "stat-tiles", graphLost: "bars", graphReasons: "graph-reasons-body", graphHelped: "graph-helped-body", graphResolved: "graph-resolved-body" };
        var dashLast = {};
        function swapHtml(el, key, html) {
          if (!el || dashLast[key] === html) return;
          dashLast[key] = html;
          var open = {};
          var details = el.querySelectorAll("details");
          for (var i = 0; i < details.length; i++) open[i] = details[i].open;
          el.innerHTML = html;
          details = el.querySelectorAll("details");
          for (var j = 0; j < details.length; j++) if (open[j]) details[j].open = true;
        }
        function renderDashboard(state) {
          var fragments = state.dashboardHtml || {};
          Object.keys(dashSlots).forEach(function (key) {
            if (typeof fragments[key] === "string") swapHtml(document.getElementById(dashSlots[key]), key, fragments[key]);
          });
          var groups = state.noteGroups || [];
          var shown = groups.filter(function (g) {
            return (dashFilter.deck === undefined || g.deck === dashFilter.deck) && (dashFilter.slide === undefined || g.slide === dashFilter.slide);
          });
          var notesBox = document.getElementById("notes-groups");
          if (!notesBox) return;
          if (shown.length > 0) {
            swapHtml(notesBox, "notes", shown.map(function (g) { return g.html; }).join("\\n"));
          } else {
            var p = document.createElement("p");
            p.className = "notes-empty";
            p.textContent = groups.length === 0 ? dashEmpty.none : dashEmpty.filtered;
            swapHtml(notesBox, "notes", p.outerHTML);
          }
        }
`;
}
