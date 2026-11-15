import { readFileSync } from "node:fs";
import { marked } from "marked";
import type { Lecture } from "./db.ts";

export const SLIDE_DURATION_MS = 40_000;

// Loaded once at module scope: the deck is fixed content shipped with the
// app, not per-request input, so there's no reason to re-read or re-parse it
// on every page view the way handleReadme does for the (small, rarely read)
// about page.
const rawDeck = readFileSync("slides/demo.md", "utf8");
export const demoSlides: string[] = rawDeck
  .split(/\n---\n/)
  .map((slide) => marked.parse(slide.trim()) as string);

export function demoSlideCount(): number {
  return demoSlides.length;
}

// A pure function of the lecture's creation time and the wall clock: every
// visitor computing this from the same created_at lands on the same slide,
// with nothing stored anywhere — that's the "shared clock". 1-based, like
// lectures.current_slide, so a tap's `slide` value means the same thing
// whether it came from the demo's clock or a lecturer's Next/Prev.
export function demoSlideIndex(lecture: Lecture): number {
  const elapsed = Date.now() - new Date(lecture.created_at).getTime();
  const slideCount = demoSlideCount();
  return (Math.floor(Math.max(0, elapsed) / SLIDE_DURATION_MS) % slideCount) + 1;
}

export function currentSlideIndex(lecture: Lecture): number {
  return lecture.id === "demo" ? demoSlideIndex(lecture) : lecture.current_slide;
}

// A submitted slide index is trusted only if it matches the slide the server
// currently has recorded, or the previous one if the change happened within
// the last 5 seconds — a tap already in flight when the lecturer advances
// shouldn't be silently reattributed to the new slide. Anything else (stale
// beyond the grace window, or not matching either value) falls back to the
// current slide, so a tap is never dropped, just attributed to the safest one.
const SLIDE_GRACE_MS = 5_000;

export function resolveTapSlide(lecture: Lecture, submittedSlide: number | undefined): number {
  const current = currentSlideIndex(lecture);
  if (submittedSlide === undefined) return current;
  if (submittedSlide === current) return current;
  if (
    lecture.previous_slide !== null &&
    lecture.slide_changed_at !== null &&
    submittedSlide === lecture.previous_slide &&
    Date.now() - new Date(lecture.slide_changed_at).getTime() < SLIDE_GRACE_MS
  ) {
    return lecture.previous_slide;
  }
  return current;
}
