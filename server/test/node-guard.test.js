'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { guardNode, belowFloor, EXIT_CONFIG } = require('../lib/node-guard');

function pkgWith(range) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-guard-'));
  const p = path.join(dir, 'package.json');
  fs.writeFileSync(p, JSON.stringify(range === undefined ? {} : { engines: { node: range } }));
  return p;
}

function run(opts) {
  const logs = [];
  let code = null;
  const r = guardNode({ log: (l) => logs.push(l), exit: (c) => { code = c; }, env: {}, ...opts });
  return { r, logs, code };
}

test('belowFloor compares major.minor.patch and ignores ranges it does not parse', () => {
  assert.equal(belowFloor('>=22.14.0', '20.20.1'), '22.14.0');
  assert.equal(belowFloor('>=22.14.0', '22.13.9'), '22.14.0');
  assert.equal(belowFloor('>=22.14.0', '22.14.0'), null);
  assert.equal(belowFloor('>=22.14.0', 'v24.1.0'), null);
  assert.equal(belowFloor('>=24.0.0', '22.23.2'), '24.0.0', 'the BrightSign bundle floor is honoured too');
  assert.equal(belowFloor('20.x || >=22', '18.0.0'), null);
  assert.equal(belowFloor(undefined, '18.0.0'), null);
});

test('below the floor: one clear message and exit 78', () => {
  const { r, logs, code } = run({ pkgPath: pkgWith('>=22.14.0'), version: '20.20.1' });
  assert.equal(r, '22.14.0');
  assert.equal(code, EXIT_CONFIG);
  assert.equal(EXIT_CONFIG, 78);
  assert.match(logs.join('\n'), /needs Node\.js 22\.14\.0 or newer; this is Node 20\.20\.1/);
  assert.match(logs.join('\n'), /Upgrading Node\.js/);
});

test('ST_ALLOW_OLD_NODE=1 downgrades the refusal to a warning', () => {
  const { r, logs, code } = run({ pkgPath: pkgWith('>=22.14.0'), version: '20.20.1', env: { ST_ALLOW_OLD_NODE: '1' } });
  assert.equal(r, '22.14.0');
  assert.equal(code, null);
  assert.match(logs.join('\n'), /starting anyway/);
});

test('at or above the floor, or with no floor/package.json, it says nothing', () => {
  for (const [pkgPath, version] of [
    [pkgWith('>=22.14.0'), '22.14.0'],
    [pkgWith('>=22.14.0'), '24.19.0'],
    [pkgWith(undefined), '18.0.0'],
    [path.join(os.tmpdir(), 'definitely-missing', 'package.json'), '18.0.0'],
  ]) {
    const { r, logs, code } = run({ pkgPath, version });
    assert.equal(r, null);
    assert.equal(code, null);
    assert.deepEqual(logs, []);
  }
});

test('the shipped package.json floor is Node 22.14+', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.engines.node, '>=22.14.0');
  assert.equal(belowFloor(pkg.engines.node, process.versions.node), null, 'the test runner itself meets the floor');
});
