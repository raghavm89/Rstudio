'use strict';

const pool = require('../../config/db');

/**
 * The admin SQL console.
 *
 * ── Reads are enforced by Postgres, not by inspecting the SQL ───────────────
 *
 * The obvious implementation inspects the statement — reject anything matching
 * /^\s*(insert|update|delete|drop)/i and run the rest. That has never held
 * anywhere it has been tried. `WITH x AS (DELETE FROM users RETURNING *)
 * SELECT * FROM x` starts with WITH. A function called inside a SELECT can
 * write. A leading comment defeats a prefix match. Writing a parser to guess
 * intent is the wrong shape of answer to a question the database already
 * settles.
 *
 * So the statement runs inside `BEGIN TRANSACTION READ ONLY`, which is
 * refused... by Postgres, with a real error, for every INSERT, UPDATE, DELETE,
 * TRUNCATE, GRANT and DDL, including the ones hidden in a CTE. The transaction
 * is then ALWAYS rolled back.
 *
 * ── But READ ONLY is about DATA, and that is not the whole attack surface ───
 *
 * This was written believing READ ONLY was the whole answer. It is not, and the
 * gap was found by trying it rather than by reading about it:
 *
 *     COPY (SELECT 1) TO PROGRAM 'touch /tmp/rce-proof'   →  the file appeared
 *     SELECT pg_read_file('/etc/hostname')                →  returned its contents
 *
 * Neither writes a row, so a read-only transaction has no objection. Both need
 * superuser, or membership of `pg_execute_server_program` / `pg_read_server_files`
 * — which a database user created by `createuser` for a small deployment very
 * often has. On such a connection this endpoint is remote code execution on the
 * database server, reachable from a text box in a browser.
 *
 * ── So the boundary is the ROLE, and it is checked before anything runs ─────
 *
 * `assertSafeConnection` asks the connection what it can do. If it is a
 * superuser, or a member of any of the file/program roles, the console refuses
 * to run at all and says how to fix it. That check cannot be talked around by
 * clever SQL, because it happens before the SQL is sent.
 *
 * Two ways to satisfy it: point the app at a database user that is not a
 * superuser (which is where a production deployment should be anyway), or give
 * this console its own role via ADMIN_QUERY_DB_USER — see `createRoleSql()`.
 *
 * The leading-keyword check below is a backstop, not the defence. It exists
 * because COPY and SET ROLE have no legitimate use at an analytics prompt, so
 * refusing them costs nothing — but the reason the console is safe is the role.
 *
 * ── What this is deliberately NOT ───────────────────────────────────────────
 * There is no write mode and no "I know what I'm doing" flag. A tool that can
 * be flipped into a write tool is a write tool, and this one lives inside the
 * customer-facing app. Anything that changes data goes through a purpose-built
 * endpoint in studioAdminController, where it is validated, bounded and
 * audited. A one-off change with no endpoint is a psql session on the server:
 * harder on purpose, and it leaves its trace on a machine rather than in a
 * text box.
 */

const TIMEOUT_MS = Number(process.env.ADMIN_QUERY_TIMEOUT_MS || 5000);
const MAX_ROWS   = Number(process.env.ADMIN_QUERY_MAX_ROWS || 500);
const MAX_LENGTH = 20000;

/**
 * The connection this console uses.
 *
 * Its own pool when ADMIN_QUERY_DB_USER is set, so the console can hold a role
 * with nothing but CONNECT and SELECT while the app keeps the privileges it
 * needs to migrate and write. Otherwise the app's pool — which is fine when the
 * app's own database user is not a superuser, and is refused below when it is.
 */
let consolePool = null;
function poolForQueries() {
  if (consolePool) return consolePool;
  if (!process.env.ADMIN_QUERY_DB_USER) { consolePool = pool; return consolePool; }

  const { Pool } = require('pg');
  consolePool = new Pool({
    host:     process.env.DB_HOST,
    port:     process.env.DB_PORT,
    database: process.env.DB_NAME,
    user:     process.env.ADMIN_QUERY_DB_USER,
    password: process.env.ADMIN_QUERY_DB_PASSWORD,
    // Small: this is a human at a prompt, not a request path.
    max: 2,
    idleTimeoutMillis: 10_000,
  });
  return consolePool;
}

