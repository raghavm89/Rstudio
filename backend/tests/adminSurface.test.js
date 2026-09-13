'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');
const http   = require('node:http');
const jwt    = require('jsonwebtoken');

const ROOT = path.join(__dirname, '..');
const FE   = path.join(ROOT, '..', 'frontend');
const read = (p) => fs.readFileSync(p, 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/**
 * The back office.
 *
 * Every other Studio controller is scoped to the caller's own tenant and could
 * not return someone else's row if it tried. This one is the deliberate
 * exception, so the role gate is not a convenience — it is the whole thing
 * standing between any signed-in customer and every other customer's data.
 * That is worth testing over the running server rather than by reading the
 * route file.
 */

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-secret-for-admin-surface';
process.env.NODE_ENV = 'test';
process.env.STUDIO_SERVER_RUNNER = 'off';   // don't start the render loop for a route test

const app = require('../src/app');

const ADMIN_ROUTES = [
  ['GET',  '/api/studio/admin/overview'],
  ['GET',  '/api/studio/admin/tenants'],
  ['GET',  '/api/studio/admin/tenants/1'],
  ['POST', '/api/studio/admin/tenants/1/credits'],
  ['GET',  '/api/studio/admin/money'],
  ['GET',  '/api/studio/admin/jobs'],
  ['POST', '/api/studio/admin/jobs/1/requeue'],
  ['POST', '/api/studio/admin/query'],
  ['GET',  '/api/studio/admin/audit'],
];

const token = (over = {}) => jwt.sign(
  { id: 1, email: 'x@y.z', role: 'tenant_admin', tenant_id: 9, aud: 'studio', ...over },
  process.env.JWT_ACCESS_SECRET,
  { expiresIn: '5m' }
);

let server, port;
test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  port = server.address().port;
});
test.after(() => server && server.close());

function call(method, url, { auth, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, method, path: url,
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://localhost:3100',
          ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        } },
      (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(text); } catch { /* not json */ }
          resolve({ status: res.statusCode, body: parsed, text });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── The gate ─────────────────────────────────────────────────────────────────

test('no admin route answers without a token', async () => {
  for (const [method, url] of ADMIN_ROUTES) {
    const r = await call(method, url, { body: method === 'POST' ? {} : undefined });
    assert.strictEqual(r.status, 401, `${method} ${url} answered ${r.status} unauthenticated`);
  }
});

test('a signed-in customer is refused every one of them', async () => {
  // The case that matters. These people have valid tokens; the only thing
  // between them and every other tenant's data is the role check.
  for (const role of ['tenant_admin', 'tenant_user', 'developer', 'customer']) {
    const auth = token({ role });
    for (const [method, url] of ADMIN_ROUTES) {
      const r = await call(method, url, { auth, body: method === 'POST' ? {} : undefined });
      assert.strictEqual(r.status, 403,
        `role "${role}" got ${r.status} from ${method} ${url} — it must be 403`);
    }
  }
});

test('the refusal happens before the query, not after it', async () => {
  // If a controller ran first and the role check second, a 403 would still be
  // returned — after the cross-tenant rows had been read. The tell is that
  // these tests pass with no database at all: the gate is reached first, so
  // nothing ever connects. A 500 here would mean the controller ran.
  const r = await call('GET', '/api/studio/admin/tenants', { auth: token({ role: 'tenant_user' }) });
  assert.strictEqual(r.status, 403);
  assert.notStrictEqual(r.status, 500, 'the controller ran before the gate');
});

test('an admin gets past the gate', async () => {
  // Not a 200 — there is no database in this test — but it must not be a 403.
  // Without this the suite above would pass just as well if every route were
  // broken.
  const r = await call('GET', '/api/studio/admin/overview', { auth: token({ role: 'admin' }) });
  assert.notStrictEqual(r.status, 403, 'an admin must not be refused');
  assert.notStrictEqual(r.status, 404, 'the route must exist');
});

