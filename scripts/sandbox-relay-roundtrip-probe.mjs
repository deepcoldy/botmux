// RELAY round-trip probe: inside the sandbox, run the `botmux` relay shim
// (`botmux send ...`) and confirm it drops a valid request into the outbox.
// Then validate that request with the exported validateRelayRequest (the host
// security boundary). We deliberately do NOT run the real host watcher re-exec
// (that would post to a real Lark chat). A background "fake watcher" writes a
// .res.json so the in-sandbox shim returns instead of hanging 120s.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareSandbox, validateRelayRequest } from '../dist/adapters/backend/sandbox.js';
import { createCliAdapterSync } from '../dist/adapters/cli/registry.js';

const SRC = '/root/sandbox-demo';
const adapter = createCliAdapterSync('codex', '/root/.local/share/fnm/node-versions/v22.21.1/installation/bin/codex');
const data = mkdtempSync(join(tmpdir(), 'sbx-relay-'));
const sid = `relay-${Date.now()}`;

// The in-sandbox shim runs `botmux send`, which resolves session-id from
// BOTMUX_SESSION_ID — inject it like the worker does.
const script = `
  set +e
  export BOTMUX_SESSION_ID=${sid}
  echo "RELAY: BOTMUX_SEND_RELAY=$BOTMUX_SEND_RELAY"
  botmux send "hello from sandbox via relay shim" --no-quote
  echo "RELAY: botmux send exit=$?"
`;

const sbx = prepareSandbox({
  enabled: true, cliId: 'codex', sessionId: sid, sourceWorkingDir: SRC,
  dataDir: data, cliBin: '/bin/sh', cliArgs: ['-c', script], hidePaths: [],
});
if (!sbx) { console.log('prepareSandbox null — FAIL'); process.exit(2); }

const outbox = sbx.outbox;
let capturedReq = null;

// Fake watcher: as soon as a *.req.json appears, capture+validate it and write a
// .res.json so the in-sandbox shim's 120s wait returns immediately.
const fake = setInterval(() => {
  let entries = [];
  try { entries = readdirSync(outbox); } catch { return; }
  for (const name of entries) {
    if (!name.endsWith('.req.json')) continue;
    const id = name.slice(0, -'.req.json'.length);
    try {
      const req = JSON.parse(readFileSync(join(outbox, name), 'utf8'));
      capturedReq = req;
      // validate content file actually exists in outbox
      const contentPath = join(outbox, req.contentFile);
      capturedReq.__contentExists = existsSync(contentPath);
      capturedReq.__contentText = capturedReq.__contentExists ? readFileSync(contentPath, 'utf8') : null;
    } catch (e) { capturedReq = { __parseError: String(e) }; }
    writeFileSync(join(outbox, `${id}.res.json`), JSON.stringify({ code: 0, stdout: 'fake-watcher-ok', stderr: '' }));
  }
}, 100);

// IMPORTANT: run the shim with async spawn (NOT spawnSync) so the fake-watcher
// setInterval can fire concurrently — spawnSync would block the event loop and
// the in-sandbox shim would hang 120s waiting for a .res.json that never lands.
const env = { ...process.env, ...sbx.env };
const r = await new Promise((resolve) => {
  const child = spawn(sbx.bin, sbx.args, { env });
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  child.on('close', (code) => resolve({ status: code, stdout: out, stderr: err }));
  child.on('error', (e) => resolve({ status: -1, stdout: out, stderr: String(e) }));
});
clearInterval(fake);
console.log('--- shim stdout ---'); console.log((r.stdout || '(none)').trimEnd());
if (r.stderr && r.stderr.trim()) { console.log('--- shim stderr ---'); console.log(r.stderr.trimEnd()); }
console.log('shim exit =', r.status);

console.log('captured outbox request =', JSON.stringify(capturedReq));
let validOk = false;
if (capturedReq && !capturedReq.__parseError) {
  const v = validateRelayRequest({ contentFile: capturedReq.contentFile, attachments: capturedReq.attachments, flags: capturedReq.flags });
  validOk = v.ok;
  console.log('validateRelayRequest =', JSON.stringify(v));
  console.log('content materialized & readable on host =', capturedReq.__contentExists, JSON.stringify(capturedReq.__contentText));
}

sbx.cleanup();
try { rmSync(data, { recursive: true, force: true }); } catch {}

const pass = !!capturedReq && !capturedReq.__parseError && validOk && capturedReq.__contentExists;
console.log('RESULT:', pass ? 'RELAY ROUND-TRIP OK (shim → outbox req → host-side validate passes)' : 'RELAY FAIL');
process.exit(pass ? 0 : 1);