/** The SQL to create that role. Printed by the console when it refuses. */
function createRoleSql(dbName = process.env.DB_NAME || 'rstudio') {
  return [
    "CREATE ROLE studio_console LOGIN PASSWORD 'choose-a-strong-one' NOSUPERUSER NOCREATEDB NOCREATEROLE;",
    `GRANT CONNECT ON DATABASE ${dbName} TO studio_console;`,
    'GRANT USAGE ON SCHEMA public TO studio_console;',
    'GRANT SELECT ON ALL TABLES IN SCHEMA public TO studio_console;',
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO studio_console;',
  ].join('\n');
}

/**
 * What this connection is allowed to do at the operating system.
 *
 * Probed once and cached: role grants do not change between two queries in a
 * session, and this runs before every query.
 */
let privileges = null;
async function connectionPrivileges() {
  if (privileges) return privileges;
  const { rows } = await poolForQueries().query(`
    SELECT current_user AS role,
           COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), FALSE) AS superuser,
           pg_has_role(current_user, 'pg_read_server_files',    'member') AS read_files,
           pg_has_role(current_user, 'pg_write_server_files',   'member') AS write_files,
           pg_has_role(current_user, 'pg_execute_server_program','member') AS exec_program`);
  privileges = rows[0];
  return privileges;
}

/**
 * Refuse to run at all on a connection that could reach the filesystem.
 *
 * Before the statement is sent, so no SQL can influence the outcome.
 */
async function assertSafeConnection() {
  const p = await connectionPrivileges();
  const powers = [
    p.superuser    && 'is a superuser',
    p.exec_program && 'can run programs on the server (pg_execute_server_program)',
    p.write_files  && 'can write files on the server (pg_write_server_files)',
    p.read_files   && 'can read files on the server (pg_read_server_files)',
  ].filter(Boolean);

  if (!powers.length) return p;

  const err = new QueryRefused(
    `The SQL console is disabled: the database user "${p.role}" ${powers.join(', and ')}. `
    + 'On such a connection a query can run shell commands on the database server '
    + '(COPY ... TO PROGRAM) and read files off its disk, neither of which a read-only '
    + 'transaction prevents. Give the console its own unprivileged role and set '
    + 'ADMIN_QUERY_DB_USER / ADMIN_QUERY_DB_PASSWORD:\n\n' + createRoleSql(),
    'CONSOLE_CONNECTION_TOO_PRIVILEGED'
  );
  err.status = 503;
  throw err;
}

/**
 * The backstop: two statements a read-only transaction happily allows and an
 * analytics prompt has no use for.
 *
 * Not the defence — `assertSafeConnection` is — but free, so it is here too.
 * COPY is the file/program vector; SET ROLE and SET SESSION AUTHORIZATION are
 * attempts to become someone else, which is only ever a step towards the first.
 */
const BLOCKED = [
  { re: /^copy\b/i,                        why: 'COPY reads and writes files on the database server.' },
  { re: /^set\s+role\b/i,                  why: 'Changing role at a read-only prompt has no legitimate use.' },
  { re: /^set\s+session\s+authorization\b/i, why: 'Changing role at a read-only prompt has no legitimate use.' },
];

/** The statement with leading whitespace and comments removed. */
function withoutLeadingComments(sql) {
  let i = 0;
  for (;;) {
    while (i < sql.length && /\s/.test(sql[i])) i += 1;
    if (sql[i] === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      if (nl === -1) return '';
      i = nl + 1; continue;
    }
    if (sql[i] === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) return '';
      i = end + 2; continue;
    }
    return sql.slice(i);
  }
}

class QueryRefused extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.status = 400;
  }
}

/**
 * The one thing we DO check before handing it over.
 *
 * Not to spot writes — Postgres does that — but because `pg` will happily run
 * several statements separated by semicolons in a single call, and a result set
 * from "the last one" is a confusing thing to show someone. One statement in,
 * one grid out.
 *
 * Semicolons inside string literals, dollar-quoted blocks and comments are not
 * separators, so they are skipped rather than counted.
 */
