'use strict';

const pool = require('../config/db');
const AdminQuery = require('../services/studio/adminQuery');
const CreditLedger = require('../services/studio/creditLedger');
const Catalogue = require('../services/studio/catalogue');

/**
 * The Studio back office.
 *
 * ── These are the only cross-tenant reads in the product ────────────────────
 *
 * Every other Studio controller scopes to `req.user.tenant_id` and could not
 * return another tenant's row if it tried. This file is the deliberate
 * exception, which makes it the one place where a missing WHERE clause is a
 * data breach rather than a bug. Two consequences worth stating:
 *
 *   1. Nothing here reads `req.user.tenant_id`. If a query in this file starts
 *      filtering by the caller's tenant it has been copied from the wrong place.
 *   2. The route gate is the whole security boundary. `authorize('admin')` in
 *      src/routes/studio.js is what stands between these queries and any signed
 *      -in customer, so it is asserted by a test rather than trusted to review.
 *
 * ── Every write leaves a trace ──────────────────────────────────────────────
 * Admin actions go into `studio_audit_log`, the same table tenant actions use,
 * under `admin.*` actions. One trail, so "what happened to this account" is one
 * query and not a reconciliation between two logs.
 */

// ── Audit ────────────────────────────────────────────────────────────────────

/**
 * Record an admin action.
 *
 * Takes a client so it can be part of the caller's transaction: an audit row
 * that commits when the action rolls back is a lie, and one that rolls back
 * when the action commits is worse.
 */
async function audit(client, req, { action, tenantId = null, entity = null, entityId = null, meta = {} }) {
  await client.query(
    `INSERT INTO studio_audit_log (tenant_id, user_id, action, entity, entity_id, meta, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
    [
      tenantId,
      req.user.id,
      action,
      entity,
      entityId,
      JSON.stringify(meta || {}),
      req.ip || null,
      (req.get && req.get('user-agent')) || null,
    ]
  );
}

// ── Overview ─────────────────────────────────────────────────────────────────

// GET /api/studio/admin/overview
async function overview(req, res) {
  // One round trip each, in parallel. Deliberately not one giant query with
  // six subselects — that reads as a puzzle and each of these is independently
  // useful when one of them looks wrong.
  const [accounts, jobs, money, credits] = await Promise.all([
    pool.query(
      `SELECT
         (SELECT COUNT(*) FROM tenants)                                        AS tenants,
         (SELECT COUNT(*) FROM users WHERE tenant_id IS NOT NULL)              AS users,
         (SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '7 days') AS users_7d,
         (SELECT COUNT(*) FROM avatars)                                        AS avatars,
         (SELECT COUNT(*) FROM avatar_loras WHERE active)                      AS loras_active`
    ),
    pool.query(
      `SELECT status, COUNT(*)::int AS n
         FROM render_jobs
        WHERE created_at > NOW() - INTERVAL '24 hours'
        GROUP BY status`
    ),
    pool.query(
      // Paise. `payments.amount` is what was actually charged, tax included.
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE status = 'captured'
                    AND created_at >= date_trunc('month', NOW())), 0)::bigint AS captured_this_month,
         COALESCE(SUM(amount) FILTER (WHERE status = 'captured'), 0)::bigint  AS captured_all_time,
         COUNT(*) FILTER (WHERE status = 'failed'
                    AND created_at > NOW() - INTERVAL '7 days')::int          AS failed_7d
       FROM payments`
    ),
    pool.query(
      `SELECT
         COALESCE(SUM(credits) FILTER (WHERE kind = 'purchase'), 0)::numeric AS purchased,
         COALESCE(-SUM(credits) FILTER (WHERE kind = 'spend'), 0)::numeric   AS spent
       FROM credit_ledger`
    ),
  ]);

  const byStatus = Object.fromEntries(jobs.rows.map((r) => [r.status, r.n]));

  return res.json({
    accounts: numeric(accounts.rows[0]),
    jobs_24h: {
      queued:  byStatus.queued  || 0,
      running: (byStatus.running || 0) + (byStatus.claimed || 0),
      done:    byStatus.done    || 0,
      failed:  byStatus.failed  || 0,
    },
    money: numeric(money.rows[0]),
    credits: numeric(credits.rows[0]),
  });
}

// ── Accounts ─────────────────────────────────────────────────────────────────

