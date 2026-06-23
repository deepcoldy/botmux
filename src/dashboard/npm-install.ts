/**
 * The dashboard's manual-update install step, factored out of dashboard.ts so it
 * can be unit-tested in isolation (dashboard.ts exports nothing and pulls in the
 * whole server module graph).
 */
import { spawn } from 'node:child_process';
import { safeCwd } from '../utils/safe-cwd.js';

/**
 * Run `npm install -g botmux@latest` for the manual-update flow WITHOUT blocking
 * the event loop (async spawn, not execSync — the dashboard must keep serving
 * during the ~10-30s install). Resolves on exit 0; rejects with the tail of
 * stdout/stderr on a non-zero exit, spawn error, or 3-minute timeout. Args are
 * a fixed literal — no shell interpolation of untrusted input.
 *
 * `cwd: safeCwd()` is load-bearing: the dashboard process runs with cwd=PKG_ROOT
 * (its own checkout dir), which can be deleted out from under it (worktree
 * cleanup / in-place update). Without an explicit cwd the npm child inherits the
 * dead cwd and crashes at startup with `ENOENT ... uv_cwd` (npm exits 7) — the
 * exact failure this guards against. See utils/safe-cwd.ts.
 */
export function runNpmInstallLatest(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('npm', ['install', '-g', 'botmux@latest'], {
      cwd: safeCwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32', // resolve npm.cmd on Windows
    });
    let tail = '';
    const capture = (d: Buffer): void => { tail = (tail + d.toString()).slice(-2000); };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('npm install timed out after 180s'));
    }, 180_000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`npm exited ${code}: ${tail.trim().slice(-500)}`));
    });
  });
}
