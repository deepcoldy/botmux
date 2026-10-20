import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyRemoteRunnerOutboundHostResult,
  sendRemoteRunnerOutboundMessage,
} from '../src/services/remote-runner-outbound-send.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('remote runner outbound host send', () => {
  it('forces the current session and the bounded interim send shape', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-remote-outbound-test-'));
    roots.push(root);
    const observed = join(root, 'observed.json');
    const fixture = join(root, 'fixture.mjs');
    writeFileSync(fixture, `#!/usr/bin/env node
import fs from 'node:fs';
const argv = process.argv.slice(2);
const value = flag => argv[argv.indexOf(flag) + 1];
const values = flag => argv.flatMap((item, index) => item === flag ? [argv[index + 1]] : []);
fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify({
  argv,
  content: fs.readFileSync(value('--content-file'), 'utf8'),
  images: values('--images').map(path => ({ name: ${JSON.stringify('placeholder')}, actualName: path.split('/').pop(), bytes: fs.readFileSync(path).toString('hex') })),
  authorized: process.env.BOTMUX_HOST_RELAY_AUTHORIZED,
  sessionId: process.env.BOTMUX_SESSION_ID,
  turnId: process.env.BOTMUX_TURN_ID,
  dispatchAttempt: process.env.BOTMUX_DISPATCH_ATTEMPT,
}));
process.stdout.write(JSON.stringify({ success: true, messageId: 'om_remote_outbound' }) + '\\n');
`);
    chmodSync(fixture, 0o755);

    await expect(sendRemoteRunnerOutboundMessage({
      operationId: 'operation-1',
      turnId: 'turn-1',
      generation: 2,
      content: '阶段进展',
      responseKind: 'progress',
      mention: 'requester',
      images: [{
        name: 'proof.png',
        mimeType: 'image/png',
        dataBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64'),
      }],
    }, {
      sessionId: 'session-1',
      turnId: 'turn-1',
      dispatchAttempt: 3,
      cliPath: fixture,
      env: { PATH: process.env.PATH },
    })).resolves.toEqual({ outcome: 'delivered', messageId: 'om_remote_outbound' });

    expect(JSON.parse(readFileSync(observed, 'utf8'))).toMatchObject({
      argv: [
        'send', '--remote-runner-outbound',
        '--response-kind', 'progress',
        '--mention-back',
        '--content-file', expect.any(String),
        '--images', expect.any(String),
        '--session-id', 'session-1',
      ],
      content: '阶段进展',
      images: [{
        name: 'placeholder',
        actualName: 'image-0-proof.png',
        bytes: '89504e470d0a1a0a',
      }],
      authorized: '1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      dispatchAttempt: '3',
    });
  });

  it('distinguishes policy rejection from an unknown provider outcome', () => {
    expect(classifyRemoteRunnerOutboundHostResult(2, '', 'mention decision rejected'))
      .toEqual({
        outcome: 'rejected',
        code: 'outbound_rejected',
        message: 'mention decision rejected',
      });
    expect(classifyRemoteRunnerOutboundHostResult(1, '', 'provider response lost'))
      .toEqual({
        outcome: 'unknown',
        code: 'outbound_delivery_unknown',
        message: 'provider response lost',
      });
  });

  it('passes explicit mention arguments to the ordinary host send policy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-remote-outbound-mention-test-'));
    roots.push(root);
    const observed = join(root, 'observed.json');
    const fixture = join(root, 'fixture.mjs');
    writeFileSync(fixture, `#!/usr/bin/env node
import fs from 'node:fs';
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify(argv));
process.stdout.write(JSON.stringify({ success: true, messageId: 'om_explicit_mention' }) + '\\n');
`);
    chmodSync(fixture, 0o755);

    await expect(sendRemoteRunnerOutboundMessage({
      operationId: 'operation-explicit',
      turnId: 'turn-explicit',
      generation: 2,
      content: '请查看',
      responseKind: 'auxiliary',
      mention: 'explicit',
      mentions: ['ou_target:Target', 'target@example.com:Target by email'],
    }, {
      sessionId: 'session-explicit',
      turnId: 'turn-explicit',
      cliPath: fixture,
      env: { PATH: process.env.PATH },
    })).resolves.toEqual({ outcome: 'delivered', messageId: 'om_explicit_mention' });

    expect(JSON.parse(readFileSync(observed, 'utf8'))).toEqual([
      'send', '--remote-runner-outbound',
      '--response-kind', 'auxiliary',
      '--mention', 'ou_target:Target',
      '--mention', 'target@example.com:Target by email',
      '--content-file', expect.any(String),
      '--session-id', 'session-explicit',
    ]);
  });

  it('re-enters the ordinary final-send path for a negotiated final message', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-remote-outbound-final-test-'));
    roots.push(root);
    const observed = join(root, 'observed.json');
    const fixture = join(root, 'fixture.mjs');
    writeFileSync(fixture, `#!/usr/bin/env node
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ success: true, messageId: 'om_final' }) + '\\n');
`);
    chmodSync(fixture, 0o755);

    await expect(sendRemoteRunnerOutboundMessage({
      operationId: 'operation-final',
      turnId: 'turn-final',
      generation: 2,
      content: '最终正文',
      responseKind: 'final',
      mention: 'explicit',
      mentions: ['ou_target:Target'],
    }, {
      sessionId: 'session-final',
      turnId: 'turn-final',
      cliPath: fixture,
      env: { PATH: process.env.PATH },
    })).resolves.toEqual({ outcome: 'delivered', messageId: 'om_final' });

    expect(JSON.parse(readFileSync(observed, 'utf8'))).toEqual([
      'send', '--remote-runner-outbound',
      '--response-kind', 'final',
      '--mention', 'ou_target:Target',
      '--content-file', expect.any(String),
      '--session-id', 'session-final',
    ]);
  });
});
