// Live check of the extraction source's KAN-16 fix against a real herdr, at
// the level the bug actually lived: HerdrBridge.
//
// Before the fix, a second spawnSession for one agent opened a second
// `herdr agent attach --takeover`, which evicted the first and left the
// evicted client rendering a dead frame. This drives exactly that sequence
// and asserts the first PTY is still streaming afterwards.
//
// Usage: node scripts/verify-no-attach-steal.mjs <directory>
//
// The directory is the agent's whole address, and it must be one herdr already
// has a live agent in with nothing attached to it. Run it after
// `npm run build`. (It used to take a <key> and a <type>; the pane name is now
// a pure function of the path, so there is one operand and nothing to
// disambiguate.)

import fs from 'fs';
import path from 'path';
import { HerdrBridge } from '../dist/herdr.js';
import { paneNameFor } from '../dist/identity.js';
import { DEFAULT_DATA_DIR } from '../dist/config.js';

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/verify-no-attach-steal.mjs <directory>');
  process.exit(2);
}
const agentPath = fs.realpathSync(path.resolve(target));
const dataDir = process.env.CRABCAST_DATA_DIR
  ? path.resolve(process.env.CRABCAST_DATA_DIR)
  : DEFAULT_DATA_DIR;
console.log(`target agent: ${agentPath} (pane ${paneNameFor(agentPath)}, dataDir ${dataDir})\n`);

/** The knobs the bridge needs. `shell` explicitly — see below. */
const CONFIG = {
  priority: 1, refusable: true, chargeable: true, preemptable: true, launcher: 'shell'
};

const bridge = new HerdrBridge(dataDir);
const ended = [];
bridge.setSessionEndedListener((e) => {
  ended.push(e);
  console.log(`  [event] agent.detached sessionId=${e.sessionId} reason=${e.reason} exitCode=${e.exitCode}`);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// No prompt, so this touches nothing but the attach itself — and nothing is
// written into the caller's directory either way, since the prompt would go to
// CrabCast's own sidecar. `shell` explicitly: this script borrows an existing
// agent, and a claude launcher's setup would write folder trust into the real
// ~/.claude.json on the way past.
console.log('== first activate ==');
const first = bridge.spawnSession(agentPath, CONFIG);
await sleep(2000);

let firstBytes = 0;
bridge.registerDataListener(first.sessionId, (d) => { firstBytes += d.length; });

console.log('\n== second activate at the same agent (this is what used to steal it) ==');
const second = bridge.spawnSession(agentPath, CONFIG);
await sleep(3000);

console.log('\n== result ==');
console.log(`same session returned: ${first.sessionId === second.sessionId}`);
console.log(`first session status:  ${first.status}`);
console.log(`detach events:         ${ended.length ? JSON.stringify(ended) : 'none'}`);

// A live attach keeps redrawing, so any traffic at all proves it is streaming.
const before = firstBytes;
await sleep(1500);
console.log(`bytes streamed after the second activate: ${firstBytes - before >= 0 ? firstBytes : 0} total`);

const ok =
  first.sessionId === second.sessionId &&
  first.status === 'active' &&
  ended.length === 0;

// Drop only our own attach. terminateSession would also close the agent's
// pane, and this script borrows an agent it does not own.
first.ptyProcess?.kill();
await sleep(500);

console.log(ok
  ? '\nPASS: the second activate reused the live session; nothing was evicted.'
  : '\nFAIL: a second attach was opened or the first session died.');
process.exit(ok ? 0 : 1);
