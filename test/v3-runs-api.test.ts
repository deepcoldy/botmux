import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Writable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { appendEvent } from '../src/workflows/v3/journal.js';
import { handleV3RunsApi } from '../src/dashboard/v3-runs-api.js';

/** Minimal ServerResponse mock: a real Writable (so createReadStream.pipe
 *  works) with writeHead/end capture. */
function mockRes() {
  const chunks: Buffer[] = [];
  let status = 0;
  let headers: Record<string, string> = {};
  const w = new Writable({
    write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
  });
  (w as unknown as ServerResponse).writeHead = ((s: number, h?: Record<string, string>) => {
    status = s; if (h) headers = h; return w as unknown as ServerResponse;
  }) as ServerResponse['writeHead'];
  return {
    res: w as unknown as ServerResponse,
    done: new Promise<void>((resolve) => w.on('finish', resolve)),
    get status() { return status; },
    get headers() { return headers; },
    body() { return Buffer.concat(chunks).toString('utf-8'); },
    json() { return JSON.parse(Buffer.concat(chunks).toString('utf-8')); },
  };
}

function get(path: string): { req: IncomingMessage; url: URL } {
  return { req: { method: 'GET' } as IncomingMessage, url: new URL(`http://x${path}`) };
}

function buildRun(runsDir: string, runId: string): string {
  const runDir = join(runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'dag.json'), JSON.stringify({
    runId,
    nodes: [{ id: 'research', type: 'goal', goal: 'g', depends: [], inputs: [] }],
  }));
  const jp = join(runDir, 'journal.ndjson');
  appendEvent(jp, { type: 'runStarted', runId });
  appendEvent(jp, { type: 'nodeDispatched', nodeId: 'research', attemptId: 'research/attempts/001' });
  appendEvent(jp, {
    type: 'nodeSessionReady', nodeId: 'research', attemptId: 'research/attempts/001',
    sessionInfo: { sessionId: 's', webPort: 5101 },
    ptyLogPath: join(runDir, 'research/attempts/001/pty.log'),
  });
  return runDir;
}

describe('v3-runs-api', () => {
  it('GET /api/v3/runs → 200 + runs[]', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-api-'));
    try {
      buildRun(base, 'r-260602-0907');
      const { req, url } = get('/api/v3/runs');
      const m = mockRes();
      const handled = await handleV3RunsApi(req, m.res, url, { runsDir: base }, false);
      expect(handled).toBe(true);
      expect(m.status).toBe(200);
      const body = m.json() as { runs: Array<{ runId: string }> };
      expect(body.runs.map((r) => r.runId)).toContain('r-260602-0907');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('GET /api/v3/runs/:id → 200 + RunView', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-api-'));
    try {
      buildRun(base, 'r-260602-0907');
      const { req, url } = get('/api/v3/runs/r-260602-0907');
      const m = mockRes();
      await handleV3RunsApi(req, m.res, url, { runsDir: base }, false);
      expect(m.status).toBe(200);
      const view = m.json() as { runId: string; nodes: Array<{ id: string; webTerminal?: unknown }> };
      expect(view.runId).toBe('r-260602-0907');
      expect(view.nodes[0].id).toBe('research');
      // read-only DTO：webTerminal 无 token
      expect((view.nodes[0].webTerminal as Record<string, unknown>).token).toBeUndefined();
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('GET /api/v3/runs/:id 未知 → 404；非法字符 id → 404（isValidRunId 拒）', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-api-'));
    try {
      const m1 = mockRes();
      await handleV3RunsApi(get('/api/v3/runs/missing-260602-0000').req, m1.res, get('/api/v3/runs/missing-260602-0000').url, { runsDir: base }, false);
      expect(m1.status).toBe(404);
      // 单段但含非法字符（projectRunById 的 isValidRunId 拒 → 404）
      const m2 = mockRes();
      await handleV3RunsApi(get('/api/v3/runs/bad!id').req, m2.res, get('/api/v3/runs/bad!id').url, { runsDir: base }, false);
      expect(m2.status).toBe(404);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('GET pty-log 未授权 → 401（不泄漏原始终端字节）', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-api-'));
    try {
      buildRun(base, 'r-260602-0907');
      const p = '/api/v3/runs/r-260602-0907/nodes/research/pty-log';
      const m = mockRes();
      await handleV3RunsApi(get(p).req, m.res, get(p).url, { runsDir: base }, /*authed*/ false);
      expect(m.status).toBe(401);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('GET pty-log 已授权 + 文件存在 → 200 + 内容 + size header', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-api-'));
    try {
      const runDir = buildRun(base, 'r-260602-0907');
      const ptyDir = join(runDir, 'research/attempts/001');
      mkdirSync(ptyDir, { recursive: true });
      writeFileSync(join(ptyDir, 'pty.log'), 'hello pty bytes\n');
      const p = '/api/v3/runs/r-260602-0907/nodes/research/pty-log';
      const m = mockRes();
      await handleV3RunsApi(get(p).req, m.res, get(p).url, { runsDir: base }, /*authed*/ true);
      await m.done;
      expect(m.status).toBe(200);
      expect(m.headers['x-botmux-log-bytes']).toBe(String('hello pty bytes\n'.length));
      expect(m.body()).toContain('hello pty bytes');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('GET pty-log 已授权但无日志 → 404', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-api-'));
    try {
      buildRun(base, 'r-260602-0907'); // 事件里有路径，但 pty.log 文件没写出来
      const p = '/api/v3/runs/r-260602-0907/nodes/research/pty-log';
      const m = mockRes();
      await handleV3RunsApi(get(p).req, m.res, get(p).url, { runsDir: base }, true);
      expect(m.status).toBe(404);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('非 v3 路由 / 非 GET → 返回 false（交给后续 handler）', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-api-'));
    try {
      const m = mockRes();
      const handled = await handleV3RunsApi({ method: 'POST' } as IncomingMessage, m.res, new URL('http://x/api/v3/runs'), { runsDir: base }, false);
      expect(handled).toBe(false);
      const m2 = mockRes();
      const h2 = await handleV3RunsApi(get('/api/other').req, m2.res, get('/api/other').url, { runsDir: base }, false);
      expect(h2).toBe(false);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});
