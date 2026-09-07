/** Real Codex, local-only Responses provider, isolated home; no account or model
 * credentials are copied. Opt in with BOTMUX_TEST_REAL_CODEX_BIN=/path/to/codex.
 * The seed turn uses a deterministic localhost response; both subsequent
 * resumes must stay idle without making another inference request. */
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as pty from 'node-pty';
import { describe, expect, it } from 'vitest';
import { createCodexAdapter } from '../src/adapters/cli/codex.js';

const codexBin = process.env.BOTMUX_TEST_REAL_CODEX_BIN;
const observeMs = 2_100;

async function until(predicate: () => boolean, detail: () => string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${detail()}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function startAppServer(bin: string, cwd: string, env: Record<string, string>) {
  const child = spawn(bin, ['app-server', '--stdio'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  let buffer = '';
  let sequence = 0;
  const notifications: any[] = [];
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  child.stdout.on('data', chunk => {
    buffer += String(chunk);
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const entry = pending.get(message.id);
      if (entry) {
        pending.delete(message.id);
        if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
        else entry.resolve(message.result);
      } else notifications.push(message);
    }
  });
  child.once('exit', code => {
    for (const entry of pending.values()) entry.reject(new Error(`Codex exited ${code}: ${stderr}`));
    pending.clear();
  });
  return {
    child, notifications,
    get stderr() { return stderr; },
    request(method: string, params: Record<string, unknown>): Promise<any> {
      const id = ++sequence;
      const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      return result;
    },
    notify(method: string) { child.stdin.write(`${JSON.stringify({ method })}\n`); },
  };
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 1_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

function usageRecords(codexHome: string): unknown[] {
  const result: unknown[] = [];
  function visit(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith('.jsonl')) {
        for (const line of readFileSync(path, 'utf8').trim().split('\n')) {
          if (!line) continue;
          const record = JSON.parse(line);
          if (record.type === 'event_msg' && record.payload?.type === 'token_count') result.push(record.payload.info);
        }
      }
    }
  }
  visit(join(codexHome, 'sessions'));
  return result;
}

describe.skipIf(!codexBin)('real Codex quiet maintenance resume', () => {
  it('restores the original history through app-server and TUI without extra inference or usage', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'botmux-real-codex-quiet-resume-'));
    const codexHome = join(directory, '.codex');
    const workspace = join(directory, 'workspace');
    mkdirSync(codexHome);
    mkdirSync(workspace);
    const requests: Array<{ method: string; path: string }> = [];
    const server = createServer(async (req, res) => {
      requests.push({ method: req.method ?? '', path: req.url ?? '' });
      for await (const _chunk of req) { /* consume local request without storing prompts */ }
      if (req.url === '/v1/models') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'quiet-resume-test', object: 'model', owned_by: 'local-test' }] }));
        return;
      }
      if (req.url !== '/v1/responses') { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const message = { id: 'msg_local', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Local seed answer.', annotations: [] }] };
      const response = { id: 'resp_local', object: 'response', created_at: 1, model: 'quiet-resume-test', status: 'completed', output: [message], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
      const events = [
        { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
        { type: 'response.content_part.added', item_id: message.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
        { type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: 'Local seed answer.' },
        { type: 'response.output_text.done', item_id: message.id, output_index: 0, content_index: 0, text: 'Local seed answer.' },
        { type: 'response.output_item.done', output_index: 0, item: message },
        { type: 'response.completed', response },
      ];
      for (const [sequence_number, event] of events.entries()) res.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`);
      res.end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected localhost TCP provider');
    writeFileSync(join(codexHome, 'config.toml'), `model = "quiet-resume-test"
model_provider = "local_test"
check_for_update_on_startup = false
[analytics]
enabled = false
[model_providers.local_test]
name = "Isolated local test"
base_url = "http://127.0.0.1:${address.port}/v1"
wire_api = "responses"
requires_openai_auth = false
env_key = "BOTMUX_TEST_LOCAL_API_KEY"
`);
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: directory, CODEX_HOME: codexHome, TERM: 'xterm-256color', BOTMUX_TEST_LOCAL_API_KEY: 'local-fixture-only' };
    const processes: ChildProcessWithoutNullStreams[] = [];
    let terminal: pty.IPty | undefined;
    let terminalExited = false;
    try {
      const seed = startAppServer(codexBin!, workspace, env);
      processes.push(seed.child);
      await seed.request('initialize', { clientInfo: { name: 'botmux-quiet-resume-test', version: '1.0.0' }, capabilities: { experimentalApi: true } });
      seed.notify('initialized');
      const started = await seed.request('thread/start', { cwd: workspace, approvalPolicy: 'never', sandbox: 'danger-full-access', persistExtendedHistory: true });
      const threadId = started.thread.id;
      await seed.request('turn/start', { threadId, input: [{ type: 'text', text: 'Create local seed history.', text_elements: [] }] });
      await until(() => seed.notifications.some(event => event.method === 'turn/completed'), () => JSON.stringify({ notifications: seed.notifications, stderr: seed.stderr }));
      expect(seed.notifications.find(event => event.method === 'turn/completed')?.params.turn.status).toBe('completed');
      expect(seed.notifications.some(event => event.method === 'thread/tokenUsage/updated')).toBe(true);
      const seedUsage = seed.notifications.filter(event => event.method === 'thread/tokenUsage/updated').at(-1).params.tokenUsage.total;
      await stop(seed.child);
      const usageBefore = usageRecords(codexHome);
      expect(usageBefore.length).toBeGreaterThan(0);
      const requestCountBefore = requests.length;
      expect(requests.filter(request => request.path === '/v1/responses')).toHaveLength(1);

      const resumed = startAppServer(codexBin!, workspace, env);
      processes.push(resumed.child);
      await resumed.request('initialize', { clientInfo: { name: 'botmux-quiet-resume-test', version: '1.0.0' }, capabilities: { experimentalApi: true } });
      resumed.notify('initialized');
      const restored = await resumed.request('thread/resume', { threadId, cwd: workspace, approvalPolicy: 'never', sandbox: 'danger-full-access', persistExtendedHistory: true });
      expect(restored.thread.id).toBe(threadId);
      expect(restored.thread.turns.length).toBeGreaterThan(0);
      await new Promise(resolve => setTimeout(resolve, observeMs));
      expect(requests).toHaveLength(requestCountBefore);
      // Codex replays the persisted usage snapshot while resuming. It is not
      // new consumption: every replay must equal the completed seed total.
      const replayedUsage = resumed.notifications.filter(event => event.method === 'thread/tokenUsage/updated');
      for (const event of replayedUsage) expect(event.params.tokenUsage.total).toEqual(seedUsage);
      expect(usageRecords(codexHome)).toEqual(usageBefore);
      await stop(resumed.child);

      const args = createCodexAdapter(codexBin).buildArgs({ sessionId: 'quiet-resume-local-test', resume: true, resumeSessionId: threadId, quietResume: true, bypassHookTrust: true });
      let screen = '';
      terminal = pty.spawn(codexBin!, args, { name: 'xterm-256color', cols: 120, rows: 40, cwd: workspace, env });
      terminal.onData(data => { screen += data; });
      terminal.onExit(() => { terminalExited = true; });
      await until(() => screen.includes('quiet-resume-test') && screen.includes('›'), () => screen);
      await new Promise(resolve => setTimeout(resolve, observeMs));
      expect(terminalExited).toBe(false);
      expect(requests).toHaveLength(requestCountBefore);
      expect(usageRecords(codexHome)).toEqual(usageBefore);
      const report = { binary: codexBin, version: execFileSync(codexBin!, ['--version'], { env, encoding: 'utf8' }).trim(), threadId, provider: 'localhost fixture only', seedInferenceRequests: 1, seedUsage, replayedHistoricalUsageEvents: replayedUsage.length, appServerObservationMs: observeMs, tuiObservationMs: observeMs, additionalInferenceRequests: requests.length - requestCountBefore, additionalUsageRecords: usageRecords(codexHome).length - usageBefore.length, tuiArgs: args };
      if (process.env.BOTMUX_TEST_REAL_CODEX_REPORT) writeFileSync(process.env.BOTMUX_TEST_REAL_CODEX_REPORT, JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report));
    } finally {
      if (terminal && !terminalExited) {
        terminal.kill();
        await until(() => terminalExited, () => 'PTY did not exit', 3_000);
      }
      await Promise.all(processes.map(stop));
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
