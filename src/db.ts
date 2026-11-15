import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { hashCode } from "./codes.ts";
import type { HashedCode } from "./codes.ts";

const dataDir = process.env.DATA_DIR ?? "./data";
mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(join(dataDir, "meter.db"));

// WAL with synchronous=NORMAL: a tap's insert dropped from ~7.5ms (a full
// disk sync per write) to ~0.1ms. The cost, accepted in ADR 005: a power
// loss can drop the last moment of taps, and meter.db-wal and meter.db-shm
// sit beside meter.db and must be kept with it.
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");
const { journal_mode: journalMode } = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
if (journalMode !== "wal") throw new Error(`expected WAL journal mode, got ${journalMode}`);

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
// Every existing row belongs to run 1; ADR 006's fresh runs start at 2.
if (!tapColumns.some((c) => c.name === "run_id")) {
  db.exec("ALTER TABLE taps ADD COLUMN run_id INTEGER NOT NULL DEFAULT 1");
}
if (!tapColumns.some((c) => c.name === "legacy_duplicate")) {
  db.exec("ALTER TABLE taps ADD COLUMN legacy_duplicate INTEGER NOT NULL DEFAULT 0");
}
// What helped, from a fixed list, answered once after "I get it now".
if (!tapColumns.some((c) => c.name === "helped")) {
  db.exec("ALTER TABLE taps ADD COLUMN helped TEXT");
}

// One "I'm lost" per (lecture, run, deck, slide, browser), held by a unique
// index rather than by a check in the insert. Two things make the index
// unusual, and both are deliberate:
// - COALESCE(deck, ''): a created lecture's deck is NULL, and SQLite treats
//   every NULL as distinct in a unique index, so a plain index on deck
//   would let those lectures' duplicates through.
// - WHERE legacy_duplicate = 0: before this rule a browser could tap the
//   same slide again after 60 seconds or after "I get it now", so existing
//   databases hold duplicates and CREATE UNIQUE INDEX would fail on them.
//   Nothing is deleted. The earliest tap per key stays counted; later ones
//   are marked legacy_duplicate = 1, which only takes them out of this
//   index. Bars and reasons already count distinct browsers, and the total
//   still counts every row, so no number shown before changes. Rows with no
//   browser or no slide (from before C10) can't collide and are left alone.
// The whole migration runs once, in one transaction, before the index
// exists, so a crash part-way leaves the database as it was.
const hasOneTapIndex = db
  .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'taps_one_per_slide'")
  .get();