function looksLikeMultipleStatements(sql) {
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];

    if (c === '-' && sql[i + 1] === '-') {                     // line comment
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl + 1;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {                     // block comment
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (c === "'" || c === '"') {                              // string / identifier
      const quote = c;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { i += 2; continue; }      // an escaped quote
          i += 1; break;
        }
        i += 1;
      }
      continue;
    }
    if (c === '$') {                                           // dollar-quoted body
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        i = end === -1 ? sql.length : end + tag[0].length;
        continue;
      }
    }
    if (c === ';') {
      // A trailing semicolon is fine; anything after it is a second statement.
      return sql.slice(i + 1).trim().length > 0;
    }
    i += 1;
  }
  return false;
}

/**
 * Run one statement and give back rows.
 *
 * Resolves with `{ ok: false, error }` for a SQL error rather than throwing:
 * a query that does not compile is an ordinary outcome at a SQL prompt and the
 * person needs to read the message, not a 500.
 */
async function run(sql) {
  const text = String(sql || '').trim();
  if (!text) throw new QueryRefused('There is no query to run.', 'EMPTY_QUERY');
  if (text.length > MAX_LENGTH) {
    throw new QueryRefused(`That query is longer than ${MAX_LENGTH} characters.`, 'QUERY_TOO_LONG');
  }
  if (looksLikeMultipleStatements(text)) {
    throw new QueryRefused(
      'Run one statement at a time — several separated by semicolons would return only the last result.',
      'MULTIPLE_STATEMENTS'
    );
  }

  const bare = withoutLeadingComments(text);
  const blocked = BLOCKED.find((b) => b.re.test(bare));
  if (blocked) throw new QueryRefused(blocked.why, 'STATEMENT_NOT_ALLOWED');

  // The real boundary, checked before a byte of the statement is sent.
  await assertSafeConnection();

  const client = await poolForQueries().connect();
  const startedAt = Date.now();
  try {
    // READ ONLY is the whole guarantee. Everything else here is comfort.
    await client.query('BEGIN TRANSACTION READ ONLY');
    // LOCAL, so it dies with the transaction and cannot leak onto the pooled
    // connection the next request picks up.
    await client.query(`SET LOCAL statement_timeout = ${Number(TIMEOUT_MS)}`);
    // A runaway query must not sit on a lock either.
    await client.query("SET LOCAL lock_timeout = '2s'");

    const result = await client.query({ text, rowMode: 'array' });

    const fields = (result.fields || []).map((f) => f.name);
    const rows = (result.rows || []).slice(0, MAX_ROWS).map((row) => row.map(present));

    return {
      ok: true,
      fields,
      rows,
      row_count: result.rowCount ?? rows.length,
      truncated: (result.rows || []).length > MAX_ROWS,
      max_rows: MAX_ROWS,
      ms: Date.now() - startedAt,
      command: result.command || null,
    };
  } catch (err) {
    if (err instanceof QueryRefused) throw err;
    return {
      ok: false,
      // Postgres' own words. `position` is what lets an editor point at the
      // character, and `hint` is often the actual answer.
      error: err.message,
      code: err.code || null,
      position: err.position ? Number(err.position) : null,
      hint: err.hint || null,
      ms: Date.now() - startedAt,
      read_only: err.code === '25006',
    };
  } finally {
    // Always. A read-only transaction has nothing to commit, and rolling back
    // unconditionally means there is no path in this file that can persist
    // anything even if the flag above were somehow lost.
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    client.release();
  }
}

/**
 * Values, as something JSON can carry and a table can show.
 *
 * `rowMode: 'array'` is used above so that `SELECT id, id FROM ...` keeps both
 * columns — an object would silently collapse them, which is a confusing way to
 * lose data at a SQL prompt.
 */
function present(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return `\\x${v.toString('hex').slice(0, 64)}`;
  if (typeof v === 'object') return v;          // JSONB, arrays — the grid stringifies
  return v;
}

module.exports = {
  run, QueryRefused, looksLikeMultipleStatements, withoutLeadingComments,
  connectionPrivileges, assertSafeConnection, createRoleSql, BLOCKED,
  TIMEOUT_MS, MAX_ROWS,
};
