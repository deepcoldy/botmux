/**
 * Sandbox → host relay for the read-only session tools (`botmux history`,
 * `botmux quoted`).
 *
 * When a bot sets `sandboxWithholdBotSecret`, its file sandbox cannot read
 * `<BOT_HOME>/send-cred.json`, so these commands cannot call Lark themselves.
 * Instead they drop one structured request into the session outbox; the host
 * watcher re-runs the command with real credentials, forces this session's id,
 * and (for `quoted`) refuses a message outside this session's chat. The request
 * reuses the remote-runner session-tool contract, so the host never executes
 * sandbox-supplied argv.
 */
import { constants as fsConstants, closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { basename, join } from 'node:path';
import type {
  RemoteRunnerSessionToolAttachment,
  RemoteRunnerSessionToolRequest,
} from '../adapters/backend/remote-runner-protocol.js';

export type RelaySessionTool = 'history' | 'quoted';

type Built =
  | { ok: true; request: Extract<RemoteRunnerSessionToolRequest, { tool: RelaySessionTool }> }
  | { ok: false; error: string };

/** Split `--flag value` / `--flag=value` into a uniform list. */
function tokens(args: readonly string[]): Array<{ flag?: string; value?: string; positional?: string }> {
  const out: Array<{ flag?: string; value?: string; positional?: string }> = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('--')) { out.push({ positional: a }); continue; }
    const eq = a.indexOf('=');
    if (eq > 0) { out.push({ flag: a.slice(0, eq), value: a.slice(eq + 1) }); continue; }
    out.push({ flag: a });
  }
  return out;
}

/**
 * Map the sandboxed command line onto the structured request. Options the
 * relay cannot honour are refused loudly rather than silently dropped, and
 * `--session-id` may only name this session (the host forces it anyway).
 */
export function buildRelaySessionToolRequest(
  tool: RelaySessionTool,
  args: readonly string[],
  ownSessionId: string | undefined,
): Built {
  const valueFlags = new Set(tool === 'history' ? ['--limit', '--scope', '--session-id'] : ['--session-id']);
  const boolFlags = new Set(tool === 'history' ? ['--with-card-json'] : ['--raw']);
  const values = new Map<string, string>();
  const bools = new Set<string>();
  const positionals: string[] = [];
  const list = tokens(args);
  for (let i = 0; i < list.length; i++) {
    const t = list[i]!;
    if (t.positional !== undefined) { positionals.push(t.positional); continue; }
    const flag = t.flag!;
    if (boolFlags.has(flag) && t.value === undefined) { bools.add(flag); continue; }
    if (valueFlags.has(flag)) {
      let value = t.value;
      if (value === undefined) {
        const next = list[i + 1];
        if (!next || next.positional === undefined) return { ok: false, error: `${flag} requires a value` };
        value = next.positional; i++;
      }
      values.set(flag, value);
      continue;
    }
    return { ok: false, error: `botmux ${tool}: ${flag} is not available through the sandbox relay (this bot keeps its secret out of the sandbox)` };
  }
  const sid = values.get('--session-id');
  if (sid !== undefined && sid !== ownSessionId) {
    return { ok: false, error: `botmux ${tool}: the sandbox relay only reads the current session` };
  }
  if (tool === 'history') {
    if (positionals.length) return { ok: false, error: `botmux history: unexpected argument ${positionals[0]}` };
    const rawLimit = values.get('--limit');
    let limit: number | undefined;
    if (rawLimit !== undefined) {
      limit = Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1) return { ok: false, error: 'botmux history: --limit must be a positive integer' };
      limit = Math.min(limit, 100);
    }
    const scope = values.get('--scope');
    if (scope !== undefined && !['session', 'thread', 'chat', 'ambient'].includes(scope)) {
      return { ok: false, error: `botmux history: unknown --scope ${scope}` };
    }
    return {
      ok: true,
      request: {
        tool: 'history',
        ...(limit !== undefined ? { limit } : {}),
        ...(scope !== undefined ? { scope: scope as 'session' | 'thread' | 'chat' | 'ambient' } : {}),
        ...(bools.has('--with-card-json') ? { withCardJson: true } : {}),
      },
    };
  }
  const ids = [...new Set(positionals)];
  if (ids.length !== 1) {
    return { ok: false, error: 'botmux quoted: the sandbox relay reads exactly one message id per call' };
  }
  if (!/^om_[A-Za-z0-9_-]+$/.test(ids[0]!)) return { ok: false, error: `Invalid message id: ${ids[0]}` };
  return { ok: true, request: { tool: 'quoted', messageId: ids[0]!, ...(bools.has('--raw') ? { raw: true } : {}) } };
}

/**
 * Write relayed `quoted` attachments into `dir` (created here, inside the
 * sandbox-writable outbox) and point the placeholders in `stdout` at them.
 * Files are created with O_EXCL so a pre-planted entry cannot redirect them.
 */
export function materializeRelayedAttachments(
  stdout: string,
  attachments: readonly RemoteRunnerSessionToolAttachment[] | undefined,
  dir: string,
): string {
  if (!attachments?.length) return stdout;
  let root: unknown;
  try { root = JSON.parse(stdout); } catch { return stdout; }
  if (!root || typeof root !== 'object' || Array.isArray(root)) return stdout;
  const byPlaceholder = new Map(attachments.map((att, index) => [att.placeholder, { att, index }]));
  const holders: Array<Record<string, unknown>> = [];
  const envelope = root as Record<string, unknown>;
  if (Array.isArray(envelope.attachments)) holders.push(envelope);
  if (Array.isArray(envelope.messages)) {
    for (const message of envelope.messages) {
      if (message && typeof message === 'object' && !Array.isArray(message)
          && Array.isArray((message as Record<string, unknown>).attachments)) {
        holders.push(message as Record<string, unknown>);
      }
    }
  }
  let rewritten = false;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const holder of holders) {
    for (const raw of holder.attachments as unknown[]) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const item = raw as Record<string, unknown>;
      const match = typeof item.path === 'string' ? byPlaceholder.get(item.path) : undefined;
      if (!match) continue;
      const safe = basename(String(match.att.name ?? '')).replace(/^\.+/, '').slice(0, 200) || 'attachment';
      const path = join(dir, `${match.index}-${safe}`);
      const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      try { writeSync(fd, Buffer.from(match.att.dataBase64, 'base64')); } finally { closeSync(fd); }
      item.path = path;
      rewritten = true;
    }
  }
  return rewritten ? `${JSON.stringify(root, null, 2)}\n` : stdout;
}
