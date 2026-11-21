export declare const TMUX_SERVER_LOG_BASENAME: string;
export declare const SANDBOX_SCRIPT_LOG_BASENAME: string;

export interface RegisteredTmuxServer {
  pid: number;
  identity: string;
  socket: string;
}

export interface TmuxRegistrationOptions {
  env?: NodeJS.ProcessEnv;
  serverLog?: string;
  registryRoot?: string;
}

export interface ReapTestProcessesResult {
  tmuxFailed: RegisteredTmuxServer[];
  sandboxPids: number[];
  sandboxFailed: number[];
}

export declare function testProcessIdentity(pid: number): string | null;
export declare function registerTmuxServer(
  tmux: string,
  socket: string,
  options?: TmuxRegistrationOptions,
): RegisteredTmuxServer | null;
export declare function registerSandboxScriptForCleanup(script: string, env?: NodeJS.ProcessEnv): void;
export declare function parseLsofTmuxServers(
  output: string,
  sockets: ReadonlySet<string>,
  identityForPid?: (pid: number) => string | null,
): { ok: boolean; refs: RegisteredTmuxServer[] };
export declare function killPrivateTmuxServer(
  tmux: string,
  socket: string,
  options?: TmuxRegistrationOptions,
): {
  ok: boolean;
  killServerStatus: number | null;
  killServerError?: Error;
  tmuxFailed: RegisteredTmuxServer[];
};
export declare function reapRegisteredTestProcesses(root: string): ReapTestProcessesResult;
