"use strict";

/**
 * Shared catalogue — browse, select, publish, and the shoot-authorisation rule.
 *
 * Needs Postgres with migrations applied (054 included). Everything runs inside
 * one transaction that is rolled back, so it seeds throwaway rows at a high
 * tenant id and leaves the database byte-identical. The select() plan-limit path
 * needs seeded plan/subscription rows and is covered separately (a throwaway PG
 * verification, see the T24 build note); here we exercise the query logic and
 * the security-critical isolation of the orchestrator WHERE-clause.
 */

const test = require("node:test");
const assert = require("node:assert");
const pool = require("../src/config/db");
const Catalogue = require("../src/services/studio/catalogue");

const T = 990001; // throwaway tenant, high id
const OTHER = 990002; // a second customer tenant
const PLAT = 990003; // the platform / catalogue-owner tenant

let db;
let hasDb = true;

test.before(async () => {
  try {
    db = await pool.connect();
  } catch {
    hasDb = false;
    return;
  }
  try {
    await db.query("BEGIN");
    await db.query("INSERT INTO tenants (id, name) VALUES ($1,'t'),($2,'o'),($3,'p') ON CONFLICT DO NOTHING", [T, OTHER, PLAT]);
    // catalogue avatar (owned by platform tenant), fully built
    await db.query(
      `INSERT INTO avatars (id, tenant_id, slug, name, mode, is_catalogue, catalogue_region, catalogue_published_at)
       VALUES (990100,$1,'cat-meher','Meher','synthetic',TRUE,'delhi',NOW())`, [PLAT]);
    // a private avatar owned by OTHER
    await db.query(
      `INSERT INTO avatars (id, tenant_id, slug, name, mode)
       VALUES (990101,$1,'priv','Priv','synthetic')`, [OTHER]);
    await db.query("INSERT INTO avatar_loras (avatar_id, version, file_path, trigger_token, base_checkpoint, active) VALUES (990100,1,'p','x','flux1-dev',TRUE)");
    await db.query("INSERT INTO look_profiles (avatar_id) VALUES (990100)");
    await db.query("INSERT INTO expression_baselines (avatar_id, lora_id, preset_key, expected_similarity) SELECT 990100, id, 'neutral', 0.7 FROM avatar_loras WHERE avatar_id=990100");
  } catch (e) {
    // schema not present / migration not applied — skip rather than fail hard
    hasDb = false;
    try { await db.query("ROLLBACK"); db.release(); } catch {}
  }
});

test.after(async () => {
  if (db && hasDb) {
    try { await db.query("ROLLBACK"); } catch {}
    db.release();
  }
});

test("listPublished returns catalogue avatars only, never a private one", async (t) => {
  if (!hasDb) return t.skip("no database");
  const rows = await Catalogue.listPublished(db, {});
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes(990100), "catalogue avatar present");
  assert.ok(!ids.includes(990101), "private avatar must not appear");
});

test("region filter narrows the catalogue", async (t) => {
  if (!hasDb) return t.skip("no database");
  assert.ok((await Catalogue.listPublished(db, { region: "delhi" })).some((r) => r.id === 990100));
  assert.ok(!(await Catalogue.listPublished(db, { region: "punjab" })).some((r) => r.id === 990100));
});

test("getPublished refuses a private avatar", async (t) => {
  if (!hasDb) return t.skip("no database");
  assert.ok(await Catalogue.getPublished(db, 990100));
  assert.strictEqual(await Catalogue.getPublished(db, 990101), null);
});

test("select is idempotent on (tenant, avatar)", async (t) => {
  if (!hasDb) return t.skip("no database");
  await db.query("INSERT INTO catalogue_selections (tenant_id, avatar_id) VALUES ($1,990100)", [T]);
  const out = await Catalogue.select(db, { tenantId: T, avatarId: 990100 });
  assert.strictEqual(out.alreadyHad, true, "re-selecting is a no-op, not a duplicate-key error");
});

test("select refuses an unknown or not-ready catalogue avatar", async (t) => {
  if (!hasDb) return t.skip("no database");
  await assert.rejects(() => Catalogue.select(db, { tenantId: T, avatarId: 990101 }), (e) => e.status === 404);
});

test("publish refuses an avatar with no calibration baseline", async (t) => {
  if (!hasDb) return t.skip("no database");
  // 990101 has no LoRA/look/baseline -> refused before it can become a catalogue face
  await assert.rejects(() => Catalogue.publish(db, { avatarId: 990101 }), (e) => e.status === 409);
});

test("SECURITY: the shoot WHERE-clause never returns a private avatar cross-tenant", async (t) => {
  if (!hasDb) return t.skip("no database");
  const orch = async (av, ten) => (await db.query(
    `SELECT count(*)::int n FROM avatars a
       WHERE a.id=$1 AND (a.tenant_id=$2 OR (a.is_catalogue AND EXISTS(
         SELECT 1 FROM catalogue_selections s WHERE s.avatar_id=a.id AND s.tenant_id=$2)))`,
    [av, ten])).rows[0].n;
  // OTHER's private avatar is invisible to tenant T
  assert.strictEqual(await orch(990101, T), 0, "private avatar must not leak cross-tenant");
  // catalogue avatar is shootable by T because T selected it (in the idempotency test)
  assert.strictEqual(await orch(990100, T), 1, "selected catalogue avatar is shootable");
  // ...but NOT by OTHER, who never selected it
  assert.strictEqual(await orch(990100, OTHER), 0, "catalogue requires selection");
});

test("admin adminList surfaces catalogue + publishable, excluding unbuilt avatars", async (t) => {
  if (!hasDb) return t.skip("no database");
  const { catalogue, publishable } = await Catalogue.adminList(db);
  assert.ok(catalogue.some((a) => a.id === 990100), "catalogue avatar listed");
  assert.ok(!publishable.some((a) => a.id === 990101), "an avatar without a LoRA/look/baseline is not publishable");
});

test("admin unpublish refuses a catalogue avatar customers have selected", async (t) => {
  if (!hasDb) return t.skip("no database");
  await assert.rejects(
    () => Catalogue.unpublish(db, { avatarId: 990100 }),
    (e) => e.status === 409 && e.code === "IN_USE"
  );
});

test("admin unpublish with force removes it and drops selections", async (t) => {
  if (!hasDb) return t.skip("no database");
  const out = await Catalogue.unpublish(db, { avatarId: 990100, force: true });
  assert.strictEqual(out.removed, true);
  assert.strictEqual(await Catalogue.getPublished(db, 990100), null, "no longer a catalogue avatar");
});