test('the gate is applied once to the router, not repeated per route', async () => {
  // A per-route list of `authorize('admin')` is a list somebody eventually adds
  // a route without, and that route is a data breach. One `use` on a mounted
  // sub-router cannot be forgotten.
  const src = strip(read(path.join(ROOT, 'src', 'routes', 'studio.js')));
  assert.match(src, /adminRouter\.use\(authorize\('admin'\)\)/,
    'the admin sub-router must gate itself');

  const block = src.slice(src.indexOf('const adminRouter'), src.indexOf("router.use('/admin'"));
  const gate  = block.indexOf("adminRouter.use(authorize('admin'))");
  const first = block.search(/adminRouter\.(get|post|put|delete)\s*\(/);
  assert.ok(gate > -1 && gate < first, 'the gate must come before the first admin route');
});

// ── Cross-tenant by design ───────────────────────────────────────────────────

test('the back office never filters by the caller\'s own tenant', async () => {
  // A query in this file that starts scoping to req.user.tenant_id has been
  // copied from a tenant controller, and it would silently show an admin only
  // their own account while looking like it worked.
  const src = strip(read(path.join(ROOT, 'src', 'controllers', 'studioAdminController.js')));
  assert.doesNotMatch(src, /req\.user\.tenant_id/,
    'the admin controller must not read the caller\'s tenant');
});

// ── Writes leave a trace ─────────────────────────────────────────────────────

test('every write records who did it, in the same transaction', async () => {
  const src = strip(read(path.join(ROOT, 'src', 'controllers', 'studioAdminController.js')));

  for (const fn of ['grantCredits', 'requeueJob']) {
    const body = src.slice(src.indexOf(`async function ${fn}(`));
    const cut  = body.slice(0, body.indexOf('\n}\n'));
    assert.match(cut, /await audit\(client, req/,
      `${fn} must write an audit row on the same client as its change`);
    assert.match(cut, /COMMIT/, `${fn} must be transactional`);
    // The audit row is written BEFORE the commit — one after it could be lost
    // while the change stands.
    // Presence before order: indexOf gives -1 when absent, and `-1 < n` is
    // true, so an ordering check alone passes exactly when the audit call has
    // been deleted.
    const auditAt = cut.indexOf('await audit(');
    const commitAt = cut.indexOf("client.query('COMMIT')");
    assert.ok(auditAt > -1 && commitAt > -1, `${fn} must both audit and commit`);
    assert.ok(auditAt < commitAt,
      `${fn} audits after committing, so a crash loses the record but keeps the change`);
  }

  // A grant with no reason is a log line that answers nothing later.
  assert.match(src, /NOTE_REQUIRED/, 'a credit grant must require a reason');
});

// ── The SQL console ──────────────────────────────────────────────────────────

test('the console refuses a connection that can reach the filesystem', () => {
  // Found by trying it rather than by reading about it: a read-only transaction
  // does NOT stop `COPY (SELECT 1) TO PROGRAM 'touch /tmp/x'`, which runs a
  // shell command on the database server, nor pg_read_file(). Both need
  // superuser or one of the pg_*_server_files roles — which a database user
  // made with `createuser` for a small deployment very often has.
  //
  // So the boundary is the ROLE, checked before any SQL is sent.
  const src = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'adminQuery.js')));

  assert.match(src, /rolsuper/,                       'it must ask whether the role is a superuser');
  assert.match(src, /pg_execute_server_program/,      'and whether it can run programs');
  assert.match(src, /pg_write_server_files/,          'and whether it can write files');
  assert.match(src, /pg_read_server_files/,           'and whether it can read them');

  // Checked before the statement is sent, so no SQL can influence the outcome.
  const run   = src.slice(src.indexOf('async function run('));
  const gate  = run.indexOf('assertSafeConnection');
  const send  = run.indexOf('client.query({ text');
  assert.ok(gate > -1 && gate < send, 'the privilege check must precede the query');
});

test('the console cannot write, and Postgres is what says so', () => {
  const src = strip(read(path.join(ROOT, 'src', 'services', 'studio', 'adminQuery.js')));

  assert.match(src, /BEGIN TRANSACTION READ ONLY/,
    'the read-only transaction is what refuses INSERT/UPDATE/DELETE, including inside a CTE');
  assert.match(src, /ROLLBACK/, 'and it is always rolled back');
  assert.match(src, /SET LOCAL statement_timeout/,
    'LOCAL, so a timeout cannot leak onto the next request using this pooled connection');

  // No write mode. A tool that can be flipped into one is one.
  assert.doesNotMatch(src, /allowWrites|writeMode|force\s*[:=]\s*true/i);
});

test('COPY and SET ROLE are refused outright', () => {
  const q = require('../src/services/studio/adminQuery');
  for (const sql of [
    "COPY (SELECT 1) TO PROGRAM 'touch /tmp/x'",
    "COPY users TO '/tmp/stolen.csv'",
    '  -- a comment first\n  COPY users FROM \'/etc/passwd\'',
    'SET ROLE postgres',
    'set session authorization postgres',
  ]) {
    assert.ok(q.BLOCKED.some((b) => b.re.test(q.withoutLeadingComments(sql))),
      `not refused: ${sql.replace(/\n/g, ' ')}`);
  }
  // And an ordinary read is not caught by the same net.
  for (const sql of ['SELECT * FROM users', 'WITH x AS (SELECT 1) SELECT * FROM x', '/* c */ SELECT 1']) {
    assert.ok(!q.BLOCKED.some((b) => b.re.test(q.withoutLeadingComments(sql))), `wrongly refused: ${sql}`);
  }
});

test('one statement at a time, and a semicolon in a string is not a statement', () => {
  const { looksLikeMultipleStatements: multi } = require('../src/services/studio/adminQuery');
  for (const sql of ['SELECT 1; DELETE FROM users', "SELECT 1; -- x\nDROP TABLE users"]) {
    assert.ok(multi(sql), `should be refused: ${sql.replace(/\n/g, ' ')}`);
  }
  for (const sql of ['SELECT 1', 'SELECT 1;', "SELECT ';' AS x", "SELECT 'it''s; fine'", 'SELECT 1 /* ; */, 2']) {
    assert.ok(!multi(sql), `should be allowed: ${sql}`);
  }
});

test('every query is recorded, including the ones that failed', () => {
  // "Who looked at what" is the question an audit log exists to answer, and a
  // query that errored is still someone looking.
  const src = strip(read(path.join(ROOT, 'src', 'controllers', 'studioAdminController.js')));
  const fn  = src.slice(src.indexOf('async function query('));
  const cut = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(cut, /admin\.query\.run/, 'the console must write an audit row');
  assert.match(cut, /sql: sql\.slice/,   'and keep the text of the query');
  // After the run, not conditional on it succeeding.
  assert.ok(!/if \(out\.ok\)[\s\S]{0,80}audit\(/.test(cut), 'a failed query must be logged too');
});

// ── The UI ───────────────────────────────────────────────────────────────────

test('the admin section is not offered to people who cannot use it', () => {
  const shell = read(path.join(FE, 'components', 'Shell.jsx'));
  assert.match(shell, /role === 'admin'/, 'the nav entry must be gated on the role');
});
