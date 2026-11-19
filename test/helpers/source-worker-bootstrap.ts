// Entry spawned by spawnLoadedSourceWorker() (./source-worker-boot.ts): install
// the production IPC preload, load the full source worker, then ACK. The ACK is
// sent only after worker.ts has evaluated, i.e. after its IPC handler is
// installed, so it marks the end of module loading rather than process start.
await import('../../src/worker-ipc-preload.js');
await import('../../src/worker.js');
process.send?.({ type: 'worker_ipc_ready' });
