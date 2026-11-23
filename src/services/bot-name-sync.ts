import { rmwBotEntry } from './config-store.js';
import { assertUniqueBotProcessNames, normalizeBotProcessName } from '../setup/bot-config-editor.js';

/**
 * Create once per bot/daemon. Queue the entire transaction, not just its remote
 * publish: file-lock retries are not FIFO and can otherwise commit old names
 * after newer remote publishes. A rejected transaction must not poison the tail.
 */
export function createSerializedBotRenamer<T>(
  rename: (name: string) => Promise<T>,
): (name: string) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return name => {
    const run = tail.then(() => rename(name));
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
}

/** Run only after the remote rename succeeded. Merge into the latest locked
 * generation so an unrelated concurrent configuration edit is never lost. */
export async function persistRenamedBotName(
  appId: string, displayName: string, path?: string,
): Promise<string> {
  const name = normalizeBotProcessName(displayName);
  if (!name) throw new Error('The renamed bot has no valid local configuration name');
  const result = await rmwBotEntry(appId, (entry, raw) => {
    const changed = entry.name !== name;
    entry.name = name;
    assertUniqueBotProcessNames(raw);
    return { write: changed, result: name };
  }, path ? { path } : {});
  if (!result.ok) throw new Error(result.reason);
  return result.result;
}
