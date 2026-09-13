'use strict';

const pool = require('../../config/db');

/**
 * Give a person a workspace.
 *
 * Studio is self-serve: someone finds it, signs up, and must be able to start.
 * That requires a `tenants` row, because every Studio table is scoped by
 * `tenant_id` — avatars, jobs, usage counters, consent records. A user with
 * `tenant_id NULL` signs in perfectly and then owns nothing, which is the worst
 * shape of broken: no error anywhere, just an app with no content and no way to
 * make any.
 *
 * The platform side is deliberately NOT changed. On rstudio.app a tenant is
 * created by an admin, and minting one per visitor would fill the table with
 * empty tenants nobody asked for. So provisioning is scoped to Studio, and the
 * scoping is recorded at registration rather than inferred later.
 */

/** Free tier is `plan_id IS NULL` in `studio_entitlements` — a global row set,
 *  not a per-tenant one. So a new workspace needs no entitlement seeding: it is
 *  already on the free tier by virtue of having no plan. Anything that writes
 *  per-tenant entitlement rows here would shadow the global ones and freeze this
 *  tenant on today's limits forever. */
const FREE_TIER_NEEDS_NO_SEEDING = true;

class ProvisioningError extends Error {
  constructor(message, { status = 400, code = null } = {}) {
    super(message);
    this.name = 'ProvisioningError';
    this.status = status;
    this.code = code;
  }
}

/**
 * A workspace name from what we know about the person.
 *
 * `tenants.name` is UNIQUE and only 150 chars, so this has to be both derived
 * and collision-tolerant — two people called Priya is not an error condition.
 */
function baseName(user) {
  const from = (user.name || '').trim() || (user.email || '').split('@')[0] || 'Studio';
  const cleaned = from.replace(/\s+/g, ' ').slice(0, 120);
  return `${cleaned}'s Studio`;
}

const Provisioning = {
  ProvisioningError,
  FREE_TIER_NEEDS_NO_SEEDING,
  baseName,

  /**
   * Ensure this user has a workspace, and return it.
   *
   * Idempotent and safe to call on every request — the bootstrap endpoint does
   * exactly that. Two concurrent calls for the same user cannot produce two
   * tenants: the user row is locked FOR UPDATE for the duration, so the second
   * call blocks, then re-reads and finds the tenant the first one made.
   *
   * Never re-parents. If the user already belongs to a workspace this returns it
   * untouched, including their existing role — silently promoting an agency's
   * junior editor to tenant_admin because they opened Studio would be a
   * privilege escalation dressed as a convenience.
   */
  async ensureWorkspace(userId, { client = null } = {}) {
    const runner = client || (await pool.connect());
    const ownsTransaction = !client;
    try {
      if (ownsTransaction) await runner.query('BEGIN');

      // FOR UPDATE is the whole concurrency story. Without it, two tabs opening
      // Studio at once both read tenant_id NULL and both insert.
      const { rows: users } = await runner.query(
        'SELECT id, name, email, role, tenant_id FROM users WHERE id = $1 FOR UPDATE',
        [userId]
      );
      const user = users[0];
      if (!user) throw new ProvisioningError('User not found', { status: 404 });

      if (user.tenant_id) {
        const { rows } = await runner.query('SELECT id, name FROM tenants WHERE id = $1', [user.tenant_id]);
        if (ownsTransaction) await runner.query('COMMIT');
        return { tenant: rows[0] || { id: user.tenant_id, name: null }, created: false, role: user.role };
      }

      const wanted = baseName(user);
      let tenant = null;
      // Bounded, because an unbounded retry on a unique violation is an infinite
      // loop the day something else is wrong with the constraint.
      for (let attempt = 0; attempt < 12 && !tenant; attempt += 1) {
        const name = attempt === 0 ? wanted : `${wanted.slice(0, 140)} ${attempt + 1}`;
        // The savepoint is taken BEFORE the insert that might fail. In Postgres a
        // failed statement poisons the whole transaction, so without a savepoint
        // to roll back to, the first name collision makes every later query in
        // this function fail with "current transaction is aborted" — including
        // the UPDATE that attaches the user to the tenant.
        await runner.query('SAVEPOINT before_tenant_insert');
        try {
          const { rows } = await runner.query(
            'INSERT INTO tenants (name) VALUES ($1) RETURNING id, name',
            [name]
          );
          tenant = rows[0];
          await runner.query('RELEASE SAVEPOINT before_tenant_insert');
        } catch (err) {
          await runner.query('ROLLBACK TO SAVEPOINT before_tenant_insert');
          // Only a name collision is worth another attempt. Two people called
          // Priya is not an error condition; anything else is.
          if (err.code !== '23505') throw err;
        }
      }
      if (!tenant) {
        throw new ProvisioningError('Could not name a workspace', { status: 500, code: 'WORKSPACE_NAME_EXHAUSTED' });
      }

      // They own the workspace they just created, so they administer it. This is
      // not the same as letting a registration nominate `tenant_admin` — which
      // `register` still refuses — because the role is decided server-side and
      // attaches to a brand-new empty tenant containing nothing but them.
      await runner.query(
        `UPDATE users SET tenant_id = $1, role = CASE WHEN role IN ('admin','developer') THEN role ELSE 'tenant_admin' END,
                          updated_at = NOW()
          WHERE id = $2`,
        [tenant.id, userId]
      );

      const { rows: after } = await runner.query('SELECT role FROM users WHERE id = $1', [userId]);
      if (ownsTransaction) await runner.query('COMMIT');
      return { tenant, created: true, role: after[0].role };
    } catch (err) {
      if (ownsTransaction) await runner.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      if (ownsTransaction) runner.release();
    }
  },

  /**
   * The bootstrap the Studio frontend calls once it has a session.
   *
   * Returns `token_stale` when a workspace was just created, because the access
   * token in the caller's hand was minted BEFORE the tenant existed and still
   * says `tenant_id: null`. Every Studio route reads the tenant from that claim,
   * so without a refresh the very next request is scoped to nothing and the user
   * watches an empty app. Saying so explicitly beats having the client guess.
   */
  async bootstrap(user) {
    const { tenant, created, role } = await this.ensureWorkspace(user.id);
    return {
      user: { id: user.id, email: user.email, name: user.name, role },
      workspace: tenant,
      token_stale: created || user.tenant_id !== tenant.id || user.role !== role,
    };
  },
};

module.exports = Provisioning;
