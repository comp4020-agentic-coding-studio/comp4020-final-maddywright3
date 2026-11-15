import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { hashCode } from "./codes.ts";
import type { HashedCode } from "./codes.ts";

const dataDir = process.env.DATA_DIR ?? "./data";
mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(join(dataDir, "meter.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS lectures (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS taps (
    id INTEGER PRIMARY KEY,
    lecture_id TEXT NOT NULL REFERENCES lectures(id),
    created_at TEXT NOT NULL
  )
`);

const lectureColumns = db.prepare("PRAGMA table_info(lectures)").all() as { name: string }[];
if (!lectureColumns.some((c) => c.name === "min_present")) {
  db.exec("ALTER TABLE lectures ADD COLUMN min_present INTEGER NOT NULL DEFAULT 5");
}
if (!lectureColumns.some((c) => c.name === "code_hash")) {
  db.exec("ALTER TABLE lectures ADD COLUMN code_hash TEXT");
}
if (!lectureColumns.some((c) => c.name === "code_salt")) {
  db.exec("ALTER TABLE lectures ADD COLUMN code_salt TEXT");
}

if (!lectureColumns.some((c) => c.name === "current_slide")) {
  db.exec("ALTER TABLE lectures ADD COLUMN current_slide INTEGER NOT NULL DEFAULT 1");
}

const tapColumns = db.prepare("PRAGMA table_info(taps)").all() as { name: string }[];
if (!tapColumns.some((c) => c.name === "browser_id")) {
  db.exec("ALTER TABLE taps ADD COLUMN browser_id TEXT");
}
if (!tapColumns.some((c) => c.name === "slide")) {
  db.exec("ALTER TABLE taps ADD COLUMN slide INTEGER");
}
if (!tapColumns.some((c) => c.name === "deck")) {
  db.exec("ALTER TABLE taps ADD COLUMN deck TEXT");
}
if (!tapColumns.some((c) => c.name === "reason")) {
  db.exec("ALTER TABLE taps ADD COLUMN reason TEXT");
}
if (!tapColumns.some((c) => c.name === "resolved_at")) {
  db.exec("ALTER TABLE taps ADD COLUMN resolved_at TEXT");
}

db.exec(`
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY,
    lecture_id TEXT NOT NULL REFERENCES lectures(id),
    deck TEXT,
    slide INTEGER NOT NULL,
    browser_id TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    hidden_at TEXT,
    UNIQUE(lecture_id, deck, browser_id, slide)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS browsers (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS lecturer_sessions (
    token TEXT PRIMARY KEY,
    lecture_id TEXT NOT NULL REFERENCES lectures(id),
    created_at TEXT NOT NULL
  )
`);

db.prepare(
  "INSERT OR IGNORE INTO lectures (id, title, created_at) VALUES (?, ?, ?)",
).run("demo", "Demo lecture", new Date().toISOString());

db.prepare("UPDATE lectures SET min_present = 2 WHERE id = 'demo'").run();

const demoCode = hashCode("DEMO");
db.prepare("UPDATE lectures SET code_hash = ?, code_salt = ? WHERE id = 'demo' AND code_hash IS NULL").run(
  demoCode.hash,
  demoCode.salt,
);

export interface Lecture {
  id: string;
  title: string;
  created_at: string;
  min_present: number;
  code_hash: string | null;
  code_salt: string | null;
  current_slide: number;
}

export interface Tap {
  id: number;
  lecture_id: string;
  created_at: string;
  browser_id: string | null;
  slide: number | null;
  deck: string | null;
  reason: string | null;
  resolved_at: string | null;
}

export function getLecture(id: string): Lecture | undefined {
  return db.prepare("SELECT * FROM lectures WHERE id = ?").get(id) as Lecture | undefined;
}

export function createLecture(id: string, title: string, minPresent: number, code: HashedCode): void {
  db.prepare(
    "INSERT INTO lectures (id, title, created_at, min_present, code_hash, code_salt) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, title, new Date().toISOString(), minPresent, code.hash, code.salt);
}

export function tapCount(lectureId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM taps WHERE lecture_id = ?")
    .get(lectureId) as { count: number };
  return row.count;
}

export interface LiveTapInfo {
  count: number;
  earliest: string | null;
}

// AND resolved_at IS NULL: a resolved tap stops counting as live
// immediately, everywhere "live" is read — "I get it now" ends a tap's live
// status at once, independent of the 60s window.
export function liveTapInfo(lectureId: string, sinceIso: string): LiveTapInfo {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS count, MIN(created_at) AS earliest FROM taps WHERE lecture_id = ? AND created_at >= ? AND resolved_at IS NULL",
    )
    .get(lectureId, sinceIso) as { count: number; earliest: string | null };
  return row;
}

// Atomic insert-if-not-recently-tapped: a single statement rather than a
// separate SELECT-then-INSERT, so a browser can't double-count a tap no
// matter how the handler around it changes later. Returns whether a row was
// actually inserted. The dedup clause also excludes resolved taps — without
// this, "I get it now" flips youAreCounted to false and re-enables the
// button, but a re-tap inside the original 60s window would silently fail
// to insert (the clause only looked at created_at >= since, never at
// resolution) — this is the one place a resolved tap must stop blocking a
// fresh tap, exactly mirroring how it already stops counting as live.
export function tapIfNotRecentlyTapped(
  lectureId: string,
  browserId: string,
  sinceIso: string,
  deck: string | null,
  slide: number,
): boolean {
  const nowIso = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO taps (lecture_id, created_at, browser_id, deck, slide)
       SELECT ?, ?, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM taps
         WHERE lecture_id = ? AND browser_id = ? AND created_at >= ? AND resolved_at IS NULL
       )`,
    )
    .run(lectureId, nowIso, browserId, deck, slide, lectureId, browserId, sinceIso);
  return result.changes > 0;
}

