import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConnection, MemoryClient, resolveIdentity } from './client.mjs';
import { setupShared } from './setup-shared.mjs';

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'ov-shared-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function configure(root, fields = {}) {
  const path = join(root, 'ovcli.conf');
  writeFileSync(path, JSON.stringify({ url: 'http://127.0.0.1:1933', account: 'default', user: 'shared-owner', ...fields }));
  return path;
}

async function recordingServer(t) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', result: req.url.endsWith('/commit') ? { task_id: 'task-123' } : { ok: true } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

test('same project across Agent skill roots, subdirectories, worktrees and remote spellings', t => {
  const root = workspace(t), repo = join(root, 'repo'), worktree = join(root, 'worktree');
  mkdirSync(repo);
  const git = args => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git(['init']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'test']);
  git(['remote', 'add', 'origin', 'git@github.com:Example/Shared.git']);
  git(['worktree', 'add', '-b', 'other', worktree]);
  const sub = join(repo, 'src'); mkdirSync(sub);
  const connection = loadConnection(configure(root));
  const peer = resolveIdentity(connection, repo).peer;
  assert.equal(resolveIdentity(connection, sub).peer, peer);
  assert.equal(resolveIdentity(connection, worktree).peer, peer);
  git(['remote', 'set-url', 'origin', 'https://token:secret@github.com/Example/Shared.git']);
  assert.equal(resolveIdentity(connection, repo).peer, peer);
  assert.equal(peer, 'github.com-example-shared');
  assert.equal(peer.includes('secret'), false);
});

test('two different Agent installations reuse a single user and client without Codex dependencies', async t => {
  const root = workspace(t), config = configure(root, { peer: { id: 'shared-project' } });
  const { requests, url } = await recordingServer(t);
  configure(root, { url, peer: { id: 'shared-project' } });
  for (const name of ['codex', 'opencode']) {
    const skillsDir = join(root, name, 'skills');
    await setupShared(['agent-bind', '--config', config, '--skills-dir', skillsDir]);
    const installed = join(skillsDir, 'openviking-memory/scripts/memory.mjs');
    const identity = JSON.parse(execFileSync(process.execPath, [installed, '--config', config, '--cwd', root, 'identity'], { encoding: 'utf8' }));
    assert.equal(identity.user, 'shared-owner'); assert.equal(identity.peer, 'shared-project');
    const module = await import(installed);
    await module.runMemoryCommand(['search', 'past decision'], { config, cwd: root });
  }
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(r => r.headers['x-openviking-actor-peer']), ['shared-project', 'shared-project']);
});

test('search enforces actor/coding context; project writes carry explicit peer and extraction policy', async t => {
  const root = workspace(t), { requests, url } = await recordingServer(t);
  const connection = loadConnection(configure(root, { url, peer: { id: 'project-a' } }));
  const client = new MemoryClient(connection, resolveIdentity(connection, root));
  await client.search('past decision');
  const receipt = await client.remember([{ role: 'user', content: 'Confirmed decision' }]);
  assert.equal(receipt.task_id, 'task-123');
  assert.equal(requests[0].body.peer_scope, 'actor');
  assert.equal(requests[0].body.purpose, 'coding');
  assert.equal(requests[0].body.mode, 'context');
  assert.deepEqual(requests[1].body.memory_policy, { self: { enabled: false }, peer: { enabled: true }, working_memory: { enabled: false } });
  assert.equal(requests[2].body.messages[0].peer_id, 'project-a');
});

test('user writes have no project peer; no-project reads never widen to all peers', async t => {
  const root = workspace(t), { requests, url } = await recordingServer(t);
  const connection = loadConnection(configure(root, { url }));
  const client = new MemoryClient(connection, resolveIdentity(connection, root));
  await client.search('user preference');
  await client.remember([{ role: 'user', content: 'Prefer Chinese replies' }], 'user');
  assert.deepEqual(requests[0].body.target_uri, ['viking://user/shared-owner/memories']);
  assert.equal('peer_id' in requests[2].body.messages[0], false);
  await assert.rejects(client.remember([{ role: 'user', content: 'project fact' }]), /Project memory needs/);
  assert.equal(requests.length, 4);
});

test('another project or user URI is rejected before HTTP while returned Unicode URI is readable', async t => {
  const root = workspace(t), { requests, url } = await recordingServer(t);
  const connection = loadConnection(configure(root, { url, peer: { id: 'project-a' } }));
  const client = new MemoryClient(connection, resolveIdentity(connection, root));
  for (const uri of ['viking://user/shared-owner/peers/project-b/memories/x', 'viking://user/other/memories/x', 'viking://user/shared-owner/memories/../peers/project-b/x']) {
    assert.throws(() => client.read(uri), /Read a memory URI/);
  }
  assert.equal(requests.length, 0);
  await client.read('viking://user/shared-owner/peers/project-a/memories/项目 约定.md');
  assert.equal(requests.length, 1);
});

test('setup help has no side effects; explicit bind and unbind protect local skill edits', async t => {
  const root = workspace(t), config = configure(root), skillsDir = join(root, 'skills');
  assert.match(await setupShared([]), /default off/);
  await setupShared(['agent-bind', '--config', config, '--skills-dir', skillsDir]);
  const path = join(skillsDir, 'openviking-memory/SKILL.md');
  const original = readFileSync(path, 'utf8');
  assert.match(original, /scripts\/memory.mjs/);
  writeFileSync(path, original + '\nuser edit\n');
  await assert.rejects(setupShared(['agent-unbind', '--skills-dir', skillsDir]), /local edits/);
  writeFileSync(path, original);
  const result = await setupShared(['agent-unbind', '--skills-dir', skillsDir]);
  assert.equal(result.enabled, false);
});
