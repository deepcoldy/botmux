/**
 * Chat leases: lanes run concurrently in one process, but some Feishu state is
 * shared across them.
 *
 * - A bot's private-chat mode (`/reply-mode chat|topic|group` in the DM) is
 *   per bot, not per DM. Ordinary DM cases hold `dm:<bot>` shared; a case that
 *   switches the mode holds it exclusively, so no other lane talks to that bot
 *   in a mode it does not expect.
 * - A group chat is held exclusively for the whole case: group modes are per
 *   group, and the no-reply assertions break if another case talks there.
 *
 * Leases are writer-preferring (a waiting exclusive holder stops new shared
 * holders) and FIFO, so a mode case waits for the DM cases already running and
 * then runs before later ones. A lease is bound to the page that took it and
 * released when that page closes, which every case teardown does.
 */
import type { Page } from 'playwright';

export type LeaseMode = 'shared' | 'exclusive';

interface Waiter {
  mode: LeaseMode;
  grant: () => void;
}

interface LeaseState {
  readers: number;
  writer: boolean;
  queue: Waiter[];
}

const leases = new Map<string, LeaseState>();

function stateFor(key: string): LeaseState {
  let state = leases.get(key);
  if (!state) {
    state = { readers: 0, writer: false, queue: [] };
    leases.set(key, state);
  }
  return state;
}

function pump(state: LeaseState): void {
  while (state.queue.length > 0) {
    const head = state.queue[0];
    if (head.mode === 'exclusive') {
      if (state.writer || state.readers > 0) return;
      state.queue.shift();
      state.writer = true;
      head.grant();
      return;
    }
    if (state.writer) return;
    state.queue.shift();
    state.readers += 1;
    head.grant();
  }
}

// Longer than any single case, so a wait only times out when a holder leaked.
const LEASE_TIMEOUT_MS = 25 * 60_000;

/** Acquire `key` and resolve with its release function. */
export function acquireLease(
  key: string,
  mode: LeaseMode,
  timeoutMs = LEASE_TIMEOUT_MS,
): Promise<() => void> {
  const state = stateFor(key);
  return new Promise((resolve, reject) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (mode === 'exclusive') state.writer = false;
      else state.readers -= 1;
      pump(state);
    };
    const waiter: Waiter = {
      mode,
      grant: () => {
        clearTimeout(timer);
        resolve(release);
      },
    };
    const timer = setTimeout(() => {
      const index = state.queue.indexOf(waiter);
      if (index >= 0) state.queue.splice(index, 1);
      pump(state);
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${mode} chat lease ${key}`));
    }, timeoutMs);
    state.queue.push(waiter);
    pump(state);
  });
}

const pageLeases = new WeakMap<Page, Set<string>>();

/**
 * Hold `key` until `page` closes. A page that already holds the key keeps its
 * lease, so a case that took `dm:<bot>` exclusively can still call `openChat`.
 */
export async function holdLeaseForPage(page: Page, key: string, mode: LeaseMode): Promise<void> {
  const held = pageLeases.get(page) ?? new Set<string>();
  pageLeases.set(page, held);
  if (held.has(key)) return;
  held.add(key);
  const release = await acquireLease(key, mode);
  if (page.isClosed()) {
    release();
    return;
  }
  page.once('close', release);
}

export function dmLeaseKey(botName: string): string {
  return `dm:${botName}`;
}

export function chatLeaseKey(chatName: string): string {
  return `chat:${chatName}`;
}
