'use strict';

const test = require('node:test');
const assert = require('node:assert');

const pool = require('../../src/config/db');
const Provisioning = require('../../src/services/studio/provisioning');

/**
 * The failure this file exists to prevent: a person signs up, signs in
 * perfectly, and owns nothing. Every Studio table is scoped by `tenant_id`, so a
 * user with NULL there gets a working app with no content and no error anywhere
 * — the hardest kind of bug to notice and the easiest to ship.
 */

const made = [];

async function makeUser({ name = 'Test Person', role = 'tenant_user', tenant_id = null } = {}) {
  const email = `prov-${Math.random().toString(36).slice(2, 10)}@example.test`;
  const { rows } = await pool.query(
    `INSERT INTO users (name, email, password, role, tenant_id, phone_verified, email_verified)
     VALUES ($1, $2, 'x', $3, $4, TRUE, TRUE) RETURNING id, name, email, role, tenant_id`,
    [name, email, role, tenant_id]
  );
  made.push(rows[0].id);
  return rows[0];
}

test.after(async () => {
  if (made.length) {
    const { rows } = await pool.query('SELECT DISTINCT tenant_id FROM users WHERE id = ANY($1) AND tenant_id IS NOT NULL', [made]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [made]);
    const ids = rows.map((r) => r.tenant_id);
    if (ids.length) await pool.query("DELETE FROM tenants WHERE id = ANY($1) AND name LIKE '%Studio%'", [ids]);
  }
  await pool.end();
});

// ── The happy path ────────────────────────────────────────────────────────────

test('a user with no workspace gets one, and administers it', async () => {
  const user = await makeUser({ name: 'Aarti Menon' });
  const { tenant, created, role } = await Provisioning.ensureWorkspace(user.id);

  assert.strictEqual(created, true);
  assert.ok(tenant.id > 0);
  assert.match(tenant.name, /Aarti Menon/);

  // They own a brand-new empty tenant containing only themselves, so they
  // administer it. This is not the same as letting a registration nominate
  // `tenant_admin` — which `register` still refuses — because the decision is
  // made server-side about a tenant that did not exist a moment ago.
  assert.strictEqual(role, 'tenant_admin');

  const { rows } = await pool.query('SELECT tenant_id, role FROM users WHERE id = $1', [user.id]);
  assert.strictEqual(rows[0].tenant_id, tenant.id);
  assert.strictEqual(rows[0].role, 'tenant_admin');
});

test('the free tier needs no per-tenant seeding', async () => {
  // `studio_entitlements` rows with plan_id NULL ARE the free tier — global, not
  // per-tenant. Writing per-tenant rows here would shadow them and freeze this
  // one workspace on today's limits forever, while every other tenant moved on.
  const user = await makeUser();
  const { tenant } = await Provisioning.ensureWorkspace(user.id);

  const { rows: free } = await pool.query('SELECT metric FROM studio_entitlements WHERE plan_id IS NULL');
  assert.ok(free.length > 0, 'the free tier should be seeded globally by migration 030');

  const { rows: counters } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM studio_usage_counters WHERE tenant_id = $1', [tenant.id]
  );
  assert.strictEqual(counters[0].n, 0, 'a fresh workspace should carry no usage rows');
});

// ── Idempotence and the things it protects ────────────────────────────────────

test('calling it twice does not make two workspaces', async () => {
  // The bootstrap endpoint calls this on every page load, so "twice" is the
  // normal case rather than an edge one.
  const user = await makeUser();
  const first = await Provisioning.ensureWorkspace(user.id);
  const second = await Provisioning.ensureWorkspace(user.id);

  assert.strictEqual(second.tenant.id, first.tenant.id);
  assert.strictEqual(second.created, false);
});

