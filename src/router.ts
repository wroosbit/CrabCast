import { CrabcastConfig } from './config.js';
import { WorkspaceRegistry } from './registry.js';
import { DaemonResponse } from './types.js';

// Deliberately minimal: one real action so the socket is provable end-to-end.
// The herdr bridge (T2) replaces/extends this file with activation paths.

export interface RouterDeps {
  registry: WorkspaceRegistry;
  config: CrabcastConfig;
  daemonStartedAt: Date;
  send: (msg: DaemonResponse) => void;
}

export class MessageRouter {
  constructor(private deps: RouterDeps) {}

  public handle(msg: any): void {
    const id = msg?.id !== undefined ? { id: msg.id } : {};
    const action = msg?.action;

    switch (action) {
      case 'daemon_status': {
        const { registry, config, daemonStartedAt } = this.deps;
        this.deps.send({
          success: true,
          ...id,
          pid: process.pid,
          startedAt: daemonStartedAt.toISOString(),
          configPath: config.configPath,
          dataDir: config.dataDir,
          workspaceTypes: registry.all()
        });
        return;
      }
      default:
        this.deps.send({
          success: false,
          error: `Unknown action: ${typeof action === 'string' ? action : JSON.stringify(action)}`,
          ...id
        });
    }
  }
}
