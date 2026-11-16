import { readFileSync } from "node:fs";
import { marked } from "marked";
import type { Lecture } from "./db.ts";

// Each demo deck stands in for a 60-minute lecture condensed 12x into
// about 5 minutes (ADR 006). Every slide has its own duration, written in
// its deck file as `<!-- duration: N -->` (seconds), weighted by how much
// it covers. The live window for a demo tap is scaled down the same way;
// a created lecture keeps the real 60 seconds.
export const CONDENSED_FACTOR = 12;
export const DEMO_LIVE_WINDOW_MS = 20_000;
export const CREATED_LIVE_WINDOW_MS = 60_000;

// How long a tap on this lecture stays live.
export function liveWindowMs(lectureId: string): number {
  return lectureId === "demo" ? DEMO_LIVE_WINDOW_MS : CREATED_LIVE_WINDOW_MS;
}

export type DeckId = "week-4" | "week-6";
export const DECK_IDS: DeckId[] = ["week-4", "week-6"];
export const DECK_TITLES: Record<DeckId, string> = {
  "week-4": "Week 4: Context engineering",
  "week-6": "Week 6: Evidence of practice",
};

// The deck's short human name, for wherever a slide is named to a person:
// "Week 4 &middot; slide 6". The full title is for the deck menu.
export const DECK_SHORT_NAMES: Record<DeckId, string> = {
  "week-4": "Week 4",
  "week-6": "Week 6",
};

// Between the deck and the slide: a middle dot (&middot;, U+00B7), written
// as an escape so the source stays ASCII, as in the slide card's chip
// "Week 4 &middot; slide 3 of 9". SLIDE_NAME_CLIENT_JS in src/server.ts uses
// this same constant, so a live update never names a slide differently.
export const DECK_SLIDE_SEPARATOR = " \u00b7 ";

export interface SlideNameOptions {
  // The deck's slide count, for "Week 4 &middot; slide 6 of 10".
  of?: number;
  // Whether this is the live slide: adds "(live)".
  live?: boolean;
}

// How every page names a slide. A demo slide names its deck, because the
// demo has two and "Slide 6" alone doesn't say which; a created lecture has
// no deck, so it's just "Slide 6". The page scripts use the same wording
// (SLIDE_NAME_CLIENT_JS in src/server.ts), so a live update never changes
// how a slide is named.
export function slideName(deck: string | null, slide: number, options: SlideNameOptions = {}): string {
  const short = deck !== null && isDeckId(deck) ? DECK_SHORT_NAMES[deck] : undefined;
  const name = short !== undefined ? `${short}${DECK_SLIDE_SEPARATOR}slide ${slide}` : `Slide ${slide}`;
  const of = options.of !== undefined ? ` of ${options.of}` : "";
  return `${name}${of}${options.live ? " (live)" : ""}`;
}

interface Deck {
  creditHtml: string;
  slides: string[];
  durationsMs: number[];
}

const DURATION_LINE = /^\s*<!-- duration: (\d+) -->\n?/;

// Loaded once at module scope: each deck is fixed content shipped with the
// app, not per-request input, so there's no reason to re-read or re-parse it
// on every page view the way handleReadme does for the (small, rarely read)
// about page. A deck file's first part (before the first ---) is a credit
// block, not a slide — split off and rendered once, separately, under every
// slide view rather than as slide content itself.
// Each slide's first line is its duration; it's taken off before the
// slide is rendered, and a slide without one stops the app at startup
// rather than running a deck with a hole in its clock.
function loadDeck(id: DeckId): Deck {
  const raw = readFileSync(`slides/${id}.md`, "utf8");
  const [rawCredit, ...rawSlides] = raw.split(/\n---\n/);
  const durationsMs: number[] = [];
  const slides = rawSlides.map((slide, i) => {
    const match = slide.match(DURATION_LINE);
    if (!match) throw new Error(`slides/${id}.md: slide ${i + 1} has no <!-- duration: N --> line`);
    durationsMs.push(Number(match[1]) * 1000);
    return marked.parse(slide.slice(match[0].length).trim()) as string;
  });
  return { creditHtml: marked.parse(rawCredit.trim()) as string, slides, durationsMs };
}

const DECKS: Record<DeckId, Deck> = {
  "week-4": loadDeck("week-4"),
  "week-6": loadDeck("week-6"),
};

