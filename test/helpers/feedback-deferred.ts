export function deferred<Result>() {
  let resolve!: (value: Result) => void;
  const promise = new Promise<Result>(done => { resolve = done; });
  return { promise, resolve };
}
