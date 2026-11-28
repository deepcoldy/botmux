import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

export const MAX_PLUGIN_ARCHIVE_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
export const MAX_PLUGIN_ARCHIVE_ENTRIES = 10_000;
export const MAX_PLUGIN_MANIFEST_BYTES = 1 * 1024 * 1024;

export interface PluginTarEntry {
  path: string;
  type: 'file' | 'dir';
  mode: number;
  data: Buffer;
}

export interface ParsePluginTgzOptions {
  maxUncompressedBytes?: number;
  maxEntries?: number;
}

function isZeroBlock(buf: Buffer, offset: number): boolean {
  for (let i = 0; i < 512; i++) {
    if (buf[offset + i] !== 0) return false;
  }
  return true;
}

function readCString(buf: Buffer, start: number, length: number): string {
  const end = buf.indexOf(0, start);
  const limit = end >= 0 && end < start + length ? end : start + length;
  return buf.subarray(start, limit).toString('utf8');
}

function parseTarNumber(buf: Buffer, start: number, length: number, field: string): number {
  const first = buf[start];
  // POSIX/GNU base-256 binary encoding (high bit 0x80 set).
  if ((first & 0x80) !== 0) {
    // Reject negative two's complement values (0xff sign extension).
    if ((first & 0x40) !== 0) throw new Error(`plugin_archive_invalid_${field}`);
    let value = first & 0x7f;
    for (let i = 1; i < length; i++) {
      value = value * 256 + buf[start + i];
      if (!Number.isSafeInteger(value)) throw new Error(`plugin_archive_invalid_${field}`);
    }
    return value;
  }
  const raw = readCString(buf, start, length).trim();
  if (!raw) return 0;
  if (!/^[0-7]+$/.test(raw)) throw new Error(`plugin_archive_invalid_${field}`);
  const parsed = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`plugin_archive_invalid_${field}`);
  return parsed;
}

function verifyHeaderChecksum(buf: Buffer, offset: number): void {
  const expected = parseTarNumber(buf, offset + 148, 8, 'checksum');
  let unsignedSum = 0;
  let signedSum = 0;
  for (let i = 0; i < 512; i++) {
    const byte = i >= 148 && i < 156 ? 0x20 : buf[offset + i];
    unsignedSum += byte;
    signedSum += byte < 128 ? byte : byte - 256;
  }
  if (unsignedSum !== expected && signedSum !== expected) {
    throw new Error('plugin_archive_invalid_checksum');
  }
}

function parsePaxRecords(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space <= pos) throw new Error('plugin_archive_invalid_pax');
    const lenText = data.subarray(pos, space).toString('ascii');
    if (!/^\d+$/.test(lenText)) throw new Error('plugin_archive_invalid_pax');
    const recordLen = Number.parseInt(lenText, 10);
    if (!Number.isSafeInteger(recordLen) || recordLen <= space - pos + 1 || pos + recordLen > data.length) {
      throw new Error('plugin_archive_invalid_pax');
    }
    if (data[pos + recordLen - 1] !== 0x0a) throw new Error('plugin_archive_invalid_pax');
    const body = data.subarray(space + 1, pos + recordLen - 1).toString('utf8');
    const eq = body.indexOf('=');
    if (eq <= 0) throw new Error('plugin_archive_invalid_pax');
    out[body.slice(0, eq)] = body.slice(eq + 1);
    pos += recordLen;
  }
  return out;
}

function normalizePluginTarPath(rawPath: string, isDir: boolean): string | null {
  if (rawPath.includes('\0') || rawPath.includes('\\')) {
    throw new Error(`plugin_archive_invalid_path:${rawPath}`);
  }
  let normalized = rawPath;
  if (normalized.startsWith('./')) normalized = normalized.slice(2);
  if (isDir && (normalized === '' || normalized === '.')) return null;
  if (normalized.startsWith('/')) {
    throw new Error(`plugin_archive_invalid_path:${rawPath}`);
  }
  while (isDir && normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  if (!normalized) throw new Error(`plugin_archive_invalid_path:${rawPath}`);
  const segments = normalized.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') {
      throw new Error(`plugin_archive_invalid_path:${rawPath}`);
    }
  }
  if (segments[0] !== 'package') {
    throw new Error(`plugin_archive_outside_package:${rawPath}`);
  }
  return segments.join('/');
}

