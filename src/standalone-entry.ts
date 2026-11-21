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

// statusline 每条 assistant 消息都会被 Claude 调一次：跳过 cli.js 整张模块图的求值，
// 只跑叶子模块（与 Node/Bun 源码态的 statusline-entry.js 同一实现）。
if (process.argv[2] === 'statusline') {
  await (await import('./services/statusline-command.js')).runStatusline();
} else {
  await import('./cli.js');
}
