'use strict';

/*
 * Experiments: the background work (docs/experiments.md).
 *
 *   - a test whose end date has passed is ended: the control goes back on screen, results stay
 *   - running tests copy their exposure out of play_logs before raw plays are pruned
 *   - running tests measured on sales import new orders once an hour
 *
 * One test at a time, in sequence: an import can wait on a provider's rate limit, and two of them
 * at once would only wait twice as long. Never throws: a broken test must not stop the others.
 */

const { db } = require('../../db/database');
const core = require('./core');

const SWEEP_MS = 10 * 60 * 1000;
const SALES_EVERY_SEC = 60 * 60;

async function sweep(io, now = core.nowSec()) {
  const rows = db.prepare("SELECT id, workspace_id FROM experiments WHERE status = 'running'").all();
  let ended = 0, imported = 0;
  for (const r of rows) {
    const exp = core.load(r.id, r.workspace_id);
    if (!exp) continue;
    try {
      if (exp.planned_end_at && exp.planned_end_at <= now) {
        require('./resolve').finish(exp, io, { reason: 'ended', now, system: true });
        require('../audit').audit('experiment.ended', { workspaceId: exp.workspace_id, details: { experiment_id: exp.id, name: exp.name, by: 'schedule' } });
        ended++;
        continue;
      }
      require('./data').refreshExposure(exp, now);
      const usesSales = [exp.config.outcome, ...(exp.config.secondary || [])].some((o) => o && o.source === 'sales');
      if (usesSales && (!exp.sales_synced_at || now - exp.sales_synced_at >= SALES_EVERY_SEC)) {
        const res = await require('./data').importSales(exp, { now });
        if (res.ok) imported++;
      }
    } catch (e) {
      console.warn(`[experiments] sweep failed for ${exp.id}: ${e && e.message}`);
    }
  }
  return { running: rows.length, ended, imported };
}

let timer = null;
function start(io) {
  if (timer) return;
  const run = () => sweep(io).catch((e) => console.warn(`[experiments] sweep failed: ${e && e.message}`));
  setTimeout(run, 60 * 1000).unref?.();
  timer = setInterval(run, SWEEP_MS);
  if (timer.unref) timer.unref();
}

module.exports = { sweep, start, SWEEP_MS };