// GET /api/studio/admin/tenants?q=&limit=&offset=
async function listTenants(req, res) {
  const q = String(req.query.q || '').trim();
  const { limit, offset } = page(req);

  const { rows } = await pool.query(
    `SELECT
        t.id,
        t.name,
        t.created_at,
        -- The owner is whoever joined first; a tenant with several users still
        -- needs one name and one address to write to.
        (SELECT u.email FROM users u WHERE u.tenant_id = t.id ORDER BY u.id LIMIT 1)  AS owner_email,
        (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id)::int                  AS users,
        (SELECT COUNT(*) FROM avatars a WHERE a.tenant_id = t.id)::int                AS avatars,
        -- The plan they are actually paying for, or null for free.
        (SELECT p.slug
           FROM subscriptions s
           JOIN users u2 ON u2.id = s.user_id
           JOIN plans p  ON p.id = s.plan_id
          WHERE u2.tenant_id = t.id AND s.status IN ('active', 'authenticated')
          ORDER BY s.current_end DESC NULLS LAST
          LIMIT 1)                                                                    AS plan,
        COALESCE((SELECT SUM(credits) FROM credit_ledger cl
                   WHERE cl.tenant_id = t.id), 0)::numeric                            AS credit_balance,
        (SELECT MAX(rj.created_at) FROM render_jobs rj WHERE rj.tenant_id = t.id)      AS last_job_at,
        (SELECT COUNT(*) FROM render_jobs rj
          WHERE rj.tenant_id = t.id AND rj.created_at > NOW() - INTERVAL '30 days')::int AS jobs_30d
       FROM tenants t
      WHERE ($1 = '' OR t.name ILIKE '%' || $1 || '%'
             OR EXISTS (SELECT 1 FROM users u3
                         WHERE u3.tenant_id = t.id AND u3.email ILIKE '%' || $1 || '%'))
      ORDER BY t.created_at DESC
      LIMIT $2 OFFSET $3`,
    [q, limit, offset]
  );

  return res.json({ tenants: rows.map(numeric), limit, offset });
}

// GET /api/studio/admin/tenants/:id
async function getTenant(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad tenant id' });

  const [tenant, users, avatars, usage, ledger, payments] = await Promise.all([
    pool.query('SELECT id, name, created_at FROM tenants WHERE id = $1', [id]),
    pool.query(
      `SELECT id, name, email, phone_number, role, email_verified, phone_verified, created_at,
              billing_name, billing_city, billing_state, billing_country, gstin
         FROM users WHERE tenant_id = $1 ORDER BY id`,
      [id]
    ),
    pool.query(
      `SELECT a.id, a.name, a.slug, a.mode, a.status, a.created_at,
              (SELECT COUNT(*) FROM avatar_loras l WHERE l.avatar_id = a.id)::int AS loras
         FROM avatars a WHERE a.tenant_id = $1 ORDER BY a.id`,
      [id]
    ),
    pool.query(
      `SELECT metric, period_start, used, limit_value, cost_cents
         FROM studio_usage_counters
        WHERE tenant_id = $1 AND period_start >= date_trunc('month', NOW()) - INTERVAL '3 months'
        ORDER BY period_start DESC, metric`,
      [id]
    ),
    pool.query(
      `SELECT id, kind, credits, metric, reference, note, created_at
         FROM credit_ledger WHERE tenant_id = $1 ORDER BY id DESC LIMIT 50`,
      [id]
    ),
    pool.query(
      `SELECT p.id, p.amount, p.currency, p.status, p.method, p.description,
              p.razorpay_payment_id, p.created_at, u.email
         FROM payments p JOIN users u ON u.id = p.user_id
        WHERE u.tenant_id = $1 ORDER BY p.id DESC LIMIT 50`,
      [id]
    ),
  ]);

  if (!tenant.rows[0]) return res.status(404).json({ error: 'No such tenant' });

  return res.json({
    tenant: tenant.rows[0],
    users: users.rows,
    avatars: avatars.rows.map(numeric),
    usage: usage.rows.map(numeric),
    ledger: ledger.rows.map(numeric),
    payments: payments.rows.map(numeric),
    credit_balance: Number(
      (await pool.query('SELECT COALESCE(SUM(credits),0)::numeric AS b FROM credit_ledger WHERE tenant_id = $1', [id]))
        .rows[0].b
    ),
  });
}

// ── Money ────────────────────────────────────────────────────────────────────

