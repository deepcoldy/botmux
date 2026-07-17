import type { ServerResponse } from 'node:http';

/** Write a JSON HTTP response without coupling callers to a feature module. */
export function jsonRes(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
