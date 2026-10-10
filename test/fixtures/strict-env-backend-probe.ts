// A native PTY fixture must run in Node even when its parent test uses Bun.
// All input is synthetic, stored in a private test file; output reports booleans.
import { readFileSync } from 'node:fs';
import { PtyBackend } from '../../src/adapters/backend/pty-backend.js';
import { TmuxBackend } from '../../src/adapters/backend/tmux-backend.js';
import { TmuxPipeBackend } from '../../src/adapters/backend/tmux-pipe-backend.js';
import type { SpawnOpts } from '../../src/adapters/backend/types.js';
const [kind, bin, script, report, options, session] = process.argv.slice(2);
const opts = JSON.parse(readFileSync(options!, 'utf8')) as SpawnOpts;
const backend = kind === 'pty' ? new PtyBackend() : kind === 'tmux'
  ? new TmuxBackend(session!) : new TmuxPipeBackend(session!, { createSession: true, ownsSession: true });
backend.spawn(bin!, [script!, report!], opts);
process.on('SIGTERM', () => { backend.kill(); process.exit(0); });