// GET /api/studio/admin/money?status=&limit=&offset=
async function money(req, res) {
  const { limit, offset } = page(req);
  const status = String(req.query.status || '').trim();

  const [payments, invoices] = await Promise.all([
    pool.query(
      `SELECT p.id, p.amount, p.currency, p.status, p.method, p.description,
              p.razorpay_payment_id, p.razorpay_order_id, p.created_at,
              u.email, u.tenant_id, t.name AS tenant_name
         FROM payments p
         JOIN users u   ON u.id = p.user_id
         LEFT JOIN tenants t ON t.id = u.tenant_id
        WHERE ($1 = '' OR p.status = $1)
        ORDER BY p.id DESC
        LIMIT $2 OFFSET $3`,
      [status, limit, offset]
    ),
    pool.query(
      `SELECT i.id, i.number, i.subtotal, i.cgst, i.sgst, i.igst, i.total, i.currency,
              i.place_of_supply, i.payment_ref, i.payment_method, i.issued_at,
              i.buyer_name, i.tenant_id, t.name AS tenant_name
         FROM studio_invoices i
         LEFT JOIN tenants t ON t.id = i.tenant_id
        ORDER BY i.id DESC
        LIMIT $1 OFFSET $2`,
      [limit, offset]
    ),
  ]);

  return res.json({
    payments: payments.rows.map(numeric),
    invoices: invoices.rows.map(numeric),
    limit,
    offset,
  });
}

// ── Jobs ─────────────────────────────────────────────────────────────────────

