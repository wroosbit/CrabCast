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
   * EXTRA ARGUMENTS FOR THE LAUNCHER'S OWN COMMAND LINE, in order, each one
   * delivered as exactly one argument.
   *
   * WHY THIS EXISTS AT ALL, because "let the caller put anything in an argv" is
   * a real capability increase and deserves its reason written down rather than
   * assumed. CrabCast is a general-purpose spawner, and a spawner that cannot
   * pass arguments to the thing it spawns is incomplete: every runtime worth
   * launching has switches, and with no route for them the ONLY vocabulary
   * available is whatever CrabCast happens to hard-code. That is the situation
   * this field ends. `--permission-mode bypassPermissions` sits on the claude
   * launcher's command line today, chosen by this daemon, unopt-outable and
   * invisible to the caller — so argv was already a place consumer vocabulary
   * lived, with CrabCast as the only party allowed to write there. This is what
   * lets it live ABOVE the socket instead, in the hands of whoever is actually
   * running the agent.
   *
   * WHAT IT IS NOT: an increase in WHO IS TRUSTED. A caller that can reach
   * `configure` already chooses the launcher, the working directory and the
   * prompt, and CrabCast spawns a process on their behalf — the boundary is
   * already "whoever can configure an agent controls a process". This widens
   * what they can SAY, not who may say it. The premise that makes that
   * acceptable is worth naming because it is the thing that would go wrong:
   * it holds while `configure` is reached by a party that already chose the
   * launcher and cwd, and it stops holding the moment something proxies
   * `configure` on behalf of a less-trusted caller. Nothing does today. The
   * defence if anything ever does is DISCLOSURE — argv is reported in the
   * `config` echo that `list` and `status` carry, and in the capacity refusal,
   * so what a spawn was given is readable rather than inferred.
   *
   * EACH ELEMENT IS ONE ARGUMENT AND CANNOT BECOME TWO. The command is handed
   * to `bash -c`, and every element is shell-quoted on its way onto it, so an
   * element containing spaces, quotes or a newline arrives as the single
   * argument it was sent as. There is no splitting, no globbing and no
   * expansion — which is also why this is an ARRAY rather than a string: a
   * string would have to be split by something, and whatever did the splitting
   * would be a shell-quoting rule CrabCast invented and a caller had to guess.
   *
   * REFUSED ON A LAUNCHER THAT CANNOT TAKE THEM, rather than accepted and
   * dropped. See {@link AgentLauncher.acceptsArgs} in `src/launchers.ts`: a
   * caller shipping args that never arrive and are never mentioned is exactly
   * the silent-nothing failure this daemon refuses everywhere else.
   *
   * RESTART-REQUIRED, and not by policy — argv is fixed at process start, so
   * accepting a change under a running agent would rewrite the record without
   * changing the process. It is refused the way `launcher` and `prompt` are.
   *
   * Optional, and absent means no extra arguments — never "the defaults",
   * because there are none. An empty array means the same thing as absent, and
   * `knobValue` normalizes the two so a reconciler that always sends `args: []`
   * is not told "restart required" forever over a difference with no
   * consequence.
   */
  args?: string[];
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
  /**
   * WHOSE AGENT THIS IS, in the caller's own word for themselves — so an
   * application can find its own agents without parsing their names.
   *
   * **NOT A PERMISSION BOUNDARY, and this is the sentence to read before any
   * other.** Anyone who can reach the daemon's socket can list EVERY agent on
   * this machine whatever its owner: `list_agents` without a filter returns the
   * whole fleet, deliberately, and that is intended behaviour rather than a
   * leak. The only auth boundary CrabCast has is the socket's own filesystem
   * permission — `0600` in a `0700` directory — and nothing else. A field
   * called `owner` reads like access control to almost everybody who meets it;
   * a consumer that relies on filtering to HIDE anything has a claim this
   * mechanism does not support. It is a way to ASK a narrower question, not a
   * way to be told less.
   *
   * **CRABCAST MAY MATCH THIS STRING AND MUST NEVER DERIVE MEANING FROM ONE.**
   * That single distinction is what makes this field safe to have at all, given
   * that KAN-103 and KAN-123 deleted `type`, `key` and the parseable agent name
   * on the rule that no consumer's vocabulary lives inside CrabCast. An
   * equality test against an opaque value is not vocabulary — `owner === 'x'`
   * requires this daemon to know nothing whatever about what `x` is. The moment
   * anything here parses it, splits it, folds its case, infers a namespace from
   * it or attaches behaviour to a particular value, that rule is broken and
   * this field was a mistake. So: EXACT MATCH ONLY. No prefix, no glob, no
   * hierarchy, no case-folding — the first prefix match invites a namespace,
   * and a namespace is vocabulary CrabCast would then owe compatibility on.
   *
   * **ABSENCE IS A REAL STATE AND NEVER A WILDCARD.** Every agent configured
   * before this field shipped has no owner, and an agent with no owner is
   * matched by NO filter — not by a filter for `''`, not by a filter for
   * anything else. It is still reachable, because an unfiltered read returns
   * it. That asymmetry is deliberate and it is the safety-critical half rather
   * than the tidy one: a false MATCH over-includes a row in a listing, while a
   * false NON-MATCH can stop an agent. The caller this exists for is a
   * reconciler whose last step is *"anything running that is not in my desired
   * list → off"*, and such a caller must be able to tell **not mine** from
   * **unknown to me**. Silently matching absence collapses those two into the
   * destructive one.
   *
   * It is metadata rather than runtime, so it is reconfigurable in place like
   * {@link AgentConfig.label} — with the consequence that a filtered list is a
   * SNAPSHOT: an agent can move between owners, or acquire or lose one,
   * between two polls.
   *
   * Optional. `configure` is a desired-state document, so a reconfiguration
   * that omits it removes the owner, exactly as omitting `label` removes the
   * label.
   */
  owner?: string;
}