function gunzipArchive(tgzBytes: Uint8Array, maxOutputLength: number): Buffer {
  try {
    return gunzipSync(tgzBytes, { maxOutputLength });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const message = error instanceof Error ? error.message : String(error);
    if (code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|Cannot create a Buffer larger/i.test(message)) {
      throw new Error('plugin_archive_too_large');
    }
    throw new Error('plugin_archive_invalid_gzip');
  }
}

/**
 * Decompress and parse a plugin `.tgz` archive (npm pack / POSIX ustar / PAX / GNU LongLink),
 * enforcing strict safety invariants: bounded output, header checksums, no symlinks/hardlinks/
 * devices, no path traversal, entries confined to `package/`, and no duplicate file paths.
 */
export function parsePluginTgz(tgzBytes: Uint8Array, options: ParsePluginTgzOptions = {}): PluginTarEntry[] {
  const maxUncompressedBytes = options.maxUncompressedBytes ?? MAX_PLUGIN_ARCHIVE_UNCOMPRESSED_BYTES;
  const maxEntries = options.maxEntries ?? MAX_PLUGIN_ARCHIVE_ENTRIES;
  const tar = gunzipArchive(tgzBytes, maxUncompressedBytes);
  if (tar.length < 512 || tar.length % 512 !== 0) {
    // Allow trailing non-zero-padded EOF only if empty, otherwise fail closed.
    if (tar.length < 512) throw new Error('plugin_archive_truncated');
  }

  const entries: PluginTarEntry[] = [];
  const seenFiles = new Set<string>();
  const seenDirs = new Set<string>();
  let globalPax: Record<string, string> = {};
  let nextPax: Record<string, string> | null = null;
  let nextLongName: string | null = null;
  let totalFileBytes = 0;
  let offset = 0;
  let sawEndOfArchive = false;

  while (offset + 512 <= tar.length) {
    if (isZeroBlock(tar, offset)) {
      sawEndOfArchive = true;
      break;
    }
    verifyHeaderChecksum(tar, offset);
    const rawName = readCString(tar, offset, 100);
    const mode = parseTarNumber(tar, offset + 100, 8, 'mode');
    const headerSize = parseTarNumber(tar, offset + 124, 12, 'size');
    const typeByte = tar[offset + 156];
    const typeflag = typeByte === 0 ? '0' : String.fromCharCode(typeByte);
    const magic = tar.subarray(offset + 257, offset + 263).toString('ascii');
    const prefix = (magic === 'ustar\0' || magic === 'ustar ') ? readCString(tar, offset + 345, 155) : '';

    const mergedPax = nextPax ? { ...globalPax, ...nextPax } : globalPax;
    let size = headerSize;
    if (typeflag !== 'x' && typeflag !== 'g' && typeflag !== 'L' && mergedPax.size !== undefined) {
      if (!/^\d+$/.test(mergedPax.size)) throw new Error('plugin_archive_invalid_pax_size');
      size = Number.parseInt(mergedPax.size, 10);
      if (!Number.isSafeInteger(size) || size < 0) throw new Error('plugin_archive_invalid_pax_size');
    }

    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    const paddedSize = Math.ceil(size / 512) * 512;
    if (dataStart + paddedSize > tar.length) throw new Error('plugin_archive_truncated');
    const data = tar.subarray(dataStart, dataEnd);
    offset = dataStart + paddedSize;

    if (typeflag === 'x') {
      nextPax = parsePaxRecords(data);
      continue;
    }
    if (typeflag === 'g') {
      globalPax = { ...globalPax, ...parsePaxRecords(data) };
      continue;
    }
    if (typeflag === 'L') {
      const endNul = data.indexOf(0);
      nextLongName = (endNul >= 0 ? data.subarray(0, endNul) : data).toString('utf8');
      continue;
    }

    const effectiveName = nextLongName
      ?? mergedPax.path
      ?? (prefix ? `${prefix}/${rawName}` : rawName);
    nextPax = null;
    nextLongName = null;

    if (typeflag !== '0' && typeflag !== '5') {
      throw new Error(`plugin_archive_unsupported_entry_type:${typeflag}`);
    }

    if (entries.length >= maxEntries) {
      throw new Error('plugin_archive_too_many_entries');
    }

    const isDir = typeflag === '5';
    const normalizedPath = normalizePluginTarPath(effectiveName, isDir);
    if (normalizedPath === null) continue;

    if (isDir) {
      if (seenFiles.has(normalizedPath)) {
        throw new Error(`plugin_archive_path_conflict:${normalizedPath}`);
      }
      const dirParts = normalizedPath.split('/');
      for (let i = 1; i < dirParts.length; i++) {
        const ancestor = dirParts.slice(0, i).join('/');
        if (seenFiles.has(ancestor)) {
          throw new Error(`plugin_archive_path_conflict:${normalizedPath}`);
        }
      }
      seenDirs.add(normalizedPath);
      entries.push({ path: normalizedPath, type: 'dir', mode, data: Buffer.alloc(0) });
      continue;
    }

    if (seenFiles.has(normalizedPath)) {
      throw new Error(`plugin_archive_duplicate_entry:${normalizedPath}`);
    }
    if (seenDirs.has(normalizedPath)) {
      throw new Error(`plugin_archive_path_conflict:${normalizedPath}`);
    }
    // Check no ancestor segment is already a regular file.
    const parts = normalizedPath.split('/');
    for (let i = 1; i < parts.length; i++) {
      const ancestor = parts.slice(0, i).join('/');
      if (seenFiles.has(ancestor)) {
        throw new Error(`plugin_archive_path_conflict:${normalizedPath}`);
      }
      seenDirs.add(ancestor);
    }

    totalFileBytes += data.length;
    if (totalFileBytes > maxUncompressedBytes) {
      throw new Error('plugin_archive_too_large');
    }
    seenFiles.add(normalizedPath);
    entries.push({ path: normalizedPath, type: 'file', mode, data: Buffer.from(data) });
  }

  if (!sawEndOfArchive && offset < tar.length) {
    throw new Error('plugin_archive_truncated');
  }

  return entries;
}

