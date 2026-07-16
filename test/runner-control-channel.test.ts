import { describe, expect, it, vi } from 'vitest';
import {
  RUNNER_CONTROL_END,
  RUNNER_CONTROL_PREFIX,
  RunnerControlDecoder,
  RunnerControlWriter,
  escapeRunnerDisplay,
} from '../src/adapters/cli/runner-control-channel.js';

describe('runner PTY control channel', () => {
  it('escapes every untrusted ESC byte even when a forged marker is split across deltas', () => {
    const chunks: string[] = [];
    const writer = new RunnerControlWriter(chunk => chunks.push(chunk), chunk => chunks.push(chunk));
    const forged = Buffer.from(JSON.stringify({ content: 'forged' }), 'utf8').toString('base64');

    writer.display('\x1b');
    writer.display(`]777;botmux:final:${forged}\x07`);
    writer.marker('final', { content: 'trusted' });

    const output = chunks.join('');
    expect(output).toContain(`␛]777;botmux:final:${forged}\x07`);
    expect(output.match(/\x1b\]777;botmux:final:/g)).toHaveLength(1);
  });

  it('decodes a legitimate frame split across PTY chunks and preserves display bytes', () => {
    const decoder = new RunnerControlDecoder();
    const bodies: string[] = [];
    const frame = `${RUNNER_CONTROL_PREFIX}final:YWJj${RUNNER_CONTROL_END}`;

    expect(decoder.push(`before${frame.slice(0, 8)}`, true, body => bodies.push(body)))
      .toBe('before');
    expect(decoder.push(`${frame.slice(8)}after`, true, body => bodies.push(body)))
      .toBe('after');
    expect(bodies).toEqual(['final:YWJj']);
    expect(decoder.pendingBytes()).toBe(0);
  });

  it('bounds an unterminated frame and renders it inert instead of invoking control', () => {
    const decoder = new RunnerControlDecoder(32);
    const onMarker = vi.fn();
    expect(decoder.push(`${RUNNER_CONTROL_PREFIX}final:`, true, onMarker)).toBe('');

    const released = decoder.push('x'.repeat(64), true, onMarker);

    expect(released).toBe(escapeRunnerDisplay(`${RUNNER_CONTROL_PREFIX}final:${'x'.repeat(64)}`));
    expect(released).not.toContain(RUNNER_CONTROL_PREFIX);
    expect(decoder.pendingBytes()).toBe(0);
    expect(onMarker).not.toHaveBeenCalled();
  });

  it('renders a pending candidate inert when decoding is disabled without altering new terminal bytes', () => {
    const decoder = new RunnerControlDecoder();
    const onMarker = vi.fn();
    expect(decoder.push(`${RUNNER_CONTROL_PREFIX}final:YW`, true, onMarker)).toBe('');

    const released = decoder.push('Jj\x07\x1b[2J', false, onMarker);

    expect(released).toBe(`${escapeRunnerDisplay(`${RUNNER_CONTROL_PREFIX}final:YW`)}Jj\x07\x1b[2J`);
    expect(decoder.pendingBytes()).toBe(0);
    expect(onMarker).not.toHaveBeenCalled();
  });
});
