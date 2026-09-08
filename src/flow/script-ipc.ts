/**
 * script host 进程侧的 IPC 胶水：把 `HostBridge` 映射到 runner ↔ script 的消息（§6.1）。
 * 入口 `src/flow-script.ts` 只是把它接到 `process.send`/`process.on('message')` 上。
 */
import { ScriptHardError, ScriptRuntime, type HostBridge } from './script-host.js';
import type { Outcome, RunnerToScriptMessage, ScriptToRunnerMessage } from './types.js';

export interface ScriptTransport {
  send(message: ScriptToRunnerMessage): void;
  onMessage(handler: (message: RunnerToScriptMessage) => void): void;
  /** runner 断开：script host 必须立刻退出（父死子亡，§6.3）。 */
  onDisconnect(handler: () => void): void;
}

export interface ScriptHostSession {
  /** 在 `start` 到达后开始执行；返回 runner 收到 done/error 之后 resolve。 */
  finished: Promise<'done' | 'error' | 'aborted'>;
}

export function serveScriptHost(transport: ScriptTransport, pid: number = process.pid): ScriptHostSession {
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let runtime: ScriptRuntime | null = null;
  let finishedResolve: (v: 'done' | 'error' | 'aborted') => void = () => {};
  const finished = new Promise<'done' | 'error' | 'aborted'>((resolve) => {
    finishedResolve = resolve;
  });

  type CallMessage = Extract<ScriptToRunnerMessage, { t: 'call' }>;
  type DistributiveOmitId<M> = M extends unknown ? Omit<M, 'id'> : never;
  const call = <T>(message: DistributiveOmitId<CallMessage>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      transport.send({ ...message, id } as CallMessage);
    });

  const bridge: HostBridge = {
    agent: (c) => call<Outcome>({ t: 'call', op: 'agent', identity: c.identity, scopePath: c.scopePath, content: c.content, spec: c.spec }),
    signal: (c) => call<Outcome>({ t: 'call', op: 'signal', identity: c.identity, scopePath: c.scopePath, content: c.content, spec: c.spec }),
    log: (c) => call<void>({ t: 'call', op: 'log', scopePath: c.scopePath, text: c.text }),
    position: (c) => {
      // 不等应答；runner 只用它记录结构与刷新失速看门狗
      void call<void>({ t: 'call', op: 'position', scopePath: c.scopePath, kind: c.kind, identity: c.identity, size: c.size }).catch(() => {});
    },
  };

  const rejectAll = (err: Error): void => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };

  transport.onMessage((message) => {
    switch (message.t) {
      case 'start': {
        if (runtime) return;
        runtime = new ScriptRuntime({
          source: message.source,
          input: message.input,
          cwd: message.cwd,
          execConfigDigest: message.execConfigDigest,
          filename: message.filename,
          bridge,
        });
        void runtime.run().then((result) => {
          if (result.kind === 'done') {
            transport.send({ t: 'done', value: result.value });
            finishedResolve('done');
          } else {
            transport.send({ t: 'error', code: result.code, message: result.message, ...(result.stack ? { stack: result.stack } : {}) });
            finishedResolve(result.code === 'aborted' ? 'aborted' : 'error');
          }
        });
        break;
      }
      case 'reply': {
        const p = pending.get(message.id);
        if (!p) return;
        pending.delete(message.id);
        p.resolve(message.result);
        break;
      }
      case 'reject': {
        const p = pending.get(message.id);
        if (!p) return;
        pending.delete(message.id);
        p.reject(new ScriptHardError(message.code as ScriptHardError['code'], message.message));
        break;
      }
      case 'abort': {
        runtime?.abort(message.reason);
        rejectAll(new ScriptHardError('aborted', message.reason));
        if (!runtime) finishedResolve('aborted');
        break;
      }
      default:
        break;
    }
  });

  transport.onDisconnect(() => {
    runtime?.abort('runner disconnected');
    rejectAll(new ScriptHardError('aborted', 'runner disconnected'));
    finishedResolve('aborted');
  });

  transport.send({ t: 'hello', pid });
  return { finished };
}
