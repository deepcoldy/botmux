import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Keep this mock compatible with both Vitest and the repository's Bun test leg:
// Bun requires every real named export to remain present, and does not provide
// vi.importActual/importOriginal to mock factories.
vi.mock('node:child_process', () => {
  const actual = require('node:child_process') as typeof import('node:child_process');
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

import { spawn } from 'node:child_process';
import { runSchedulePrecondition } from '../src/services/schedule-precondition-runner.js';

const mockedSpawn = vi.mocked(spawn);

class FakeChildProcess extends EventEmitter {
  // Emit data/end explicitly so Node/Bun stream-flush timing cannot weaken the
  // intended close-before-end interleaving.
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly prompt = new EventEmitter();
  readonly stdio = [null, this.stdout, this.stderr, this.prompt];
  readonly kill = vi.fn(() => true);
}

async function expectPending(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  void promise.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
}

function startRun(): { child: FakeChildProcess; result: ReturnType<typeof runSchedulePrecondition> } {
  const child = new FakeChildProcess();
  mockedSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  const result = runSchedulePrecondition('printf 1', '/tmp');
  return { child, result };
}

beforeEach(() => {
  mockedSpawn.mockReset();
});

describe('runSchedulePrecondition output-stream ordering', () => {
  it('waits for late file descriptor 3 data and end after child close', async () => {
    const { child, result } = startRun();

    child.stdout.emit('data', Buffer.from('1'));
    child.stdout.emit('end');
    child.stderr.emit('end');
    child.emit('close', 0, null);
    await expectPending(result);

    child.prompt.emit('data', Buffer.from('late '));
    await expectPending(result);
    child.prompt.emit('data', Buffer.from('prompt\n'));
    child.prompt.emit('end');

    await expect(result).resolves.toEqual({
      decision: 'pass',
      additionalPrompt: 'late prompt\n',
    });
  });

  it('waits for stdout end even after close and the other streams end', async () => {
    const { child, result } = startRun();

    child.prompt.emit('data', Buffer.from('context'));
    child.prompt.emit('end');
    child.stderr.emit('end');
    child.emit('close', 0, null);
    child.stdout.emit('data', Buffer.from('1'));
    await expectPending(result);

    child.stdout.emit('end');

    await expect(result).resolves.toEqual({
      decision: 'pass',
      additionalPrompt: 'context',
    });
  });

  it('waits for stderr end even after close and the captured streams end', async () => {
    const { child, result } = startRun();

    child.stdout.emit('data', Buffer.from('1'));
    child.stdout.emit('end');
    child.prompt.emit('data', Buffer.from('context'));
    child.prompt.emit('end');
    child.emit('close', 0, null);
    child.stderr.emit('data', Buffer.from('diagnostic'));
    await expectPending(result);

    child.stderr.emit('end');

    await expect(result).resolves.toEqual({
      decision: 'pass',
      additionalPrompt: 'context',
    });
  });
});