// The deck a bare /l/demo (or a student stream with no or an invalid
// ?deck=) shows, and the one whose live slide the lecturer view reports.
// Only a default: every demo deck has its own independent clock (below).
export const LIVE_DECK: DeckId = "week-4";

export function isDeckId(value: string): value is DeckId {
  return (DECK_IDS as string[]).includes(value);
}

export function deckSlides(deckId: DeckId): string[] {
  return DECKS[deckId].slides;
}

export function deckCreditHtml(deckId: DeckId): string {
  return DECKS[deckId].creditHtml;
}

export function deckSlideCount(deckId: DeckId): number {
  return DECKS[deckId].slides.length;
}

// Each slide's duration in this deck, in order (the timeline sizes its
// segments by these).
export function slideDurationsMs(deck: DeckId): number[] {
  return [...DECKS[deck].durationsMs];
}

export function deckLengthMs(deck: DeckId): number {
  return DECKS[deck].durationsMs.reduce((a, b) => a + b, 0);
}

// Where in its cycle the deck's clock is: which slide (0-based), and how
// far into that slide. The deck loops, so the clock wraps at its length.
function positionAt(deck: DeckId, elapsedMs: number): { index: number; intoSlideMs: number } {
  const durations = DECKS[deck].durationsMs;
  let t = elapsedMs % deckLengthMs(deck);
  for (let i = 0; i < durations.length; i++) {
    if (t < durations[i]) return { index: i, intoSlideMs: t };
    t -= durations[i];
  }
  return { index: durations.length - 1, intoSlideMs: durations[durations.length - 1] };
}

// When each (lecture, deck)'s shared clock started. src/realtime.ts sets it
// when a student stream opens on a deck nobody is watching, and deletes it
// when that deck's last viewer leaves. No entry means nobody is watching,
// so the live slide is 1: the next arrival starts the deck from the top
// instead of landing mid-lecture in an empty room. In memory only (see
// docs/state.md) — a restart means nobody is watching, so losing this map
// gives exactly the right answer.
const deckStarts = new Map<string, number>();

function clockKey(lectureId: string, deck: DeckId): string {
  return `${lectureId}:${deck}`;
}

export function startDeckClock(lectureId: string, deck: DeckId): void {
  deckStarts.set(clockKey(lectureId, deck), Date.now());
}

export function clearDeckClock(lectureId: string, deck: DeckId): void {
  deckStarts.delete(clockKey(lectureId, deck));
}

function msSinceDeckStart(lectureId: string, deck: DeckId): number | undefined {
  const start = deckStarts.get(clockKey(lectureId, deck));
  return start === undefined ? undefined : Math.max(0, Date.now() - start);
}

// Every viewer of a deck computes this from the same start time, so they
// all land on the same slide — that's the "shared clock". 1-based, like
// lectures.current_slide, so a tap's `slide` value means the same thing
// whether it came from the demo's clock or a lecturer's Next/Prev. Browsing
// never changes this — it only changes what a given viewer is looking at,
// not the shared live slide "Back to live" returns to.
export function liveSlideIndex(lectureId: string, deck: DeckId): number {
  const elapsed = msSinceDeckStart(lectureId, deck);
  if (elapsed === undefined) return 1;
  return positionAt(deck, elapsed).index + 1;
}

// How far into the condensed lecture the deck's clock is, wrapping as the
// deck loops; 0 when nobody is watching.
export function lectureElapsedMs(lectureId: string, deck: DeckId): number {
  const elapsed = msSinceDeckStart(lectureId, deck);
  return elapsed === undefined ? 0 : elapsed % deckLengthMs(deck);
}

// A timed lecture (ADR 006, section 4) keeps its clock in the database:
// when the lecturer pressed Start lecture, and how long each slide lasts.
// Unlike the demo's in-memory clock, it survives a restart, because a real
// lecture keeps going whether or not the server blinked. Before Start it
// sits wherever the lecturer's Previous/Next left it (slide 1 to begin
// with); after the last slide's time is up it stays there. The lecturer's
// Previous/Next on a started lecture move the clock's origin, started_at,
// so the chosen slide starts now (timedOriginFor): the slide is still only
// ever computed from started_at, one source of truth.
interface TimedPosition {
  slide: number;
  // Milliseconds until the next slide; undefined once on the last slide.
  msUntilNext: number | undefined;
}

