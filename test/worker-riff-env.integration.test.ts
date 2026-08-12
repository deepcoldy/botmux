import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectPromise);
      resolvePromise();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Riff test server has no TCP address');
  return address.port;
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.once('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    req.once('error', rejectPromise);
  });
}

describe('Riff worker session environment', () => {
  it('defaults an omitted response kind to non-final in an env-only Riff CLI', () => {
    const source = readFileSync(resolve('src/cli.ts'), 'utf8');
    const cmdSendStart = source.indexOf('async function cmdSend(');
    const cmdDispatchStart = source.indexOf('async function cmdDispatch(', cmdSendStart);
    const cmdSend = source.slice(cmdSendStart, cmdDispatchStart);
    expect(cmdSend).toContain("const effectiveResponseKind = responseKind ?? 'progress'");
    expect(cmdSend).not.toContain('启用最终回答反馈后，必须显式指定 --response-kind progress|final');
    expect(cmdSend).not.toContain("feedbackPolicy && responseKind === 'final'");
  });

  it('forwards reply-card usage and the effective feedback policy into the remote sandbox', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-worker-riff-env-'));
    const sockets = new Set<Socket>();
    let child: ChildProcess | undefined;
    let settleRequest!: (body: Record<string, any>) => void;
    let rejectRequest!: (error: Error) => void;
    let requestSettled = false;
    const taskExecuteRequest = new Promise<Record<string, any>>((resolvePromise, rejectPromise) => {
      settleRequest = body => {
        if (requestSettled) return;
        requestSettled = true;
        resolvePromise(body);
      };
      rejectRequest = error => {
        if (requestSettled) return;
        requestSettled = true;
        rejectPromise(error);
      };
    });

    const server = createServer(async (req, res) => {
      if (req.url === '/api/task-execute' && req.method === 'POST') {
        try {
          settleRequest(JSON.parse(await readRequestBody(req)));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ success: true, data: { id: 'task-env-1', status: 'running' } }));
        } catch (error) {
          rejectRequest(error instanceof Error ? error : new Error(String(error)));
          res.writeHead(400);
          res.end();
        }
        return;
      }
      if (req.url?.startsWith('/api2/task-stream')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(': keepalive\n\n');
        return;
      }
      if (req.url?.startsWith('/api/task-detail')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: { task: {} } }));
        return;
      }
      if (req.url === '/api/task-cancel') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: {} }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.on('connection', socket => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });

    try {
      const port = await listen(server);
      const appId = 'app_riff_usage_hidden';
      const botsPath = join(root, 'bots.json');
      writeFileSync(botsPath, JSON.stringify([{
        larkAppId: appId,
        larkAppSecret: 'secret',
        cliId: 'riff',
        backendType: 'riff',
        riff: { baseUrl: `http://127.0.0.1:${port}` },
        usageDisplay: 'footer',
      }]));

      const logs: string[] = [];
      child = spawn(process.execPath, ['--import', 'tsx', resolve('src/worker.ts')], {
        cwd: resolve('.'),
        env: {
          ...process.env,
          HOME: root,
          SESSION_DATA_DIR: root,
          BOTS_CONFIG: botsPath,
          BOTMUX_SESSION_ID: 'sid-riff-env',
          LARK_APP_ID: appId,
          LARK_APP_SECRET: 'secret',
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      child.stdout?.on('data', chunk => logs.push(chunk.toString()));
      child.stderr?.on('data', chunk => logs.push(chunk.toString()));
      child.on('message', (raw) => {
        const msg = raw as WorkerToDaemon;
        if (msg.type === 'error') {
          rejectRequest(new Error(`worker error: ${msg.message}\n${logs.join('')}`));
        }
      });
      child.once('exit', (code, signal) => {
        rejectRequest(new Error(`worker exited before task-execute (${code ?? signal})\n${logs.join('')}`));
      });

      const init: DaemonToWorker = {
        type: 'init',
        sessionId: 'sid-riff-env',
        chatId: 'oc_riff_env',
        rootMessageId: 'om_riff_env',
        workingDir: root,
        cliId: 'riff',
        backendType: 'riff',
        backendConfig: {
          baseUrl: `http://127.0.0.1:${port}`,
          injectStatusLines: false,
          env: {
            BOTMUX_OWNER_OPEN_ID: 'ou_stale_config_owner',
            __OWNER_OPEN_ID: 'ou_stale_config_owner',
          },
        },
        prompt: 'verify remote session environment',
        larkAppId: appId,
        larkAppSecret: 'secret',
        ownerOpenId: 'ou_authenticated_owner',
        feedback: {
          enabled: true,
          audience: 'requester',
          visibleSemantics: ['positive', 'progress', 'negative'],
          buttons: [
            { key: 'yes', label: 'Yes', semantic: 'positive', style: 'primary' },
            { key: 'progress', label: 'Progress', semantic: 'progress', style: 'default' },
            { key: 'no', label: 'No', semantic: 'negative', style: 'danger' },
          ],
          negativeFollowup: {
            reasons: [],
            comment: { enabled: false, required: false, placeholder: 'Explain', maxLength: 100 },
          },
          allowReselect: false,
        },
      };
      child.send(init);

      const request = await Promise.race([
        taskExecuteRequest,
        new Promise<never>((_, rejectPromise) => {
          setTimeout(() => rejectPromise(new Error(`task-execute timeout\n${logs.join('')}`)), 15_000);
        }),
      ]);
      expect(request.config?.env?.BOTMUX_USAGE_DISPLAY).toBe('footer');
      expect(request.config?.env?.BOTMUX_OWNER_OPEN_ID).toBe('ou_authenticated_owner');
      expect(request.config?.env?.__OWNER_OPEN_ID).toBe('ou_authenticated_owner');
      expect(JSON.parse(request.config?.env?.BOTMUX_FEEDBACK_POLICY)).toMatchObject({
        enabled: true,
        buttons: [{ key: 'yes' }, { key: 'progress' }, { key: 'no' }],
      });
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
      rmSync(root, { recursive: true, force: true });
    }
  }, 25_000);
});