/**
 * {@link AgentConfig} with the prompt REPLACED BY ITS SIZE — what a FLEET read
 * echoes on every row, in place of the text.
 *
 * WHY THIS TYPE EXISTS RATHER THAN A DELETED FIELD (KAN-528). A prompt is
 * finished text of arbitrary length, it is by far the largest thing on an agent
 * record — measured on this fleet's registry, **97.0% of its bytes** — and the
 * fleet read echoes one per row. Ten supervisor-sized prompts exceed the
 * framing bound `MAX_LINE_CHARS` (src/ipc.ts) on their own, and the connection is
 * destroyed rather than the response truncated: `crabcast list` stopped
 * answering at all.
 *
 * SO THE TEXT COMES OFF THE FLEET READ, AND THE ABSENCE IS NOT SPELLED AS AN
 * ABSENT `prompt`. That spelling was available and it is the wrong one: an
 * omitted `prompt` ALREADY MEANS "this agent has none, it starts at its
 * runtime's own prompt" — the CLI prints exactly that sentence for it — so
 * dropping the field would make an agent carrying a 103 KB prompt
 * indistinguishable from an agent carrying none. That is the silent
 * under-report this ticket forbids, one field wide.
 *
 * `prompt` is therefore made UNREPRESENTABLE here rather than merely unset, and
 * the row's own `promptChars` answers the question in its place. A consumer
 * reading `config.prompt` off a fleet row gets a COMPILE ERROR rather than
 * `undefined`, which is the difference between being told and guessing; a
 * consumer reading `promptChars` is told the exact size, including `0` — and
 * `null`, which is the state an absent `prompt` used to mean and now says so.
 *
 * THE COUNT IS ON THE ROW AND NOT IN HERE, deliberately, and it is the one
 * design note worth keeping: putting it inside `config` would make it a knob
 * `CONFIG_FIELDS` does not declare — reported as `undeclared` drift on every
 * row of every response — and would put a SECOND copy of the number beside the
 * `promptChars` the single read already carries. One number, one place, on the
 * block that every category spreads. See `ConfigEcho.promptChars`.
 *
 * THE TEXT IS NOT LOST AND THIS TYPE IS NOT THE ONLY ECHO. `agent_status`
 * — one agent, asked for by path — still carries {@link AgentConfig} whole,
 * prompt included, because one prompt is bounded by `MAX_PROMPT_CHARS` (src/router.ts) and
 * cannot approach the framing bound. The fleet read is the surface where the
 * count multiplies; the single read is where the bytes stay reachable.
 */
export type SummarisedAgentConfig = Omit<AgentConfig, 'prompt'>;

/** Every daemon reply carries `success`; failures carry `error`; both echo `id`. */
export interface DaemonResponse {
  success: boolean;
  error?: string;
  id?: number | string;
  [key: string]: unknown;
}
