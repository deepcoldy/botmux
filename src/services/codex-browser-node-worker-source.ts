/** Trusted Node service entry embedded as source, so Bun/Vitest cannot rewrite
 * its built-in imports or introduce references to host bundler helpers. */
export const BROWSER_NODE_WORKER_SOURCE = String.raw`/** Self-contained trusted worker body. Embedded in the compiled binary; never
 * resolved through a Bun virtual path or supplied by a tool caller. */
async function browserNodeServiceMain(wire) {
    const { createInterface } = await import('node:readline');
    const { createConnection } = await import('node:net');
    const { pathToFileURL } = await import('node:url');
    const { homedir, tmpdir, platform } = await import('node:os');
    const { WASI } = await import('node:wasi');
    if (Number(process.versions.node.split('.')[0]) < 22 || typeof WASI.prototype.getImportObject !== 'function' || typeof WASI.prototype.initialize !== 'function') {
        throw new Error('The browser plugin requires Node.js with WASI reactor support (Node 22 or newer)');
    }
    const pending = new Map();
    const hooks = new Set();
    let serial = 0;
    let meta = {};
    let service;
    function send(message) {
        const line = JSON.stringify(wire.encode(message));
        if (Buffer.byteLength(line) > 32 * 1024 * 1024)
            throw new Error('Browser runtime message is too large');
        process.stdout.write(line + '\n');
    }
    function callback(method, params) {
        if (pending.size >= 128)
            return Promise.reject(new Error('Browser runtime callback capacity exceeded'));
        const id = ++serial;
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            try {
                send({ type: 'callback', id, method, params });
            }
            catch (error) {
                pending.delete(id);
                reject(error);
            }
        });
    }
    // Each hook gets its own bounded timeout, and the timer is cleared as soon
    // as the hook settles, so a fast hook never leaves a pending Timeout handle.
    function runTurnEndedHook(h, event) {
        const timeoutMs = typeof h.timeoutMs === 'number' && Number.isFinite(h.timeoutMs) && h.timeoutMs > 0
            ? h.timeoutMs : 4000;
        let timer;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(
                () => reject(new Error('turn-ended handler timed out after ' + timeoutMs + 'ms')),
                timeoutMs,
            );
        });
        return Promise.race([Promise.resolve().then(() => h.run(event)), timeout])
            .finally(() => clearTimeout(timer));
    }
    async function handle(message) {
        if (message.type === 'callback-result') {
            const p = pending.get(message.id);
            if (!p)
                return;
            pending.delete(message.id);
            typeof message.error === 'string' ? p.reject(new Error(message.error)) : p.resolve(message.value);
            return;
        }
        if (message.type !== 'request')
            return;
        meta = message.meta ?? {};
        try {
            let value;
            if (message.method === 'initialize') {
                const runtime = {
                    env: process.env, cwd: process.cwd(), homeDir: homedir(), tmpDir: tmpdir(), platform: platform(),
                    get requestMeta() { return meta; },
                    nativePipe: { createConnection: (path) => new Promise((resolve, reject) => {
                            const socket = createConnection(path);
                            socket.once('error', reject);
                            socket.once('connect', () => { socket.off('error', reject); resolve(socket); });
                        }) },
                    config: {
                        read: (p) => callback('config.read', p),
                        readRequirements: () => callback('config.readRequirements'),
                        readToml: (p) => callback('config.readToml', p),
                        writeToml: (path, v) => callback('config.writeToml', { path, value: v }),
                    },
                    createElicitation: (p) => callback('createElicitation', p),
                    fetch: async (input, init) => {
                        const r = new Request(input, init);
                        r.signal.throwIfAborted();
                        const result = await callback('fetch', {
                            url: r.url, method: r.method, headers: [...r.headers.entries()],
                            body: Buffer.from(await r.arrayBuffer()).toString('base64'),
                        });
                        r.signal.throwIfAborted();
                        return new Response([204, 205, 304].includes(result.status) ? null : Buffer.from(result.body, 'base64'), result);
                    },
                    addTurnEndedHandler: (h) => { hooks.add(h); return () => hooks.delete(h); },
                    setResponseMeta() { }, addAfterSubmittedCodeHook() { }, emitContentItem() { }, emitImage() { }, write() { },
                };
                globalThis.nodeRepl = runtime;
                service = await import(pathToFileURL(message.params.modulePath).href);
                value = { nodeVersion: process.versions.node };
            }
            else if (message.method === 'rpc') {
                if (!service)
                    throw new Error('Browser runtime has not initialized');
                value = await service.handleRpc(message.params);
            }
            else if (message.method === 'turnEnded') {
                // Settle the whole batch (each hook bounded by its own timeout)
                // before answering: a fail-fast race would let the next turn
                // start while hooks from this batch are still running.
                const outcomes = await Promise.allSettled([...hooks].map(h => runTurnEndedHook(h, message.params)));
                const rejected = outcomes.find(outcome => outcome.status === 'rejected');
                if (rejected)
                    throw rejected.reason;
            }
            else
                throw new Error('Unsupported browser runtime request');
            send({ type: 'result', id: message.id, value });
        }
        catch (error) {
            send({ type: 'result', id: message.id, error: error instanceof Error ? error.message : String(error) });
        }
    }
    // Plugin diagnostics must never share or corrupt the structured stdout pipe.
    console.log = () => { };
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    lines.on('line', line => {
        if (Buffer.byteLength(line) > 32 * 1024 * 1024)
            process.exit(1);
        try {
            void handle(wire.decode(JSON.parse(line))).catch(() => process.exit(1));
        }
        catch {
            process.exit(1);
        }
    });
    lines.on('close', () => process.exit(0));
    send({ type: 'ready' });
}

browserNodeServiceMain((__BOTMUX_BROWSER_CODEC__)()).catch(() => process.exit(1));
`;
