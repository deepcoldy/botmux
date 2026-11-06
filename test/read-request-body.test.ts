import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { readRequestBody, readRequestBodyJson } from './helpers/read-request-body.js';
// Pins the contract the loopback mock servers rely on: an EMPTY body (a port
// scanner's `GET /` probe, or any bodyless request) must not throw, while a
// non-empty malformed body is still a real failure when the caller asks for it.

let server: Server | undefined;

afterEach(async () => {
  const active = server;
  if (active) await new Promise<void>(resolve => active.close(() => resolve()));
  server = undefined;
});

/** Send `body` to a throwaway server and return what the helper read. */
async function roundTrip(body: string | undefined, method = 'POST') {
  let observed: { text: string; read: Awaited<ReturnType<typeof readRequestBody>> } | undefined;
  server = createServer(async (req, res) => {
    // Read ONCE: reading the stream twice yields empty on the second pass.
    const read = await readRequestBody(req);
    observed = { text: read.raw, read };
    res.writeHead(204).end();
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    method,
    ...(body === undefined ? {} : { body, headers: { 'content-type': 'application/json' } }),
  });
  expect(response.status).toBe(204);
  return observed!;
}

describe('readRequestBody', () => {
  it('classifies an empty body without throwing (scanner probe shape)', async () => {
    const { text, read } = await roundTrip(undefined, 'GET');
    expect(text).toBe('');
    expect(read).toEqual({ kind: 'empty', raw: '', value: undefined });
  });

  it('classifies a JSON body and returns the parsed value', async () => {
    const { read } = await roundTrip(JSON.stringify({ scopes: ['im:chat'] }));
    expect(read).toEqual({ kind: 'json', raw: '{"scopes":["im:chat"]}', value: { scopes: ['im:chat'] } });
  });

  it('classifies a malformed body instead of throwing', async () => {
    const { read } = await roundTrip('not json at all');
    expect(read.kind).toBe('other');
    expect(read.value).toBeUndefined();
  });

  it('does not equal an empty-string body to a JSON null payload', async () => {
    // Regression guard: `JSON.parse('')` throws, so a naive guard that keys off
    // falsiness would also swallow a legitimate `0` / `null` / `false` payload.
    const zero = await roundTrip('0');
    expect(zero.read).toEqual({ kind: 'json', raw: '0', value: 0 });
    const nul = await roundTrip('null');
    expect(nul.read).toEqual({ kind: 'json', raw: 'null', value: null });
  });
});

describe('readRequestBodyJson', () => {
  it('returns undefined for an empty probe by default', async () => {
    let value: unknown = 'sentinel';
    let threw: unknown;
    server = createServer(async (req, res) => {
      try { value = await readRequestBodyJson(req); } catch (error) { threw = error; }
      res.writeHead(204).end();
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await fetch(`http://127.0.0.1:${port}/`, { method: 'GET' });
    expect(threw).toBeUndefined();
    expect(value).toBeUndefined();
  });

  it('throws for a non-empty malformed body when strict', async () => {
    let threw: unknown;
    server = createServer(async (req, res) => {
      try { await readRequestBodyJson(req, { strict: true }); } catch (error) { threw = error; }
      res.writeHead(204).end();
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: '{oops' });
    expect(threw).toBeInstanceOf(SyntaxError);
  });

  it('tolerates a malformed body in the non-strict default', async () => {
    let value: unknown = 'sentinel';
    let threw: unknown;
    server = createServer(async (req, res) => {
      try { value = await readRequestBodyJson(req); } catch (error) { threw = error; }
      res.writeHead(204).end();
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: '{oops' });
    expect(threw).toBeUndefined();
    expect(value).toBeUndefined();
  });
});
