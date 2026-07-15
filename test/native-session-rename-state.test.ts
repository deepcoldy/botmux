import { describe, expect, it } from 'vitest';
import { NativeSessionRenameState } from '../src/core/native-session-rename-state.js';

describe('NativeSessionRenameState', () => {
  it('restores a durable desired title at-least-once across worker restart', () => {
    const state = new NativeSessionRenameState();
    state.observeCliSessionId('native-session-1');
    state.restoreDesired('A');
    expect(state.hasDesiredTitle).toBe(true);
    expect(state.hasPending).toBe(true);
    expect(state.takeForSend()).toBe('A');
    state.settle();

    state.beginRotationCommandWrite();
    expect(state.commitRotationCommand()).toBe(true);
    state.noteFreshPrompt();
    expect(state.takeForSend()).toBe('A');
  });

  it('re-queues desired state for a same-worker CLI respawn', () => {
    const state = new NativeSessionRenameState();
    state.request('A');
    expect(state.takeForSend()).toBe('A');
    state.settle();

    expect(state.queueDesiredForSpawn()).toBe(true);
    expect(state.takeForSend()).toBe('A');
  });

  it('re-applies desired title after an in-flight rename is followed by /clear', () => {
    const state = new NativeSessionRenameState();
    const delivered: string[] = [];
    expect(state.observeCliSessionId('claude-session-1')).toEqual({
      kind: 'baseline',
      queuedTitleReapply: false,
    });

    state.request('A');
    delivered.push(`/rename ${state.takeForSend()}`);
    expect(state.isInFlight).toBe(true);

    // `/clear` arrived while rename owned the TUI and sat in the worker's raw
    // FIFO. Once A settles, the raw command runs first and must queue A again.
    state.settle();
    delivered.push('/clear');
    expect(state.isRotationCommand('/clear', ['/clear'])).toBe(true);
    state.beginRotationCommandWrite();
    expect(state.blocksInput).toBe(true);
    expect(state.commitRotationCommand()).toBe(true);
    expect(state.requiresFreshPrompt).toBe(true);
    expect(state.takeForSend()).toBeNull();
    state.noteFreshPrompt();
    delivered.push(`/rename ${state.takeForSend()}`);

    expect(delivered).toEqual(['/rename A', '/clear', '/rename A']);
  });

  it('re-applies desired title when /new rotates after the first rename completed', () => {
    const state = new NativeSessionRenameState();
    const delivered: string[] = [];
    state.observeCliSessionId('codex-session-1');
    state.request('A');
    delivered.push(`/rename ${state.takeForSend()}`);
    state.settle();
    expect(state.takeForSend()).toBeNull();

    delivered.push('/new');
    expect(state.isRotationCommand('/new', ['/new'])).toBe(true);
    state.beginRotationCommandWrite();
    expect(state.commitRotationCommand()).toBe(true);
    expect(state.takeForSend()).toBeNull();
    state.noteFreshPrompt();
    delivered.push(`/rename ${state.takeForSend()}`);
    expect(delivered).toEqual(['/rename A', '/new', '/rename A']);
  });

  it('re-applies desired title after an observed session-id rotation', () => {
    const state = new NativeSessionRenameState();
    state.observeCliSessionId('native-session-1');
    state.request('A');
    expect(state.takeForSend()).toBe('A');
    state.settle();

    expect(state.observeCliSessionId('native-session-2')).toEqual({
      kind: 'rotation',
      queuedTitleReapply: true,
    });
    expect(state.requiresFreshPrompt).toBe(true);
    expect(state.blocksInput).toBe(false);
    expect(state.takeForSend()).toBeNull();
    state.noteFreshPrompt();
    expect(state.takeForSend()).toBe('A');
    state.settle();
    expect(state.observeCliSessionId('native-session-2').kind).toBe('unchanged');
    expect(state.takeForSend()).toBeNull();
  });

  it('lets ordinary input create a fresh idle proof for an independent id change', () => {
    const state = new NativeSessionRenameState();
    state.observeCliSessionId('native-session-1');
    state.request('A');
    expect(state.takeForSend()).toBe('A');
    state.settle();

    state.observeCliSessionId('native-session-2');
    expect(state.requiresFreshPrompt).toBe(true);
    expect(state.blocksInput).toBe(false);
    expect(state.takeForSend()).toBeNull();

    // The worker may now submit a normal user turn. Its later authoritative
    // idle signal releases the deferred native title reapply.
    state.noteFreshPrompt();
    expect(state.takeForSend()).toBe('A');
  });

  it('replays once when the first observable id arrives after the title request', () => {
    const state = new NativeSessionRenameState();
    state.request('A');
    expect(state.takeForSend()).toBe('A');
    state.settle();

    // The worker may not know a fresh CLI's id until after /rename. Replaying
    // once is harmless, but first discovery is still a baseline: it must not
    // invent a fresh-prompt rotation gate for a static adopted pane.
    expect(state.observeCliSessionId('native-session-2')).toEqual({
      kind: 'baseline',
      queuedTitleReapply: true,
    });
    expect(state.requiresFreshPrompt).toBe(false);
    state.noteFreshPrompt();
    expect(state.takeForSend()).toBe('A');
    state.settle();
    expect(state.observeCliSessionId('native-session-2').kind).toBe('unchanged');
  });

  it('keeps an id-triggered reapply queued while the prior rename is still in flight', () => {
    const state = new NativeSessionRenameState();
    state.observeCliSessionId('native-session-1');
    state.request('A');
    expect(state.takeForSend()).toBe('A');
    expect(state.isInFlight).toBe(true);

    expect(state.observeCliSessionId('native-session-2')).toEqual({
      kind: 'rotation',
      queuedTitleReapply: true,
    });
    expect(state.takeForSend()).toBeNull();
    state.noteFreshPrompt();
    state.settle();
    expect(state.takeForSend()).toBe('A');
  });

  it('keeps latest-wins when a newer rename arrives during rotation', () => {
    const state = new NativeSessionRenameState();
    state.request('A');
    expect(state.takeForSend()).toBe('A');
    expect(state.isRotationCommand('/clear', ['/clear'])).toBe(true);
    state.beginRotationCommandWrite();
    state.commitRotationCommand();
    state.request('B');
    state.settle();

    expect(state.takeForSend()).toBeNull();
    state.noteFreshPrompt();
    expect(state.takeForSend()).toBe('B');
  });

  it('matches only adapter-declared rotation commands', () => {
    const state = new NativeSessionRenameState();
    state.request('A');
    expect(state.takeForSend()).toBe('A');
    state.settle();

    expect(state.isRotationCommand('/clear', ['/new'])).toBe(false);
    expect(state.isRotationCommand('/NEW now', ['/new'])).toBe(true);
    state.beginRotationCommandWrite();
    expect(state.commitRotationCommand()).toBe(true);
    state.noteFreshPrompt();
    expect(state.takeForSend()).toBe('A');
  });

  it('coalesces command and early session-id signals into one pending delivery', () => {
    const state = new NativeSessionRenameState();
    state.observeCliSessionId('native-session-1');
    state.request('A');
    expect(state.takeForSend()).toBe('A');
    state.settle();

    expect(state.isRotationCommand('/new', ['/new'])).toBe(true);
    state.beginRotationCommandWrite();
    expect(state.commitRotationCommand()).toBe(true);
    expect(state.requiresFreshPrompt).toBe(true);
    // The id signal describes the same rotation, but latest-wins pending state
    // still contains only one title delivery.
    expect(state.observeCliSessionId('native-session-2')).toEqual({
      kind: 'rotation',
      queuedTitleReapply: true,
    });
    state.noteFreshPrompt();
    expect(state.takeForSend()).toBe('A');
    state.settle();
    expect(state.takeForSend()).toBeNull();
  });

  it('treats a late id after a proven known rotation as one bounded idempotent replay', () => {
    const state = new NativeSessionRenameState();
    state.observeCliSessionId('native-session-1');
    state.request('A');
    expect(state.takeForSend()).toBe('A');
    state.settle();

    expect(state.isRotationCommand('/new', ['/new'])).toBe(true);
    state.beginRotationCommandWrite();
    expect(state.commitRotationCommand()).toBe(true);
    state.noteFreshPrompt();
    expect(state.takeForSend()).toBe('A');
    state.settle();

    // The command already reapplied A, but a delayed authoritative id is still
    // treated as rotation evidence. One extra /rename is harmless and avoids
    // suppressing a genuinely newer identity when an intermediate id was missed.
    expect(state.observeCliSessionId('native-session-2')).toEqual({
      kind: 'rotation',
      queuedTitleReapply: true,
    });
    expect(state.requiresFreshPrompt).toBe(true);
    state.noteFreshPrompt();
    expect(state.takeForSend()).toBe('A');
    state.settle();
    expect(state.observeCliSessionId('native-session-2').kind).toBe('unchanged');
    expect(state.takeForSend()).toBeNull();
  });

  it('replays when the expected intermediate id is skipped and a later id is observed directly', () => {
    const state = new NativeSessionRenameState();
    state.observeCliSessionId('native-session-1');
    state.request('A');
    expect(state.takeForSend()).toBe('A');
    state.settle();

    state.beginRotationCommandWrite();
    state.commitRotationCommand();
    state.noteFreshPrompt();
    expect(state.takeForSend()).toBe('A');
    state.settle();

    // The watcher never reports native-session-2. The next changed id must not
    // be consumed as a stale "expected" confirmation from the known command.
    expect(state.observeCliSessionId('native-session-3')).toEqual({
      kind: 'rotation',
      queuedTitleReapply: true,
    });
    expect(state.requiresFreshPrompt).toBe(true);
    state.noteFreshPrompt();
    expect(state.takeForSend()).toBe('A');
    state.settle();
    expect(state.observeCliSessionId('native-session-3').kind).toBe('unchanged');
  });

  it('remembers a rotation that happened before the first title request', () => {
    const state = new NativeSessionRenameState();
    state.observeCliSessionId('native-session-1');

    expect(state.isRotationCommand('/new', ['/new'])).toBe(true);
    state.beginRotationCommandWrite();
    expect(state.commitRotationCommand()).toBe(false);
    expect(state.requiresFreshPrompt).toBe(false);

    state.request('A');
    expect(state.takeForSend()).toBe('A');
    state.settle();
    expect(state.observeCliSessionId('native-session-2')).toEqual({
      kind: 'rotation',
      queuedTitleReapply: true,
    });
    expect(state.takeForSend()).toBeNull();
    state.noteFreshPrompt();
    expect(state.takeForSend()).toBe('A');
    state.settle();
    expect(state.observeCliSessionId('native-session-2').kind).toBe('unchanged');
    expect(state.takeForSend()).toBeNull();
  });

  it('releases a reserved rotation write when command delivery fails', () => {
    const state = new NativeSessionRenameState();
    state.observeCliSessionId('native-session-1');
    state.request('A');
    state.beginRotationCommandWrite();
    expect(state.blocksInput).toBe(true);
    expect(state.takeForSend()).toBeNull();

    state.cancelRotationCommandWrite();
    expect(state.blocksInput).toBe(false);
    expect(state.takeForSend()).toBe('A');
    state.settle();
    expect(state.observeCliSessionId('native-session-2')).toEqual({
      kind: 'rotation',
      queuedTitleReapply: true,
    });
  });

  it('reports the first id as baseline and repeated observations as unchanged', () => {
    const state = new NativeSessionRenameState();
    state.request('A');
    expect(state.observeCliSessionId('native-session-1')).toEqual({
      kind: 'baseline',
      queuedTitleReapply: true,
    });
    expect(state.requiresFreshPrompt).toBe(false);
    expect(state.observeCliSessionId('native-session-1')).toEqual({
      kind: 'unchanged',
      queuedTitleReapply: false,
    });
    expect(state.takeForSend()).toBe('A');
    state.settle();
  });

  it('reports a changed id as rotation even when no title is desired', () => {
    const state = new NativeSessionRenameState();
    expect(state.observeCliSessionId('native-session-1').kind).toBe('baseline');
    expect(state.observeCliSessionId('native-session-2')).toEqual({
      kind: 'rotation',
      queuedTitleReapply: false,
    });
    expect(state.requiresFreshPrompt).toBe(false);
  });

  it('does not gate legacy rotation passthrough when no title is desired', () => {
    const state = new NativeSessionRenameState();
    expect(state.hasDesiredTitle).toBe(false);
    state.beginRotationCommandWrite();
    expect(state.blocksInput).toBe(true);

    expect(state.commitRotationCommand()).toBe(false);
    expect(state.blocksInput).toBe(false);
    expect(state.requiresFreshPrompt).toBe(false);
  });
});
