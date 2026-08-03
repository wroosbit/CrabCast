import { WorkspaceTypeConfig } from './types.js';

/**
 * The workspace-type registry, populated from the config file.
 *
 * In the extraction source this class also owned URL-pattern matching and a
 * Jira issue-type lookup; both stayed behind. What travels is the part every
 * consumer needs: which types exist, and what each one is worth when the
 * machine is full.
 */
export class WorkspaceRegistry {
  private types: Map<string, WorkspaceTypeConfig> = new Map();

  constructor(types: WorkspaceTypeConfig[] = []) {
    for (const type of types) this.register(type);
  }

  public register(config: WorkspaceTypeConfig): void {
    this.types.set(config.name, config);
  }

  public get(name: string): WorkspaceTypeConfig | undefined {
    return this.types.get(name);
  }

  /** Every declared type, in declaration order. */
  public all(): WorkspaceTypeConfig[] {
    return [...this.types.values()];
  }

  /**
   * What a workspace type outranks. Unregistered types get the floor —
   * deliberately: a type this daemon has never heard of can be preempted by
   * anything and can preempt nothing, so whatever went wrong with resolution
   * lands somewhere that cannot kill another agent's work. With priorities
   * declared in config rather than fixed constants, the floor is the lowest
   * declared priority (preemption is strictly-greater, so the floor ties with
   * the lowest type and cannot displace it). This is the only place that
   * fallback is applied, so a caller cannot accidentally pick a different one.
   */
  public priorityFor(type: string | null | undefined): number {
    if (typeof type === 'string') {
      const config = this.types.get(type);
      if (config) return config.priority;
    }
    let floor = 0;
    let first = true;
    for (const config of this.types.values()) {
      if (first || config.priority < floor) floor = config.priority;
      first = false;
    }
    return floor;
  }
}
