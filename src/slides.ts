import { readFileSync } from "node:fs";
import { marked } from "marked";
import type { Lecture } from "./db.ts";

export const SLIDE_DURATION_MS = 40_000;

export type DeckId = "week-4" | "week-6";
export const DECK_IDS: DeckId[] = ["week-4", "week-6"];
export const DECK_TITLES: Record<DeckId, string> = {
  "week-4": "Week 4: Context engineering",
  "week-6": "Week 6: Evidence of practice",
};

interface Deck {
  creditHtml: string;
  slides: string[];
}

// Loaded once at module scope: each deck is fixed content shipped with the
// app, not per-request input, so there's no reason to re-read or re-parse it
// on every page view the way handleReadme does for the (small, rarely read)
// about page. A deck file's first part (before the first ---) is a credit
// block, not a slide — split off and rendered once, separately, under every
// slide view rather than as slide content itself.
function loadDeck(id: DeckId): Deck {
  const raw = readFileSync(`slides/${id}.md`, "utf8");
  const [rawCredit, ...rawSlides] = raw.split(/\n---\n/);
  return {
    creditHtml: marked.parse(rawCredit.trim()) as string,
    slides: rawSlides.map((slide) => marked.parse(slide.trim()) as string),
  };
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
  return (Math.floor(elapsed / SLIDE_DURATION_MS) % deckSlideCount(deck)) + 1;
}

// The demo's live slide on `deck` (LIVE_DECK unless named); a created
// lecture's lecturer-driven current_slide, which has no deck at all.
export function currentSlideIndex(lecture: Lecture, deck: DeckId = LIVE_DECK): number {
  return lecture.id === "demo" ? liveSlideIndex(lecture.id, deck) : lecture.current_slide;
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
  return SLIDE_DURATION_MS - (elapsed % SLIDE_DURATION_MS);
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
// than the current one too).
export function isValidSlide(lecture: Lecture, deck: string | undefined, slide: number): boolean {
  if (!Number.isInteger(slide) || slide < 1) return false;
  if (lecture.id !== "demo") return true;
  if (deck === undefined || !isDeckId(deck)) return false;
  return slide <= deckSlideCount(deck);
}
