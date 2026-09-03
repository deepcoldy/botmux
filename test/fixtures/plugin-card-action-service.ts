import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const [portRaw, endpoint, token, mode, logPath, delayRaw] = process.argv.slice(2);
const port = Number(portRaw);
const delayMs = Number(delayRaw ?? '0');

if (!Number.isInteger(port) || port < 0 || port > 65_535 || !endpoint || !token || !mode || !logPath) {
  throw new Error('invalid_fixture_arguments');
}

const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', chunk => chunks.push(Buffer.from(chunk)));
  request.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    appendFileSync(logPath, `${JSON.stringify({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      contentType: request.headers['content-type'],
      body: JSON.parse(body),
    })}\n`);

    if (request.url !== endpoint || request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ schemaVersion: 1, ack: { toast: { type: 'error', content: 'unauthorized' } } }));
      return;
    }

    const send = () => {
      if (mode === 'non2xx') {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end('{"error":"unavailable"}');
        return;
      }
      if (mode === 'redirect') {
        response.writeHead(302, { location: 'http://example.test/forbidden' });
        response.end();
        return;
      }
      if (mode === 'invalid-json') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{not-json');
        return;
      }
      if (mode === 'invalid-schema') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ schemaVersion: 2, ack: {} }));
        return;
      }
      if (mode === 'oversized') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ schemaVersion: 1, ack: { toast: { type: 'info', content: 'x'.repeat(4096) } } }));
        return;
      }
      if (mode === 'card') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ schemaVersion: 1, ack: { card: { schema: '2.0', body: { elements: [] } } } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ schemaVersion: 1, ack: { toast: { type: 'success', content: 'accepted' } } }));
    };

    if (delayMs > 0) setTimeout(send, delayMs);
    else send();
  });
});

server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture_address_unavailable');
  process.stdout.write(`${JSON.stringify({ ready: true, port: address.port })}\n`);
});

const close = () => server.close(() => process.exit(0));
process.on('SIGTERM', close);
process.on('SIGINT', close);
