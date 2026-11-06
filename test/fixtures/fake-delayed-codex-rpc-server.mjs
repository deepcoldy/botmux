#!/usr/bin/env node
process.on('SIGTERM', () => { setTimeout(() => process.exit(0), 1500); });
await import('./fake-codex-rpc-server.mjs');
