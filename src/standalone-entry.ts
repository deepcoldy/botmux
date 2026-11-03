const STANDALONE_WORKER_FIRST_IPC_TIMEOUT_MS = 30_000;

if (process.argv[2] === '__worker' && typeof process.send === 'function') {
  const {
    waitForWorkerIpcPreloadMessage,
  } = await import('./worker-ipc-preload.js');
  await waitForWorkerIpcPreloadMessage(
    process,
    STANDALONE_WORKER_FIRST_IPC_TIMEOUT_MS,
  );
}

await import('./cli.js');
