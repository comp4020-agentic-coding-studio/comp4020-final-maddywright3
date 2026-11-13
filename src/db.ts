import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

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

db.prepare(
  "INSERT OR IGNORE INTO lectures (id, title, created_at) VALUES (?, ?, ?)",
).run("demo", "Demo lecture", new Date().toISOString());

db.prepare("UPDATE lectures SET min_present = 2 WHERE id = 'demo'").run();

export interface Lecture {
  id: string;
  title: string;
  created_at: string;
  min_present: number;
}

export interface Tap {
  id: number;
  lecture_id: string;
  created_at: string;
}

export function getLecture(id: string): Lecture | undefined {
  return db.prepare("SELECT * FROM lectures WHERE id = ?").get(id) as Lecture | undefined;
}

export function addTap(lectureId: string): void {
  db.prepare("INSERT INTO taps (lecture_id, created_at) VALUES (?, ?)").run(
    lectureId,
    new Date().toISOString(),
  );
}

export function tapCount(lectureId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM taps WHERE lecture_id = ?")
    .get(lectureId) as { count: number };
  return row.count;
}

export function tapsNewestFirst(lectureId: string): Tap[] {
  return db
    .prepare("SELECT * FROM taps WHERE lecture_id = ? ORDER BY created_at DESC, id DESC")
    .all(lectureId) as unknown as Tap[];
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