export function yourTapCount(lectureId: string, browserId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM taps WHERE lecture_id = ? AND browser_id = ?")
    .get(lectureId, browserId) as { count: number };
  return row.count;
}

// The caller's own live (unresolved, within the window) tap, if any —
// needed to attach/change a reason, show a countdown, or resolve it.
export function liveTapFor(lectureId: string, browserId: string, sinceIso: string): Tap | undefined {
  return db
    .prepare(
      "SELECT * FROM taps WHERE lecture_id = ? AND browser_id = ? AND created_at >= ? AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 1",
    )
    .get(lectureId, browserId, sinceIso) as Tap | undefined;
}

export function setTapReason(lectureId: string, browserId: string, sinceIso: string, reason: string): boolean {
  const result = db
    .prepare(
      `UPDATE taps SET reason = ?
       WHERE id = (
         SELECT id FROM taps
         WHERE lecture_id = ? AND browser_id = ? AND created_at >= ? AND resolved_at IS NULL
         ORDER BY created_at DESC LIMIT 1
       )`,
    )
    .run(reason, lectureId, browserId, sinceIso);
  return result.changes > 0;
}

export function resolveTap(lectureId: string, browserId: string, sinceIso: string): boolean {
  const nowIso = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE taps SET resolved_at = ?
       WHERE id = (
         SELECT id FROM taps
         WHERE lecture_id = ? AND browser_id = ? AND created_at >= ? AND resolved_at IS NULL
         ORDER BY created_at DESC LIMIT 1
       )`,
    )
    .run(nowIso, lectureId, browserId, sinceIso);
  return result.changes > 0;
}

export interface ReasonCount {
  deck: string | null;
  slide: number;
  reason: string;
  count: number;
}

// Raw counts per (deck, slide, reason) — gating (per-pair, not inherited
// from the slide's own bar gate) lives in realtime.ts, mirroring
// slideTapCounts.
export function reasonCounts(lectureId: string): ReasonCount[] {
  return db
    .prepare(
      `SELECT deck, slide, reason, COUNT(DISTINCT browser_id) AS count
       FROM taps WHERE lecture_id = ? AND reason IS NOT NULL
       GROUP BY deck, slide, reason`,
    )
    .all(lectureId) as unknown as ReasonCount[];
}

export interface SlideTapCount {
  deck: string | null;
  slide: number;
  distinctBrowsers: number;
}

// Distinct browsers per (deck, slide) — grouped by deck too, not slide alone,
// so week-4's slide 3 and week-6's slide 3 are counted separately. No gating
// here; that's realtime.ts's job, same separation as the rest of db.ts.
export function slideTapCounts(lectureId: string): SlideTapCount[] {
  return db
    .prepare(
      `SELECT deck, slide, COUNT(DISTINCT browser_id) AS distinctBrowsers
       FROM taps WHERE lecture_id = ? AND slide IS NOT NULL
       GROUP BY deck, slide`,
    )
    .all(lectureId) as unknown as SlideTapCount[];
}

// SQLite's UNIQUE/ON CONFLICT treats every NULL as distinct from every other
// NULL, so a nullable deck column in the UNIQUE(lecture_id, deck, ...)
// constraint would let a created lecture's notes (always deck=NULL) bypass
// the "one note per slide" dedup entirely — confirmed by testing the exact
// upsert against :memory: before trusting it. Stored as this sentinel
// instead, converted back to null at the read boundary, so the external API
// (deck: string | null) is unaffected by the storage workaround.
const NO_DECK = "";

// One note per (lecture, deck, browser, slide): sending again replaces the
// previous note and un-hides it (a replaced note is a fresh one), as one
// atomic statement rather than a separate select/update — same reasoning
// as tapIfNotRecentlyTapped's atomic insert.
export function setNote(lectureId: string, deck: string | null, browserId: string, slide: number, text: string): void {
  const nowIso = new Date().toISOString();
  db.prepare(
    `INSERT INTO notes (lecture_id, deck, slide, browser_id, text, created_at, hidden_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT (lecture_id, deck, browser_id, slide)
     DO UPDATE SET text = excluded.text, created_at = excluded.created_at, hidden_at = NULL`,
  ).run(lectureId, deck ?? NO_DECK, slide, browserId, text, nowIso);
}

export function hideNoteById(noteId: number): void {
  db.prepare("UPDATE notes SET hidden_at = ? WHERE id = ?").run(new Date().toISOString(), noteId);
}

export interface SlideNoteCount {
  deck: string | null;
  slide: number;
  distinctBrowsers: number;
}

// Distinct browsers per (deck, slide) among VISIBLE notes only — used
// purely to decide which (deck, slide) pairs clear the gate; never returns
// note text.
export function slideNoteCounts(lectureId: string): SlideNoteCount[] {
  const rows = db
    .prepare(
      `SELECT deck, slide, COUNT(DISTINCT browser_id) AS distinctBrowsers
       FROM notes WHERE lecture_id = ? AND hidden_at IS NULL
       GROUP BY deck, slide`,
    )
    .all(lectureId) as unknown as SlideNoteCount[];
  return rows.map((row) => ({ ...row, deck: row.deck === NO_DECK ? null : row.deck }));
}

export interface VisibleNote {
  id: number;
  text: string;
  created_at: string;
}

// Only called once a (deck, slide) pair has already cleared the
// min_present-distinct-browsers gate; never returns browser_id to its
// caller, since the lecturer must never be able to link a note back to a
// browser, only to a slide. Newest first.
export function visibleNotesForSlide(lectureId: string, deck: string | null, slide: number): VisibleNote[] {
  return db
    .prepare(
      `SELECT id, text, created_at FROM notes
       WHERE lecture_id = ? AND deck = ? AND slide = ? AND hidden_at IS NULL
       ORDER BY created_at DESC`,
    )
    .all(lectureId, deck ?? NO_DECK, slide) as unknown as VisibleNote[];
}

export function browserExists(id: string): boolean {
  const row = db.prepare("SELECT 1 FROM browsers WHERE id = ?").get(id);
  return row !== undefined;
}

export function insertBrowser(id: string): void {
  db.prepare("INSERT OR IGNORE INTO browsers (id, created_at) VALUES (?, ?)").run(
    id,
    new Date().toISOString(),
  );
}

export function insertLecturerSession(token: string, lectureId: string): void {
  db.prepare("INSERT INTO lecturer_sessions (token, lecture_id, created_at) VALUES (?, ?, ?)").run(
    token,
    lectureId,
    new Date().toISOString(),
  );
}

export function lecturerSessionValid(token: string, lectureId: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM lecturer_sessions WHERE token = ? AND lecture_id = ?")
    .get(token, lectureId);
  return row !== undefined;
}

export function setCurrentSlide(lectureId: string, newSlide: number): void {
  db.prepare("UPDATE lectures SET current_slide = ? WHERE id = ?").run(newSlide, lectureId);
}