if (!hasOneTapIndex) {
  db.exec("BEGIN");
  try {
    // Created lectures' taps were once filed under the demo's default deck
    // (fixed in 28b7d1d). Only the demo has decks, so those rows go back to
    // NULL, where their notes already are.
    db.exec("UPDATE taps SET deck = NULL WHERE lecture_id <> 'demo' AND deck IS NOT NULL");
    db.exec(`
      UPDATE taps SET legacy_duplicate = 1
      WHERE browser_id IS NOT NULL AND slide IS NOT NULL
        AND id NOT IN (
          SELECT MIN(id) FROM taps
          WHERE browser_id IS NOT NULL AND slide IS NOT NULL
          GROUP BY lecture_id, run_id, COALESCE(deck, ''), slide, browser_id
        )
    `);
    db.exec(`
      CREATE UNIQUE INDEX taps_one_per_slide
      ON taps (lecture_id, run_id, COALESCE(deck, ''), slide, browser_id)
      WHERE legacy_duplicate = 0
    `);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
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
  helped: string | null;
}

export function getLecture(id: string): Lecture | undefined {
  return db.prepare("SELECT * FROM lectures WHERE id = ?").get(id) as Lecture | undefined;
}

export function createLecture(id: string, title: string, minPresent: number, code: HashedCode): void {
  db.prepare(
    "INSERT INTO lectures (id, title, created_at, min_present, code_hash, code_salt) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, title, new Date().toISOString(), minPresent, code.hash, code.salt);
}

export function lectureCount(): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM lectures").get() as { count: number };
  return row.count;
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
// status at once, independent of the 60s window. `count` is distinct
// browsers, not taps: with one tap per slide, a browser lost on two slides
// inside a minute has two live taps, and it's still one person lost.
export function liveTapInfo(lectureId: string, sinceIso: string): LiveTapInfo {
  const row = db
    .prepare(
      "SELECT COUNT(DISTINCT browser_id) AS count, MIN(created_at) AS earliest FROM taps WHERE lecture_id = ? AND created_at >= ? AND resolved_at IS NULL",
    )
    .get(lectureId, sinceIso) as { count: number; earliest: string | null };
  return row;
}

// One "I'm lost" per browser per slide, ever: a single INSERT that the
// taps_one_per_slide index turns into a no-op when this browser has already
// tapped this (lecture, run, deck, slide). Two requests at the same moment
// can't both get in, because the index, not a prior SELECT, decides. ON
// CONFLICT DO NOTHING ignores only that conflict; any other failure (a
// missing lecture id, say) still raises. Returns whether a row was
// inserted.
export function tapOncePerSlide(lectureId: string, browserId: string, deck: string | null, slide: number): boolean {
  const result = db
    .prepare(
      `INSERT INTO taps (lecture_id, created_at, browser_id, deck, slide)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    .run(lectureId, new Date().toISOString(), browserId, deck, slide);
  return result.changes > 0;
}

export interface YourSlide {
  deck: string | null;
  slide: number;
  // Still counted as lost: inside the live window and not resolved.
  live: boolean;
  // "I get it now" was pressed for this slide.
  resolved: boolean;
  // Whether a reason / what-helped has been sent. Flags only, never the
  // answer itself: no answer text travels in a student payload.
  answeredReason: boolean;
  answeredHelped: boolean;
}

// Every (deck, slide) this browser has said it's lost on in the lecture,
// and whether that tap still counts as live. For its own page only: never
// sent to any other browser or the lecturer.
export function slidesYouTapped(lectureId: string, browserId: string, sinceIso: string): YourSlide[] {
  const rows = db
    .prepare(
      `SELECT deck, slide, (created_at >= ? AND resolved_at IS NULL) AS live,
              resolved_at IS NOT NULL AS resolved, reason IS NOT NULL AS answeredReason,
              helped IS NOT NULL AS answeredHelped
       FROM taps
       WHERE lecture_id = ? AND browser_id = ? AND slide IS NOT NULL AND legacy_duplicate = 0
       ORDER BY deck, slide`,
    )
    .all(sinceIso, lectureId, browserId) as {
    deck: string | null;
    slide: number;
    live: number;
    resolved: number;
    answeredReason: number;
    answeredHelped: number;
  }[];
  return rows.map((row) => ({
    deck: row.deck,
    slide: row.slide,
    live: row.live === 1,
    resolved: row.resolved === 1,
    answeredReason: row.answeredReason === 1,
    answeredHelped: row.answeredHelped === 1,
  }));
}

// This browser's own answers on one slide, for its own server-rendered page
// only (to mark the chosen button pressed): never put in any stream.
export function yourAnswersOn(
  lectureId: string,
  browserId: string,
  slideRef: SlideRef,
): { reason: string | null; helped: string | null } | undefined {
  return db
    .prepare(
      `SELECT reason, helped FROM taps
       WHERE lecture_id = ? AND browser_id = ? AND COALESCE(deck, '') = ? AND slide = ? AND legacy_duplicate = 0`,
    )
    .get(lectureId, browserId, slideRef.deck ?? "", slideRef.slide) as { reason: string | null; helped: string | null } | undefined;
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

// With one tap per slide, a browser can have live taps on two slides at
// once, so a reason or "I get it now" names the slide it's about. A request
// that names none (a page from before this change) gets the browser's most
// recent live tap, as it always did.
export function liveTapOn(
  lectureId: string,
  browserId: string,
  sinceIso: string,
  slideRef: SlideRef | undefined,
): Tap | undefined {
  if (slideRef === undefined) return liveTapFor(lectureId, browserId, sinceIso);
  return db
    .prepare(
      `SELECT * FROM taps
       WHERE lecture_id = ? AND browser_id = ? AND COALESCE(deck, '') = ? AND slide = ?
         AND created_at >= ? AND resolved_at IS NULL AND legacy_duplicate = 0
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(lectureId, browserId, slideRef.deck ?? "", slideRef.slide, sinceIso) as Tap | undefined;
}

export interface SlideRef {
  deck: string | null;
  slide: number;
}

// The tap a "what helped" answer goes on: this browser's tap on the named
// slide, once resolved. Not limited to the live window: someone can say
// what helped a little after pressing "I get it now".
export function resolvedTapOn(lectureId: string, browserId: string, slideRef: SlideRef): Tap | undefined {
  return db
    .prepare(
      `SELECT * FROM taps
       WHERE lecture_id = ? AND browser_id = ? AND COALESCE(deck, '') = ? AND slide = ?
         AND resolved_at IS NOT NULL AND legacy_duplicate = 0`,
    )
    .get(lectureId, browserId, slideRef.deck ?? "", slideRef.slide) as Tap | undefined;
}

// Answers lock once sent (ADR 006): "AND reason IS NULL" in the same UPDATE
// means a second answer changes nothing, even two arriving at once.
export function setTapReason(tapId: number, reason: string): boolean {
  return db.prepare("UPDATE taps SET reason = ? WHERE id = ? AND reason IS NULL").run(reason, tapId).changes > 0;
}

export function setTapHelped(tapId: number, helped: string): boolean {
  return (
    db
      .prepare("UPDATE taps SET helped = ? WHERE id = ? AND helped IS NULL AND resolved_at IS NOT NULL")
      .run(helped, tapId).changes > 0
  );
}

export interface HelpedCount {
  deck: string | null;
  slide: number;
  helped: string;
  count: number;
}

// Raw counts per (deck, slide, answer); gated in realtime.ts like reasons.
export function helpedCounts(lectureId: string): HelpedCount[] {
  return db
    .prepare(
      `SELECT deck, slide, helped, COUNT(DISTINCT browser_id) AS count
       FROM taps WHERE lecture_id = ? AND helped IS NOT NULL AND legacy_duplicate = 0
       GROUP BY deck, slide, helped`,
    )
    .all(lectureId) as unknown as HelpedCount[];
}

// resolved_at IS NULL in the WHERE: two "I get it now" presses at once
// resolve it once, keeping the first time.
export function resolveTap(tapId: number): boolean {
  return (
    db
      .prepare("UPDATE taps SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL")
      .run(new Date().toISOString(), tapId).changes > 0
  );
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
// as tapOncePerSlide's single statement.
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

// sinceIso is the cutoff below which a session has expired (now - 12h),
// computed by the caller — same pattern as every other since-based query in
// this file, rather than trusting SQLite's own clock.
export function lecturerSessionValid(token: string, lectureId: string, sinceIso: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM lecturer_sessions WHERE token = ? AND lecture_id = ? AND created_at >= ?")
    .get(token, lectureId, sinceIso);
  return row !== undefined;
}

// Atomic, not read-then-write: two concurrent Next presses both reading
// current_slide = 3 before either writes would both compute 4 and both set
// it to 4, losing one press. Computing the new value inside the UPDATE
// itself (current_slide +/- 1, clamped to a floor of 1 in the same
// statement) means each write starts from whatever the column holds at the
// moment it actually runs, not a stale value read earlier — same atomicity
// discipline as tapOncePerSlide's single-statement dedup.
export function stepCurrentSlide(lectureId: string, direction: 1 | -1): void {
  db.prepare(
    `UPDATE lectures SET current_slide = MAX(1, current_slide + ?) WHERE id = ?`,
  ).run(direction, lectureId);
}
