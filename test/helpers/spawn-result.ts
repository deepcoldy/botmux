import type { SpawnSyncReturns } from 'node:child_process';
import type { NonSharedBuffer } from 'node:buffer';

type SpawnResultInput<T> =
  Partial<SpawnSyncReturns<T>>
  & Pick<SpawnSyncReturns<T>, 'status'>;

export function textSpawnResult(
  partial: SpawnResultInput<string>,
): SpawnSyncReturns<string> {
  const stdout = partial.stdout ?? '';
  const stderr = partial.stderr ?? '';
  return {
    pid: 4242,
    output: [null, stdout, stderr],
    stdout,
    stderr,
    signal: null,
    ...partial,
  };
}

export function bufferSpawnResult(
  partial: SpawnResultInput<NonSharedBuffer>,
): SpawnSyncReturns<NonSharedBuffer> {
  const stdout = partial.stdout ?? Buffer.alloc(0) as NonSharedBuffer;
  const stderr = partial.stderr ?? Buffer.alloc(0) as NonSharedBuffer;
  return {
    pid: 4242,
    output: [null, stdout, stderr],
    stdout,
    stderr,
    signal: null,
    ...partial,
  };
}
