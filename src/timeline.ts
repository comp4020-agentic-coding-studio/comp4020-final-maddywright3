import type { Lecture } from "./db.ts";
import type { Bar } from "./realtime.ts";
import { clockText, slideDurationsMs, slideName } from "./slides.ts";
import type { DeckId } from "./slides.ts";

// The student page's lecture timeline: one segment per slide, each a plain
// link to that slide (?deck=D&slide=N), so it works without JS and moves
// only this browser. On the demo a segment's width follows its slide's
// duration; a created lecture has no durations, so it gets one equal
// segment per slide reached so far. A segment is shaded only when that
// slide's bar is in `bars`, which is already gated per slide on
// min_present; the timeline never shows a count of its own.

const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 40;
// The live and viewed rings sit inside their segment, so their strokes
// aren't clipped at the edges of the viewBox.
const RING_INSET = 2;

export interface TimelineSegment {
  slide: number;
  x: number;
  width: number;
  label: string;
}

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// To one decimal place, so the markup stays short and the widths still
// add to exactly the viewBox width (each edge is rounded once, then a
// width is the difference of two rounded edges).
const tenth = (n: number): number => Math.round(n * 10) / 10;

export function timelineSegments(lecture: Lecture, deck: DeckId, liveSlide: number): TimelineSegment[] {
  if (lecture.id === "demo") {
    const durations = slideDurationsMs(deck);
    const total = durations.reduce((a, b) => a + b, 0);
    const segments: TimelineSegment[] = [];
    let start = 0;
    for (let i = 0; i < durations.length; i++) {
      const left = tenth((start / total) * VIEW_WIDTH);
      const right = tenth(((start + durations[i]) / total) * VIEW_WIDTH);
      segments.push({ slide: i + 1, x: left, width: tenth(right - left), label: `${slideName(deck, i + 1)}, starts ${clockText(start)}` });
      start += durations[i];
    }
    return segments;
  }
  const reached = Math.max(1, liveSlide);
  return Array.from({ length: reached }, (_, i) => {
    const left = tenth((i / reached) * VIEW_WIDTH);
    const right = tenth(((i + 1) / reached) * VIEW_WIDTH);
    return { slide: i + 1, x: left, width: tenth(right - left), label: slideName(null, i + 1) };
  });
}

export function timelineHtml(lecture: Lecture, deck: DeckId, viewedSlide: number, liveSlide: number, bars: Bar[]): string {
  const isDemo = lecture.id === "demo";
  const barDeck = isDemo ? deck : null;
  const segments = timelineSegments(lecture, deck, liveSlide);
  const shaded = (slide: number): boolean => bars.some((b) => b.deck === barDeck && b.slide === slide);
  const ring = (cls: string, s: TimelineSegment): string =>
    `<rect class="${cls}" x="${tenth(s.x + RING_INSET)}" y="${RING_INSET}" width="${tenth(Math.max(0, s.width - 2 * RING_INSET))}" height="${VIEW_HEIGHT - 2 * RING_INSET}"></rect>`;

  const links = segments
    .map((s) => {
      const href = isDemo ? `?deck=${deck}&slide=${s.slide}` : `?slide=${s.slide}`;
      const marks =
        (s.slide === liveSlide ? ring("timeline-live", s) : "") +
        (s.slide === viewedSlide && viewedSlide !== liveSlide ? ring("timeline-you", s) : "");
      return `<a href="${escapeHtml(href)}" data-slide="${s.slide}" aria-label="${escapeHtml(s.label)}"><rect class="timeline-segment${shaded(s.slide) ? " shaded" : ""}" x="${s.x}" y="0" width="${s.width}" height="${VIEW_HEIGHT}"></rect>${marks}</a>`;
    })
    .join("");

  // The same segments as text, for a screen reader: what each one is, and
  // whether it's shaded, live or yours. No counts, only the gated fact.
  const items = segments
    .map((s) => {
      const notes = [
        shaded(s.slide) ? "people were lost here" : "",
        s.slide === liveSlide ? "live" : "",
        s.slide === viewedSlide && viewedSlide !== liveSlide ? "you're here" : "",
      ].filter((n) => n !== "");
      return `<li>${escapeHtml(s.label)}${notes.length > 0 ? `: ${notes.join(", ")}` : ""}</li>`;
    })
    .join("");

  return `<svg viewBox="0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}" width="100%" role="group" aria-label="Lecture timeline" data-deck="${isDemo ? deck : ""}" data-segments="${escapeHtml(JSON.stringify(segments))}">${links}</svg>
          <ol class="visually-hidden" id="timeline-text">${items}</ol>`;
}
