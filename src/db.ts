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
if (!lectureColumns.some((c) => c.name === "previous_slide")) {
  db.exec("ALTER TABLE lectures ADD COLUMN previous_slide INTEGER");
}
if (!lectureColumns.some((c) => c.name === "slide_changed_at")) {
  db.exec("ALTER TABLE lectures ADD COLUMN slide_changed_at TEXT");
}

const tapColumns = db.prepare("PRAGMA table_info(taps)").all() as { name: string }[];
if (!tapColumns.some((c) => c.name === "browser_id")) {
  db.exec("ALTER TABLE taps ADD COLUMN browser_id TEXT");
}
if (!tapColumns.some((c) => c.name === "slide")) {
  db.exec("ALTER TABLE taps ADD COLUMN slide INTEGER");
}

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
  previous_slide: number | null;
  slide_changed_at: string | null;
}

export interface Tap {
  id: number;
  lecture_id: string;
  created_at: string;
  browser_id: string | null;
  slide: number | null;
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

export function liveTapInfo(lectureId: string, sinceIso: string): LiveTapInfo {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS count, MIN(created_at) AS earliest FROM taps WHERE lecture_id = ? AND created_at >= ?",
    )
    .get(lectureId, sinceIso) as { count: number; earliest: string | null };
  return row;
}

// Atomic insert-if-not-recently-tapped: a single statement rather than a
// separate SELECT-then-INSERT, so a browser can't double-count a tap no
// matter how the handler around it changes later. Returns whether a row was
// actually inserted.
export function tapIfNotRecentlyTapped(
  lectureId: string,
  browserId: string,
  sinceIso: string,
  slide: number,
): boolean {
  const nowIso = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO taps (lecture_id, created_at, browser_id, slide)
       SELECT ?, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM taps WHERE lecture_id = ? AND browser_id = ? AND created_at >= ?
       )`,
    )
    .run(lectureId, nowIso, browserId, slide, lectureId, browserId, sinceIso);
  return result.changes > 0;
}

export function yourTapCount(lectureId: string, browserId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM taps WHERE lecture_id = ? AND browser_id = ?")
    .get(lectureId, browserId) as { count: number };
  return row.count;
}

export function hasLiveTap(lectureId: string, browserId: string, sinceIso: string): boolean {
  const row = db
    .prepare(
      "SELECT 1 FROM taps WHERE lecture_id = ? AND browser_id = ? AND created_at >= ? LIMIT 1",
    )
    .get(lectureId, browserId, sinceIso);
  return row !== undefined;
}

export interface MinuteBucket {
  minute: string;
  count: number;
}

export function perMinuteTimeline(lectureId: string): MinuteBucket[] {
  return db
    .prepare(
      `SELECT strftime('%Y-%m-%dT%H:%M:00Z', created_at) AS minute, COUNT(*) AS count
       FROM taps WHERE lecture_id = ? GROUP BY minute ORDER BY minute ASC`,
    )
    .all(lectureId) as unknown as MinuteBucket[];
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

// Records what the slide *was* (previous_slide) and *when* it changed
// (slide_changed_at), not just the new value — a tap already in flight when
// the lecturer advances needs both to be attributed correctly.
export function setCurrentSlide(lectureId: string, newSlide: number, oldSlide: number): void {
  db.prepare(
    "UPDATE lectures SET current_slide = ?, previous_slide = ?, slide_changed_at = ? WHERE id = ?",
  ).run(newSlide, oldSlide, new Date().toISOString(), lectureId);
}
