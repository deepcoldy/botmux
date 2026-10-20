import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  SetLevelRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const serverName = process.argv[2] || 'fixture';
if (serverName === 'fail') process.exit(17);

const server = new Server(
  { name: serverName, version: '1.0.0' },
  {
    capabilities: {
      tools: {},
      resources: { subscribe: true },
      prompts: {},
      completions: {},
      logging: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, request => {
  return request.params?.cursor
    ? {
        tools: [{ name: `${serverName}_unique`, description: `${serverName} unique`, inputSchema: { type: 'object' } }],
      }
    : {
        tools: [{ name: 'echo', description: `${serverName} echo`, inputSchema: { type: 'object' } }],
        nextCursor: 'second-page',
      };
});

server.setRequestHandler(CallToolRequestSchema, request => {
  if (serverName === 'delivery') {
    const outbound = join(process.env.BOTMUX_PLUGIN_HOME, 'outbound');
    mkdirSync(outbound, { recursive: true });
    const attachment = join(outbound, 'result.txt');
    writeFileSync(attachment, 'private-result-row');
    return {
      content: [{ type: 'text', text: 'PRIVATE_ROWS_MUST_NOT_REACH_CALLER' }],
      _meta: {
        botmuxHostDelivery: {
          schemaVersion: 1,
          deliveryId: 'delivery_fixture_001',
          markdown: '分析摘要',
          files: [{ path: attachment }],
          responseKind: 'final',
        },
      },
    };
  }
  return {
    content: [{
      type: 'text',
      text: `${serverName}:${request.params.name}:${JSON.stringify(request.params.arguments ?? {})}:meta=${JSON.stringify(request.params._meta ?? {})}:session=${process.env.BOTMUX_SESSION_ID || ''}:token=${process.env.PRIVATE_MCP_TOKEN || ''}`,
    }],
  };
});

server.setRequestHandler(ListPromptsRequestSchema, () => ({
  prompts: [{ name: 'welcome', description: `${serverName} welcome` }],
}));

server.setRequestHandler(GetPromptRequestSchema, request => ({
  description: `${serverName}:${request.params.name}`,
  messages: [{ role: 'user', content: { type: 'text', text: `${serverName} prompt` } }],
}));

server.setRequestHandler(ListResourcesRequestSchema, () => ({
  resources: [{ uri: 'demo://shared', name: `${serverName} shared` }],
}));

server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
  resourceTemplates: [{ uriTemplate: 'demo://item/{id}', name: `${serverName} item` }],
}));

server.setRequestHandler(ReadResourceRequestSchema, request => ({
  contents: [{ uri: request.params.uri, text: `${serverName}:${request.params.uri}` }],
}));

server.setRequestHandler(SubscribeRequestSchema, () => ({}));
server.setRequestHandler(UnsubscribeRequestSchema, () => ({}));
server.setRequestHandler(SetLevelRequestSchema, () => ({}));
server.setRequestHandler(CompleteRequestSchema, request => ({
  completion: { values: [`${serverName}:${request.params.argument.value}`] },
}));

await server.connect(new StdioServerTransport());