export function slideDurations(lecture: Lecture): number[] | undefined {
  if (lecture.pacing !== "timed" || lecture.slide_durations_ms === null) return undefined;
  return JSON.parse(lecture.slide_durations_ms) as number[];
}

function timedPosition(lecture: Lecture, now = Date.now()): TimedPosition | undefined {
  const durations = slideDurations(lecture);
  if (durations === undefined || lecture.started_at === null) return undefined;
  let remaining = Math.max(0, now - Date.parse(lecture.started_at));
  for (let i = 0; i < durations.length - 1; i++) {
    if (remaining < durations[i]) return { slide: i + 1, msUntilNext: durations[i] - remaining };
    remaining -= durations[i];
  }
  return { slide: durations.length, msUntilNext: undefined };
}

// The demo's live slide on `deck` (LIVE_DECK unless named); a timed
// lecture's slide from its stored clock; otherwise a created lecture's
// lecturer-driven current_slide, which has no deck at all.
export function currentSlideIndex(lecture: Lecture, deck: DeckId = LIVE_DECK): number {
  if (lecture.id === "demo") return liveSlideIndex(lecture.id, deck);
  if (lecture.pacing === "timed") return timedPosition(lecture)?.slide ?? lecture.current_slide;
  return lecture.current_slide;
}

// The started_at that puts a timed lecture at the start of `slide` at
// `now`: now minus the durations of every slide before it. Start lecture
// uses it to start from the current slide, and the lecturer's Previous/Next
// to carry the clock on from the slide they chose.
export function timedOriginFor(lecture: Lecture, slide: number, now = Date.now()): string {
  const durations = slideDurations(lecture) ?? [];
  const before = durations.slice(0, Math.max(0, slide - 1)).reduce((sum, ms) => sum + ms, 0);
  return new Date(now - before).toISOString();
}

// Whether a timed lecture's clock is running.
export function timedStarted(lecture: Lecture): boolean {
  return lecture.pacing === "timed" && lecture.started_at !== null && slideDurations(lecture) !== undefined;
}

// For a started timed lecture, milliseconds until its slide next moves, so
// src/realtime.ts can push the change on time. undefined before Start,
// on the last slide, and for any other lecture.
export function msUntilTimedSlideChange(lecture: Lecture): number | undefined {
  return timedPosition(lecture)?.msUntilNext;
}

// For a running deck clock, milliseconds until its live slide advances on
// its own — so a timer can be armed to push a broadcast right then, the same
// way a live tap's 60s fade is scheduled rather than only recomputed when
// something else happens to trigger a broadcast. undefined when the deck's
// clock isn't running (nobody watching), and for a lecturer-driven lecture,
// where every slide change already broadcasts from the handler that makes it.
export function msUntilNextSlideChange(lectureId: string, deck: DeckId): number | undefined {
  if (lectureId !== "demo") return undefined;
  const elapsed = msSinceDeckStart(lectureId, deck);
  if (elapsed === undefined) return undefined;
  const { index, intoSlideMs } = positionAt(deck, elapsed);
  return DECKS[deck].durationsMs[index] - intoSlideMs;
}

// "1:20": minutes and seconds, for the lecture time and its real-time note.
export function clockText(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds < 10 ? "0" : ""}${seconds}`;
}

// A tap always records the slide (and deck) the viewer says they're looking
// at — ADR 004's amendment replaces the old grace-window reconciliation with
// outright browsing, so there's no single "current slide" a late tap could
// be racing against. The demo's two decks each have a fixed slide count, so a
// submitted slide must fall within whichever deck was named. A created
// lecture has no deck of its own — just a number the lecturer advances — so
// there's no fixed ceiling to validate against; any positive integer is a
// plausible slide for one of those (the lecturer may advance further after a
// student's page loads, and a student may be looking at an earlier slide
// than the current one too). One made at /new since it asked for a slide
// count has that ceiling.
export function isValidSlide(lecture: Lecture, deck: string | undefined, slide: number): boolean {
  if (!Number.isInteger(slide) || slide < 1) return false;
  if (lecture.id !== "demo") return lecture.slide_count === null || slide <= lecture.slide_count;
  if (deck === undefined || !isDeckId(deck)) return false;
  return slide <= deckSlideCount(deck);
}
