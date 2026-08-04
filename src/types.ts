/**
 * What a caller froze onto one agent's record with `configure`.
 *
 * THIS IS NOT A PRESET, and the test that settles it is: can two agents share
 * one of these? No — by construction, because the canonical path is the
 * identity and the record is keyed by it. A preset is a named template applied
 * to many agents, addressed by name, reused and versioned. This is one row per
 * agent, addressed by path, never reused, never looked up by name.
 *
 * Every field is caller-supplied. CrabCast derives none of them and defaults
 * none of the three that decide what happens when the machine is full — the
 * config loader used to refuse a workspace type with no `priority` rather than
 * silently flooring it, and that decision travels to this shape unchanged.
 */
/**
 * What one MCP server is, as `configure` receives it.
 *
 * TWO FORMS, AND THE UNION IS THE POINT:
 *
 *  - an **object** — the caller's own definition, written into `.mcp.json`
 *    VERBATIM. CrabCast does not read it, validate its interior, resolve
 *    anything in it, or reorder it. Whatever JSON arrives under this key is the
 *    JSON that appears in the file.
 *  - the string `'builtin'` — a server CrabCast constructs itself. Exactly one
 *    name qualifies (`crabcast`), and it qualifies because its definition
 *    depends on facts only this daemon has: its own `node`, its own `mcp.js`,
 *    and the config path that decides WHICH daemon a workspace-spawned server
 *    addresses. A caller could not write it correctly, so it is the one entry
 *    CrabCast legitimately owns.
 *
 * WHY DEFINITIONS RATHER THAN NAMES, which is the third time this call has come
 * up in this project and the third time the answer is the same. A consumer
 * assembles their server set at activation time from whichever integrations are
 * enabled *and hold a valid credential* — runtime state that lives on their side
 * of the boundary and never crosses it. So a name is not a thing they can send:
 * there is nothing here for it to name. `"atlassian"` is the consumer's
 * vocabulary in exactly the way a Jira ticket key was, and this daemon gave up
 * the right to hold either. Requiring a name would also require the
 * name-resolution table consumers have already deleted on their own side.
 *
 * WHY A MAP KEYED BY NAME rather than a list of `{name, …}` records. The
 * destination is a map — Claude Code reads `{"mcpServers": {"<name>": {…}}}` —
 * so a map is the shape that lets "written verbatim" be LITERALLY true: the
 * value written under key K is the value the caller supplied under key K, with
 * no step in between that could rename or reorder anything. A list would have
 * to be reshaped into a map here, which is the exact class of work this field
 * promises not to do, and it would introduce a duplicate-name question the map
 * makes unaskable.
 *
 * It also makes one whole class of mistake unrepresentable: a caller cannot
 * both supply their own definition for a name AND ask for CrabCast's builtin
 * under it, because one key holds one value.
 */
export type McpServerSpec = 'builtin' | Record<string, unknown>;

export interface AgentConfig {
  /**
   * What this agent outranks when the machine is full. Required: a
   * silently-defaulted priority would sit at the floor, be preemptable by
   * everything, and nobody would find out until its work was destroyed.
   */
  priority: number;
  /**
   * Whether the capacity gate may refuse this agent's activation. `false`
   * means never refused — its cost is carried by whoever set the flag.
   */
  refusable: boolean;
  /**
   * Whether this agent occupies a charged slot in the capacity count. `false`
   * means it is reported as exempt and never charged.
   */
  chargeable: boolean;
  /**
   * Whether this agent may be selected as a preemption victim. `false` means
   * nothing may stand it down to make room.
   */
  preemptable: boolean;
  /** Which launcher runs in the pane — `claude`, `shell`, … . */
  launcher: string;
  /**
   * The agent's bootstrap prompt: FINISHED TEXT, not a path and not a
   * template. CrabCast writes these bytes into the agent's sidecar verbatim
   * and never inspects them.
   *
   * IT USED TO BE A TEMPLATE, AND THE INTERPOLATOR IS DELETED. `PromptLoader`
   * substituted doubled-brace KEY and URL placeholders into a workspace type's
   * `promptFile`, and once `key` is gone that substitution has no source. The
   * available fixes were to keep rendering with caller-supplied variables, or
   * to stop rendering. Rendering was the wrong one twice over:
   *
   *  - It makes the placeholder syntax and the variable set into API. A
   *    consumer whose supervision depends on a KEY placeholder reaching the
   *    agent breaks SILENTLY when either changes — the agent starts, reads the
   *    placeholder as literal text, and works on nothing.
   *  - That KEY was a Jira ticket key. The whole point of deleting `type`,
   *    `key` and the parseable agent name was that CrabCast stop carrying its
   *    consumer's vocabulary; an interpolator whose variables are named after
   *    another system's concepts is that same artifact wearing a hat.
   *
   * (The placeholders are described rather than written out above so that a
   * grep for a doubled brace across `src/` returns nothing. A check somebody
   * has to eyeball to see that the hits are only comments is a check that has
   * stopped working.)
   *
   * So the caller renders, and hands over the result. It costs an adopting
   * caller nothing — they already have a template engine, and now they may use
   * any one they like, with conditionals and loops CrabCast would never have
   * grown — and it means the bytes the agent reads are exactly the bytes the
   * caller wrote.
   *
   * Optional: an agent configured without one starts at its runtime's own
   * prompt rather than being handed an instruction nobody wrote.
   */
  prompt?: string;
  /**
   * MCP servers offered to this agent, keyed by name. See {@link McpServerSpec}.
   *
   * SUPPLYING THIS IS THE CONSENT TO WRITE `.mcp.json` INTO THE CALLER'S
   * DIRECTORY. There is no second flag, and the absence of one is a decision
   * with a reason.
   *
   * An earlier revision of the design required `provision: { mcpConfig: true }`
   * beside this field, on the grounds that asking for a CAPABILITY ("the
   * atlassian server") is a different act from agreeing to a FILE appearing in
   * your repository. That reasoning was right about names — and definitions
   * dissolve it. A caller supplying definitions is handing over the literal
   * bytes of the `mcpServers` block; there is no gap left between "here are the
   * exact contents" and "please write them". A separate flag would then be a
   * box to tick beside the thing it consents to, which is not a second decision,
   * only a second chance to forget one.
   *
   * And forgetting it would not have been loud where it mattered. A consumer
   * whose agents reach their issue tracker *through* MCP, cutting over a whole
   * fleet at once, would have needed the flag on every activation to get any
   * tools at all. One field cannot be half-supplied, so that failure has no
   * path here.
   *
   * What the flag was buying — a caller LEARNING that CrabCast writes into their
   * directory — is bought better by the `configure` response, which names the
   * file and the keys it will write at activation, before anything is written.
   * Being told the consequence beats being asked to assert it.
   *
   * Absent or empty means nothing is written into the caller's directory at all.
   */
  mcpServers?: Record<string, McpServerSpec>;
  /**
   * Opaque display text. Never parsed, never looked up by, duplicates fine.
   * The enforcement that matters is structural rather than stated: `label` is
   * not a parameter of any read or address in this API, so there is no surface
   * through which a lookup by label could be written.
   */
  label?: string;
}

/** Every daemon reply carries `success`; failures carry `error`; both echo `id`. */
export interface DaemonResponse {
  success: boolean;
  error?: string;
  id?: number | string;
  [key: string]: unknown;
}
