/**
 * A workspace type, declared in `crabcast.config.json`.
 *
 * In the extraction source (Butchr) a workspace type was TypeScript in a
 * registry, keyed to Jira URL patterns. Here a type is pure data: adding one
 * is editing config, not code. URL resolution stayed behind — CrabCast never
 * resolves pages; a URL is optional caller-supplied metadata for prompt
 * interpolation and nothing else.
 */
export interface WorkspaceTypeConfig {
  /**
   * The type identifier, e.g. `shell`. Appears in agent names
   * (`<prefix>-<type>-<key>`), which are split at the first dash after the
   * prefix — so a name containing a dash is a config error, refused at load.
   */
  name: string;
  /**
   * What this type outranks when the machine is full.
   *
   * Required rather than optional so a new workspace type cannot be declared
   * without someone deciding where it sits — a type that defaulted silently to
   * the floor would be preemptable by everything and nobody would find out
   * until its work was destroyed.
   */
  priority: number;
  /** Prompt template path, resolved relative to the config file's directory. */
  promptFile: string;
  /** Launcher used when an activation does not name one. */
  defaultLauncher: string;
  /** MCP servers offered to agents of this type. Defaults to `[]`. */
  mcpServers: string[];
  /**
   * When true, activations of this type are never refused by the capacity
   * gate; their cost is carried by the model's reservation instead. The
   * invariant: the gate never argues with the model's own arithmetic — a type
   * whose cost is reserved is not also refused for it. Defaults to false.
   */
  gateExempt: boolean;
}

/** Every daemon reply carries `success`; failures carry `error`; both echo `id`. */
export interface DaemonResponse {
  success: boolean;
  error?: string;
  id?: number | string;
  [key: string]: unknown;
}
