import { Marked } from "marked";
import type { Tokens } from "marked";

// Slide text a lecturer pasted at /new is shown to every student, so it is
// rendered by its own Marked instance, never the shared `marked` the
// repo's decks and README use (CLAUDE.md: "Lecturer-supplied slide text is
// escaped. No raw HTML, no images, nothing loaded from elsewhere."):
// - raw HTML, block or inline, comes out as escaped text;
// - an image renders only its alt text, so nothing is fetched;
// - a link stays a link only for an absolute http: or https: URL; anything
//   else (javascript:, data:, a relative path) is just its text.
// Everything else (headings, lists, emphasis, code) is marked's own output,
// which already escapes text.

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

function isWebUrl(href: string): boolean {
  try {
    const { protocol } = new URL(href);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

const pasted = new Marked({ async: false, gfm: true });
pasted.use({
  renderer: {
    html({ text }: Tokens.HTML | Tokens.Tag): string {
      return escapeHtml(text);
    },
    image({ text }: Tokens.Image): string {
      return escapeHtml(text);
    },
    link({ href, title, tokens }: Tokens.Link): string {
      const inner = this.parser.parseInline(tokens);
      if (!isWebUrl(href)) return inner;
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      return `<a href="${escapeHtml(href)}"${titleAttr} rel="noopener noreferrer">${inner}</a>`;
    },
  },
});

export function renderPastedSlide(markdown: string): string {
  return pasted.parse(markdown) as string;
}

// Slides are separated by a line holding only ---. Split before parsing,
// so a --- under a line of text is a slide break, never a setext heading.
// Blank parts (a leading or trailing ---, two in a row) aren't slides.
export function splitPastedSlides(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/^[ \t]*---[ \t]*$/m)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}
