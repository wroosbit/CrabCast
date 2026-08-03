#!/usr/bin/env node
// Round-trips `daemon_status` over the daemon socket and prints the reply.
//
// Usage: node scripts/daemon-status.mjs [configPath]
//
// Loads the same config the daemon would (argv path, else CRABCAST_CONFIG,
// else ./crabcast.config.json) to find the data dir, connects — spawning the
// daemon if none is running — and prints the JSON response. Build first:
// `npm run build`.

import { loadConfig, resolveConfigPath } from '../dist/config.js';
import { connectToDaemon, onJsonLines, writeJsonLine } from '../dist/ipc.js';

const configPath = resolveConfigPath();
const config = loadConfig(configPath);

const socket = await connectToDaemon(config.dataDir, { configPath });
socket.on('error', (err) => {
  console.error(`socket error: ${err.message}`);
  process.exit(1);
});

const timeout = setTimeout(() => {
  console.error('timed out waiting for daemon_status reply');
  process.exit(1);
}, 5000);

onJsonLines(socket, (msg) => {
  if (msg.id !== 1) return;
  clearTimeout(timeout);
  console.log(JSON.stringify(msg, null, 2));
  socket.end();
  process.exit(msg.success ? 0 : 1);
});

writeJsonLine(socket, { action: 'daemon_status', id: 1 });
