import { execFile } from 'node:child_process';
import type { CliAdapter, CliId } from '../adapters/cli/types.js';
import { createCliAdapterSync } from '../adapters/cli/registry.js';
import { localTerminalCapable } from '../core/local-terminal-opener.js';
import type { DaemonSession } from '../core/types.js';
import { getSessionPersistentBackendType, persistentSessionName } from '../core/persistent-backend.js';
import { readGlobalConfig, type LocalCliOpenMode } from '../global-config.js';

export const LOCAL_CLI_IDS = [
  'claude-code',
  'seed',
  'relay',
  'aiden',
  'coco',
  'codex',
  'cursor',
  'genius',
  'opencode',
  'antigravity',
  'mtr',
  'hermes',
  'traex',
  'pi',
  'copilot',
  'oh-my-pi',
  'kimi',
  'grok',
] as const satisfies readonly CliId[];

export type LocalCliId = typeof LOCAL_CLI_IDS[number];

const LOCAL_CLI_ID_SET = new Set<CliId>(LOCAL_CLI_IDS);

const RESUME_COMMAND_PREFIXES: Record<Exclude<LocalCliId, 'oh-my-pi'>, string> = {
  'claude-code': 'claude --resume',
  'seed': 'seed --resume',
  'relay': 'relay --resume',
  'aiden': 'aiden --resume',
  'coco': 'coco --resume',
  'codex': 'codex resume',
  'cursor': 'cursor-agent --resume',
  'genius': 'genius --resume',
  'opencode': 'opencode -s',
  'antigravity': 'agy --conversation',
  'mtr': 'mtr --session',
  'hermes': 'hermes --resume',
  'traex': 'traex resume',
  'pi': 'pi --session-id',
  'copilot': 'copilot --resume',
  'kimi': 'kimi --resume',
  'grok': 'grok --resume',
};

type AdoptedMetadata = NonNullable<DaemonSession['adoptedFrom']> | NonNullable<DaemonSession['session']['adoptedFrom']>;

export type LocalCliOpenError =
  | 'unsupported_cli'
  | 'unsupported_platform'
  | 'terminal_unavailable'
  | 'missing_working_dir'
  | 'missing_resume_id'
  | 'unsupported_backend'
  | 'missing_attach_target';

export type LocalCliOpenResult =
  | { ok: true; command: string }
  | { ok: false; error: LocalCliOpenError; message: string };

export type LocalCliPreflightResult = LocalCliOpenResult;

export interface LocalCliOpenerDeps {
  platform?: NodeJS.Platform;
  mode?: LocalCliOpenMode;
  adapterFactory?: (cliId: LocalCliId) => Pick<CliAdapter, 'buildResumeCommand'>;
  runOsascript?: (args: string[]) => Promise<{ ok: boolean; stderr?: string }>;
}

const OSASCRIPT = '/usr/bin/osascript';
const ITERM_TARGETS = [
  'application "/Applications/iTerm.app"',
  'application id "com.googlecode.iterm2"',
  'application "iTerm"',
] as const;
const TERMINAL_TARGETS = [
  'application "/System/Applications/Utilities/Terminal.app"',
  'application id "com.apple.Terminal"',
] as const;

function fail(error: LocalCliOpenError, message: string): LocalCliOpenResult {
  return { ok: false, error, message };
}

export function supportsLocalCliOpen(cliId: string | undefined): cliId is LocalCliId {
  return !!cliId && LOCAL_CLI_ID_SET.has(cliId as CliId);
}

/** The iTerm-first opener is intentionally macOS-only. Keep the generic host
 *  capability check as well so the policy stays aligned with native-terminal
 *  availability if that check becomes stricter later. */
export function isLocalCliOpenCapable(): boolean {
  return process.platform === 'darwin' && localTerminalCapable();
}

export function isLocalCliOpenConfigured(): boolean {
  return readGlobalConfig().dashboard?.enableLocalCliOpen === true;
}

export function localCliOpenMode(): LocalCliOpenMode {
  return readGlobalConfig().dashboard?.localCliOpenMode ?? 'attach';
}

export function isLocalCliOpenEnabled(): boolean {
  return isLocalCliOpenConfigured() && isLocalCliOpenCapable();
}

