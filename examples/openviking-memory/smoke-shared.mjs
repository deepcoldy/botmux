#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConnection, MemoryClient, resolveIdentity } from './client.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  if (!['--config', '--codex', '--opencode', '--opencode-model', '--opencode-config'].includes(process.argv[i]) || !process.argv[i + 1]) {
    throw new Error('Use --config FILE [--codex BIN] [--opencode BIN --opencode-model PROVIDER/MODEL --opencode-config FILE].');
  }
  options[process.argv[i].slice(2)] = process.argv[i + 1];
}
if (!options.config) throw new Error('--config is required; this test writes isolated project memory and optionally calls Agent models.');
const connection = loadConnection(options.config);
const work = mkdtempSync(join(tmpdir(), 'ov-cross-agent-'));
const project = join(work, 'project'), other = join(work, 'other');
const id = randomUUID().slice(0, 8), peer = `shared-test-${id}`;
for (const [path, name] of [[project, peer], [other, `other-test-${id}`]]) {
  mkdirSync(join(path, '.openviking'), { recursive: true });
  writeFileSync(join(path, '.openviking/config.local.json'), JSON.stringify({ peer: { id: name } }));
}
const evidence = join(root, 'evidence', 'shared', id);
mkdirSync(evidence, { recursive: true, mode: 0o700 });
const save = (name, value) => writeFileSync(join(evidence, name + '.json'), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const client = new MemoryClient(connection, resolveIdentity(connection, project));
const prefix = `青杉-${id}已验收`, tag = `验收标签：琥珀-${id}`;
const receipt = await client.remember([
  { role: 'user', content: `请记住本项目的发布摘要约定：第一行必须是“${prefix}”，最后一行必须是“${tag}”。只适用于本项目，其他项目不使用这条规则。` },
  { role: 'assistant', content: `已确认本项目发布摘要约定：首行 ${prefix}，末行 ${tag}。` },
]);
save('receipt', receipt);
assert.ok(receipt.task_id, 'commit must return a task ID');
let task;
const deadline = Date.now() + 180_000;
while (Date.now() < deadline) {
  task = await client.task(receipt.task_id);
  if (['completed', 'failed', 'cancelled'].includes(task.status)) break;
  await new Promise(resolve => setTimeout(resolve, 1000));
}
save('task', task);
assert.equal(task?.status, 'completed', 'extraction must complete');
const hits = await client.find(`本项目 发布摘要 首行 末行 ${id}`);
save('find', hits);
const uris = (hits.memories || []).map(hit => hit.uri);
const uri = uris.find(uri => uri.includes(`/peers/${peer}/`));
assert.ok(uri, 'project write must be indexed under its peer');
const detail = await client.read(uri);
save('read', detail);
assert.ok(detail.includes(tag), 'read must return the unique convention');
const search = await client.search('本项目之前约定的发布摘要格式');
save('search', search);
assert.ok(JSON.stringify(search).includes(`/peers/${peer}/`), 'search must return the current project memory');
const otherClient = new MemoryClient(connection, resolveIdentity(connection, other));
const negative = await otherClient.search(`发布摘要 ${id}`);
save('other-project', negative);
assert.equal(JSON.stringify(negative).includes(`/peers/${peer}/`), false);

const quote = text => "'" + text.replace(/'/g, "'\\''") + "'";
const command = `node ${quote(join(root, 'memory.mjs'))} --config ${quote(connection.configPath)}`;
const guide = readFileSync(join(root, 'memory-usage.md'), 'utf8').replace('{{MEMORY_COMMAND}}', command)
  .replace('The optional Codex adapter automatically captures dialogue;', 'No automatic capture is enabled in this test;');
const instructions = join(work, 'memory-guide.md');
writeFileSync(instructions, guide);
const prompt = '请按本项目此前约定写一份发布摘要，内容是修复登录页面错误。只输出摘要。';

async function agent(name, binary, args, env = {}) {
  const child = spawn(binary, args, { cwd: project, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timeout = setTimeout(() => child.kill('SIGTERM'), 180_000);
  const code = await new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject); }).finally(() => clearTimeout(timeout));
  const result = { code, stdout, stderr };
  save(name, result);
  assert.equal(code, 0, `${name} did not complete; inspect private evidence`);
  const records = stdout.split('\n').filter(line => line.trim().startsWith('{')).map(line => JSON.parse(line));
  const answer = name === 'codex'
    ? records.filter(r => r.item?.type === 'agent_message').map(r => r.item.text).join('\n')
    : records.filter(r => r.type === 'text').map(r => r.part?.text || '').join('\n');
  const toolEvidence = JSON.stringify(records.filter(r => name === 'codex' ? r.item?.type !== 'agent_message' : r.type !== 'text'));
  assert.ok(toolEvidence.includes('memory.mjs') && /\b(search|find)\b/.test(toolEvidence), `${name} must actively search shared memory`);
  assert.ok(answer.includes(prefix) && answer.includes(tag), `${name} must apply the recalled convention`);
  return { name, answer, activelySearched: true };
}

const agents = [];
if (options.codex) {
  agents.push(await agent('codex', options.codex, [
    '--no-daemon', 'exec', '--json', '--skip-git-repo-check', '-C', project,
    '-c', 'memories.use_memories=false', '-c', 'memories.generate_memories=false',
    '-c', 'plugins.openviking-memory@openviking.enabled=false',
    '-c', 'developer_instructions=' + JSON.stringify(guide), prompt,
  ]));
}
if (options.opencode) {
  const config = join(work, 'opencode.json');
  const provided = options['opencode-config'] ? JSON.parse(readFileSync(options['opencode-config'], 'utf8')) : {};
  writeFileSync(config, JSON.stringify({ ...provided, instructions: [...(provided.instructions || []), instructions] }), { mode: 0o600 });
  agents.push(await agent('opencode', options.opencode, [
    '--pure', 'run', '--auto', '--format', 'json', '--dir', project,
    ...(options['opencode-model'] ? ['--model', options['opencode-model']] : []), prompt,
  ], { OPENCODE_CONFIG: config }));
}
const result = { passed: true, peer, uri, extractionCompleted: true, otherProjectFiltered: true, agents, evidence, larkEndToEndVerified: false };
save('summary', result);
console.log(JSON.stringify(result, null, 2));
