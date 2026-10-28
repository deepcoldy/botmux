import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StringDecoder } from 'node:string_decoder';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { botmuxCliInvocation, buildRelayHostEnv } from '../adapters/backend/sandbox.js';
import { quotedAttachments } from './remote-runner-session-tool.js';
import { isStandaloneBinary } from '../core/self-spawn.js';

export const RIFF_HOST_TOOLS_ROUTE = '/api/riff-host-tools';
export const RIFF_HOST_BINDING_ENV = 'BOTMUX_RIFF_HOST_BINDING';
export const RIFF_HOST_MAX_BYTES = 48 * 1024 * 1024;
const OUTPUT_LIMIT = 2 * 1024 * 1024;
const UPLOAD_PREFIX = 'riff-upload:';
const RECEIPT_LIMIT = 1000;
const RECEIPT_TTL_MS = 7 * 24 * 60 * 60_000;
let cliSha256: string | undefined;

export interface RiffHostBinding { url: string; token: string; sessionId: string; turnId: string; cliSha256?: string }
export interface RiffHostUpload { name: string; dataBase64: string }
export interface RiffHostRequest { operationId: string; argv: string[]; stdin?: string; files?: RiffHostUpload[] }
export interface RiffHostResult {
  exitCode: number; stdout: string; stderr: string;
  attachments?: Array<{ placeholder: string; name: string; type: 'image' | 'file'; dataBase64: string }>;
}
export interface RiffHostContext {
  sessionId: string; turnId: string; dispatchAttempt?: number;
  dataDir: string; env: NodeJS.ProcessEnv; cliPath?: string; workingDir?: string;
  isCurrent: () => boolean;
}

// The remote caller supplies content and supported options, never an executable,
// environment, host path, destination session or application. Existing CLI and
// daemon policies still authorize the resulting operation.
const SPECS: Record<string, { sub?: string[]; values?: string; bools?: string; files?: string }> = {
  send: {
    values: '--response-kind --mention --layout --expected-link --quote --as --plugin-card-action --card-json --image-mode',
    bools: '--mention-back --no-mention --no-quote --anyway --attention --urgent --schedule-remove-self --voice --text --card',
    files: '--content-file --card-file --images --image --files --file --videos --video-covers --completion-proposal-file',
  },
  ask: { sub: ['buttons'], values: '--options --timeout', bools: '--json --multi', files: '--questions-file' },
  auth: { sub: ['request', 'wait'], values: '--scope --request-id', bools: '--json --allow-unknown' },
  schedule: {
    sub: ['list', 'add', 'update', 'remove', 'pause', 'resume', 'run', 'calendars'],
    values: '--name --id --prompt --model --reasoning-effort --calendar --calendar-day-type --topic-title',
    bools: '--top-level --topic --new-topic --silent --follow-active', files: '--prompt-file',
  },
  history: { values: '--limit --scope', bools: '--with-card-json' },
  quoted: { bools: '--raw' },
  bots: { sub: ['list'], values: '--scope' },
  project: {
    sub: ['init', 'status', 'update', 'close', 'resume'],
    values: '--title --goal --phase --focus --remaining --progress --blocker --milestone --next-milestone',
    bools: '--json --clear-blockers --clear-next-milestone',
  },
  board: {
    sub: ['guide', 'list', 'show', 'add', 'set', 'history', 'attach', 'pending'],
    values: '--view --key --state --stage --kind --repo --summary --progress --ask --option --recommend --reason --link --unlink --note --title',
    bools: '--json --handled --clear-ask',
  },
  workflow: { sub: ['list', 'show', 'run', 'start', 'retry', 'cancel', 'grant'], values: '--param --reason --node', bools: '--json' },
  card: { sub: ['patch'], values: '--message-id --card-json --plugin-card-action', files: '--card-file' },
  'card.stream': { sub: ['open', 'write', 'finish', 'snapshot', 'reanchor'], values: '--message-id --stream-id --element-id --summary --content', files: '--content-file', bools: '--json' },
  whiteboard: { sub: ['status'], bools: '--json' },
  tabs: { sub: ['list', 'add', 'update', 'remove', 'sort'], values: '--name --url', bools: '--json' },
  'top-notice': { sub: ['set'], bools: '--json' },
};

function words(value?: string): Set<string> { return new Set(value?.split(' ') ?? []); }

