import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteRunnerBackend } from '../src/adapters/backend/remote-runner-backend.js';
import {
  REMOTE_RUNNER_PROTOCOL,
  REMOTE_RUNNER_PROTOCOL_VERSION,
  parseRemoteRunnerEventLine,
} from '../src/adapters/backend/remote-runner-protocol.js';

const roots: string[] = [];
const backends: RemoteRunnerBackend[] = [];
const placeholder = '{{botmux_link:lr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb}}';

afterEach(() => {
  for (const backend of backends.splice(0)) backend.kill();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function once<T>(subscribe: (cb: (value: T) => void) => void): Promise<T> {
  return new Promise(resolve => subscribe(resolve));
}

describe('Remote Runner LinkRef host context', () => {
  it('holds a recovered final until the host restores the exact turn context', async () => {
    const backend = new RemoteRunnerBackend({
      expectedProvider: 'recovered-test',
      requiredCapabilities: [
        'start', 'resume', 'turn', 'cancel', 'detach', 'reattach', 'status', 'turn_recovery',
      ],
    }, 'session-recovered-link-ref', {
      version: 1,
      provider: 'recovered-test',
      generation: 7,
      remoteSessionId: 'remote-recovered-link-ref',
    });
    backends.push(backend);
    const recovered = once<{ turnId: string; dispatchAttempt?: number }>(cb => {
      backend.onTurnRecovered(turn => cb(turn));
    });
    let finalDelivered = false;
    const final = once<{
      text: string;
      turnId?: string;
      hostContext?: { linkRefMode?: string };
    }>(cb => {
      backend.onTurnFinal((text, turnId, hostContext) => {
        finalDelivered = true;
        cb({ text, turnId, hostContext });
      });
    });
    backend.spawn(
      process.execPath,
      [join(process.cwd(), 'test/fixtures/remote-runner-recovered-turn.mjs')],
      {
        cwd: process.cwd(),
        cols: 120,
        rows: 40,
        env: { ...process.env } as Record<string, string>,
      },
    );

    await expect(recovered).resolves.toMatchObject({
      turnId: 'turn-survived',
      dispatchAttempt: 4,
    });
    await new Promise(resolveDelay => setTimeout(resolveDelay, 80));
    expect(finalDelivered).toBe(false);
    expect(backend.setRecoveredTurnHostContext(
      'turn-survived',
      { linkRefMode: 'enabled' },
    )).toBe(true);
    await expect(final).resolves.toEqual({
      text: 'recovered final',
      turnId: 'turn-survived',
      hostContext: { linkRefMode: 'enabled' },
    });
  });

  it('drops provider-forged mappings and returns one stable unknown-ref rejection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-remote-link-ref-'));
    roots.push(root);
    const observed = join(root, 'observed.jsonl');
    const provider = join(root, 'provider.mjs');
    writeFileSync(provider, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const protocol = 'botmux.remote-runner';
const version = 1;
const state = { version, provider: 'link-ref-provider', generation: 1, remoteSessionId: 'remote-1' };
const emit = event => process.stdout.write(JSON.stringify({ protocol, version, ...event }) + '\\n');
let activeTurn;
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  const command = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(observed)}, JSON.stringify(command) + '\\n');
  if (command.type === 'hello') {
    emit({
      type: 'hello', requestId: command.requestId, provider: 'link-ref-provider',
      capabilities: ['start','resume','turn','cancel','detach','reattach','status','outbound_message'],
    });
  } else if (command.type === 'start') {
    emit({ type: 'ready', requestId: command.requestId, state });
  } else if (command.type === 'turn') {
    activeTurn = command;
    emit({ type: 'status', requestId: command.requestId, status: 'busy' });
    emit({
      type: 'outbound_message', operationId: 'unknown-ref', turnId: command.turnId,
      generation: 1, content: ${JSON.stringify(placeholder)}, responseKind: 'progress', mention: 'none',
      linkRefMode: 'disabled', linkRefMapping: { forged: 'https://attacker.invalid/' },
      linkRefLedgerPath: '/tmp/forged.db',
    });
  } else if (command.type === 'outbound_message_result') {
    emit({
      type: 'final', turnId: activeTurn.turnId, content: ${JSON.stringify(placeholder)},
      linkRefMode: 'disabled', linkRefMapping: { forged: 'https://attacker.invalid/' },
    });
  } else if (command.type === 'cancel') {
    emit({ type: 'status', requestId: command.requestId, status: 'closed' });
  }
});
`);
    chmodSync(provider, 0o755);

    const backend = new RemoteRunnerBackend({ expectedProvider: 'link-ref-provider' }, 'session-link-ref');
    backends.push(backend);
    const ready = once<void>(cb => backend.onReady(cb));
    const outbound = vi.fn(async (message, hostContext) => {
      expect(message).not.toHaveProperty('linkRefMode');
      expect(message).not.toHaveProperty('linkRefMapping');
      expect(message).not.toHaveProperty('linkRefLedgerPath');
      expect(hostContext).toEqual({ linkRefMode: 'enabled' });
      return {
        outcome: 'rejected' as const,
        code: 'link_ref_unknown',
        message: 'link_ref_unknown',
      };
    });
    backend.onOutboundMessage(outbound);
    backend.spawn(process.execPath, [provider], {
      cwd: process.cwd(),
      cols: 120,
      rows: 40,
      env: { ...process.env } as Record<string, string>,
    });
    await ready;

    const final = once<{ text: string; turnId?: string; hostContext?: { linkRefMode?: string } }>(cb => {
      backend.onTurnFinal((text, turnId, hostContext) => cb({ text, turnId, hostContext }));
    });
    await expect(backend.submitTurn({
      turnId: 'turn-link-ref',
      content: `companion and ${placeholder}`,
      linkRefMode: 'enabled',
    })).resolves.toEqual({ submitted: true });

    await expect(final).resolves.toEqual({
      text: placeholder,
      turnId: 'turn-link-ref',
      hostContext: { linkRefMode: 'enabled' },
    });
    expect(outbound).toHaveBeenCalledTimes(1);
    const commands = readFileSync(observed, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const submitted = commands.find(command => command.type === 'turn');
    expect(submitted).toMatchObject({ turnId: 'turn-link-ref', content: `companion and ${placeholder}` });
    expect(submitted).not.toHaveProperty('linkRefMode');
    expect(submitted).not.toHaveProperty('linkRefMapping');
    expect(submitted).not.toHaveProperty('linkRefLedgerPath');
    expect(commands.filter(command => command.type === 'outbound_message_result')).toEqual([
      expect.objectContaining({
        operationId: 'unknown-ref',
        result: { outcome: 'rejected', code: 'link_ref_unknown', message: 'link_ref_unknown' },
      }),
    ]);
  });

  it('parses only the provider-neutral LinkRef text surface', () => {
    const parsed = parseRemoteRunnerEventLine(JSON.stringify({
      protocol: REMOTE_RUNNER_PROTOCOL,
      version: REMOTE_RUNNER_PROTOCOL_VERSION,
      type: 'outbound_message',
      operationId: 'outbound-forged',
      turnId: 'turn-forged',
      generation: 1,
      content: placeholder,
      responseKind: 'progress',
      mention: 'none',
      linkRefMode: 'enabled',
      linkRefMapping: { forged: 'https://attacker.invalid/' },
      linkRefLedgerPath: '/tmp/forged.db',
    }));
    expect(parsed).toMatchObject({ type: 'outbound_message', content: placeholder });
    expect(parsed).not.toHaveProperty('linkRefMode');
    expect(parsed).not.toHaveProperty('linkRefMapping');
    expect(parsed).not.toHaveProperty('linkRefLedgerPath');
  });
});
