/** Minimal per-worker promise-chain mutex. Each task begins only after the
 *  previous task settles; rejection never poisons the tail. Used for adopt
 *  writes where concurrent paste -> delay -> Enter/history verification would
 *  otherwise interleave in the same external CLI composer. */
export class AsyncSerialQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
