import { gzipSync } from 'node:zlib';

export interface TarFixtureEntry {
  path: string;
  content?: string | Uint8Array;
  typeflag?: '0' | '1' | '2' | '5' | 'x' | 'g' | 'L';
  linkname?: string;
  mode?: number;
  corruptChecksum?: boolean;
  paxPath?: string;
  gnuLongPath?: string;
}

function writeString(buf: Buffer, value: string, offset: number, length: number): void {
  const bytes = Buffer.from(value, 'utf8');
  bytes.copy(buf, offset, 0, Math.min(bytes.length, length));
}

function writeOctal(buf: Buffer, value: number, offset: number, length: number): void {
  const str = value.toString(8).padStart(length - 1, '0');
  writeString(buf, str, offset, length - 1);
  buf[offset + length - 1] = 0;
}

function tarHeader(
  name: string,
  size: number,
  typeflag: string,
  mode: number,
  linkname = '',
  corruptChecksum = false,
): Buffer {
  const header = Buffer.alloc(512, 0);
  writeString(header, name, 0, 100);
  writeOctal(header, mode, 100, 8);
  writeOctal(header, 0, 108, 8);
  writeOctal(header, 0, 116, 8);
  writeOctal(header, size, 124, 12);
  writeOctal(header, Math.floor(Date.now() / 1000), 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = typeflag.charCodeAt(0);
  if (linkname) writeString(header, linkname, 157, 100);
  writeString(header, 'ustar\0', 257, 6);
  writeString(header, '00', 263, 2);

  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  if (corruptChecksum) sum += 123;
  const chksum = sum.toString(8).padStart(6, '0');
  writeString(header, chksum, 148, 6);
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function pad512(data: Buffer): Buffer {
  const rem = data.length % 512;
  if (rem === 0) return data;
  return Buffer.concat([data, Buffer.alloc(512 - rem, 0)]);
}

function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body, 'utf8') + 1;
  while (String(len).length + Buffer.byteLength(body, 'utf8') !== len) {
    len = String(len).length + Buffer.byteLength(body, 'utf8');
  }
  return Buffer.from(`${len}${body}`, 'utf8');
}

export function buildTarBuffer(entries: TarFixtureEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    if (entry.paxPath) {
      const paxData = paxRecord('path', entry.paxPath);
      blocks.push(tarHeader('PaxHeader/entry', paxData.length, 'x', 0o644));
      blocks.push(pad512(paxData));
    }
    if (entry.gnuLongPath) {
      const longData = Buffer.from(`${entry.gnuLongPath}\0`, 'utf8');
      blocks.push(tarHeader('././@LongLink', longData.length, 'L', 0o644));
      blocks.push(pad512(longData));
    }
    const typeflag = entry.typeflag ?? '0';
    const data = entry.content === undefined
      ? Buffer.alloc(0)
      : (typeof entry.content === 'string' ? Buffer.from(entry.content, 'utf8') : Buffer.from(entry.content));
    const mode = entry.mode ?? (typeflag === '5' ? 0o755 : 0o644);
    blocks.push(tarHeader(entry.path, data.length, typeflag, mode, entry.linkname, entry.corruptChecksum));
    if (data.length > 0) blocks.push(pad512(data));
  }
  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}

export function buildTgzBuffer(entries: TarFixtureEntry[]): Buffer {
  return gzipSync(buildTarBuffer(entries));
}

export function buildPluginTgz(
  pkg: Record<string, unknown>,
  distFiles: Record<string, string | Uint8Array> = { 'index.js': 'export const ok = true;\n' },
): Buffer {
  const entries: TarFixtureEntry[] = [
    { path: 'package/package.json', content: JSON.stringify(pkg, null, 2) + '\n' },
  ];
  for (const [relPath, content] of Object.entries(distFiles)) {
    entries.push({ path: `package/dist/${relPath}`, content });
  }
  return buildTgzBuffer(entries);
}