function localCliId(cliId: string | undefined): LocalCliId | undefined {
  return supportsLocalCliOpen(cliId) ? cliId : undefined;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function appleScriptQuote(value: string): string {
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')}"`;
}

function sessionWorkingDir(ds: DaemonSession): string | undefined {
  return ds.workingDir ?? ds.session.workingDir ?? ds.adoptedFrom?.cwd ?? ds.session.adoptedFrom?.cwd;
}

function nativeResumeId(ds: DaemonSession): string | undefined {
  return ds.adoptedFrom?.sessionId ?? ds.session.adoptedFrom?.sessionId ?? ds.session.cliSessionId;
}

function adoptedMetadata(ds: DaemonSession): AdoptedMetadata | undefined {
  return ds.adoptedFrom ?? ds.session.adoptedFrom;
}

function quoteKnownResumeCommand(cliId: LocalCliId, raw: string): string | null {
  if (cliId === 'oh-my-pi') return raw === 'omp --continue' ? raw : null;
  const prefix = `${RESUME_COMMAND_PREFIXES[cliId]} `;
  if (!raw.startsWith(prefix)) return null;
  const sid = raw.slice(prefix.length).trim();
  if (!sid) return null;
  return `${RESUME_COMMAND_PREFIXES[cliId]} ${shellQuote(sid)}`;
}

export function buildItermAppleScript(command: string, tellTarget: string = ITERM_TARGETS[0]): string {
  return [
    `tell ${tellTarget}`,
    '  activate',
    '  set newWindow to (create window with default profile)',
    '  tell current session of newWindow',
    `    write text ${appleScriptQuote(command)}`,
    '  end tell',
    'end tell',
  ].join('\n');
}

export function buildTerminalAppleScript(command: string, tellTarget: string = TERMINAL_TARGETS[0]): string {
  return [
    `tell ${tellTarget}`,
    '  activate',
    `  do script ${appleScriptQuote(command)}`,
    'end tell',
  ].join('\n');
}

export function buildLocalCliOpenCommand(
  ds: DaemonSession,
  opts: { cliId?: CliId; mode?: LocalCliOpenMode; adapterFactory?: LocalCliOpenerDeps['adapterFactory'] } = {},
): LocalCliOpenResult {
  const mode = opts.mode ?? localCliOpenMode();
  if (mode === 'attach') return buildLocalCliAttachCommand(ds);
  return buildLocalCliResumeCommand(ds, opts);
}

function safeAttachAtom(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(v) ? v : undefined;
}

function buildManagedAttachCommand(ds: DaemonSession): LocalCliOpenResult {
  const backendType = getSessionPersistentBackendType(ds);
  if (backendType === 'tmux') {
    const name = persistentSessionName('tmux', ds.session.sessionId);
    return { ok: true, command: `tmux attach-session -t ${shellQuote(`=${name}`)}` };
  }
  if (backendType === 'herdr') {
    const name = persistentSessionName('herdr', ds.session.sessionId);
    return { ok: true, command: `herdr session attach ${shellQuote(name)}` };
  }
  return fail('unsupported_backend', 'This session backend does not provide a safe local attach command.');
}

/** Adopted tmux is deliberately never opened locally, regardless of metadata:
 *  the pane coordinates captured at adopt time (`tmuxTarget` / `originalCliPid`)
 *  can be stale or reused by the time the user clicks, so there is no reliably
 *  safe attach target. Always fails closed — resume mode is the supported path
 *  for these sessions. */
function buildAdoptedTmuxAttachCommand(_adopted: AdoptedMetadata): LocalCliOpenResult {
  return fail('missing_attach_target', 'Adopted tmux sessions are not opened locally because pane targets can be stale or reused.');
}

function buildAdoptedHerdrAttachCommand(adopted: AdoptedMetadata): LocalCliOpenResult {
  const sessionName = safeAttachAtom(adopted.herdrSessionName);
  const terminalId = safeAttachAtom(adopted.herdrTerminalId);
  if (sessionName && terminalId) {
    return { ok: true, command: `herdr --session ${shellQuote(sessionName)} terminal attach ${shellQuote(terminalId)}` };
  }

  return fail('missing_attach_target', 'Adopted Herdr session metadata has no reliable scoped session and terminal target.');
}

export function buildLocalCliAttachCommand(ds: DaemonSession): LocalCliOpenResult {
  const adopted = adoptedMetadata(ds);
  if (!adopted) return buildManagedAttachCommand(ds);

  if (adopted.source === 'herdr' || adopted.herdrSessionName || adopted.herdrTerminalId || adopted.herdrPaneId || adopted.herdrTarget) {
    return buildAdoptedHerdrAttachCommand(adopted);
  }
  if (adopted.source === 'zellij' || adopted.zellijPaneId || adopted.zellijSession) {
    return fail('unsupported_backend', 'Adopted zellij sessions do not provide a safe local attach command yet.');
  }
  return buildAdoptedTmuxAttachCommand(adopted);
}

function buildLocalCliResumeCommand(
  ds: DaemonSession,
  opts: { cliId?: CliId; adapterFactory?: LocalCliOpenerDeps['adapterFactory'] } = {},
): LocalCliOpenResult {
  const cliId = localCliId(opts.cliId ?? ds.session.cliId ?? ds.adoptedFrom?.cliId ?? ds.session.adoptedFrom?.cliId);
  if (!cliId) return fail('unsupported_cli', 'This CLI does not provide a supported local resume command.');

  const workingDir = sessionWorkingDir(ds);
  if (!workingDir) return fail('missing_working_dir', 'Session working directory is missing.');

  const adapter = opts.adapterFactory?.(cliId) ?? createCliAdapterSync(cliId);
  const rawResume = adapter.buildResumeCommand?.({
    sessionId: ds.session.sessionId,
    cliSessionId: nativeResumeId(ds),
  });
  if (!rawResume) return fail('missing_resume_id', `${cliId} does not have a resumable session id yet.`);

  const resumeCommand = quoteKnownResumeCommand(cliId, rawResume);
  if (!resumeCommand) return fail('missing_resume_id', `${cliId} returned an unsupported resume command.`);

  return { ok: true, command: `cd ${shellQuote(workingDir)} && ${resumeCommand}` };
}

/** Pure preflight for local CLI opening. It performs the same attach/resume
 *  target resolution as the real opener, but never launches AppleScript. */
export function preflightLocalCliOpen(
  ds: DaemonSession,
  opts: { cliId?: CliId; mode?: LocalCliOpenMode; adapterFactory?: LocalCliOpenerDeps['adapterFactory'] } = {},
): LocalCliPreflightResult {
  try {
    return buildLocalCliOpenCommand(ds, opts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail('missing_resume_id', message || 'This CLI does not have a resumable session id yet.');
  }
}

export function isLocalCliOpenReady(
  ds: DaemonSession,
  opts: { cliId?: CliId; mode?: LocalCliOpenMode; adapterFactory?: LocalCliOpenerDeps['adapterFactory'] } = {},
): boolean {
  return preflightLocalCliOpen(ds, opts).ok;
}

function defaultRunOsascript(args: string[]): Promise<{ ok: boolean; stderr?: string }> {
  return new Promise((resolve) => {
    execFile(OSASCRIPT, args, { timeout: 15_000 }, (err, _stdout, stderr) => {
      resolve({ ok: !err, stderr: stderr?.trim() || (err ? String(err) : undefined) });
    });
  });
}

function terminalUnavailableMessage(errors: string[]): string {
  const detail = [...errors].reverse().find((e) => e.trim().length > 0);
  const base = 'Neither iTerm nor Terminal.app could be opened with AppleScript.';
  return detail
    ? `${base} Install iTerm or allow Automation access, then retry. Last error: ${detail}`
    : `${base} Install iTerm or allow Automation access, then retry.`;
}

export async function openLocalCliInIterm(
  ds: DaemonSession,
  deps: LocalCliOpenerDeps & { cliId?: CliId } = {},
): Promise<LocalCliOpenResult> {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'darwin') {
    return fail('unsupported_platform', 'Opening a local CLI is only supported on macOS.');
  }

  const built = buildLocalCliOpenCommand(ds, { cliId: deps.cliId, mode: deps.mode, adapterFactory: deps.adapterFactory });
  if (!built.ok) return built;

  const runOsascript = deps.runOsascript ?? defaultRunOsascript;
  const errors: string[] = [];
  for (const target of ITERM_TARGETS) {
    const launched = await runOsascript(['-e', buildItermAppleScript(built.command, target)]);
    if (launched.ok) return built;
    if (launched.stderr) errors.push(launched.stderr);
  }

  for (const target of TERMINAL_TARGETS) {
    const launched = await runOsascript(['-e', buildTerminalAppleScript(built.command, target)]);
    if (launched.ok) return built;
    if (launched.stderr) errors.push(launched.stderr);
  }

  return fail('terminal_unavailable', terminalUnavailableMessage(errors));
}
