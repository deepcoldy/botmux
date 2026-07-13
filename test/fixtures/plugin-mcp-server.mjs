import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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

server.setRequestHandler(ListToolsRequestSchema, request => request.params?.cursor
  ? {
      tools: [{ name: `${serverName}_unique`, description: `${serverName} unique`, inputSchema: { type: 'object' } }],
    }
  : {
      tools: [{ name: 'echo', description: `${serverName} echo`, inputSchema: { type: 'object' } }],
      nextCursor: 'second-page',
    });

server.setRequestHandler(CallToolRequestSchema, request => ({
  content: [{ type: 'text', text: `${serverName}:${request.params.name}:${JSON.stringify(request.params.arguments ?? {})}` }],
}));

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
