/** Async operations on an already-open file descriptor. Opening the descriptor
 * is deliberately synchronous in download paths (to pin the validated parent
 * directory); data I/O then stays off the daemon event loop. */
import { fstat, ftruncate, write, type Stats } from 'node:fs';

export function fdWrite(
  fd: number,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    write(fd, buffer, offset, length, position, (error, written) => {
      if (error) reject(error);
      else resolve(written);
    });
  });
}

export async function fdWriteAll(fd: number, buffer: Buffer, position = 0): Promise<void> {
  let written = 0;
  while (written < buffer.length) {
    const n = await fdWrite(fd, buffer, written, buffer.length - written, position + written);
    if (!n) throw new Error('Zero-byte write');
    written += n;
  }
}

export function fdTruncate(fd: number, length: number): Promise<void> {
  return new Promise((resolve, reject) => {
    ftruncate(fd, length, error => { if (error) reject(error); else resolve(); });
  });
}

export function fdStat(fd: number): Promise<Stats> {
  return new Promise((resolve, reject) => {
    fstat(fd, (error, stats) => { if (error) reject(error); else resolve(stats); });
  });
}
