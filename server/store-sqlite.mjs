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
    CREATE TABLE IF NOT EXISTS profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
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
    listProfiles: db.prepare(`
      SELECT p.id, p.name, p.created_at, p.last_played_at, p.career,
        (SELECT s.summary FROM saves s WHERE s.profile_id = p.id AND s.kind = 'auto') AS checkpoint
      FROM profiles p ORDER BY p.last_played_at DESC`),
    countProfiles: db.prepare('SELECT COUNT(*) AS n FROM profiles'),
    getProfile: db.prepare('SELECT * FROM profiles WHERE id = ?'),
    findProfileByName: db.prepare('SELECT id FROM profiles WHERE name = ?'),
    insertProfile: db.prepare('INSERT INTO profiles (name, created_at, last_played_at) VALUES (?, ?, ?)'),
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
    countProfiles: async () => q.countProfiles.get().n,
    listProfiles: async () => q.listProfiles.all(),
    getProfile: async (id) => q.getProfile.get(id),
    findProfileByName: async (name) => q.findProfileByName.get(name),
    insertProfile: async (name, now) => Number(q.insertProfile.run(name, now, now).lastInsertRowid),
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
