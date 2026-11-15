import { readFileSync } from "node:fs";
import { marked } from "marked";
import type { Lecture } from "./db.ts";

export const SLIDE_DURATION_MS = 40_000;

// Loaded once at module scope: the deck is fixed content shipped with the
// app, not per-request input, so there's no reason to re-read or re-parse it
// on every page view the way handleReadme does for the (small, rarely read)
// about page. The file's first part (before the first ---) is a credit
// block, not a slide — split off and rendered once, separately, under every
// slide view rather than as slide content itself.
const rawDeck = readFileSync("slides/demo.md", "utf8");
const [rawCredit, ...rawSlides] = rawDeck.split(/\n---\n/);
export const demoCreditHtml: string = marked.parse(rawCredit.trim()) as string;
export const demoSlides: string[] = rawSlides.map((slide) => marked.parse(slide.trim()) as string);

export function demoSlideCount(): number {
  return demoSlides.length;
}

// A pure function of the lecture's creation time and the wall clock: every
// visitor computing this from the same created_at lands on the same slide,
// with nothing stored anywhere — that's the "shared clock". 1-based, like
// lectures.current_slide, so a tap's `slide` value means the same thing
// whether it came from the demo's clock or a lecturer's Next/Prev. Browsing
// (below) never changes this — it only changes what a given viewer is
// looking at, not the shared live slide "Back to live" returns to.
export function demoSlideIndex(lecture: Lecture): number {
  const elapsed = Date.now() - new Date(lecture.created_at).getTime();
  const slideCount = demoSlideCount();
  return (Math.floor(Math.max(0, elapsed) / SLIDE_DURATION_MS) % slideCount) + 1;
}

export function currentSlideIndex(lecture: Lecture): number {
  return lecture.id === "demo" ? demoSlideIndex(lecture) : lecture.current_slide;
}

// For a clock-driven lecture (the demo), milliseconds until the slide
// advances on its own — so a timer can be armed to push a broadcast right
// then, the same way a live tap's 60s fade is scheduled rather than only
// recomputed when something else happens to trigger a broadcast. undefined
// for a lecturer-driven lecture, where every slide change already broadcasts
// from the handler that makes it.
export function msUntilNextSlideChange(lecture: Lecture): number | undefined {
  if (lecture.id !== "demo") return undefined;
  const elapsed = Date.now() - new Date(lecture.created_at).getTime();
  const intoCurrentSlide = Math.max(0, elapsed) % SLIDE_DURATION_MS;
  return SLIDE_DURATION_MS - intoCurrentSlide;
}

// A tap always records the slide the viewer says they're looking at — ADR
// 004's amendment replaces the old grace-window reconciliation with outright
// browsing, so there's no single "current slide" a late tap could be racing
// against. The demo has a fixed deck (9 slides), so a submitted slide must
// fall within it. A created lecture has no deck of its own — just a number
// the lecturer advances — so there's no fixed ceiling to validate against;
// any positive integer is a plausible slide for one of those (the lecturer
// may advance further after a student's page loads, and a student may be
// looking at an earlier slide than the current one too).
export function isValidSlide(lecture: Lecture, slide: number): boolean {
  if (!Number.isInteger(slide) || slide < 1) return false;
  return lecture.id === "demo" ? slide <= demoSlideCount() : true;
}
