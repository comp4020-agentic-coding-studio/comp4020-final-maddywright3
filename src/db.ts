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

db.prepare(
  "INSERT OR IGNORE INTO lectures (id, title, created_at) VALUES (?, ?, ?)",
).run("demo", "Demo lecture", new Date().toISOString());

export interface Lecture {
  id: string;
  title: string;
  created_at: string;
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
