// Checks the one-tap-per-slide migration on a database made the way older
// versions of the app made it, duplicates and all, without touching any real
// data. It builds a pre-migration copy in a new temporary directory, starts
// this server on it (DATA_DIR pointing there, its own port), lets the
// server's own startup migrate it, and then checks from the database file:
// every row is still there, the totals are what they were, the counted
// taps are the earliest per (lecture, run, deck, slide, browser), created
// lectures' taps carry no deck, and the unique index exists and holds.
//
// Why a script and not a spec test: spec/ talks only to the running app over
// HTTP, and CI starts that app on an empty /data, so a pre-migration
// database never exists there. A spec test gated on an env var would skip in
// every pnpm check, and CLAUDE.md doesn't allow a skipped test to stand
// behind a claim. So this runs by hand: `node scripts/check-migration.ts`.
// It never deletes anything; each run uses a fresh directory under the OS
// temp dir.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const PORT = Number(process.env.MIGRATION_CHECK_PORT ?? 8099);
const dir = mkdtempSync(join(tmpdir(), "meter-migration-"));
const dbPath = join(dir, "meter.db");

// The schema as it stood before this migration (taps with browser_id, deck,
// slide, reason, resolved_at, but no run_id or legacy_duplicate).
function buildPreMigrationCopy(): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE lectures (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL,
      min_present INTEGER NOT NULL DEFAULT 5, code_hash TEXT, code_salt TEXT,
      current_slide INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE taps (id INTEGER PRIMARY KEY, lecture_id TEXT NOT NULL REFERENCES lectures(id),
      created_at TEXT NOT NULL, browser_id TEXT, slide INTEGER, deck TEXT, reason TEXT, resolved_at TEXT);
    CREATE TABLE notes (id INTEGER PRIMARY KEY, lecture_id TEXT NOT NULL REFERENCES lectures(id),
      deck TEXT, slide INTEGER NOT NULL, browser_id TEXT NOT NULL, text TEXT NOT NULL,
      created_at TEXT NOT NULL, hidden_at TEXT, UNIQUE(lecture_id, deck, browser_id, slide));
    CREATE TABLE browsers (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
    CREATE TABLE lecturer_sessions (token TEXT PRIMARY KEY, lecture_id TEXT NOT NULL REFERENCES lectures(id),
      created_at TEXT NOT NULL);
  `);
  const t0 = Date.parse("2026-11-10T01:00:00Z");
  const at = (minutes: number) => new Date(t0 + minutes * 60_000).toISOString();
  db.prepare("INSERT INTO lectures (id, title, created_at, min_present) VALUES ('demo', 'Demo lecture', ?, 2)").run(at(0));
  db.prepare("INSERT INTO lectures (id, title, created_at) VALUES ('abcd1234', 'Old created lecture', ?)").run(at(0));
  const tap = db.prepare(
    "INSERT INTO taps (lecture_id, created_at, browser_id, deck, slide, reason, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  // Demo: browser A tapped week-4 slide 3 three times (after the 60 s
  // window, and after "I get it now"), B once; A also tapped week-6 slide 3.
  tap.run("demo", at(1), "a".repeat(32), "week-4", 3, "Too fast", null);
  tap.run("demo", at(3), "a".repeat(32), "week-4", 3, "Notation", at(3.2));
  tap.run("demo", at(5), "a".repeat(32), "week-4", 3, null, null);
  tap.run("demo", at(1), "b".repeat(32), "week-4", 3, "Too fast", null);
  tap.run("demo", at(2), "a".repeat(32), "week-6", 3, null, null);
  // Created lecture: taps filed under the demo's default deck by the bug
  // fixed in 28b7d1d, with a duplicate, plus one already NULL. After the
  // deck is cleared these three are one key, so two become legacy.
  tap.run("abcd1234", at(1), "c".repeat(32), "week-4", 1, null, null);
  tap.run("abcd1234", at(4), "c".repeat(32), "week-4", 1, null, null);
  tap.run("abcd1234", at(6), "c".repeat(32), null, 1, null, null);
  // Pre-C10 rows: no browser, no slide. Can't collide, must be left alone.
  tap.run("demo", at(0.5), null, null, null, null, null);
  tap.run("demo", at(0.6), null, null, null, null, null);
  db.close();
}

interface Snapshot {
  rows: number;
  totals: Record<string, number>;
}

function snapshot(db: DatabaseSync): Snapshot {
  const rows = (db.prepare("SELECT COUNT(*) AS n FROM taps").get() as { n: number }).n;
  const totals = Object.fromEntries(
    (db.prepare("SELECT lecture_id, COUNT(*) AS n FROM taps GROUP BY lecture_id").all() as { lecture_id: string; n: number }[]).map(
      (r) => [r.lecture_id, r.n],
    ),
  );
  return { rows, totals };
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`http://localhost:${PORT}/`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`server on ${PORT} never answered`);
}

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

buildPreMigrationCopy();
const before = snapshot(new DatabaseSync(dbPath, { readOnly: true }));
console.log(`copy: ${dbPath}`);
console.log(`before: ${before.rows} rows, totals ${JSON.stringify(before.totals)}`);

const server = spawn(process.execPath, ["src/server.ts"], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dir },
  stdio: ["ignore", "ignore", "inherit"],
});
try {
  await waitForServer();
  // The demo's total over HTTP, the way a person sees it: open two streams
  // so present reaches its min_present of 2, then read one frame.
  const cookies = await Promise.all(
    [0, 1].map(async () => {
      const res = await fetch(`http://localhost:${PORT}/l/demo`);
      return res.headers.getSetCookie().find((c) => c.startsWith("bid="))!.split(";")[0];
    }),
  );
  const controllers = cookies.map(() => new AbortController());
  const streams = await Promise.all(
    cookies.map((cookie, i) => fetch(`http://localhost:${PORT}/l/demo/events`, { headers: { cookie }, signal: controllers[i].signal })),
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  const reader = streams[0].body!.getReader();
  let text = "";
  let httpTotal: number | undefined;
  while (httpTotal === undefined) {
    text += new TextDecoder().decode((await reader.read()).value);
    for (const m of text.matchAll(/data: (.*)\n\n/g)) {
      const frame = JSON.parse(m[1]) as { shown: boolean; totalTaps?: number };
      if (frame.shown) httpTotal = frame.totalTaps;
    }
  }
  controllers.forEach((c) => c.abort());

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const after = snapshot(db);
  console.log(`after:  ${after.rows} rows, totals ${JSON.stringify(after.totals)}`);
  check("every row is still there", after.rows === before.rows, `${before.rows} -> ${after.rows}`);
  check("per-lecture totals unchanged", JSON.stringify(after.totals) === JSON.stringify(before.totals));
  check("demo total over HTTP matches", httpTotal === before.totals.demo, `${httpTotal} vs ${before.totals.demo}`);

  const index = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'taps_one_per_slide'").get() as
    | { sql: string }
    | undefined;
  check("unique index exists", index !== undefined, index?.sql.replace(/\s+/g, " "));

  const counted = db
    .prepare(
      "SELECT id, lecture_id, deck, slide, substr(browser_id, 1, 1) AS who, legacy_duplicate FROM taps ORDER BY id",
    )
    .all() as { id: number; lecture_id: string; deck: string | null; slide: number | null; who: string | null; legacy_duplicate: number }[];
  for (const r of counted) console.log(`  row ${r.id}: ${r.lecture_id} ${r.deck ?? "NULL"} slide ${r.slide ?? "-"} browser ${r.who ?? "-"} legacy=${r.legacy_duplicate}`);
  const legacyIds = counted.filter((r) => r.legacy_duplicate === 1).map((r) => r.id);
  check("later duplicates marked legacy, earliest kept", JSON.stringify(legacyIds) === JSON.stringify([2, 3, 7, 8]), `legacy ${JSON.stringify(legacyIds)}`);
  check(
    "created lecture's taps carry no deck",
    counted.filter((r) => r.lecture_id === "abcd1234").every((r) => r.deck === null),
  );
  check("pre-C10 rows untouched", counted.filter((r) => r.who === null).every((r) => r.legacy_duplicate === 0));
  db.close();

  // The index holds: a duplicate insert, including a NULL deck, is refused.
  const writable = new DatabaseSync(dbPath);
  const insert = writable.prepare(
    "INSERT INTO taps (lecture_id, created_at, browser_id, deck, slide) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
  );
  const demoDup = insert.run("demo", new Date().toISOString(), "a".repeat(32), "week-4", 3).changes;
  const nullDup = insert.run("abcd1234", new Date().toISOString(), "c".repeat(32), null, 1).changes;
  const fresh = insert.run("abcd1234", new Date().toISOString(), "c".repeat(32), null, 2).changes;
  writable.close();
  check("duplicate demo tap refused", demoDup === 0);
  check("duplicate NULL-deck tap refused", nullDup === 0);
  check("a new slide still inserts", fresh === 1);

  // Restarting on the migrated copy must not re-run anything destructive.
  server.kill();
  await new Promise((resolve) => server.once("exit", resolve));
  const again = spawn(process.execPath, ["src/server.ts"], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dir },
    stdio: ["ignore", "ignore", "inherit"],
  });
  await waitForServer();
  again.kill();
  await new Promise((resolve) => again.once("exit", resolve));
  const afterRestart = snapshot(new DatabaseSync(dbPath, { readOnly: true }));
  check("a second start changes nothing", afterRestart.rows === after.rows + 1, `${afterRestart.rows} rows (one new tap added above)`);
} finally {
  server.kill();
}

console.log(failures === 0 ? "migration check passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
