import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseExactChatGrantCliArgs } from '../src/cli/exact-chat-grant.js';

const CLI_PATH = join(__dirname, '..', 'src', 'cli.ts');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI_PATH, ...args], {
      env: { ...process.env, ...env, BOTMUX_WORKFLOW: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', status => resolve({ status, stdout, stderr }));
  });
}

describe('exact chat-grant CLI parser', () => {
  it('accepts equals syntax and repeated subject flags', () => {
    expect(parseExactChatGrantCliArgs([
      'chat',
      '--bot=receiver',
      '--chat-id=oc_chat',
      '--subject-open-id=ou_a',
      '--subject-open-id', 'ou_b',
    ])).toEqual({
      ok: true,
      value: {
        operation: 'grant',
        receiverRef: 'receiver',
        chatId: 'oc_chat',
        subjectOpenIds: ['ou_a', 'ou_b'],
        subjectLarkAppIds: [],
      },
    });
  });

  it('accepts repeated stable subject-bot app identities for grant', () => {
    expect(parseExactChatGrantCliArgs([
      'chat',
      '--bot', 'receiver',
      '--chat-id', 'oc_chat',
      '--subject-bot=cli_peer_a',
      '--subject-bot', 'cli_peer_b',
    ])).toEqual({
      ok: true,
      value: {
        operation: 'grant',
        receiverRef: 'receiver',
        chatId: 'oc_chat',
        subjectOpenIds: [],
        subjectLarkAppIds: ['cli_peer_a', 'cli_peer_b'],
      },
    });
  });

  it('parses symmetric revoke/readback operations', () => {
    expect(parseExactChatGrantCliArgs([
      'chat', 'revoke', '--bot', 'r', '--chat-id', 'oc_c', '--subject-open-id', 'ou_a',
    ])).toMatchObject({ ok: true, value: { operation: 'revoke' } });
    expect(parseExactChatGrantCliArgs([
      'chat', 'readback', '--bot', 'r', '--chat-id', 'oc_c', '--subject-open-id', 'ou_a',
    ])).toMatchObject({ ok: true, value: { operation: 'readback' } });
  });

  it.each([
    {
      label: 'subject flag followed by another flag',
      args: ['chat', '--bot', 'r', '--chat-id', 'oc_c', '--subject-open-id', '--bot', 'other'],
      error: '--subject-open-id 缺少值',
    },
    {
      label: 'empty equals value',
      args: ['chat', '--bot', 'r', '--chat-id', 'oc_c', '--subject-open-id='],
      error: '--subject-open-id 缺少值',
    },
    {
      label: 'duplicate bot',
      args: ['chat', '--bot', 'r', '--bot', 'r2', '--chat-id', 'oc_c', '--subject-open-id', 'ou_a'],
      error: '必须且只能传一个 --bot',
    },
    {
      label: 'duplicate chat',
      args: ['chat', '--bot', 'r', '--chat-id', 'oc_c', '--chat-id', 'oc_d', '--subject-open-id', 'ou_a'],
      error: '必须且只能传一个 --chat-id',
    },
    {
      label: 'unknown flag',
      args: ['chat', '--bot', 'r', '--chat-id', 'oc_c', '--subject-open-id', 'ou_a', '--all'],
      error: '未知参数: --all',
    },
    {
      label: 'unknown positional',
      args: ['chat', 'oops', '--bot', 'r', '--chat-id', 'oc_c', '--subject-open-id', 'ou_a'],
      error: '未知参数: oops',
    },
    {
      label: 'mixed open-id and stable app identity subjects',
      args: ['chat', '--bot', 'r', '--chat-id', 'oc_c', '--subject-open-id', 'ou_a', '--subject-bot', 'cli_peer'],
      error: '严格二选一',
    },
    {
      label: 'stable app identity on revoke',
      args: ['chat', 'revoke', '--bot', 'r', '--chat-id', 'oc_c', '--subject-bot', 'cli_peer'],
      error: '--subject-bot 仅支持 grant',
    },
    {
      label: 'stable app identity on readback',
      args: ['chat', 'readback', '--bot', 'r', '--chat-id', 'oc_c', '--subject-bot', 'cli_peer'],
      error: '--subject-bot 仅支持 grant',
    },
    {
      label: 'subject-bot flag followed by another flag',
      args: ['chat', '--bot', 'r', '--chat-id', 'oc_c', '--subject-bot', '--bot', 'other'],
      error: '--subject-bot 缺少值',
    },
  ])('rejects $label without swallowing flags', ({ args, error }) => {
    const result = parseExactChatGrantCliArgs(args);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain(error);
  });
});

