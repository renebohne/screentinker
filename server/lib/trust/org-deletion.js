'use strict';

/*
 * "Delete everything": an organization owner deletes the organization and all of its data, after a
 * grace period. docs/trust.md describes it for people.
 *
 *   schedule()  an org OWNER (not an admin) confirms by typing the organization's exact name. A row in
 *               org_deletion_requests records when; nothing is deleted yet. Every owner and admin is
 *               emailed (when the server can send mail), so a compromised or mistaken owner account
 *               cannot delete quietly.
 *   cancel()    any owner, until the grace period ends.
 *   sweep()     hourly: a request whose grace period has passed is carried out through the SAME
 *               cascade a platform admin's delete uses (lib/user-deletion.js deleteOrgCascade):
 *               every workspace, every tenant row, the integrations' credentials (Canva tokens
 *               revoked at Canva), and the media files once the rows are committed gone. Member
 *               USER accounts are not deleted — a person may belong to other organizations; they
 *               lose this membership. The audit row of the deletion itself survives (it names the
 *               organization in its details, with organization_id cleared like every other row).
 *
 * ⚠️ A PAID SUBSCRIPTION BLOCKS SCHEDULING on a hosted instance: deleting the organization would leave
 * Stripe billing a customer whose account no longer exists. The owner cancels the plan first.
 */

const DAY = 86400;
const GRACE_DAYS = require('./report').DELETION_GRACE_DAYS;
const now = () => Math.floor(Date.now() / 1000);

class DeletionError extends Error {
  constructor(message, status = 400, code = 'deletion') { super(message); this.status = status; this.code = code; }
}

function dbOf() { return require('../../db/database').db; }

function pending(db, orgId) {
  try { return db.prepare('SELECT * FROM org_deletion_requests WHERE organization_id = ?').get(orgId) || null; } catch (_) { return null; }
}

/** Throws DeletionError when the org may not be scheduled for deletion. */
function schedule({ db = dbOf(), orgId, userId, confirmName, graceDays = GRACE_DAYS }) {
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(orgId);
  if (!org) throw new DeletionError('Organization not found', 404, 'not_found');
  if (typeof confirmName !== 'string' || confirmName !== org.name) {
    throw new DeletionError('Type the organization\'s name exactly to confirm.', 400, 'confirm_mismatch');
  }
  if (pending(db, orgId)) throw new DeletionError('This organization is already scheduled for deletion.', 409, 'already_scheduled');
  if (org.stripe_subscription_id && ['active', 'trialing', 'past_due'].includes(String(org.subscription_status || ''))) {
    throw new DeletionError('Cancel the organization\'s subscription before deleting it.', 409, 'subscription_active');
  }
  const executeAfter = now() + Math.max(0, graceDays) * DAY;
  db.prepare('INSERT INTO org_deletion_requests (organization_id, org_name, requested_by, requested_at, execute_after) VALUES (?, ?, ?, ?, ?)')
    .run(orgId, org.name, userId, now(), executeAfter);
  notify(db, org, executeAfter).catch(() => { /* mail is a courtesy, never a gate */ });
  return { execute_after: executeAfter };
}

function cancel({ db = dbOf(), orgId }) {
  const r = db.prepare('DELETE FROM org_deletion_requests WHERE organization_id = ?').run(orgId);
  if (!r.changes) throw new DeletionError('This organization is not scheduled for deletion.', 404, 'not_scheduled');
  return true;
}

async function notify(db, org, executeAfter) {
  const email = require('../../services/email');
  const admins = db.prepare(`SELECT u.email FROM organization_members om JOIN users u ON u.id = om.user_id
                              WHERE om.organization_id = ? AND om.role IN ('org_owner','org_admin')`).all(org.id);
  const when = new Date(executeAfter * 1000).toUTCString();
  for (const a of admins) {
    if (!a.email) continue;
    await email.sendEmail({
      to: a.email,
      subject: `Organization "${org.name}" is scheduled for deletion`,
      text: `An owner of "${org.name}" asked for the organization and all of its data to be deleted.\n\n`
        + `It will be deleted permanently after ${when}.\n\n`
        + 'If this is a mistake, an owner can cancel it before then in Settings -> Data & privacy.',
    });
  }
}

/** Carry out every request whose grace period has passed. Returns the org ids deleted. */
function sweep({ db = dbOf(), unlink } = {}) {
  let due = [];
  try { due = db.prepare('SELECT * FROM org_deletion_requests WHERE execute_after <= ?').all(now()); } catch (_) { return []; }
  const done = [];
  const { deleteOrgCascade } = require('../user-deletion');
  const { audit } = require('../audit');
  for (const r of due) {
    try {
      const exists = db.prepare('SELECT 1 FROM organizations WHERE id = ?').get(r.organization_id);
      if (exists) {
        // Exports are files on disk the cascade does not know about: remove them with the org.
        try {
          const ex = require('./export');
          for (const j of db.prepare("SELECT * FROM data_exports WHERE organization_id = ? AND kind = 'org'").all(r.organization_id)) {
            const p = j.file_name ? ex.filePath(j) : null;
            if (p) require('fs').rmSync(p, { force: true });
          }
          db.prepare("DELETE FROM data_exports WHERE organization_id = ? AND kind = 'org'").run(r.organization_id);
          db.prepare('DELETE FROM outbound_ledger WHERE organization_id = ?').run(r.organization_id);
        } catch (_) { /* best effort */ }
        deleteOrgCascade(db, { orgId: r.organization_id, unlink });
      }
      db.prepare('DELETE FROM org_deletion_requests WHERE organization_id = ?').run(r.organization_id);
      audit('trust.org_deleted', { userId: null, details: { organization_id: r.organization_id, name: r.org_name, requested_by: r.requested_by, requested_at: r.requested_at } });
      done.push(r.organization_id);
    } catch (e) {
      console.warn(`[trust] scheduled deletion of ${r.organization_id} failed: ${e && e.message}`);
    }
  }
  return done;
}

let timer = null;
function start(db = dbOf()) {
  if (timer) return;
  timer = setInterval(() => sweep({ db }), 3600 * 1000);
  timer.unref?.();
}

module.exports = { schedule, cancel, sweep, start, pending, DeletionError, GRACE_DAYS };
