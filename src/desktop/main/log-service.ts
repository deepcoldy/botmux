import { basename, join } from 'node:path';
import type { LogTarget, LogTail } from '../shared/types.js';

export function listLogTargets(logsDir: string, filenames: string[]): LogTarget[] {
  // Only accept known botmux log basenames before joining with logsDir.
  const safeNames = filenames.filter(isLogFilename).sort();
  const targets: LogTarget[] = [
    { id: 'all', label: 'All logs', files: safeNames.map(name => join(logsDir, name)) },
  ];

  const dashboard = safeNames.filter(name => name.startsWith('dashboard-'));
  if (dashboard.length) {
    targets.push({
      id: 'dashboard',
      label: 'Dashboard',
      files: dashboard.map(name => join(logsDir, name)),
    });
  }

  const botIndexes = new Set<number>();
  for (const name of safeNames) {
    const match = name.match(/^daemon-(\d+)-(?:out|error)\.log$/);
    if (match) {
      botIndexes.add(Number(match[1]));
    }
  }

  for (const idx of [...botIndexes].sort((a, b) => a - b)) {
    const files = safeNames
      .filter(name => name === `daemon-${idx}-out.log` || name === `daemon-${idx}-error.log`)
      .map(name => join(logsDir, name));
    targets.push({ id: `bot-${idx}`, label: `Bot ${idx}`, files });
  }

  return targets;
}

function isLogFilename(name: string): boolean {
  // basename(name) rejects path traversal attempts from untrusted IPC input.
  if (basename(name) !== name) return false;
  return /^dashboard-(?:out|error)\.log$/.test(name) || /^daemon-\d+-(?:out|error)\.log$/.test(name);
}

export function tailLogText(text: string, maxBytes: number): LogTail {
  const bytes = Buffer.byteLength(text);
  if (bytes <= maxBytes) {
    return { targetId: '', text, truncated: false };
  }

  const buf = Buffer.from(text);
  const start = utf8BoundaryStart(buf, Math.max(0, buf.length - maxBytes));
  return { targetId: '', text: buf.subarray(start).toString('utf-8'), truncated: true };
}

function utf8BoundaryStart(buf: Buffer, start: number): number {
  // Avoid decoding from the middle of a multi-byte UTF-8 sequence.
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
    start += 1;
  }
  return start;
}
