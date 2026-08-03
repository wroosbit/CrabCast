/**
 * CrabCast — standalone agent orchestration for terminal AI agents.
 *
 * The daemon itself is `daemon.js` (side-effecting main; start it with
 * `node dist/daemon.js [configPath]`). This module is the library surface:
 * the config loader, registry, prompt loader, and socket client helpers.
 */

export * from './types.js';
export * from './config.js';
export * from './registry.js';
export * from './prompt.js';
export * from './env.js';
export * from './ipc.js';
export * from './router.js';