export function readPackageManifestFromTgz(tgzBytes: Uint8Array): unknown {
  const entries = parsePluginTgz(tgzBytes);
  const manifestEntry = entries.find(entry => entry.type === 'file' && entry.path === 'package/package.json');
  if (!manifestEntry) throw new Error('plugin_archive_missing_package_json');
  if (manifestEntry.data.length > MAX_PLUGIN_MANIFEST_BYTES) {
    throw new Error('plugin_archive_manifest_too_large');
  }
  try {
    return JSON.parse(manifestEntry.data.toString('utf8'));
  } catch {
    throw new Error('plugin_archive_invalid_package_json');
  }
}

export function extractPluginTgz(tgzBytes: Uint8Array, targetDir: string): string {
  const entries = parsePluginTgz(tgzBytes);
  const hasManifest = entries.some(entry => entry.type === 'file' && entry.path === 'package/package.json');
  if (!hasManifest) throw new Error('plugin_archive_missing_package_json');

  const resolvedTarget = resolve(targetDir);
  mkdirSync(resolvedTarget, { recursive: true });

  const assertInsideTarget = (relPath: string): string => {
    const outPath = resolve(resolvedTarget, relPath);
    const rel = relative(resolvedTarget, outPath);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`plugin_archive_invalid_path:${relPath}`);
    }
    return outPath;
  };

  for (const entry of entries) {
    const outPath = assertInsideTarget(entry.path);
    if (entry.type === 'dir') {
      mkdirSync(outPath, { recursive: true });
    } else {
      mkdirSync(dirname(outPath), { recursive: true });
      const safeMode = (entry.mode & 0o111) !== 0 ? 0o755 : 0o644;
      writeFileSync(outPath, entry.data, { mode: safeMode });
    }
  }

  return join(resolvedTarget, 'package');
}
