import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  remoteRunnerSessionToolArgs,
  runRemoteRunnerSessionTool,
} from '../src/services/remote-runner-session-tool.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('remote runner session tool host bridge', () => {
  it('maps structured requests to an allowlisted current-session argv', () => {
    expect(remoteRunnerSessionToolArgs({
      tool: 'history',
      limit: 20,
      scope: 'thread',
      withCardJson: true,
    }, 'session-1')).toEqual([
      'history', '--limit', '20', '--scope', 'thread', '--with-card-json',
      '--session-id', 'session-1',
    ]);
    expect(remoteRunnerSessionToolArgs({
      tool: 'skill.read',
      name: 'demo',
      path: 'references/guide.md',
    }, 'session-1')).toEqual([
      'skill', 'read', 'demo', 'references/guide.md',
    ]);
    expect(remoteRunnerSessionToolArgs({
      tool: 'quoted',
      messageId: 'om_demo',
      raw: true,
    }, 'session-1')).toEqual([
      'quoted', 'om_demo', '--remote-runner-session-tool', '--raw',
      '--session-id', 'session-1',
    ]);
  });

  it('freezes session authority and returns the exact child result', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-session-tool-test-'));
    roots.push(root);
    const observed = join(root, 'observed.json');
    const fixture = join(root, 'fixture.mjs');
    writeFileSync(fixture, `#!/usr/bin/env node
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify({
  argv: process.argv.slice(2),
  authorized: process.env.BOTMUX_HOST_RELAY_AUTHORIZED,
  sessionId: process.env.BOTMUX_SESSION_ID,
  turnId: process.env.BOTMUX_TURN_ID,
  dispatchAttempt: process.env.BOTMUX_DISPATCH_ATTEMPT,
}));
process.stdout.write(JSON.stringify({ total: 1 }) + '\\n');
`);
    chmodSync(fixture, 0o755);

    await expect(runRemoteRunnerSessionTool({
      tool: 'history',
      limit: 10,
      scope: 'ambient',
    }, {
      sessionId: 'session-1',
      turnId: 'turn-1',
      dispatchAttempt: 4,
      cliPath: fixture,
      env: { PATH: process.env.PATH },
    })).resolves.toEqual({
      outcome: 'completed',
      exitCode: 0,
      stdout: `${JSON.stringify({ total: 1 })}\n`,
      stderr: '',
    });

    expect(JSON.parse(readFileSync(observed, 'utf8'))).toEqual({
      argv: ['history', '--limit', '10', '--scope', 'ambient', '--session-id', 'session-1'],
      authorized: '1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      dispatchAttempt: '4',
    });
  });

  it('packages bounded quoted attachments without exposing host paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-session-tool-quoted-test-'));
    roots.push(root);
    const dataDir = join(root, 'data');
    const attachmentDir = join(dataDir, 'attachments', 'cli_test', 'om_test');
    mkdirSync(attachmentDir, { recursive: true });
    const attachment = join(attachmentDir, 'chart.png');
    writeFileSync(attachment, 'image-bytes');
    const fixture = join(root, 'fixture.mjs');
    writeFileSync(fixture, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  messageId: 'om_test',
  attachments: [{ type: 'image', name: 'chart.png', path: ${JSON.stringify(attachment)}, mimeType: 'image/png' }],
}) + '\\n');
`);
    chmodSync(fixture, 0o755);

    const result = await runRemoteRunnerSessionTool({
      tool: 'quoted',
      messageId: 'om_test',
      raw: true,
    }, {
      sessionId: 'session-1',
      turnId: 'turn-1',
      cliPath: fixture,
      env: { PATH: process.env.PATH, SESSION_DATA_DIR: dataDir },
    });

    expect(result).toMatchObject({
      outcome: 'completed',
      exitCode: 0,
      attachments: [{
        placeholder: 'botmux-session-tool://attachment/0',
        name: 'chart.png',
        type: 'image',
        mimeType: 'image/png',
        dataBase64: Buffer.from('image-bytes').toString('base64'),
      }],
    });
    expect(result.outcome === 'completed' ? result.stdout : '').not.toContain(attachment);
    expect(JSON.parse(result.outcome === 'completed' ? result.stdout : '')).toMatchObject({
      attachments: [{ path: 'botmux-session-tool://attachment/0' }],
    });
  });

  it('rejects quoted attachment paths outside the BotMux attachment root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-session-tool-escape-test-'));
    roots.push(root);
    const dataDir = join(root, 'data');
    mkdirSync(join(dataDir, 'attachments'), { recursive: true });
    const escaped = join(root, 'escaped.txt');
    writeFileSync(escaped, 'secret');
    const fixture = join(root, 'fixture.mjs');
    writeFileSync(fixture, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  attachments: [{ type: 'file', name: 'escaped.txt', path: ${JSON.stringify(escaped)} }],
}) + '\\n');
`);
    chmodSync(fixture, 0o755);

    await expect(runRemoteRunnerSessionTool({
      tool: 'quoted',
      messageId: 'om_test',
    }, {
      sessionId: 'session-1',
      turnId: 'turn-1',
      cliPath: fixture,
      env: { PATH: process.env.PATH, SESSION_DATA_DIR: dataDir },
    })).resolves.toMatchObject({
      outcome: 'rejected',
      code: 'session_tool_attachment_rejected',
    });
  });
});