describe('botmux grant chat CLI boundary', () => {
  it('resolves the receiver, signs localhost IPC, and forwards repeated subjects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-exact-grant-cli-'));
    tempDirs.push(root);
    const home = join(root, 'home');
    const configDir = join(home, '.botmux');
    const dataDir = join(root, 'data');
    const registryDir = join(dataDir, 'dashboard-daemons');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(registryDir, { recursive: true });
    const secret = 'exact-grant-cli-test-secret';
    writeFileSync(join(configDir, '.dashboard-secret'), secret);
    const botsConfig = join(root, 'bots.json');
    writeFileSync(botsConfig, JSON.stringify([{
      larkAppId: 'cli_receiver',
      larkAppSecret: 'secret',
      cliId: 'codex',
      allowedUsers: ['ou_owner'],
    }]));
    writeFileSync(join(dataDir, 'bots-info.json'), JSON.stringify([{
      larkAppId: 'cli_receiver',
      botOpenId: 'ou_receiver',
      botName: 'Receiver Bot',
      cliId: 'codex',
    }]));

    let requestCount = 0;
    let capturedBody: any;
    let capturedHeaders: Record<string, string | string[] | undefined> = {};
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        requestCount++;
        capturedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        capturedHeaders = req.headers;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          operation: capturedBody.operation,
          permissionSource: 'chatGrant',
          talkOnly: true,
          receiverLarkAppId: capturedBody.receiverLarkAppId,
          chatId: capturedBody.chatId,
          grantsTalk: true,
          grantsOperate: false,
          subjects: capturedBody.subjectOpenIds.map((subjectOpenId: string) => ({
            subjectOpenId,
            chatGrantActive: true,
            changed: true,
            grantsTalk: true,
            grantsOperate: false,
          })),
        }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      writeFileSync(join(registryDir, 'cli_receiver.json'), JSON.stringify({
        larkAppId: 'cli_receiver',
        ipcPort: port,
        lastHeartbeat: Date.now(),
      }));

      const result = await runCli([
        'grant', 'chat',
        '--bot', 'Receiver Bot',
        '--chat-id', 'oc_chat',
        '--subject-open-id', 'ou_peer_a',
        '--subject-open-id=ou_peer_b',
      ], {
        HOME: home,
        USERPROFILE: home,
        SESSION_DATA_DIR: dataDir,
        BOTS_CONFIG: botsConfig,
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        talkOnly: true,
        grantsOperate: false,
      });
      expect(requestCount).toBe(1);
      expect(capturedBody).toEqual({
        operation: 'grant',
        receiverLarkAppId: 'cli_receiver',
        chatId: 'oc_chat',
        subjectOpenIds: ['ou_peer_a', 'ou_peer_b'],
      });

      const ts = String(capturedHeaders['x-botmux-cli-ts']);
      const nonce = String(capturedHeaders['x-botmux-cli-nonce']);
      const expected = createHmac('sha256', secret)
        .update(`${ts}:${nonce}:POST /api/grants/chat ${port}`)
        .digest('base64url');
      expect(capturedHeaders['x-botmux-cli-auth']).toBe(expected);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    }
  });

  it('rejects a missing repeated-flag value before making any IPC request', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-exact-grant-cli-'));
    tempDirs.push(root);
    const result = await runCli([
      'grant', 'chat',
      '--bot', 'cli_receiver',
      '--chat-id', 'oc_chat',
      '--subject-open-id', '--bot', 'other',
    ], {
      HOME: join(root, 'home'),
      USERPROFILE: join(root, 'home'),
      SESSION_DATA_DIR: join(root, 'data'),
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--subject-open-id 缺少值');
  });

  it('forwards stable subject-bot identities without converting them in the CLI', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-exact-grant-cli-'));
    tempDirs.push(root);
    const home = join(root, 'home');
    const configDir = join(home, '.botmux');
    const dataDir = join(root, 'data');
    const registryDir = join(dataDir, 'dashboard-daemons');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(join(configDir, '.dashboard-secret'), 'exact-grant-cli-stable-subject-secret');
    const botsConfig = join(root, 'bots.json');
    writeFileSync(botsConfig, JSON.stringify([{
      larkAppId: 'cli_receiver',
      larkAppSecret: 'secret',
      cliId: 'codex',
      allowedUsers: ['ou_owner'],
    }]));
    writeFileSync(join(dataDir, 'bots-info.json'), JSON.stringify([{
      larkAppId: 'cli_receiver',
      botOpenId: 'ou_receiver',
      botName: 'Receiver Bot',
      cliId: 'codex',
    }]));

    let capturedBody: any;
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        capturedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          operation: 'grant',
          permissionSource: 'chatGrant',
          talkOnly: true,
          receiverLarkAppId: capturedBody.receiverLarkAppId,
          chatId: capturedBody.chatId,
          grantsTalk: true,
          grantsOperate: false,
          subjectMappings: capturedBody.subjectLarkAppIds.map((larkAppId: string, index: number) => ({
            larkAppId,
            subjectOpenId: `ou_resolved_${index}`,
          })),
        }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      writeFileSync(join(registryDir, 'cli_receiver.json'), JSON.stringify({
        larkAppId: 'cli_receiver',
        ipcPort: port,
        lastHeartbeat: Date.now(),
      }));

      const result = await runCli([
        'grant', 'chat',
        '--bot', 'Receiver Bot',
        '--chat-id', 'oc_chat',
        '--subject-bot', 'cli_peer_a',
        '--subject-bot=cli_peer_b',
      ], {
        HOME: home,
        USERPROFILE: home,
        SESSION_DATA_DIR: dataDir,
        BOTS_CONFIG: botsConfig,
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        talkOnly: true,
        grantsOperate: false,
      });
      expect(capturedBody).toEqual({
        operation: 'grant',
        receiverLarkAppId: 'cli_receiver',
        chatId: 'oc_chat',
        subjectLarkAppIds: ['cli_peer_a', 'cli_peer_b'],
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    }
  });

  it('rejects subject-bot for readback at the CLI boundary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-exact-grant-cli-'));
    tempDirs.push(root);
    const result = await runCli([
      'grant', 'chat', 'readback',
      '--bot', 'cli_receiver',
      '--chat-id', 'oc_chat',
      '--subject-bot', 'cli_peer',
    ], {
      HOME: join(root, 'home'),
      USERPROFILE: join(root, 'home'),
      SESSION_DATA_DIR: join(root, 'data'),
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--subject-bot 仅支持 grant');
  });
});
