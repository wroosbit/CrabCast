/**
 * Where the daemon process gets its config path from — and why that is a
 * module rather than a line inside `daemon.ts`.
 *
 * `daemon.ts` is top-to-bottom module code: importing it *is* starting the
 * daemon. That is deliberate and it is what makes `node dist/daemon.js` a
 * working foreground entrypoint, but it means the config path has to be
 * decided before the first line of that module runs, and there is exactly one
 * channel available at that moment — the process's own `argv`.
 *
 * That was fine while `node dist/daemon.js [configPath]` was the only way in.
 * `crabcast daemon` (KAN-322) is a second way in, and it arrives with the path
 * already resolved by the CLI's own `--config` rule, in a process whose
 * `argv[2]` is `--config` or a flag value or nothing at all. Reading `argv[2]`
 * there would take whatever the CLI happened to be invoked with and load it as
 * a config file.
 *
 * So the hand-off is written down here instead of being implied by an argv
 * index that two callers have to agree about silently. The host sets the path;
 * the daemon asks for it; a host that sets it too late is told so rather than
 * ignored.
 */

/**
 * The path an in-process host resolved, or `undefined` when the daemon was
 * started as its own program.
 */
let hostedConfigPath: string | undefined;

/**
 * Whether {@link daemonConfigPathArg} has already answered.
 *
 * The ordering this guards is real and silent when it breaks: `daemon.ts`
 * reads its config while it is being imported, so a host that calls
 * {@link hostDaemonConfigPath} *after* that import has set a variable nobody
 * will ever read again — and the daemon is by then already running against
 * whatever `argv[2]` held. There is no error, no log line, and a daemon
 * addressing the wrong data dir looks exactly like one addressing the right
 * one until somebody notices the socket is in the wrong place.
 */
let answered = false;

/**
 * Declare the config path for a daemon about to be started *in this process*.
 *
 * Must be called before `daemon.js` is imported. Callers outside this
 * repository have no reason to reach for it: the supported foreground
 * entrypoints are `crabcast daemon`, which calls this itself, and
 * `node dist/daemon.js [configPath]`, which does not need it.
 */
export function hostDaemonConfigPath(configPath: string): void {
  if (answered) {
    throw new Error(
      'hostDaemonConfigPath() was called after the daemon had already read its config path. ' +
        'The daemon reads it while `daemon.js` is being imported, so the call has to come ' +
        'first — setting it now would change nothing and leave a daemon running against a ' +
        'config nobody chose.'
    );
  }
  hostedConfigPath = configPath;
}

/**
 * The config path this daemon should load, before {@link resolveConfigPath}
 * applies its own defaulting to the answer.
 *
 * `argv[2]` is the `node dist/daemon.js [configPath]` position, and it is this
 * function's business alone — nothing else in the tree reads it.
 */
export function daemonConfigPathArg(argv: string[] = process.argv): string | undefined {
  answered = true;
  return hostedConfigPath ?? argv[2];
}

/** Test seam: forget both the hosted path and the fact that it was read. */
export function resetDaemonInvocationForTests(): void {
  hostedConfigPath = undefined;
  answered = false;
}
