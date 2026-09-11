import { closeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadNativeModule, type NativePtyProcess } from 'node-pty/lib/utils.js';

export interface NativePtySmokeOptions {
  file?: string;
  helperPath?: string;
  timeoutMs?: number;
}

export interface NativePtySmokeResult {
  pid: number;
  helperPath: string;
}

/**
 * Exercise node-pty without constructing tty.ReadStream. Bun's ReadStream can
 * close the PTY master after an initial EAGAIN, which makes a wrapper-level
 * smoke flaky and hides the code-signing signal this probe exists to test.
 */
export async function runNativePtySmoke(
  options: NativePtySmokeOptions = {},
): Promise<NativePtySmokeResult> {
  if (process.platform === 'win32') {
    throw new Error('native PTY smoke is unsupported on Windows');
  }

  const scratchRoot = process.env.BOTMUX_PTY_SMOKE_TMPDIR || tmpdir();
  mkdirSync(scratchRoot, { recursive: true });
  const scratch = mkdtempSync(join(scratchRoot, 'botmux-pty-smoke-'));
  const marker = join(scratch, 'result.txt');
  const loaded = loadNativeModule('pty');
  const helperPath = options.helperPath
    ?? loaded.helperPath
    ?? resolve(loaded.dir, 'spawn-helper');
  const file = options.file ?? '/bin/sh';
  const timeoutMs = options.timeoutMs ?? 10_000;
  const env = Object.entries({
    ...process.env,
    PWD: scratch,
    TERM: 'xterm-color',
  }).flatMap(([key, value]) => value === undefined ? [] : [`${key}=${value}`]);

  if (process.platform === 'darwin' && !existsSync(helperPath)) {
    rmSync(scratch, { recursive: true, force: true });
    throw new Error(`embedded spawn-helper is missing: ${helperPath}`);
  }

  let child: NativePtyProcess | undefined;
  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) rejectPromise(error);
        else resolvePromise();
      };
      const timer = setTimeout(() => {
        if (child) {
          try { process.kill(child.pid, 'SIGKILL'); } catch { /* already exited */ }
        }
        finish(new Error(`native PTY smoke timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      try {
        child = loaded.module.fork(
          file,
          ['-c', 'printf %s pty-ok > "$1"', 'botmux-pty-smoke', marker],
          env,
          scratch,
          80,
          24,
          -1,
          -1,
          true,
          helperPath,
          (code, signal) => {
            let actual = '<missing>';
            try { actual = readFileSync(marker, 'utf8'); } catch { /* reported below */ }
            if (code !== 0 || actual !== 'pty-ok') {
              finish(new Error(
                `native PTY child failed (code=${code} signal=${signal} marker=${JSON.stringify(actual)})`,
              ));
              return;
            }
            finish();
          },
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        finish(new Error(`native PTY fork failed via ${helperPath}: ${detail}`));
      }
    });

    if (!child) throw new Error('native PTY smoke did not create a child process');
    return { pid: child.pid, helperPath };
  } finally {
    if (child) {
      try { closeSync(child.fd); } catch { /* already closed */ }
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}
