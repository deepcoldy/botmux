import type { IncomingMessage, ServerResponse } from 'node:http';

export function isDashboardChunkJsPath(pathname: string): boolean {
  return /^\/?chunks\/[^/\\]+\.js$/.test(pathname);
}

export function serveMissingDashboardChunk(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  if (!isDashboardChunkJsPath(pathname)) return false;

  // A replacement ESM cannot supply a missing chunk's minified exports.
  // Linking would fail before its reload code could run. Reject the import
  // with 404 so the already-loaded route host can reload the current build.
  const body = 'Dashboard chunk not found';
  res.writeHead(404, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body)),
  });
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}
