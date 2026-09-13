require('dotenv').config();

const fs = require('fs');
const path = require('path');
const pool = require('../config/db');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          SERIAL PRIMARY KEY,
      filename    VARCHAR(255) UNIQUE NOT NULL,
      applied_at  TIMESTAMPTZ  DEFAULT NOW()
    );
  `);
}

async function alreadyApplied() {
  const { rows } = await pool.query('SELECT filename FROM schema_migrations');
  return new Set(rows.map((r) => r.filename));
}

async function runOne(client, file) {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query(
      'INSERT INTO schema_migrations (filename) VALUES ($1)',
      [file]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function migrate() {
  await ensureTable();
  const done = await alreadyApplied();

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (!files.length) {
    console.log('No migrations found.');
    return;
  }

  let applied = 0;
  for (const file of files) {
    if (done.has(file)) {
      console.log(`  ${file} ... skipped (already applied)`);
      continue;
    }
    process.stdout.write(`  ${file} ... `);
    const client = await pool.connect();
    try {
      await runOne(client, file);
      console.log('applied');
      applied += 1;
    } finally {
      client.release();
    }
  }

  console.log(applied ? `\n${applied} migration(s) applied.` : '\nDatabase already up to date.');
}

if (require.main === module) {
  migrate()
    .then(() => pool.end())
    .catch((err) => {
      console.error('Migration failed:', err.message);
      pool.end().finally(() => process.exit(1));
    });
}

module.exports = migrate;
