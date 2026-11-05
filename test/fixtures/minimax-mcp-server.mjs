import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [calls, marker] = process.argv.slice(2);
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result;
  if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion,
    serverInfo: { name: 'botmux-mcp-fixture', version: '1' }, capabilities: { tools: {} } };
  else if (request.method === 'tools/list') result = { tools: [{ name: 'proof', description: 'Return a local test proof marker.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] };
  else if (request.method === 'tools/call') {
    if (process.env.MCP_FIXTURE_TOKEN !== 'synthetic-mcp-only') process.exit(3);
    if (process.env.MCP_FIXTURE_CWD && process.cwd() !== process.env.MCP_FIXTURE_CWD) process.exit(4);
    appendFileSync(calls, JSON.stringify(request.params) + '\n');
    result = { content: [{ type: 'text', text: marker }] };
  } else if (request.method === 'ping') result = {};
  else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unknown fixture method' } }) + '\n'); continue; }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
}
