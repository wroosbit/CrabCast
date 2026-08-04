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
  /** MCP servers offered to this agent. Defaults to `[]`. */
  mcpServers?: string[];
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
