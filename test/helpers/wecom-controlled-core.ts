import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';

/** Isolated loopback cores. They never import daemon.ts, spawn a CLI, or connect to an IM. */
export interface ControlledCoreCall {
  method: string;
  path: string;
  body: string;
  headers: IncomingMessage['headers'];
}
export interface ControlledCoreReply { status?: number; body: unknown }
export async function createControlledWecomCore(initial: {
  health: unknown;
  sessions: unknown[];
  reply?: (call: ControlledCoreCall) => ControlledCoreReply | Promise<ControlledCoreReply>;
}) {
  const calls: ControlledCoreCall[] = [];
  const state = { health: initial.health, sessions: initial.sessions, reply: initial.reply };
  let held: Promise<void> | undefined;
  let release: (() => void) | undefined;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const call = { method: req.method ?? 'GET', path: req.url ?? '/', body: Buffer.concat(chunks).toString('utf8'), headers: req.headers };
    calls.push(call);
    if (held) await held;
    try {
      const custom = await state.reply?.(call);
      const result = custom ?? (call.path === '/healthz' || call.path === '/__health'
        ? { body: state.health }
        : call.path === '/api/sessions'
          ? { body: { sessions: state.sessions } }
          : { status: 404, body: { error: 'fixture_route_missing' } });
      res.writeHead(result.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result.body));
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  return {
    port, url: `http://127.0.0.1:${port}`, calls, state,
    hold() { held = new Promise<void>(done => { release = done; }); },
    release() { held = undefined; release?.(); release = undefined; },
    async close() {
      held = undefined; release?.();
      server.closeAllConnections();
      if (server.listening) await new Promise<void>(done => server.close(() => done()));
    },
  };
}

export interface MutableBirths {
  births: Map<number, string>;
  parents: Map<number, number>;
  namespaces: Map<number, string>;
}
/** Deliberately models two live cores carrying the same native SID. Test owners
 * may replace a birth/parent/boot while an HTTP operation is held in flight. */
export function controlledWecomBirths(): MutableBirths {
  return { births: new Map(), parents: new Map(), namespaces: new Map() };
}
export function privateUnifiedSessionRow(nativeSessionId: string, coreBotId: string) {
  return {
    sessionId: nativeSessionId, larkAppId: coreBotId,
    chatId: 'http_async_fixture', rootMessageId: 'http_fixture_root', scope: 'chat',
    title: 'private fixture session', status: 'active', cliId: 'codex', backendType: 'pty',
    workingDir: '/private/fixture-project', ownerOpenId: '',
    startedAt: Date.now(), lastMessageAt: new Date().toISOString(),
  };
}

export async function seedControlledBridgeTask(options: {
  botId: string; stateFile: string; coreIdentity: string; nativeSessionId: string; connectionId?:string;
}) {
  const { WecomBridge } = await import('../../src/im/wecom/gateway/bridge.js');
  const requests: unknown[] = [];
  const controls: Array<{ sessionId: string; triggerId: string }> = [];
  let state: 'running' | 'completed' | 'interrupted' = 'running';
  const bridge = new WecomBridge({
    botId: options.botId, connectionId:options.connectionId, stateFile: options.stateFile, coreIdentity: options.coreIdentity,
    allowedUsers: ['fixture-user'],
    transport: { reply: async () => {}, send: async () => {} },
    core: {
      trigger: async request => {
        requests.push(request);
        return { ok: true, triggerId: 'fixture-turn', target: { kind: 'turn', sessionId: options.nativeSessionId } };
      },
      result: async () => ({ ok: true, state, ...(state === 'completed' ? { output: { content: 'fixture result' } } : {}) }),
      interrupt: async (sessionId, triggerId) => { controls.push({ sessionId, triggerId }); state = 'interrupted'; },
    },
  });
  await bridge.receive({
    messageId: 'fixture-input', userId: 'fixture-user', conversationId: 'fixture-user',
    chatType: 'single', text: 'fixture task', replyContext: { requestId: 'fixture-callback' }, attachments: [],
  });
  await bridge.tick();
  return { bridge, requests, controls, complete() { state = 'completed'; } };
}
