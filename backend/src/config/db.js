const { Pool } = require('pg');

function intEnv(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max:                     intEnv('PG_POOL_MAX', 10),
  idleTimeoutMillis:       intEnv('PG_POOL_IDLE_TIMEOUT_MS', 30_000),
  connectionTimeoutMillis: intEnv('PG_CONNECTION_TIMEOUT_MS', 5_000),
});

// Don't crash the process on a stale-connection error from the pool.
pool.on('error', (err) => {
  console.error('Postgres pool error:', err);
});

module.exports = pool;
