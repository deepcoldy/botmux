import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { isHcError, type HcClient } from './client.js';
import { hcTerminalName } from './cli-ops.js';

const DOCUMENT = 'herdr-app';
const TIMEOUT = { timeoutMs: 2_000 };
const RPC_INTERNAL_ERROR = -32603;
const RETRY_INITIAL_MS = 50;
const RETRY_MAX_MS = 2_000;
const MAX_ATTEMPTS = 9;

interface HerdrPane {
  id?: string;
  type?: string;
  content?: { terminal?: string };
  children?: HerdrPane[];
  floating?: HerdrPane[];
}

interface HerdrTab {
  id: string;
  name?: string;
  root: HerdrPane;
}

interface HerdrSpace {
  id: string;
  name?: string;
  folder?: string;
  tabs?: HerdrTab[];
}

interface HerdrLayout {
  spaces?: HerdrSpace[];
}

function* panes(node: HerdrPane | undefined): Generator<HerdrPane> {
  if (!node) return;
  yield node;
  for (const child of node.children ?? []) yield* panes(child);
  for (const child of node.floating ?? []) yield* panes(child);
}

function layoutId(kind: string, seed: string): string {
  return `botmux-${kind}-${createHash('sha256').update(seed).digest('hex').slice(0, 24)}`;
}

function placeTerminal(document: HerdrLayout, sessionId: string, address: string, cwd: string, title: string): boolean {
  const paneId = layoutId('pane', sessionId);
  const tabId = layoutId('tab', sessionId);
  const spaces = document.spaces ??= [];
  let existing: HerdrPane['content'];
  for (const space of spaces) {
    for (const tab of space.tabs ?? []) {
      for (const pane of panes(tab.root)) {
        if (pane.content?.terminal === address) return false;
        if (pane.id === paneId && typeof pane.content?.terminal === 'string') existing = pane.content;
      }
    }
  }
  if (existing) {
    existing.terminal = address;
    return true;
  }

  const spaceId = layoutId('space', cwd);
  let space = spaces.find(candidate => candidate.id === spaceId);
  if (!space) {
    space = { id: spaceId, name: basename(cwd) || cwd, folder: cwd, tabs: [] };
    spaces.push(space);
  }
  const tabs = space.tabs ??= [];
  // A tab that already has this id may contain a user-edited layout. Leave it alone.
  if (tabs.some(tab => tab.id === tabId)) return false;
  tabs.push({
    id: tabId,
    name: title,
    root: {
      id: tabId,
      type: 'row',
      children: [{ id: paneId, type: 'block', content: { terminal: address } }],
    },
  });
  return true;
}

async function readLayout(client: Pick<HcClient, 'call'>): Promise<{ version: number; document: HerdrLayout }> {
  const current = await client.call<{ version: number; value: HerdrLayout | null }>('doc.get', { name: DOCUMENT }, TIMEOUT);
  const document = current.value ?? {};
  if (typeof document !== 'object' || Array.isArray(document) || (document.spaces != null && !Array.isArray(document.spaces))) {
    throw new Error('无法识别现有 Herdr 布局');
  }
  return { version: current.version, document };
}

/** Place a terminal in the current core's native Herdr layout. The app's
 * label-based adoption would enable keep and restore a shell in place of a lost
 * agent. A document pane references the running terminal without that policy. */
export async function publishHcHerdrTab(
  client: Pick<HcClient, 'call'>,
  sessionId: string,
  terminal: { address: string; cwd: string },
  sessionTitle: string,
  isCurrent: () => boolean,
): Promise<void> {
  if (!terminal.cwd) return;
  const title = sessionTitle.trim() || hcTerminalName(sessionId);
  let retryMs = RETRY_INITIAL_MS;
  for (let attempt = 1; isCurrent(); attempt++) {
    let writing = false;
    try {
      const { version, document } = await readLayout(client);
      if (!isCurrent() || !placeTerminal(document, sessionId, terminal.address, terminal.cwd, title)) return;
      writing = true;
      await client.call('doc.set', { name: DOCUMENT, version, value: document }, TIMEOUT);
      return;
    } catch (error) {
      const retryableRpc = isHcError(error, 'rpc') && (error.kind === 'conflict' || error.rpcCode === RPC_INTERNAL_ERROR);
      if (!isHcError(error, 'timeout') && !retryableRpc) throw error;
      if (!isCurrent()) return;
      if (attempt === MAX_ATTEMPTS) {
        // A timed-out save may have committed. Give it a final read-only check
        // so a reconnect can honor a user parking the registered pane.
        if (writing && isHcError(error, 'timeout')) {
          const latest = await readLayout(client).catch(() => null);
          if (!isCurrent() || (latest && !placeTerminal(latest.document, sessionId, terminal.address, terminal.cwd, title))) return;
        }
        // Reject so the worker can try again on its next connection.
        throw new Error(`Herdr 布局登记已尝试 ${attempt} 次：${error.message}`, { cause: error });
      }
      // Restoring many workers can race on one document. Spread retries and
      // re-read every time, including after a write whose reply was lost.
      const delay = retryMs + Math.floor(Math.random() * retryMs);
      await new Promise<void>(resolve => { setTimeout(resolve, delay).unref(); });
      retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
    }
  }
}
