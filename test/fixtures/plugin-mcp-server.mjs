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
  if (serverName === 'link-ref') {
    const authorizationUrl = 'https://auth.example.test/authorize'
      + '?code=code-value&token=token-value&signature=sig-value&state=state-value'
      + '&redirect_uri=https%3A%2F%2Fclient.example.test%2Fcallback';
    return {
      content: [
        { type: 'text', text: `permission required: ${authorizationUrl}` },
        {
          type: 'resource',
          resource: {
            uri: 'demo://embedded',
            mimeType: 'text/plain',
            text: `documentation ${authorizationUrl}`,
          },
        },
        { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' },
      ],
      structuredContent: {
        authorization: { url: authorizationUrl },
        documentation_url: authorizationUrl,
        headers: { Authorization: 'Bearer do-not-register' },
        access_token: 'https://credential.example.test/secret',
        excluded: {
          _meta: { 'botmux/linkRefPolicy': 'exclude' },
          url: 'https://excluded.example.test/path',
        },
      },
    };
  }
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
  contents: serverName === 'link-ref'
    ? [{
        uri: request.params.uri,
        mimeType: 'application/json',
        text: JSON.stringify({
          authorization_url: 'https://auth.example.test/approve'
            + '?state=resource-state&code=resource-code',
          password: 'https://credential.example.test/password',
        }),
      }]
    : [{ uri: request.params.uri, text: `${serverName}:${request.params.uri}` }],
}));

server.setRequestHandler(SubscribeRequestSchema, () => ({}));
server.setRequestHandler(UnsubscribeRequestSchema, () => ({}));
server.setRequestHandler(SetLevelRequestSchema, () => ({}));
server.setRequestHandler(CompleteRequestSchema, request => ({
  completion: { values: [`${serverName}:${request.params.argument.value}`] },
}));

await server.connect(new StdioServerTransport());
