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
fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify({
  argv,
  content: fs.readFileSync(value('--content-file'), 'utf8'),
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
        '--session-id', 'session-1',
      ],
      content: '阶段进展',
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
});