/** Validate both before upload on the client and again at the host boundary. */
export function riffHostFileArguments(argv: string[]): number[] {
  const nested = argv[0] === 'card' && argv[1] === 'stream';
  const spec = SPECS[nested ? 'card.stream' : argv[0] ?? ''];
  if (!spec) throw new Error('riff_host_command_unsupported');
  const values = words(spec.values), bools = words(spec.bools), files = words(spec.files);
  const paths: number[] = [];
  if (spec.sub && !spec.sub.includes(argv[nested ? 2 : 1] ?? '')) throw new Error('riff_host_subcommand_unsupported');
  for (let i = spec.sub ? (nested ? 3 : 2) : 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('-')) {
      if (argv[0] === 'board' && argv[1] === 'attach' && i >= 3) paths.push(i);
      continue;
    }
    const [flag, ...inline] = arg.split('=');
    if (flag === '--help' || flag === '-h') continue;
    if (bools.has(flag!)) {
      if (inline.length && !['--attention', '--urgent'].includes(flag!)) throw new Error('riff_host_invalid_flag');
      continue;
    }
    if (!values.has(flag!) && !files.has(flag!)) throw new Error(`riff_host_flag_unsupported:${flag}`);
    if (files.has(flag!) && inline.length) throw new Error('riff_host_file_flag_requires_separate_value');
    if (!inline.length) {
      if (++i >= argv.length || argv[i]!.startsWith('--')) throw new Error('riff_host_missing_flag_value');
      if (files.has(flag!)) paths.push(i);
    }
  }
  return paths;
}

export function parseRiffHostRequest(raw: unknown): RiffHostRequest {
  const r = raw as RiffHostRequest;
  if (!r || typeof r !== 'object' || typeof r.operationId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(r.operationId)
    || !Array.isArray(r.argv) || r.argv.length > 150 || !r.argv.every(v => typeof v === 'string' && v.length < OUTPUT_LIMIT && !v.includes('\0'))
    || (r.stdin !== undefined && typeof r.stdin !== 'string')
    || (r.files !== undefined && (!Array.isArray(r.files) || r.files.length > 16))) throw new Error('riff_host_request_invalid');
  const paths = riffHostFileArguments(r.argv);
  for (const file of r.files ?? []) {
    if (!file || typeof file.name !== 'string' || !/^[\w. -]{1,180}$/.test(file.name) || file.name === '.' || file.name === '..'
      || typeof file.dataBase64 !== 'string' || file.dataBase64.length > 32 * 1024 * 1024
      || Buffer.from(file.dataBase64, 'base64').toString('base64') !== file.dataBase64) throw new Error('riff_host_upload_invalid');
  }
  const used = new Set<number>();
  for (const i of paths) {
    const index = Number(r.argv[i]!.slice(UPLOAD_PREFIX.length));
    if (!r.argv[i]!.startsWith(UPLOAD_PREFIX) || !Number.isSafeInteger(index) || index < 0 || !r.files?.[index]) throw new Error('riff_host_upload_missing');
    used.add(index);
  }
  if (used.size !== (r.files?.length ?? 0)) throw new Error('riff_host_upload_unreferenced');
  return { operationId: r.operationId, argv: r.argv, stdin: r.stdin, files: r.files };
}

