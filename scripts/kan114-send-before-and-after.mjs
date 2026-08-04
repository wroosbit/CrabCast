#!/usr/bin/env node
// KAN-114 — the same lost Enter, put to two builds.
//
// NOT A GATE, AND DELIBERATELY NOT NAMED `verify-`. It asserts nothing and
// exits 0 whatever it finds; it is the RECIPE FOR REPRODUCING THE RED, kept in
// the tree because a reviewer has to be able to see the pre-fix behaviour and
// not merely read a claim about it. The gates are
// `verify-send-confirms-delivery.mjs` and its live sibling.
//
// It needs the pre-fix build, which is not in this branch, so it takes both
// dist directories:
//
//   git worktree add /tmp/kan114-base --detach origin/main
//   (cd /tmp/kan114-base && npm ci && npm run build)
//   npm run build
//   node scripts/kan114-send-before-and-after.mjs /tmp/kan114-base/dist ./dist
//
// The shim's pane swallows EVERY Enter — herdr answers success to the
// keystroke and the text stays in the composer, which is the witnessed
// failure. `origin/main` reports `{success: true}` about it. This branch
// reports `not-delivered` and says the message is in the composer.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

// Resolved, because a dynamic import of a bare relative path is read as a
// package name rather than a directory.
const [oldDist, newDist] = process.argv.slice(2).map((d) => path.resolve(d));
if (!oldDist || !newDist) {
  console.error('usage: node scripts/kan114-send-before-and-after.mjs <old-dist> <new-dist>');
  process.exit(2);
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kan114-ba-'));
const state = path.join(root, 'state');
const bin = path.join(root, 'bin');
fs.mkdirSync(state, { recursive: true });
fs.mkdirSync(bin, { recursive: true });
process.env.KAN114_BA_STATE = state;

// A pane where EVERY Enter is swallowed: the witnessed failure. herdr answers
// success to the keystroke, and the text stays in the composer.
fs.writeFileSync(path.join(bin, 'shim.mjs'), `
import fs from 'fs'; import path from 'path';
const state = process.env.KAN114_BA_STATE;
const args = process.argv.slice(2);
const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };
const pf = path.join(state, 'pane.json');
const read = () => fs.existsSync(pf) ? JSON.parse(fs.readFileSync(pf,'utf8')) : { t: 'bypass permissions on', c: '' };
const write = (p) => fs.writeFileSync(pf, JSON.stringify(p));
const [a,b] = args;
if (a==='agent'&&b==='get') out({ result: { agent: { name: args[2], pane_id: 'p1' } } });
if (a==='agent'&&b==='list') out({ result: { agents: [{ name: process.env.KAN114_NAME, pane_id: 'p1', agent: 'claude', cwd: process.env.KAN114_DIR, agent_status: 'working' }] } });
if (a==='agent'&&b==='read') { const p = read(); out({ result: { read: { text: p.t + '\\n❯ ' + p.c, truncated: false } } }); }
if (a==='pane'&&b==='send-text') { const p = read(); p.c = args[3]||''; write(p); out({ result: {} }); }
if (a==='pane'&&b==='send-keys') { const p = read(); if (args[3]==='C-c') p.c=''; write(p); out({ result: {} }); }
out({ result: {} });
`);
fs.writeFileSync(path.join(bin, 'herdr'),
  `#!/bin/bash\nexec "${process.execPath}" "${path.join(bin, 'shim.mjs')}" "$@"\n`);
fs.chmodSync(path.join(bin, 'herdr'), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;

const dir = fs.mkdtempSync(path.join(root, 'agent-'));
const dataDir = path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const MESSAGE = 'this message must never reach you';

async function run(label, dist, identityDist) {
  const { paneNameFor } = await import(path.join(identityDist, 'identity.js'));
  process.env.KAN114_NAME = paneNameFor(dir);
  process.env.KAN114_DIR = dir;
  fs.writeFileSync(path.join(state, 'pane.json'), JSON.stringify({ t: 'bypass permissions on', c: '' }));
  const { HerdrBridge } = await import(path.join(dist, 'herdr.js'));
  const bridge = new HerdrBridge(dataDir, path.join(root, 'c.json'));
  const r = await bridge.sendToAgent(dir, MESSAGE, { confirmTimeoutMs: 1500, pollMs: 150 });
  const pane = JSON.parse(fs.readFileSync(path.join(state, 'pane.json'), 'utf8'));
  console.log(`\n=== ${label} ===`);
  console.log(`sendToAgent(...) returned:`);
  console.log(JSON.stringify(r, null, 2).replace(/^/gm, '  '));
  console.log(`the pane afterwards — the message is in the COMPOSER, never submitted:`);
  console.log(`  transcript: ${JSON.stringify(pane.t)}`);
  console.log(`  composer:   ${JSON.stringify(pane.c)}`);
}

await run(`BEFORE (origin/main)`, oldDist, newDist);
await run(`AFTER  (butchr/KAN-114)`, newDist, newDist);
fs.rmSync(root, { recursive: true, force: true });