// GET /api/studio/admin/jobs?status=&stage=&limit=&offset=
async function jobs(req, res) {
  const { limit, offset } = page(req);
  const status = String(req.query.status || '').trim();
  const stage  = String(req.query.stage  || '').trim();

  const [rows, health] = await Promise.all([
    pool.query(
      `SELECT j.id, j.tenant_id, t.name AS tenant_name, j.stage, j.status, j.runner, j.provider,
              j.attempts, j.max_attempts, j.claimed_by, j.claimed_at, j.lease_expires_at,
              j.started_at, j.finished_at, j.created_at,
              -- Only the error, not the whole result blob: a failed motion job's
              -- result can carry a base64 frame, and this is a list view.
              j.result->>'error' AS error,
              j.result->>'code'  AS error_code
         FROM render_jobs j
         LEFT JOIN tenants t ON t.id = j.tenant_id
        WHERE ($1 = '' OR j.status = $1) AND ($2 = '' OR j.stage = $2)
        ORDER BY j.id DESC
        LIMIT $3 OFFSET $4`,
      [status, stage, limit, offset]
    ),
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'queued')::int  AS queued,
         COUNT(*) FILTER (WHERE status IN ('claimed','running'))::int AS running,
         COUNT(*) FILTER (WHERE status = 'failed'
                    AND created_at > NOW() - INTERVAL '24 hours')::int AS failed_24h,
         -- A lease that expired while the job still says it is running means the
         -- worker died. These are the ones nobody is coming back for.
         COUNT(*) FILTER (WHERE status IN ('claimed','running')
                    AND lease_expires_at IS NOT NULL
                    AND lease_expires_at < NOW())::int    AS stranded
       FROM render_jobs`
    ),
  ]);

  return res.json({ jobs: rows.rows.map(numeric), health: numeric(health.rows[0]), limit, offset });
}

// POST /api/studio/admin/jobs/:id/requeue
async function requeueJob(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad job id' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Locked and re-read inside the transaction: a worker may be claiming this
    // exact row right now, and requeueing a job that just started would run it
    // twice and bill for it twice.
    const { rows } = await client.query(
      'SELECT id, tenant_id, status, attempts, stage FROM render_jobs WHERE id = $1 FOR UPDATE',
      [id]
    );
    const job = rows[0];
    if (!job) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'No such job' }); }

    if (!['failed', 'cancelled'].includes(job.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Only a failed or cancelled job can be requeued',
        message: `This job is ${job.status}. Requeueing a live job would run it a second time and bill for it twice.`,
        code: 'JOB_NOT_REQUEUABLE',
      });
    }

    await client.query(
      `UPDATE render_jobs
          SET status = 'queued', claimed_by = NULL, claimed_at = NULL,
              lease_expires_at = NULL, started_at = NULL, finished_at = NULL,
              -- max_attempts is raised rather than attempts reset, so the
              -- history of how many times this has been tried is not erased.
              max_attempts = GREATEST(max_attempts, attempts + 1)
        WHERE id = $1`,
      [id]
    );

    await audit(client, req, {
      action: 'admin.job.requeue',
      tenantId: job.tenant_id,
      entity: 'render_job',
      entityId: id,
      meta: { from_status: job.status, attempts: job.attempts, stage: job.stage },
    });

    await client.query('COMMIT');
    return res.json({ ok: true, id, status: 'queued' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── Acting on an account ─────────────────────────────────────────────────────

// POST /api/studio/admin/tenants/:id/credits  { credits, note }
async function grantCredits(req, res) {
  const id = Number(req.params.id);
  const credits = Number(req.body?.credits);
  const note = String(req.body?.note || '').trim();

  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad tenant id' });
  if (!Number.isFinite(credits) || credits === 0) {
    return res.status(400).json({ error: 'Say how many credits', message: 'A positive number to grant, a negative one to take back.' });
  }
  if (Math.abs(credits) > 100000) {
    return res.status(400).json({
      error: 'That is more than a grant',
      message: 'Over 100,000 credits in one action is more likely a typo than an intention.',
      code: 'GRANT_TOO_LARGE',
    });
  }
  if (!note) {
    // The one field that makes the audit trail worth having. A row saying
    // "someone gave 500 credits" answers nothing six weeks later.
    return res.status(400).json({ error: 'Say why', message: 'A short reason is recorded with the grant.', code: 'NOTE_REQUIRED' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query('SELECT id FROM tenants WHERE id = $1', [id]);
    if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'No such tenant' }); }

    const before = await CreditLedger.balance(client, id);
    const reference = `admin:${req.user.id}:${Date.now()}`;

    // Through the ledger, not an INSERT here. It owns the sign convention and
    // the uniqueness rules, and a second writer is how a balance stops adding
    // up. The schema's CHECK forbids a negative purchase, so taking credits
    // back is a spend — which also means it cannot overdraw an account.
    if (credits > 0) {
      await CreditLedger.purchase(client, id, credits, reference, `Manual grant: ${note}`);
    } else {
      const ok = await CreditLedger.spend(client, id, 'admin_adjustment', -credits, reference);
      if (!ok) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Not enough credits to take back',
          message: `This account holds ${before} credits, which is fewer than the ${-credits} you asked to remove.`,
          code: 'INSUFFICIENT_CREDITS',
        });
      }
    }

    const after = await CreditLedger.balance(client, id);

    await audit(client, req, {
      action: 'admin.credits.grant',
      tenantId: id,
      entity: 'credit_ledger',
      meta: { credits, note, balance_before: before, balance_after: after },
    });

    await client.query('COMMIT');
    return res.status(201).json({ ok: true, tenant_id: id, credits, balance: after });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── The SQL console ──────────────────────────────────────────────────────────

// POST /api/studio/admin/query  { sql }
async function query(req, res) {
  const sql = String(req.body?.sql || '');

  let out;
  try {
    out = await AdminQuery.run(sql);
  } catch (err) {
    if (err instanceof AdminQuery.QueryRefused) {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    throw err;
  }

  // Logged whether or not it worked, and outside the query's own transaction —
  // which was read-only and has been rolled back, so it could not have written
  // this row even if we had wanted it to. What matters is that the text is
  // kept: "who looked at what" is the question an audit log exists to answer,
  // and a failed query is still someone looking.
  const client = await pool.connect();
  try {
    await audit(client, req, {
      action: 'admin.query.run',
      meta: {
        sql: sql.slice(0, 4000),
        ok: out.ok,
        rows: out.row_count ?? null,
        ms: out.ms,
        error: out.ok ? null : out.error,
      },
    });
  } finally {
    client.release();
  }

  return res.json(out);
}

// GET /api/studio/admin/audit?action=&tenant_id=&limit=&offset=
async function auditLog(req, res) {
  const { limit, offset } = page(req);
  const action = String(req.query.action || '').trim();
  const tenantId = req.query.tenant_id ? Number(req.query.tenant_id) : null;

  const { rows } = await pool.query(
    `SELECT a.id, a.action, a.entity, a.entity_id, a.tenant_id, t.name AS tenant_name,
            a.user_id, u.email AS actor_email, a.meta, a.ip, a.created_at
       FROM studio_audit_log a
       LEFT JOIN tenants t ON t.id = a.tenant_id
       LEFT JOIN users   u ON u.id = a.user_id
      WHERE ($1 = '' OR a.action LIKE $1 || '%')
        AND ($2::int IS NULL OR a.tenant_id = $2)
      ORDER BY a.id DESC
      LIMIT $3 OFFSET $4`,
    [action, tenantId, limit, offset]
  );

  return res.json({ entries: rows, limit, offset });
}

// ── Small shared things ──────────────────────────────────────────────────────

/** Bounded paging. A caller asking for a million rows gets 200. */
function page(req) {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  return { limit, offset };
}

/**
 * NUMERIC and BIGINT come out of `pg` as strings, on purpose — they can hold
 * values a JS number cannot. These are counts and paise, which cannot, and a
 * string that renders as "1200" but sorts before "9" is a bug in every table
 * that shows it.
 */
function numeric(row) {
  if (!row) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) && Number.isFinite(Number(v))
      ? Number(v)
      : v;
  }
  return out;
}

// ── Catalogue management ─────────────────────────────────────────────────────
// The catalogue is the only cross-tenant WRITE surface. Adding a face publishes
// an already-built avatar (it must have a trained LoRA, a look profile and
// calibration baselines, or it could not be shot the moment a customer picks
// it); removing one clears the flag and is refused while customers are using it.

// GET /api/studio/admin/catalogue
async function listCatalogue(req, res) {
  const client = await pool.connect();
  try {
    res.json(await Catalogue.adminList(client));
  } finally { client.release(); }
}

// POST /api/studio/admin/catalogue  { avatarId, region }
async function addCatalogue(req, res) {
  const avatarId = Number(req.body && req.body.avatarId);
  const region = req.body && req.body.region ? String(req.body.region).trim() : null;
  if (!Number.isInteger(avatarId)) return res.status(400).json({ error: 'Bad avatar id' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await Catalogue.publish(client, { avatarId, region });
    await audit(client, req, {
      action: 'admin.catalogue.publish', tenantId: out.tenant_id || null,
      entity: 'avatar', entityId: avatarId, meta: { region },
    });
    await client.query('COMMIT');
    return res.status(201).json(out);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.status) return res.status(e.status).json({ error: e.message, message: e.message, code: e.code });
    throw e;
  } finally { client.release(); }
}

// DELETE /api/studio/admin/catalogue/:id?force=1
async function removeCatalogue(req, res) {
  const avatarId = Number(req.params.id);
  const force = req.query.force === '1' || req.query.force === 'true' || (req.body && req.body.force === true);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await Catalogue.unpublish(client, { avatarId, force });
    await audit(client, req, {
      action: 'admin.catalogue.remove', entity: 'avatar', entityId: avatarId,
      meta: { force: !!force, hadSelections: out.hadSelections || 0 },
    });
    await client.query('COMMIT');
    return res.json(out);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.status) return res.status(e.status).json({ error: e.message, message: e.message, code: e.code, selections: e.selections });
    throw e;
  } finally { client.release(); }
}


// ── Clone consent review (admin back office) ────────────────────────────────
// Twin consents and their verification state, across all tenants. Approving one
// marks it verified (a human review path alongside the automated footage match).
async function listConsents(_req, res) {
  const { rows } = await pool.query(
    `SELECT a.id AS avatar_id, a.name AS avatar_name, a.slug, a.tenant_id,
            c.id AS consent_id, c.subject_name, c.verified, c.match_score,
            c.video_url, c.created_at, c.verified_at
       FROM avatars a
       JOIN consent_records c ON c.id = a.consent_record_id
      WHERE a.mode <> 'synthetic'
      ORDER BY c.verified ASC, c.created_at DESC
      LIMIT 200`);
  res.json({ consents: rows });
}

async function approveConsent(req, res) {
  const avatarId = Number(req.params.id);
  const { rows } = await pool.query('SELECT consent_record_id, mode FROM avatars WHERE id = $1', [avatarId]);
  const av = rows[0];
  if (!av) return res.status(404).json({ error: 'No such avatar', code: 'NO_AVATAR' });
  if (av.mode === 'synthetic') return res.status(409).json({ error: 'A synthetic avatar needs no consent', code: 'NOT_A_TWIN' });
  if (!av.consent_record_id) return res.status(409).json({ error: 'No consent recorded yet', code: 'NO_RECORD' });
  await pool.query(
    `UPDATE consent_records SET verified = TRUE, verified_at = COALESCE(verified_at, NOW()), verified_by = $2 WHERE id = $1`,
    [av.consent_record_id, req.user.id]);
  res.json({ verified: true });
}

module.exports = {
  overview, listTenants, getTenant, money, jobs, requeueJob, grantCredits, query, auditLog,
  listCatalogue, addCatalogue, removeCatalogue,
  listConsents, approveConsent,
};
