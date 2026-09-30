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

const contractTool = serverName === 'data'
  ? 'frozen_query_raw'
  : serverName === 'legacy-data'
    ? 'execute_frozen_query'
    : serverName === 'report'
      ? 'render_report'
      : undefined;
const jsonTool = serverName === 'json-report' ? 'read_report' : undefined;

server.setRequestHandler(ListToolsRequestSchema, request => (contractTool || jsonTool)
  ? {
      tools: [
        {
          name: contractTool ?? jsonTool,
          description: 'execute frozen command',
          inputSchema: contractTool
            ? { type: 'object', properties: { payload: {}, parameters: {}, values: {} } }
            : { type: 'object' },
        },
      ],
    }
  : request.params?.cursor
    ? {
        tools: [{ name: `${serverName}_unique`, description: `${serverName} unique`, inputSchema: { type: 'object' } }],
      }
    : {
        tools: [{ name: 'echo', description: `${serverName} echo`, inputSchema: { type: 'object' } }],
        nextCursor: 'second-page',
      });

server.setRequestHandler(CallToolRequestSchema, request => {
  if (contractTool) {
    const args = request.params.arguments ?? {};
    const trusted = request.params._meta?.botmuxTrustedCaller;
    if (process.env.BOTMUX_SESSION_ID || !process.env.BOTMUX_EXECUTION_ID || trusted?.requestUserUnionId !== 'on_test') {
      return { isError: true, content: [{ type: 'text', text: 'wrong_identity' }] };
    }
    if (request.params.name === contractTool) {
      if (args.values?.days !== 30 || Object.hasOwn(args.values ?? {}, 'sql') || Object.hasOwn(args.values ?? {}, 'report')) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              rows: [], columns: [], row_count: 0, query_id: null, error_code: 'invalid_request',
            }),
          }],
        };
      }
      if (args.payload?.sql?.includes('RETURN_VALIDATION_ERROR')) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              rows: [], columns: [], row_count: 0, query_id: null, error_code: 'untrusted_caller',
            }),
          }],
        };
      }
      if (args.payload?.sql?.includes('RETURN_MATH_TEXT')) {
        return { content: [{ type: 'text', text: JSON.stringify({
          rows: [{ amount: 'a<b 且 c>d' }], columns: [{ name: 'amount', description: 'amount' }], row_count: 1, query_id: 'q_fixture', error_code: null,
        }) }] };
      }
      if (args.payload?.sql?.includes('RETURN_RAW_HTML')) {
        return { content: [{ type: 'text', text: JSON.stringify({
          rows: [{ amount: '<a href="https://evil.example">click</a>' }], columns: [{ name: 'amount', description: 'amount' }], row_count: 1, query_id: 'q_fixture', error_code: null,
        }) }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify({
        rows: [{ amount: serverName === 'report' ? 'second-plugin-ok' : 12 }],
        columns: [{ name: 'amount', description: 'amount' }],
        row_count: 1,
        query_id: 'q_fixture',
        error_code: null,
      }) }] };
    }
    return { isError: true, content: [{ type: 'text', text: 'query_plan_sql_mismatch' }] };
  }
  if (jsonTool && request.params.name === jsonTool) {
    const trusted = request.params._meta?.botmuxTrustedCaller;
    if (trusted?.requestUserUnionId !== 'on_test') {
      return { isError: true, content: [{ type: 'text', text: 'wrong_identity' }] };
    }
    return {
      content: [{ type: 'text', text: 'report ready' }],
      structuredContent: {
        rows: [
          {
            name: request.params.arguments?.days === 31
              ? '[点我领奖](http://evil.example) **bold** _italic_'
              : `report-${request.params.arguments?.days}`,
            total: 12,
            secret: 'hidden',
          },
        ],
      },
    };
  }
  if (serverName === 'content-large') {
    return { content: [{ type: 'text', text: '中'.repeat(25_000) }] };
  }
  return {
    content: [{
      type: 'text',
      text: `${serverName}:${request.params.name}:${JSON.stringify(request.params.arguments ?? {})}:meta=${JSON.stringify(request.params._meta ?? {})}:session=${process.env.BOTMUX_SESSION_ID || ''}:token=${process.env.PRIVATE_MCP_TOKEN || ''}:execution=${process.env.BOTMUX_EXECUTION_ID || ''}`,
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
