/** Real-CLI smoke test: requires fenced-run and an explicitly supplied disposable auth snapshot. */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { runAntigravityAcp } from '../src/services/antigravity-acp.js';

const { values } = parseArgs({ options: {
  'agy-bin': { type: 'string' }, 'auth-dir': { type: 'string' }, report: { type: 'string' },
  model: { type: 'string' }, effort: { type: 'string' },
  tools: { type: 'boolean', default: false },
} });
const home = homedir();
if (process.env.BOTMUX_FENCED_RUN !== '1' || !basename(home).startsWith('bmx-fenced-home-')
  || !values['agy-bin'] || !values['auth-dir'] || !values.report) {
  throw new Error('Use fenced-run with --agy-bin, --auth-dir (disposable snapshot), and --report.');
}
const root = join(home, '.gemini', 'antigravity-cli');
for (const name of ['antigravity-oauth-token', 'installation_id', 'jetski_state.pbtxt', 'cache/default_project_id.txt', 'cache/onboarding.json']) {
  const source = join(resolve(values['auth-dir']), name);
  if (!existsSync(source)) continue;
  const target = join(root, name); mkdirSync(dirname(target), { recursive: true }); copyFileSync(source, target);
}
const cwd = join(home, 'workspace'); mkdirSync(cwd, { recursive: true });
if (values.tools) writeFileSync(join(cwd, 'acp-proof.txt'), 'AGY_TOOL_READ_OK');
mkdirSync(root, { recursive: true });
writeFileSync(join(root, 'settings.json'), JSON.stringify({ trustedWorkspaces: [cwd] }));
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(), 120_000);
const records: Array<Record<string, unknown>> = [];
let nativeSessionId: string | undefined;
try {
  for (const [kind, content, expected] of [
    ['long', 'Reply exactly AGY_ACP_OK. Do not call tools. Ignore the test padding.\n<padding>\n'
      + '中文 input transmission fixture 0123456789\n'.repeat(400) + '</padding>', 'AGY_ACP_OK'],
    ['resume', 'Reply exactly AGY_ACP_RESUME_OK. Do not call tools.', 'AGY_ACP_RESUME_OK'],
    ...(values.tools ? [['tool', 'Read acp-proof.txt using a tool, then reply with only its exact contents.', 'AGY_TOOL_READ_OK'] as const] : []),
  ] as const) {
    const start = performance.now();
    let boundMs: number | undefined;
    let nativeInputObservedMs: number | undefined;
    let firstTextMs: number | undefined;
    let toolCalls = 0;
    /** Observe the actual native transcript, rather than treating a local pipe write as receipt. */
    const observe = (): void => {
      if (!nativeSessionId || nativeInputObservedMs !== undefined) return;
      const path = join(root, 'brain', nativeSessionId, '.system_generated', 'logs', 'transcript_full.jsonl');
      if (!existsSync(path)) return;
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        try {
          const record: unknown = JSON.parse(line);
          if (record && typeof record === 'object' && 'type' in record && record.type === 'USER_INPUT'
            && 'content' in record && typeof record.content === 'string' && record.content.includes(content)) {
            nativeInputObservedMs = Math.round(performance.now() - start); return;
          }
        } catch { /* Native writers can leave an incomplete trailing line. */ }
      }
    };
    const ticker = setInterval(observe, 50);
    try {
      const answer = await runAntigravityAcp({
        executable: resolve(values['agy-bin']), cwd, env: process.env, content, nativeSessionId,
        model: values.model, effort: values.effort,
        logFile: join(home, `${kind}.log`),
        onSession(id) { nativeSessionId = id; boundMs = Math.round(performance.now() - start); },
        onText() { firstTextMs ??= Math.round(performance.now() - start); },
        onTool() { toolCalls++; },
      }, controller.signal);
      observe();
      records.push({ kind, inputBytes: Buffer.byteLength(content), lines: content.split('\n').length,
        boundMs, nativeInputObservedMs, firstTextMs, completedMs: Math.round(performance.now() - start),
        nativeSessionId, matched: answer.trim() === expected, toolCalls });
      if (answer.trim() !== expected || nativeInputObservedMs === undefined) throw new Error('Native answer or full-input receipt did not match');
      if (kind === 'tool' && toolCalls === 0) throw new Error('Native tool scenario did not execute a tool');
    } finally { clearInterval(ticker); }
  }
  const report = { success: true, model: values.model ?? null, effort: values.effort ?? null, records, isolation: { home, dataDir: process.env.SESSION_DATA_DIR,
    userBus: process.env.DBUS_SESSION_BUS_ADDRESS ?? null } };
  writeFileSync(resolve(values.report), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  const report = { success: false, records, error: String(error) };
  writeFileSync(resolve(values.report), JSON.stringify(report, null, 2));
  console.error(JSON.stringify(report));
  process.exitCode = 1;
} finally { clearTimeout(deadline); }
