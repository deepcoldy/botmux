import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnTsScript } from './helpers/ts-runner.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import {
  RELAY_ORIGIN_CAPABILITY_BASENAME,
  replaceManagedOriginCapabilityFile,
} from '../src/core/managed-origin-capability.js';

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
  it('forwards an omitted response kind through the Riff relay as non-final', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-cli-riff-feedback-'));
    const outbox = join(root, 'outbox');
    const dataDir = join(root, 'data');
    const capability = 'ab'.repeat(32);
    writeFileSync(join(root, 'placeholder'), '');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(outbox, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    replaceManagedOriginCapabilityFile(join(outbox, RELAY_ORIGIN_CAPABILITY_BASENAME), JSON.stringify({
      token: capability,
      turnId: 'turn-riff-feedback',
      dispatchAttempt: 1,
    }));
    const fixture = join(root, 'host-send.mjs');
    writeFileSync(fixture, `
      import { readFileSync } from 'node:fs';
      const argv = process.argv.slice(2);
      process.stdout.write(JSON.stringify({
        content: readFileSync(argv[argv.indexOf('--content-file') + 1], 'utf8'),
        responseKind: argv.includes('--response-kind') ? argv[argv.indexOf('--response-kind') + 1] : null,
      }));
    `);
    const stop = (await import('../src/adapters/backend/sandbox.js')).startOutboxWatcher(
      outbox,
      { ...process.env },
      'sid-riff-feedback',
      {
        cliPath: fixture,
        authorize: claim => claim.capability === capability
          ? { ok: true as const, origin: { turnId: 'turn-riff-feedback', dispatchAttempt: 1 } }
          : { ok: false as const, error: 'stale' },
      },
    );
    try {
      const childResult = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolvePromise, rejectPromise) => {
        const cli = spawnTsScript(resolve('src/cli.ts'), [
          'send', 'unclassified Riff progress', '--session-id', 'sid-riff-feedback', '--no-mention',
        ], {
          cwd: resolve('.'),
          env: {
            ...process.env,
            HOME: root,
            SESSION_DATA_DIR: dataDir,
            BOTMUX_SESSION_ID: 'sid-riff-feedback',
            BOTMUX_SEND_RELAY: outbox,
            BOTMUX_FEEDBACK_POLICY: JSON.stringify({ enabled: true }),
            BOTMUX_WORKFLOW: '',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        cli.stdout?.on('data', chunk => { stdout += String(chunk); });
        cli.stderr?.on('data', chunk => { stderr += String(chunk); });
        cli.once('error', rejectPromise);
        cli.once('close', status => resolvePromise({ status, stdout, stderr }));
      });
      expect(childResult.status, childResult.stderr).toBe(0);
      expect(JSON.parse(childResult.stdout)).toEqual({
        content: 'unclassified Riff progress',
        responseKind: null,
      });
    } finally {
      stop();
      rmSync(root, { recursive: true, force: true });
    }
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
      child = spawnTsScript(resolve('src/worker.ts'), [], {
        cwd: resolve('.'),
        env: {
          ...process.env,
          HOME: root,
          SESSION_DATA_DIR: root,
          BOTS_CONFIG: botsPath,
          BOTMUX_SESSION_ID: 'sid-riff-env',
          LARK_APP_ID: appId,
          LARK_APP_SECRET: 'secret',
          BOTMUX_WORKFLOW_ENABLED: 'true',
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
            // A stale / attacker-shaped backend env trying to flip the workflow
            // kill-switch OFF in the remote pane. riffCfg.env merges LAST and is
            // NOT sanitized (unlike per-bot env), so the host must re-freeze the
            // resolved value after the merge — otherwise this would desync the
            // pane's CLI-side gate from the daemon's authoritative decision.
            BOTMUX_WORKFLOW_ENABLED: 'false',
            BOTMUX_REPLY_STYLE: JSON.stringify({ layout: true, theme: 'vivid' }),
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
        replyStyle: {
          recipes: false,
          layout: false,
          theme: 'minimal',
          layoutTags: { blocked: '请处理' },
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
      // The workflow kill-switch is host-resolved and re-frozen after the merge:
      // the host is explicitly forced ON (BOTMUX_WORKFLOW_ENABLED=true in the
      // worker env), so the stale backendConfig.env `false` must NOT survive
      // into the remote pane.
      expect(request.config?.env?.BOTMUX_WORKFLOW_ENABLED).toBe('true');
      // replyStyle is another host-normalized spawn snapshot. The raw Riff env
      // tries to replace it above, but the worker must re-freeze the init value.
      expect(JSON.parse(request.config?.env?.BOTMUX_REPLY_STYLE)).toEqual({
        recipes: false,
        layout: false,
        theme: 'minimal',
        layoutTags: { blocked: '请处理' },
      });
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
