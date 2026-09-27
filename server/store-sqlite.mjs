// SQLite storage for the Skyward ATC API (node:sqlite, Node >= 22.13). Used by server/server.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function createSqliteStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'skyward.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 3000;
  `);
  // v1: profiles belong to a Google account. Pre-auth profiles had no owner and are dropped with their data.
  if (db.prepare('PRAGMA user_version').get().user_version < 1) {
    db.exec(`
      BEGIN IMMEDIATE;
      DROP TABLE IF EXISTS results;
      DROP TABLE IF EXISTS saves;
      DROP TABLE IF EXISTS profiles;
      COMMIT;
      PRAGMA user_version = 1;
    `);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      google_sub TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_played_at INTEGER NOT NULL,
      settings TEXT NOT NULL DEFAULT '{}',
      career TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS saves (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('auto', 'manual')),
      label TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '{}',
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS saves_one_auto ON saves(profile_id) WHERE kind = 'auto';
    CREATE INDEX IF NOT EXISTS saves_by_profile ON saves(profile_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      shift_id TEXT NOT NULL,
      airport TEXT NOT NULL,
      score INTEGER NOT NULL,
      stars INTEGER NOT NULL,
      stats TEXT NOT NULL DEFAULT '{}',
      completed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS results_by_profile ON results(profile_id, completed_at DESC);
  `);

  const q = {
    getProfile: db.prepare('SELECT * FROM profiles WHERE id = ?'),
    getProfileBySub: db.prepare('SELECT * FROM profiles WHERE google_sub = ?'),
    insertProfile: db.prepare('INSERT INTO profiles (google_sub, email, name, created_at, last_played_at) VALUES (?, ?, ?, ?, ?)'),
    setEmail: db.prepare('UPDATE profiles SET email = ? WHERE id = ?'),
    checkpointSummary: db.prepare("SELECT summary FROM saves WHERE profile_id = ? AND kind = 'auto'"),
    deleteProfile: db.prepare('DELETE FROM profiles WHERE id = ?'),
    touchProfile: db.prepare('UPDATE profiles SET last_played_at = ? WHERE id = ?'),
    setSettings: db.prepare('UPDATE profiles SET settings = ? WHERE id = ?'),
    setCareer: db.prepare('UPDATE profiles SET career = ?, last_played_at = ? WHERE id = ?'),
    getCheckpoint: db.prepare("SELECT id, summary, state, updated_at FROM saves WHERE profile_id = ? AND kind = 'auto'"),
    updateCheckpoint: db.prepare("UPDATE saves SET summary = ?, state = ?, updated_at = ? WHERE profile_id = ? AND kind = 'auto'"),
    insertCheckpoint: db.prepare("INSERT INTO saves (profile_id, kind, label, summary, state, created_at, updated_at) VALUES (?, 'auto', 'Checkpoint', ?, ?, ?, ?)"),
    deleteCheckpoint: db.prepare("DELETE FROM saves WHERE profile_id = ? AND kind = 'auto'"),
    listSaves: db.prepare("SELECT id, label, summary, created_at, updated_at FROM saves WHERE profile_id = ? AND kind = 'manual' ORDER BY updated_at DESC"),
    countSaves: db.prepare("SELECT COUNT(*) AS n FROM saves WHERE profile_id = ? AND kind = 'manual'"),
    getSave: db.prepare("SELECT id, label, summary, state, created_at, updated_at FROM saves WHERE id = ? AND profile_id = ? AND kind = 'manual'"),
    insertSave: db.prepare("INSERT INTO saves (profile_id, kind, label, summary, state, created_at, updated_at) VALUES (?, 'manual', ?, ?, ?, ?, ?)"),
    deleteSave: db.prepare("DELETE FROM saves WHERE id = ? AND profile_id = ? AND kind = 'manual'"),
    insertResult: db.prepare('INSERT INTO results (profile_id, shift_id, airport, score, stars, stats, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    listResults: db.prepare('SELECT id, shift_id, airport, score, stars, stats, completed_at FROM results WHERE profile_id = ? ORDER BY completed_at DESC LIMIT 50'),
  };

  return {
    getProfile: async (id) => q.getProfile.get(id),
    /** Finds the profile of a Google account, creating it on first sign-in. */
    async upsertUserProfile({ sub, email, name, now }) {
      const row = q.getProfileBySub.get(sub);
      if (row) {
        if (email && row.email !== email) q.setEmail.run(email, row.id);
        return q.getProfile.get(row.id);
      }
      const id = Number(q.insertProfile.run(sub, email, name, now, now).lastInsertRowid);
      return q.getProfile.get(id);
    },
    getCheckpointSummary: async (id) => q.checkpointSummary.get(id)?.summary ?? null,
    deleteProfile: async (id) => void q.deleteProfile.run(id),
    setSettings: async (id, text) => void q.setSettings.run(text, id),
    setCareer: async (id, text, now) => void q.setCareer.run(text, now, id),
    getCheckpoint: async (id) => q.getCheckpoint.get(id),
    async upsertCheckpoint(id, summary, state, now) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const r = q.updateCheckpoint.run(summary, state, now, id);
        if (r.changes === 0) q.insertCheckpoint.run(id, summary, state, now, now);
        q.touchProfile.run(now, id);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    deleteCheckpoint: async (id) => void q.deleteCheckpoint.run(id),
    listSaves: async (id) => q.listSaves.all(id),
    countSaves: async (id) => q.countSaves.get(id).n,
    getSave: async (saveId, id) => q.getSave.get(saveId, id),
    insertSave: async (id, label, summary, state, now) => Number(q.insertSave.run(id, label, summary, state, now, now).lastInsertRowid),
    deleteSave: async (saveId, id) => q.deleteSave.run(saveId, id).changes > 0,
    insertResult: async (id, shiftId, airport, score, stars, stats, now) =>
      Number(q.insertResult.run(id, shiftId, airport, score, stars, stats, now).lastInsertRowid),
    listResults: async (id) => q.listResults.all(id),
    close: () => db.close(),
  };
}
