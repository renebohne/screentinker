'use strict';

/*
 * Load server modules AS THEY WERE at an older commit, next to the current ones, sharing one
 * database connection and every unchanged dependency — so a test can drive "before" and "after"
 * over the same rows and demand identical output. Same technique as
 * test/device-simulate-equivalence.test.js, factored out for the layout/campaign proofs.
 *
 * Each relative require inside a baseline copy is pointed at the baseline copy when it names one of
 * `changed`, else at the real module. Returns null (with `why`) when git or the commit is not
 * available (a tarball install): callers skip loudly rather than pass vacuously.
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const SERVER = path.join(__dirname, '..', '..');

function loadBaseline(commit, changed) {
  let root;
  try { root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: SERVER, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch (_) { return { mods: null, why: 'not a git checkout' }; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-baseline-'));
  for (const rel of changed) {
    let src;
    try { src = execFileSync('git', ['show', `${commit}:server/${rel}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }); }
    catch (_) { return { mods: null, why: `baseline commit ${commit.slice(0, 8)} not in this repository` }; }
    const dir = path.dirname(path.join(SERVER, rel));
    src = src.replace(/require\((['"])([^'"]+)\1\)/g, (m, q, spec) => {
      if (!spec.startsWith('.')) return `require(${JSON.stringify(require.resolve(spec, { paths: [dir] }))})`;
      let abs;
      try { abs = require.resolve(path.resolve(dir, spec)); } catch (_) { return m; }
      const relTarget = path.relative(SERVER, abs).split(path.sep).join('/');
      const target = changed.includes(relTarget) ? path.join(tmp, relTarget) : abs;
      return `require(${JSON.stringify(target)})`;
    });
    fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
    fs.writeFileSync(path.join(tmp, rel), src);
  }
  const mods = {};
  for (const rel of changed) mods[rel] = require(path.join(tmp, rel));
  return { mods, why: null };
}

module.exports = { loadBaseline };
