// Postgres storage for the Skyward ATC API (Neon serverless driver over HTTP). Used by the Vercel function.
// Rows are returned with the same snake_case columns and number types as the SQLite store.

import { neon } from '@neondatabase/serverless';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS profiles (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    last_played_at BIGINT NOT NULL,
    settings TEXT NOT NULL DEFAULT '{}',
    career TEXT NOT NULL DEFAULT '{}'
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS profiles_name_ci ON profiles (lower(name))',
  `CREATE TABLE IF NOT EXISTS saves (
    id SERIAL PRIMARY KEY,
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('auto', 'manual')),
    label TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '{}',
    state TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS saves_one_auto ON saves (profile_id) WHERE kind = 'auto'",
  'CREATE INDEX IF NOT EXISTS saves_by_profile ON saves (profile_id, updated_at DESC)',
  `CREATE TABLE IF NOT EXISTS results (
    id SERIAL PRIMARY KEY,
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    shift_id TEXT NOT NULL,
    airport TEXT NOT NULL,
    score INTEGER NOT NULL,
    stars INTEGER NOT NULL,
    stats TEXT NOT NULL DEFAULT '{}',
    completed_at BIGINT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS results_by_profile ON results (profile_id, completed_at DESC)',
];

// BIGINT and COUNT come back as strings.
const NUMERIC = ['created_at', 'last_played_at', 'updated_at', 'completed_at', 'n'];
const fix = (row) => {
  if (!row) return row;
  for (const k of NUMERIC) if (row[k] != null) row[k] = Number(row[k]);
  return row;
};
const one = (rows) => fix(rows[0]);
const all = (rows) => rows.map(fix);

export function createPostgresStore(url = process.env.DATABASE_URL || process.env.POSTGRES_URL) {
  if (!url) throw new Error('DATABASE_URL is not set');
  const sql = neon(url);
  let ready = null;
  // Create the schema once per cold start; retry on the next request if it failed.
  const init = () =>
    (ready ??= (async () => {
      for (const stmt of SCHEMA) await sql.query(stmt);
    })().catch((e) => {
      ready = null;
      throw e;
    }));
  const db = (fn) => async (...args) => {
    await init();
    return fn(...args);
  };

  return {
    countProfiles: db(async () => one(await sql`SELECT COUNT(*) AS n FROM profiles`).n),
    listProfiles: db(async () =>
      all(await sql`
        SELECT p.id, p.name, p.created_at, p.last_played_at, p.career,
          (SELECT s.summary FROM saves s WHERE s.profile_id = p.id AND s.kind = 'auto') AS checkpoint
        FROM profiles p ORDER BY p.last_played_at DESC`),
    ),
    getProfile: db(async (id) => one(await sql`SELECT * FROM profiles WHERE id = ${id}`)),
    findProfileByName: db(async (name) => one(await sql`SELECT id FROM profiles WHERE lower(name) = lower(${name})`)),
    insertProfile: db(async (name, now) =>
      one(await sql`INSERT INTO profiles (name, created_at, last_played_at) VALUES (${name}, ${now}, ${now}) RETURNING id`).id,
    ),
    deleteProfile: db(async (id) => void (await sql`DELETE FROM profiles WHERE id = ${id}`)),
    setSettings: db(async (id, text) => void (await sql`UPDATE profiles SET settings = ${text} WHERE id = ${id}`)),
    setCareer: db(async (id, text, now) => void (await sql`UPDATE profiles SET career = ${text}, last_played_at = ${now} WHERE id = ${id}`)),
    getCheckpoint: db(async (id) =>
      one(await sql`SELECT id, summary, state, updated_at FROM saves WHERE profile_id = ${id} AND kind = 'auto'`),
    ),
    upsertCheckpoint: db(async (id, summary, state, now) => {
      await sql.transaction([
        sql`INSERT INTO saves (profile_id, kind, label, summary, state, created_at, updated_at)
            VALUES (${id}, 'auto', 'Checkpoint', ${summary}, ${state}, ${now}, ${now})
            ON CONFLICT (profile_id) WHERE kind = 'auto'
            DO UPDATE SET summary = EXCLUDED.summary, state = EXCLUDED.state, updated_at = EXCLUDED.updated_at`,
        sql`UPDATE profiles SET last_played_at = ${now} WHERE id = ${id}`,
      ]);
    }),
    deleteCheckpoint: db(async (id) => void (await sql`DELETE FROM saves WHERE profile_id = ${id} AND kind = 'auto'`)),
    listSaves: db(async (id) =>
      all(await sql`SELECT id, label, summary, created_at, updated_at FROM saves WHERE profile_id = ${id} AND kind = 'manual' ORDER BY updated_at DESC`),
    ),
    countSaves: db(async (id) => one(await sql`SELECT COUNT(*) AS n FROM saves WHERE profile_id = ${id} AND kind = 'manual'`).n),
    getSave: db(async (saveId, id) =>
      one(await sql`SELECT id, label, summary, state, created_at, updated_at FROM saves WHERE id = ${saveId} AND profile_id = ${id} AND kind = 'manual'`),
    ),
    insertSave: db(async (id, label, summary, state, now) =>
      one(await sql`
        INSERT INTO saves (profile_id, kind, label, summary, state, created_at, updated_at)
        VALUES (${id}, 'manual', ${label}, ${summary}, ${state}, ${now}, ${now}) RETURNING id`).id,
    ),
    deleteSave: db(async (saveId, id) =>
      (await sql`DELETE FROM saves WHERE id = ${saveId} AND profile_id = ${id} AND kind = 'manual' RETURNING id`).length > 0,
    ),
    insertResult: db(async (id, shiftId, airport, score, stars, stats, now) =>
      one(await sql`
        INSERT INTO results (profile_id, shift_id, airport, score, stars, stats, completed_at)
        VALUES (${id}, ${shiftId}, ${airport}, ${score}, ${stars}, ${stats}, ${now}) RETURNING id`).id,
    ),
    listResults: db(async (id) =>
      all(await sql`SELECT id, shift_id, airport, score, stars, stats, completed_at FROM results WHERE profile_id = ${id} ORDER BY completed_at DESC LIMIT 50`),
    ),
  };
}
