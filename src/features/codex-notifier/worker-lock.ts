import { randomUUID } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { codexNotifierRoot, codexNotifierWorkerLockPath } from './paths.js';

const LOCK_INITIALIZATION_GRACE_MS = 5_000;

interface WorkerLockRecord {
  pid: number;
  token: string;
  createdAt: string;
}

export interface CodexNotifierWorkerLease {
  acquired: boolean;
  path: string;
  release(): void;
}

function readLock(path: string): WorkerLockRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<WorkerLockRecord>;
    if (
      !Number.isSafeInteger(value.pid)
      || (value.pid ?? 0) <= 0
      || typeof value.token !== 'string'
      || !value.token
      || typeof value.createdAt !== 'string'
    ) {
      return undefined;
    }
    return value as WorkerLockRecord;
  } catch {
    return undefined;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code !== 'ESRCH';
  }
}

/** 跨 Dashboard 进程独占 core outbox；崩溃遗留锁在 PID 消失后自动回收。 */
export function acquireCodexNotifierWorkerLease(
  dataDir: string,
  pid = process.pid,
): CodexNotifierWorkerLease {
  const path = codexNotifierWorkerLockPath(dataDir);
  mkdirSync(codexNotifierRoot(dataDir), { recursive: true, mode: 0o700 });
  const token = randomUUID();

  for (let attempt = 0; attempt < 3; attempt++) {
    let fd: number | undefined;
    try {
      fd = openSync(path, 'wx', 0o600);
      const record: WorkerLockRecord = {
        pid,
        token,
        createdAt: new Date().toISOString(),
      };
      writeSync(fd, `${JSON.stringify(record)}\n`);
      closeSync(fd);
      fd = undefined;
      let released = false;
      return {
        acquired: true,
        path,
        release() {
          if (released) return;
          released = true;
          if (readLock(path)?.token !== token) return;
          try {
            unlinkSync(path);
          } catch (error: any) {
            if (error?.code !== 'ENOENT') throw error;
          }
        },
      };
    } catch (error: any) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // 关闭失败不影响后续锁判断。
        }
      }
      if (error?.code !== 'EEXIST') throw error;
      const existing = readLock(path);
      if (existing && processAlive(existing.pid)) {
        return { acquired: false, path, release() {} };
      }
      if (!existing) {
        // openSync('wx') 与首条 JSON 写入之间存在极短窗口。新鲜但暂时不可解析的
        // 文件仍视为被占用，避免另一个 Dashboard 删锁后同时拿到 lease。
        try {
          if (Date.now() - statSync(path).mtimeMs < LOCK_INITIALIZATION_GRACE_MS) {
            return { acquired: false, path, release() {} };
          }
        } catch (statError: any) {
          if (statError?.code !== 'ENOENT') {
            return { acquired: false, path, release() {} };
          }
        }
      }
      try {
        unlinkSync(path);
      } catch (unlinkError: any) {
        if (unlinkError?.code !== 'ENOENT') {
          return { acquired: false, path, release() {} };
        }
      }
    }
  }

  return { acquired: false, path, release() {} };
}
