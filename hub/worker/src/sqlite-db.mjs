// sqlite-db.mjs — local Db adapter backed by node:sqlite.
//
// Implements the Db interface consumed by event-core.mjs:
//   queryOne(sql, params) -> row | undefined
//   queryAll(sql, params) -> row[]
//   batch([{sql, params}]) -> all statements in ONE transaction (atomic)
//
// At deploy time a D1 adapter implements the same interface with
// db.batch([...]) as the atomic primitive. The event core's concurrency
// model (read phase + single atomic write batch) is designed for D1's
// batch semantics; this adapter reproduces them locally with
// BEGIN IMMEDIATE / COMMIT / ROLLBACK.

import { DatabaseSync } from 'node:sqlite';

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  // Set busy_timeout FIRST: concurrent worker threads opening the same file
  // can hit a transient lock during open/recovery, and the journal_mode
  // probe below needs the retry handler already in place.
  db.exec('PRAGMA busy_timeout = 10000');
  // journal_mode is a persistent DB setting: set it once, skip when already WAL
  // so concurrently-opening connections never fight over the mode change.
  const mode = db.prepare('PRAGMA journal_mode').get();
  if (mode && mode.journal_mode !== 'wal') {
    db.exec('PRAGMA journal_mode = WAL');
  }
  db.exec('PRAGMA foreign_keys = OFF');

  return {
    _db: db,
    queryOne(sql, params = []) {
      return db.prepare(sql).get(...params);
    },
    queryAll(sql, params = []) {
      return db.prepare(sql).all(...params);
    },
    batch(stmts) {
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const s of stmts) {
          db.prepare(s.sql).run(...(s.params || []));
        }
        db.exec('COMMIT');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw err;
      }
    },
    close() {
      db.close();
    },
  };
}

export function applySchema(db, schemaSql) {
  db._db.exec(schemaSql);
}
