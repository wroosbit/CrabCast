/**
 * CrabCast — standalone agent orchestration for terminal AI agents.
 *
 * The daemon itself is `daemon.js` (side-effecting main; start it with
 * `node dist/daemon.js [configPath]`). This module is the library surface:
 * the config loader, the path-identity rules, and socket client helpers.
 *
 * There is no prompt loader any more: `configure` takes the agent's bootstrap
 * prompt as finished text and CrabCast never inspects it, so there is nothing
 * here for an embedder to render with.
 */

export * from './types.js';
export * from './config.js';
export * from './delivery.js';
export * from './identity.js';
export * from './env.js';
export * from './ipc.js';
export * from './router.js';