test('🔒 two simultaneous calls still produce one workspace', async () => {
  // Two tabs opening Studio at once. Without the FOR UPDATE lock both read
  // tenant_id NULL, both insert, and the person ends up with two workspaces —
  // one of which holds the avatar they made and the other of which is what they
  // see next time.
  const user = await makeUser({ name: `Concurrent ${Math.random().toString(36).slice(2, 8)}` });
  const [a, b] = await Promise.all([
    Provisioning.ensureWorkspace(user.id),
    Provisioning.ensureWorkspace(user.id),
  ]);
  assert.strictEqual(a.tenant.id, b.tenant.id);
  assert.strictEqual([a.created, b.created].filter(Boolean).length, 1, 'exactly one call should have created it');

  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM tenants WHERE name LIKE $1', [`${Provisioning.baseName(user)}%`]
  );
  assert.strictEqual(rows[0].n, 1);
});

test('🔒 an existing member is never re-parented or promoted', async () => {
  // The dangerous shape: an agency's junior editor opens Studio. Provisioning on
  // "no workspace" must not read as "wrong workspace", and convenience must not
  // become privilege escalation.
  const { rows: t } = await pool.query(
    "INSERT INTO tenants (name) VALUES ('prov-existing-agency') ON CONFLICT (name) DO UPDATE SET updated_at = NOW() RETURNING id"
  );
  const user = await makeUser({ role: 'tenant_user', tenant_id: t[0].id });

  const { tenant, created, role } = await Provisioning.ensureWorkspace(user.id);
  assert.strictEqual(created, false);
  assert.strictEqual(tenant.id, t[0].id);
  assert.strictEqual(role, 'tenant_user', 'opening Studio must not promote you inside someone else’s workspace');
});

test('an admin keeps their role rather than being demoted to tenant_admin', async () => {
  const user = await makeUser({ role: 'admin' });
  const { role } = await Provisioning.ensureWorkspace(user.id);
  assert.strictEqual(role, 'admin');
});

// ── Naming ────────────────────────────────────────────────────────────────────

test('two people with the same name both get a workspace', async () => {
  // `tenants.name` is UNIQUE. Two people called Priya is not an error condition,
  // and a unique violation here would fail a sign-up for a reason the person
  // cannot act on.
  const a = await makeUser({ name: 'Priya Sharma' });
  const b = await makeUser({ name: 'Priya Sharma' });
  const ta = await Provisioning.ensureWorkspace(a.id);
  const tb = await Provisioning.ensureWorkspace(b.id);

  assert.notStrictEqual(ta.tenant.id, tb.tenant.id);
  assert.notStrictEqual(ta.tenant.name, tb.tenant.name);
  assert.match(tb.tenant.name, /Priya Sharma/);
});

test('a nameless account falls back to the email local part', async () => {
  const { rows } = await pool.query(
    `INSERT INTO users (name, email, password, role, phone_verified, email_verified)
     VALUES ('', $1, 'x', 'tenant_user', TRUE, TRUE) RETURNING id, name, email`,
    [`solo-${Math.random().toString(36).slice(2, 8)}@example.test`]
  );
  made.push(rows[0].id);
  const { tenant } = await Provisioning.ensureWorkspace(rows[0].id);
  assert.match(tenant.name, /^solo-/);
});

test('a very long name cannot overflow the 150-char column', async () => {
  const user = await makeUser({ name: 'Ramachandran '.repeat(7).trim() });   // 96 chars — users.name is varchar(100)
  const { tenant } = await Provisioning.ensureWorkspace(user.id);
  assert.ok(tenant.name.length <= 150, `name was ${tenant.name.length} chars`);
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────

test('bootstrap reports a stale token when it just made the workspace', async () => {
  // The caller's token was minted before the tenant existed and still claims
  // `tenant_id: null`. Every Studio route reads the tenant from that claim, so
  // without a refresh the very next request is scoped to nothing.
  const user = await makeUser();
  const out = await Provisioning.bootstrap({ ...user, tenant_id: null });
  assert.strictEqual(out.token_stale, true);
  assert.ok(out.workspace.id);

  const again = await Provisioning.bootstrap({ ...user, tenant_id: out.workspace.id, role: out.user.role });
  assert.strictEqual(again.token_stale, false, 'a token that already matches should not be thrown away');
});

test('a missing user is a 404, not a new workspace', async () => {
  await assert.rejects(
    () => Provisioning.ensureWorkspace(2147483000),
    (e) => e.status === 404
  );
});
