import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { prepareDirectSandbox } from '../src/adapters/backend/sandbox.js';
import { protectedHttpEgressAuthTokenPath } from '../src/core/protected-http-egress-host.js';
import { rmSandboxScratch } from './helpers/rm-sandbox-scratch.js';
import { tsEvalArgs } from './helpers/ts-runner.js';

const canRun = process.platform === 'linux' && spawnSync('bwrap', [
  '--ro-bind', '/', '/', '--unshare-user', '--unshare-pid', '--proc', '/proc', '--', '/bin/true',
], { stdio: 'ignore', timeout: 5000 }).status === 0;

describe.skipIf(!canRun)('protected egress authentication in the real file sandbox', () => {
  it.each([true, false])('hides the token at both paths while sockets remain usable (host grant=%s)', async hostGrant => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'bm-egress-token-')));
    const socketDir = join(root, 'sockets');
    const dataDir = join(root, 'data');
    mkdirSync(socketDir, { mode: 0o700 });
    mkdirSync(dataDir);
    const egressPath = join(socketDir, 'e.sock');
    const tokenPath = protectedHttpEgressAuthTokenPath(egressPath);
    mkdirSync(dirname(tokenPath), { mode: 0o700 });
    writeFileSync(tokenPath, 'private-token-fixture', { mode: 0o600 });
    const paths = [join(socketDir, 'g.sock'), egressPath];
    const servers = paths.map(() => createServer(socket => socket.end('CONNECTED')));
    await Promise.all(servers.map((server, i) => new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(paths[i], resolve);
    })));
    const script = `
      import { readFileSync, statSync } from 'node:fs';
      import { createConnection } from 'node:net';
      const tokens = ${JSON.stringify([tokenPath, '/run/botmux-mcp/egress-private/egress-auth'])};
      const readable = tokens.map(path => { try { return readFileSync(path, 'utf8'); } catch { return null; } });
      const sockets = ['/run/botmux-mcp/g.sock', '/run/botmux-mcp/e.sock'];
      const connected = await Promise.all(sockets.map(path => new Promise((resolve, reject) => {
        const socket = createConnection(path); let result = '';
        socket.on('data', data => result += data); socket.once('end', () => resolve(result)); socket.once('error', reject);
      })));
      console.log(JSON.stringify({ readable, connected, sockets: sockets.map(path => statSync(path).isSocket()) }));
    `;
    const evalLaunch = tsEvalArgs(script);
    let plan: ReturnType<typeof prepareDirectSandbox> = null;
    try {
      plan = prepareDirectSandbox({
        sessionId: 'token-boundary', dataDir, chdir: '/', home: '/',
        policy: { net: true, writeRegexes: [], rules: [
          ...new Set(['/usr', '/etc', dirname(realpathSync(evalLaunch.command)), ...(hostGrant ? [root] : [])]),
        ].map(path => ({ path, access: 'readOnly', source: 'internal' })) },
        cliBin: evalLaunch.command, cliArgs: evalLaunch.args,
        mcpGatewaySocketPath: paths[0], protectedEgressSocketPath: paths[1],
      });
      expect(plan).not.toBeNull();
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(plan!.bin, plan!.args, { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = ''; let stderr = '';
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('sandbox token probe timed out')); }, 15000);
        child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
      });
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({
        readable: [null, null], connected: ['CONNECTED', 'CONNECTED'], sockets: [true, true],
      });
      // Trusted outer runner still reads the host token; masking is namespace-only.
      expect((await import('node:fs')).readFileSync(tokenPath, 'utf8')).toBe('private-token-fixture');
    } finally {
      plan?.cleanup();
      await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
      rmSandboxScratch(root);
    }
  }, 20000);
});
