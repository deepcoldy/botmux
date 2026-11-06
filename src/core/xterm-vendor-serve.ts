/**
 * 把内嵌的 xterm 组件（见 ./xterm-vendor-assets.ts）作为静态文件发出去。worker 的终端页
 * 和控制台（v3 终端回放）共用这一份实现。
 *
 * 不鉴权：这些是公开的开源库文件，不含任何会话数据。终端页的 `<script src>` 请求带不上
 * 页面地址里的 `?viewToken=` / `?token=`，要求鉴权就等于只读链接永远加载不出组件。
 *
 * 数据模块（约 170KB 源码）按需动态加载：没人打开终端的 worker 不为它付内存。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gunzipSync } from 'node:zlib';

import { matchXtermVendorPath, type XtermVendorAsset } from './xterm-vendor-assets.js';

interface AssetBody {
  gzip: Buffer;
  identity?: Buffer;
  etag: string;
}

type AssetDataMap = Readonly<Record<string, { readonly sha256: string; readonly gzipBase64: string }>>;

let dataPromise: Promise<AssetDataMap> | undefined;
const bodies = new Map<string, AssetBody>();

function loadData(): Promise<AssetDataMap> {
  if (!dataPromise) {
    dataPromise = import('./xterm-vendor-assets-data.js').then(
      (m) => m.XTERM_VENDOR_ASSET_DATA,
      (err: unknown) => {
        dataPromise = undefined;
        throw err;
      },
    );
  }
  return dataPromise;
}

async function assetBody(asset: XtermVendorAsset): Promise<AssetBody> {
  const cached = bodies.get(asset.path);
  if (cached) return cached;
  const data = (await loadData())[asset.path];
  if (!data) throw new Error(`xterm vendor asset missing from embedded data: ${asset.path}`);
  const body: AssetBody = {
    gzip: Buffer.from(data.gzipBase64, 'base64'),
    // 弱校验器：同一份内容的 gzip / 原文两种编码共用一个 ETag 是允许的。
    etag: `W/"${data.sha256.slice(0, 32)}"`,
  };
  bodies.set(asset.path, body);
  return body;
}

/** `Accept-Encoding` 是否接受 gzip（显式 `gzip;q=0` 视为拒绝，`*` 视为接受）。 */
export function acceptsGzip(header: string | string[] | undefined): boolean {
  const value = Array.isArray(header) ? header.join(',') : header;
  if (!value) return false;
  let star = false;
  for (const part of value.split(',')) {
    const [rawName, ...params] = part.split(';');
    const name = rawName.trim().toLowerCase();
    if (!name) continue;
    let q = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p);
      if (m) q = Number(m[1]);
    }
    if (name === 'gzip' || name === 'x-gzip') return q > 0;
    if (name === '*') star = q > 0;
  }
  return star;
}

function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  if (typeof header !== 'string') return false;
  const bare = etag.replace(/^W\//, '');
  return header.split(',').some((t) => {
    const tag = t.trim();
    return tag === '*' || tag.replace(/^W\//, '') === bare;
  });
}

function plain(res: ServerResponse, status: number, body: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body)),
    ...extra,
  });
  res.end(body);
}

export async function serveXtermVendorAsset(
  req: IncomingMessage,
  res: ServerResponse,
  asset: XtermVendorAsset | null,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    plain(res, 405, 'Method Not Allowed', { allow: 'GET, HEAD' });
    return;
  }
  if (!asset) {
    plain(res, 404, 'Not Found');
    return;
  }
  const body = await assetBody(asset);
  const headers: Record<string, string> = {
    'content-type': asset.contentType,
    // 路径里带着包版本，内容永不变：浏览器和中间代理都可以长期缓存。
    'cache-control': 'public, max-age=31536000, immutable',
    etag: body.etag,
    vary: 'Accept-Encoding',
    'x-content-type-options': 'nosniff',
  };
  if (etagMatches(req.headers['if-none-match'], body.etag)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  let payload: Buffer;
  if (acceptsGzip(req.headers['accept-encoding'])) {
    headers['content-encoding'] = 'gzip';
    payload = body.gzip;
  } else {
    body.identity ??= gunzipSync(body.gzip);
    payload = body.identity;
  }
  headers['content-length'] = String(payload.length);
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : payload);
}

/**
 * 认领并应答 vendor 资源请求；不是 vendor 路径时返回 false，调用方照常路由。
 * `mode` 见 {@link matchXtermVendorPath}：worker 用 `anyPrefix`，控制台用 `root`。
 */
export function handleXtermVendorHttp(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  mode: 'root' | 'anyPrefix',
  onError?: (err: unknown) => void,
): boolean {
  const match = matchXtermVendorPath(pathname, mode);
  if (!match) return false;
  serveXtermVendorAsset(req, res, match.asset).catch((err: unknown) => {
    onError?.(err);
    if (!res.headersSent) plain(res, 500, 'Internal Server Error');
    else res.destroy();
  });
  return true;
}
