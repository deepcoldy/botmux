/** Opt-in real kernel boundary tests. Run in an OUTER isolated network namespace
 * with the fixture addresses installed on lo; never adds host firewall rules.
 * bun run build && BOTMUX_NETWORK_POLICY_INTEGRATION=1 bun run test test/sandbox-network-linux.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:net';
import { mkdtempSync, writeFileSync, rmSync, realpathSync, readFileSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnTsScript } from './helpers/ts-runner.js';
import { createServer as httpServer } from 'node:http';
import { createSocket } from 'node:dgram';
import { spawn, spawnSync } from 'node:child_process';
import type { SandboxNetworkPolicy, NetworkMode } from '../src/core/sandbox-network-policy.js';

const enabled = process.platform === 'linux' && process.env.BOTMUX_NETWORK_POLICY_INTEGRATION === '1';
const modes: NetworkMode[] = ['allow', 'block', 'allowlist', 'denylist'];
const addresses = ['93.184.216.34', '10.77.0.1', '2606:4700::100', 'fd55::1'];
const port = 18087;
let directory: string;
const servers: Server[] = [];

// source tests import the BUILT sandbox, so the production re-exec entry path
// and compiled JS implementation are exercised, rather than a test wrapper.
async function run(policy: SandboxNetworkPolicy, source: string, onData?: (pid: number, text: string) => void, runtime: 'default' | 'pty' | 'binary' = 'default') {
  const { prepareDirectSandbox } = await import('../dist/adapters/backend/sandbox.js');
  const script = join(directory, `probe-${Math.random()}.mjs`);
  writeFileSync(script, source);
  const paths = ['/usr', '/etc', dirname(realpathSync(process.execPath)), directory];
  const sbx = prepareDirectSandbox({ sessionId: `network-${Math.random()}`, dataDir: directory,
    networkPolicy: policy, policy: { net: true, writeRegexes: [], rules: [...new Set(paths)].map(path => ({ path, access: path === directory ? 'readWrite' : 'readOnly', source: 'baseline' })) },
    chdir: directory, home: directory, cliBin: process.execPath, cliArgs: [script],
  });
  if (!sbx) throw new Error('sandbox setup failed');
  const env = { ...process.env, ...sbx.env } as Record<string, string>;
  let stdout = '', stderr = '';
  let kill: () => void;
  let exited: Promise<number | null>;
  if (runtime === 'pty') {
    const pty = await import('node-pty');
    const child = pty.spawn(sbx.bin, sbx.args, { name: 'xterm', cols: 100, rows: 30, cwd: directory, env });
    child.onData(chunk => { stdout += chunk; onData?.(child.pid, stdout); });
    kill = () => child.kill('SIGKILL');
    exited = new Promise(resolve => child.onExit(event => resolve(event.exitCode)));
  } else {
    // TS/JS file spawns use the runtime-aware helper. The compiled binary has
    // no script path; its production self-reexec token is tested directly.
    const child = runtime === 'binary'
      ? spawn(process.env.BOTMUX_NETWORK_TEST_BINARY!, ['__sandbox-network-runner', sbx.args.at(-1)!], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawnTsScript(sbx.args[0], sbx.args.slice(1), { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.on('data', chunk => { stdout += chunk; onData?.(child.pid!, stdout); });
    child.stderr!.on('data', chunk => stderr += chunk);
    kill = () => { child.kill('SIGKILL'); };
    exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  }
  const timer = setTimeout(kill, 15000);
  try {
    const code = await exited;
    if (code !== 0) throw new Error(`sandbox exited ${code}: ${stderr || stdout}`);
    return JSON.parse(stdout.trim().split('\n').at(-1)!);
  } finally { clearTimeout(timer); sbx.cleanup(); }

}

const probe = `import { connect } from 'node:net';
const attempt = (host) => new Promise(resolve => { const s = connect({host,port:${port}}); let done=false; const finish=x=>{if(done)return;done=true;s.destroy();resolve(x)};s.setTimeout(250,()=>finish(false));s.once('connect',()=>finish(true));s.once('error',()=>finish(false)); });
// No proxy convention is an authority: raw sockets still hit the kernel policy.
delete process.env.HTTP_PROXY; process.env.HTTPS_PROXY='http://127.0.0.1:8080';
console.log(JSON.stringify(await Promise.all(${JSON.stringify(addresses)}.map(attempt))));`;

describe.skipIf(!enabled)('real Linux sandbox network boundary', () => {
  beforeAll(async () => {
    // Refuse a normal host invocation; only the isolated fixture namespace can
    // own these addresses. Installing them is documented in the test guide.
    const ip = spawnSync('ip', ['-j', 'address', 'show', 'dev', 'lo'], { encoding: 'utf8' });
    if (!addresses.every(address => ip.stdout.includes(address))) throw new Error('run only in the isolated fixture network namespace');
    directory = mkdtempSync(join(tmpdir(), 'botmux-network-test-'));
    for (const address of addresses) {
      const server = createServer(socket => socket.end('ok'));
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, address, resolve); }); servers.push(server);
    }
  });
  afterAll(async () => { for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve())); if (directory) rmSync(directory, { recursive: true, force: true }); });
  for (const publicMode of modes) for (const privateMode of modes) {
    it(`${publicMode}/${privateMode}: IPv4, IPv6 and direct sockets`, async () => {
      const zone = (mode: NetworkMode, indices: number[]) => ({ mode, ...(['allowlist','denylist'].includes(mode) ? { rules: indices.map(i => ({ cidr: addresses[i], protocol: 'tcp' as const, ports: [port] })) } : {}) });
      const actual = await run({ version: 1, public: zone(publicMode, [0,2]), private: zone(privateMode, [1,3]) }, probe);
      const expected = (mode: NetworkMode) => mode === 'allow' || mode === 'allowlist';
      expect(actual).toEqual([expected(publicMode), expected(privateMode), expected(publicMode), expected(privateMode)]);
    });
  }
  it('blocks IPv4-mapped addresses, gateway aliases and host Unix IPC', async () => {
    const socketPath = join(directory, 'host.sock'); const host = createServer(socket => socket.end());
    await new Promise<void>(resolve => host.listen(socketPath, resolve));
    try {
      const source = `import {connect} from 'node:net'; const attempt=options=>new Promise(resolve=>{const s=connect(options);let done=false;const end=x=>{if(done)return;done=true;s.destroy();resolve(x)};s.setTimeout(250,()=>end(false));s.on('error',()=>end(false));s.on('connect',()=>end(true));}); console.log(JSON.stringify(await Promise.all([{host:'::ffff:10.77.0.1',port:${port}},{host:'10.0.2.2',port:${port}},{host:'10.0.2.3',port:53},{path:${JSON.stringify(socketPath)}}].map(attempt))));`;
      expect(await run({ version: 1, public: { mode: 'allow' }, private: { mode: 'block' } }, source)).toEqual([false,false,false,false]);
    } finally { await new Promise<void>(resolve => host.close(() => resolve())); }
  });
  it('cannot create a new user namespace or modify nftables', async () => {
    const source = `import {spawnSync} from 'node:child_process';const a=spawnSync('unshare',['-Urn','true']);const b=spawnSync('nft',['flush','ruleset']);console.log(JSON.stringify([a.status===0,b.status===0]));`;
    expect(await run({ version: 1, public: { mode: 'allow' }, private: { mode: 'block' } }, source)).toEqual([false,false]);
  });
  it('fresh lifetimes install the same frozen policy after restart', async () => {
    const policy: SandboxNetworkPolicy = { version: 1, public: { mode: 'block' }, private: { mode: 'allow' } };
    expect(await run(policy, probe)).toEqual([false,true,false,true]);
    expect(await run(structuredClone(policy), probe)).toEqual([false,true,false,true]);
  });
  it('model-shaped HTTP request succeeds through an approved exit; redirect into private space fails', async () => {
    let privateHits = 0;
    const publicServer = httpServer((req, res) => {
      if (req.url === '/redirect') { res.writeHead(307, { location: 'http://10.77.0.1:18088/secret' }); res.end(); return; }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: 'approved-model-response' } }] }));
    });
    const privateServer = httpServer((_req, res) => { privateHits++; res.end('secret'); });
    await new Promise<void>(resolve => publicServer.listen(18088, addresses[0], resolve));
    await new Promise<void>(resolve => privateServer.listen(18088, addresses[1], resolve));
    try {
      const source = `const response=await fetch('http://93.184.216.34:18088/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'fixture',messages:[{role:'user',content:'hello'}]})});const result=(await response.json()).choices[0].message.content;let redirect=false;try{await fetch('http://93.184.216.34:18088/redirect',{signal:AbortSignal.timeout(400)});redirect=true}catch{}console.log(JSON.stringify([result,redirect]));`;
      expect(await run({ version: 1, public: { mode: 'allowlist', rules: [{ cidr: addresses[0], protocol: 'tcp', ports: [18088] }] }, private: { mode: 'block' } }, source)).toEqual(['approved-model-response', false]);
      expect(privateHits).toBe(0);
    } finally { for (const server of [publicServer, privateServer]) server.closeAllConnections(); await Promise.all([publicServer, privateServer].map(server => new Promise<void>(resolve => server.close(() => resolve())))); }
  });
  it('changed DNS answers cannot move an allowed connection into private space', async () => {
    const dns = createSocket('udp4'); let query = 0;
    dns.on('message', (msg, peer) => {
      let end = 12; while (msg[end]) end += msg[end] + 1; end += 5;
      const header = Buffer.from(msg.subarray(0, 12)); header.writeUInt16BE(0x8180, 2); header.writeUInt16BE(1, 6); header.writeUInt16BE(0, 8); header.writeUInt16BE(0, 10);
      const answer = Buffer.from([0xc0,0x0c,0,1,0,1,0,0,0,0,0,4,...(++query === 1 ? [93,184,216,34] : [10,77,0,1])]);
      dns.send(Buffer.concat([header,msg.subarray(12,end),answer]),peer.port,peer.address);
    });
    await new Promise<void>(resolve => dns.bind(53, addresses[0], resolve));
    try {
      const source = `import {promises as dns} from 'node:dns'; import {connect} from 'node:net'; dns.setServers(['93.184.216.34']); const attempt=host=>new Promise(resolve=>{const s=connect({host,port:${port}});let done=false;const end=x=>{if(done)return;done=true;s.destroy();resolve(x)};s.setTimeout(300,()=>end(false));s.on('error',()=>end(false));s.on('connect',()=>end(true))});let result=[];for(let i=0;i<2;i++){const [host]=await dns.resolve4('model.test');result.push(await attempt(host))}console.log(JSON.stringify(result));`;
      expect(await run({ version: 1, public: { mode: 'allowlist', rules: [{ cidr: addresses[0], protocol: 'tcp', ports: [port] }] }, private: { mode: 'block' }, dnsServers: [addresses[0]] }, source)).toEqual([true,false]);
      expect(query).toBe(2);
    } finally { await new Promise<void>(resolve => dns.close(() => resolve())); }
  });
  it('TCP permission does not authorize UDP on the same address/port', async () => {
    const udp = createSocket('udp4'); udp.on('message', (message, peer) => udp.send(message, peer.port, peer.address));
    await new Promise<void>(resolve => udp.bind(port, addresses[0], resolve));
    try {
      const source = `import {createSocket} from 'node:dgram';const result=await new Promise(resolve=>{const s=createSocket('udp4');const timer=setTimeout(()=>{s.close();resolve(false)},300);s.once('message',()=>{clearTimeout(timer);s.close();resolve(true)});s.send('test',${port},'93.184.216.34')});console.log(JSON.stringify(result));`;
      expect(await run({ version: 1, public: { mode: 'allowlist', rules: [{ cidr: addresses[0], protocol: 'tcp', ports: [port] }] }, private: { mode: 'block' } }, source)).toBe(false);
      expect(await run({ version: 1, public: { mode: 'allow' }, private: { mode: 'block' } }, source)).toBe(true);
    } finally { await new Promise<void>(resolve => udp.close(() => resolve())); }
  });
  it('forwarder death terminates the task instead of opening unfiltered egress', async () => {
    let killed = false;
    const source = `console.log('TASK_READY'); setInterval(()=>{},1000);`;
    await expect(run({ version: 1, public: { mode: 'allow' }, private: { mode: 'block' } }, source, (pid, text) => {
      if (killed || !text.includes('TASK_READY')) return;
      const children = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean);
      const link = children.find(child => readlinkSync(`/proc/${child}/exe`).includes('slirp4netns'));
      if (!link) throw new Error('forwarder child was not found');
      killed = true; process.kill(Number(link), 'SIGKILL');
    })).rejects.toThrow('network forwarder exited');
    expect(killed).toBe(true);
  });

  it('real PTY preserves IPv4/IPv6 boundary', async () => {
    const source = probe.replace("console.log(JSON.stringify", "console.error('PTY_READY'); console.log(JSON.stringify");
    expect(await run({ version: 1, public: { mode: 'allow' }, private: { mode: 'block' } }, source, undefined, 'pty')).toEqual([true,false,true,false]);
  });
  it.skipIf(!process.env.BOTMUX_NETWORK_TEST_BINARY)('single-file binary reexec enforces the same frozen policy', async () => {
    expect(await run({ version: 1, public: { mode: 'block' }, private: { mode: 'allow' } }, probe, undefined, 'binary')).toEqual([false,true,false,true]);
  });
  it('supervisor SIGKILL closes the forwarder and namespace lifetime', async () => {
    let observed: string[] = [];
    await expect(run({ version: 1, public: { mode: 'allow' }, private: { mode: 'block' } }, `console.log('TASK_READY');setInterval(()=>{},1000);`, (pid, text) => {
      if (observed.length || !text.includes('TASK_READY')) return;
      observed = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean);
      expect(observed.length).toBe(2); process.kill(pid, 'SIGKILL');
    })).rejects.toThrow('sandbox exited');
    const running = (pid: string) => { try { return !readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.startsWith('Z '); } catch { return false; } };
    for (let i = 0; i < 40 && observed.some(running); i++) await new Promise(resolve => setTimeout(resolve, 50));
    expect(observed.every(pid => !running(pid))).toBe(true);
  });
});