export async function executeRiffHostTool(request: RiffHostRequest, ctx: RiffHostContext): Promise<RiffHostResult> {
  parseRiffHostRequest(request);
  if (!ctx.isCurrent()) throw new Error('riff_host_turn_stale');
  const dir = mkdtempSync(join(tmpdir(), 'botmux-riff-tool-'));
  try {
    const argv = [...request.argv];
    for (const i of riffHostFileArguments(argv)) {
      const index = Number(argv[i]!.slice(UPLOAD_PREFIX.length));
      const file = request.files![index]!;
      const path = join(dir, `${index}-${basename(file.name)}`);
      writeFileSync(path, Buffer.from(file.dataBase64, 'base64'), { mode: 0o600 });
      argv[i] = path;
    }
    if (argv[0] === 'quoted') argv.push('--remote-runner-session-tool');
    if (argv[0] === 'schedule' && argv[1] === 'add') {
      if (!ctx.workingDir) throw new Error('riff_host_working_directory_unavailable');
      argv.push('--workdir', ctx.workingDir);
    }
    const env = buildRelayHostEnv(ctx.env);
    delete env[RIFF_HOST_BINDING_ENV];
    env.BOTMUX_HOST_RELAY_AUTHORIZED = '1';
    env.BOTMUX_SESSION_ID = ctx.sessionId;
    env.BOTMUX_TURN_ID = ctx.turnId;
    env.SESSION_DATA_DIR = ctx.dataDir;
    if (ctx.dispatchAttempt !== undefined) env.BOTMUX_DISPATCH_ATTEMPT = String(ctx.dispatchAttempt);
    else delete env.BOTMUX_DISPATCH_ATTEMPT;
    const invocation = botmuxCliInvocation(ctx.cliPath);
    return await new Promise<RiffHostResult>((resolve) => {
      const child = spawn(invocation.command, [...invocation.args, ...argv], { env, cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', failed = false;
      const outDecoder = new StringDecoder('utf8'), errDecoder = new StringDecoder('utf8');
      const fail = () => { failed = true; child.kill('SIGKILL'); };
      const append = (old: string, text: string): string => {
        const next = old + text;
        if (Buffer.byteLength(next) > OUTPUT_LIMIT) { fail(); return old; }
        return next;
      };
      child.stdout.on('data', bytes => { stdout = append(stdout, outDecoder.write(bytes)); });
      child.stderr.on('data', bytes => { stderr = append(stderr, errDecoder.write(bytes)); });
      const deadline = setTimeout(fail, argv[0] === 'ask' ? 61 * 60_000 : 6 * 60_000);
      const fence = setInterval(() => { if (!ctx.isCurrent()) fail(); }, 100);
      const finish = (code: number | null) => {
        clearTimeout(deadline); clearInterval(fence);
        stdout += outDecoder.end(); stderr += errDecoder.end();
        try {
          const packaged = argv[0] === 'quoted' && code === 0 ? quotedAttachments(stdout, env) : { stdout };
          resolve({ exitCode: failed || code === null ? 1 : code, stdout: packaged.stdout,
            stderr: failed ? 'riff_host_execution_unknown; do not repeat this operation automatically' : stderr,
            ...('attachments' in packaged ? { attachments: packaged.attachments } : {}) });
        } catch { resolve({ exitCode: 1, stdout: '', stderr: 'riff_host_attachment_invalid' }); }
      };
      child.once('error', () => { failed = true; });
      child.once('close', finish);
      child.stdin.on('error', () => {});
      child.stdin.end(request.stdin ?? '');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Operation { fingerprint: string; turnId: string; result?: RiffHostResult }

/** One worker-owned gateway. A fresh capability is issued at each dispatch;
 * completed/running receipts are persisted before replying, including unknown
 * outcomes after a crash. Replaying an operation id never re-executes it. */
export class RiffHostTools {
  private binding?: RiffHostBinding;
  private context?: RiffHostContext;
  private readonly operations = new Map<string, Promise<void>>();
  constructor(private readonly execute = executeRiffHostTool) {}

  bind(url: string, context: RiffHostContext): RiffHostBinding {
    this.context = context;
    this.binding = { url, token: randomBytes(32).toString('base64url'), sessionId: context.sessionId, turnId: context.turnId };
    // Riff's sandbox CLI runs on Linux x64; a macOS/ARM host executable is
    // not an installable sandbox artifact. Those hosts keep the npm setup path.
    if (isStandaloneBinary() && process.platform === 'linux' && process.arch === 'x64') {
      cliSha256 ??= createHash('sha256').update(readFileSync(process.execPath)).digest('hex');
      this.binding.cliSha256 = cliSha256;
    }
    this.sweep(context);
    return this.binding;
  }

  private sweep(ctx: RiffHostContext): number {
    const directory = join(ctx.dataDir, 'sessions', ctx.sessionId, 'riff-host-operations');
    // Maintenance must never prevent task delivery. An unreadable directory is
    // conservatively full: new operations fail closed until storage recovers.
    try { mkdirSync(directory, { recursive: true, mode: 0o700 }); } catch { return RECEIPT_LIMIT; }
    let names: string[];
    try { names = readdirSync(directory).filter(n => /^[a-f0-9]{64}\.json$/.test(n)); } catch { return RECEIPT_LIMIT; }
    let retained = names.length;
    const entries: Array<{ path: string; mtime: number }> = [];
    for (const name of names) {
      const path = join(directory, name);
      try { entries.push({ path, mtime: statSync(path).mtimeMs }); }
      catch (err) {
        // The daemon's orphan sweep may remove a directory after readdir.
        // Other stat failures still count toward the limit and are not deleted.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') retained--;
      }
    }
    entries.sort((a, b) => a.mtime - b.mtime);
    for (const entry of entries) {
      if (this.operations.has(entry.path)) continue;
      if (Date.now() - entry.mtime <= RECEIPT_TTL_MS && retained < RECEIPT_LIMIT) continue;
      let op: Operation;
      try { op = JSON.parse(readFileSync(entry.path, 'utf8')); } catch { continue; }
      // A current-turn receipt is never evicted: replay must not execute twice.
      if (op.turnId === ctx.turnId) continue;
      if (Date.now() - entry.mtime > RECEIPT_TTL_MS || retained >= RECEIPT_LIMIT) {
        try { rmSync(entry.path, { force: true }); retained--; } catch { /* retry on a later sweep */ }
      }
    }
    return retained;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    const b = this.binding, ctx = this.context;
    // Dashboard terminal proxies deliberately strip browser Authorization.
    // This independent capability survives that hop and grants no terminal access.
    const token = req.headers['x-riff-host-token'] ?? req.headers.authorization?.replace(/^Bearer /, '');
    if (!b || !ctx || !ctx.isCurrent() || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)
      || token.length !== b.token.length || !timingSafeEqual(Buffer.from(token), Buffer.from(b.token))) { json(403, { error: 'riff_host_turn_unavailable' }); return; }
    if (req.method === 'GET' && new URL(req.url!, 'http://localhost').searchParams.get('artifact') === 'cli') {
      if (!b.cliSha256 || !isStandaloneBinary()) { json(404, { error: 'riff_host_cli_artifact_unavailable' }); return; }
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'content-length': statSync(process.execPath).size });
      createReadStream(process.execPath).on('error', () => res.destroy()).pipe(res);
      return;
    }
    try {
      let request: RiffHostRequest | undefined;
      let operationId: string;
      if (req.method === 'POST') {
        req.setTimeout(15_000, () => req.destroy());
        let length = 0; const chunks: Buffer[] = [];
        for await (const chunk of req) { length += chunk.length; if (length > RIFF_HOST_MAX_BYTES) throw new Error('riff_host_request_too_large'); chunks.push(chunk); }
        request = parseRiffHostRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        req.setTimeout(0);
        operationId = request.operationId;
      } else if (req.method === 'GET') {
        operationId = new URL(req.url!, 'http://localhost').searchParams.get('operationId') ?? '';
        if (!/^[a-zA-Z0-9_-]{8,100}$/.test(operationId)) throw new Error('riff_host_operation_invalid');
      } else { json(405, { error: 'method_not_allowed' }); return; }
      if (!ctx.isCurrent() || this.binding !== b) { json(409, { error: 'riff_host_turn_stale' }); return; }
      const directory = join(ctx.dataDir, 'sessions', ctx.sessionId, 'riff-host-operations');
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const key = createHash('sha256').update(operationId).digest('hex');
      const path = join(directory, `${key}.json`);
      let op: Operation | undefined;
      try {
        op = JSON.parse(readFileSync(path, 'utf8'));
        if (!op || typeof op.turnId !== 'string' || !/^[a-f0-9]{64}$/.test(op.fingerprint)) throw new Error('invalid receipt');
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('riff_host_receipt_unreadable'); }
      const fingerprint = request ? createHash('sha256').update(JSON.stringify(request)).digest('hex') : undefined;
      if (op && (op.turnId !== ctx.turnId || (fingerprint && op.fingerprint !== fingerprint))) { json(409, { error: 'riff_host_operation_conflict' }); return; }
      if (!op && request) {
        if (this.operations.size >= 16 || this.sweep(ctx) >= RECEIPT_LIMIT) { json(429, { error: 'riff_host_busy' }); return; }
        op = { fingerprint: fingerprint!, turnId: ctx.turnId };
        atomicWriteFileSync(path, JSON.stringify(op), { mode: 0o600, durable: true, followTargetSymlink: false });
        const receipt = op;
        const running = Promise.resolve().then(() => this.execute(request!, ctx)).then(result => {
          receipt.result = result;
          atomicWriteFileSync(path, JSON.stringify(receipt), { mode: 0o600, durable: true, followTargetSymlink: false });
        }).catch(() => {
          receipt.result = { exitCode: 1, stdout: '', stderr: 'riff_host_execution_unknown; do not repeat automatically' };
          try { atomicWriteFileSync(path, JSON.stringify(receipt), { mode: 0o600, durable: true, followTargetSymlink: false }); } catch { /* existing running receipt fails closed */ }
        }).finally(() => { this.operations.delete(path); });
        this.operations.set(path, running);
      }
      if (!op) { json(404, { error: 'riff_host_operation_not_found' }); return; }
      if (op.result) json(200, { state: 'completed', result: op.result });
      else if (this.operations.has(path)) json(202, { state: 'running' });
      else json(409, { error: 'riff_host_execution_unknown' });
    } catch (error) { json(400, { error: error instanceof Error ? error.message : 'riff_host_request_invalid' }); }
  }
}
