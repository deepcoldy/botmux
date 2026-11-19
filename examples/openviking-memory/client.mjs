import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

function identifier(value, field) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.@-]+$/.test(value)
      || value === '.' || value === '..' || value === '__self' || value.startsWith('ext-')
      || value.length > 255 || (value.match(/@/g) ?? []).length > 1) {
    throw new Error(`Invalid OpenViking ${field}.`);
  }
  return value;
}

function sanitizePeer(value) {
  let clean = value.replace(/[^A-Za-z0-9_.@-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  const at = clean.indexOf('@');
  if (at >= 0) clean = clean.slice(0, at + 1) + clean.slice(at + 1).replace(/@/g, '-');
  if (clean.startsWith('ext-')) clean = `x-${clean}`;
  if (clean === '__self') clean = 'self';
  if (clean.length > 100) {
    const hash = createHash('sha256').update(value).digest('hex').slice(0, 12);
    clean = `${clean.slice(0, 87).replace(/[-.]+$/, '')}-${hash}`;
  }
  return clean;
}

function normalizedRemote(remote) {
  if (/^[A-Za-z]:[\\/]/.test(remote)) return '';
  const scp = /^(?:[^@/\\]+@)?([^:/\\]+):(?!\/)(.+)$/.exec(remote);
  let host, path;
  if (scp && !remote.includes('://')) [, host, path] = scp;
  else {
    let url;
    try { url = new URL(remote); } catch { return ''; }
    if (url.protocol === 'file:' || !url.hostname) return '';
    host = url.hostname.replace(/^\[|\]$/g, '');
    path = url.pathname;
  }
  path = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  return host && path ? `${host}/${path}`.toLowerCase() : '';
}

function workspacePeer(cwd) {
  let dir = cwd;
  while (dir !== dirname(dir) && dir !== homedir()) {
    const files = ['config.local.json', 'config.json'];
    for (const name of files) {
      const path = join(dir, '.openviking', name);
      if (existsSync(path)) {
        const peer = JSON.parse(readFileSync(path, 'utf8')).peer?.id;
        if (peer) return identifier(peer, 'project peer');
      }
    }
    if (existsSync(join(dir, '.git'))) break;
    dir = dirname(dir);
  }
  return '';
}

function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
    }).trim();
  } catch { return ''; }
}

export function loadConnection(configPath = process.env.OPENVIKING_CLI_CONFIG_FILE || join(homedir(), '.openviking/ovcli.conf')) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const url = new URL(config.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('OpenViking url must be an HTTP(S) service URL without embedded credentials.');
  }
  return {
    configPath: resolve(configPath), config,
    url: url.toString().replace(/\/+$/, ''),
    account: identifier(config.account || 'default', 'account'),
    user: identifier(config.user, 'shared user'),
    apiKey: config.api_key_env ? process.env[config.api_key_env] || '' : config.api_key || '',
  };
}

export function resolveIdentity(connection, cwd = process.cwd()) {
  cwd = realpathSync(cwd);
  const config = connection.config;
  let peer = workspacePeer(cwd) || config.peer?.id || config.actor_peer_id || '';
  if (!peer) {
    const source = config.peer?.source ?? config.plugin?.codex?.peerSource ?? 'git';
    const root = git(cwd, ['rev-parse', '--show-toplevel']);
    const common = root && git(cwd, ['rev-parse', '--git-common-dir']);
    const commonPath = common && (isAbsolute(common) ? common : resolve(cwd, common));
    const repositoryRoot = commonPath ? dirname(commonPath) : root;
    const remote = root && normalizedRemote(git(cwd, ['config', '--get', 'remote.origin.url']));
    const legacy = value => value.replace(/[^A-Za-z0-9]/g, '-');
    const vars = { git_remote: remote ? sanitizePeer(remote) : '', git_root: root ? legacy(repositoryRoot) : '', cwd: legacy(cwd) };
    const templates = Array.isArray(source) ? source
      : source === 'git' ? ['{git_remote}', '{git_root}'] : source === 'cwd' ? ['{cwd}'] : source === 'none' ? [] : null;
    if (!templates) throw new Error('peer.source must be git, cwd, none, or an array of project templates.');
    for (const template of templates) {
      if (typeof template !== 'string' || /\{harness\}/.test(template)) {
        throw new Error('Shared project identity cannot depend on an Agent harness.');
      }
      let missing = false;
      const rendered = template.replace(/\{([^}]+)\}/g, (_, key) => {
        if (!vars[key]) missing = true;
        return vars[key] || '';
      });
      if (!missing && rendered) { peer = rendered; break; }
    }
  }
  return { account: connection.account, user: connection.user, peer: peer ? identifier(peer, 'project peer') : '', cwd };
}

export class MemoryClient {
  constructor(connection, identity = resolveIdentity(connection)) {
    this.connection = connection;
    this.identity = identity;
  }

  async request(path, body) {
    const headers = {
      'Content-Type': 'application/json', 'X-OpenViking-Account': this.identity.account,
      'X-OpenViking-User': this.identity.user,
      ...(this.identity.peer ? { 'X-OpenViking-Actor-Peer': this.identity.peer } : {}),
      ...(this.connection.apiKey ? { Authorization: `Bearer ${this.connection.apiKey}` } : {}),
    };
    const response = await fetch(this.connection.url + path, {
      method: body === undefined ? 'GET' : 'POST', headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000), redirect: 'error',
    });
    if (!response.ok) throw new Error(`OpenViking returned HTTP ${response.status}.`);
    const result = await response.json();
    if (result.status !== 'ok') throw new Error('OpenViking rejected the operation.');
    return result.result;
  }

  memoryRoots() {
    const root = `viking://user/${this.identity.user}`;
    return [`${root}/memories`, ...(this.identity.peer ? [`${root}/peers/${this.identity.peer}/memories`] : [])];
  }

  search(query, maxTokens = 2500) {
    if (!query.trim()) throw new Error('A memory query is required.');
    if (!Number.isInteger(maxTokens) || maxTokens < 64 || maxTokens > 32000) throw new Error('Invalid max_tokens.');
    if (!this.identity.peer) return this.find(query);
    return this.request('/api/v1/search/search', {
      query, mode: 'context', purpose: 'coding', peer_scope: 'actor',
      context_type: 'memory', max_tokens: maxTokens, rewrite: false, query_expansion: 'off',
    });
  }

  find(query) {
    if (!query.trim()) throw new Error('A memory query is required.');
    return this.request('/api/v1/search/find', {
      query, target_uri: this.memoryRoots(), context_type: 'memory', limit: 10, score_threshold: 0,
    });
  }

  read(uri) {
    if (/%|[\\?#\u0000-\u001f]/.test(uri) || uri.split('/').some(part => part === '.' || part === '..')
        || !this.memoryRoots().some(root => uri === root || uri.startsWith(root + '/'))) {
      throw new Error('Read a memory URI from this shared user or the current project.');
    }
    return this.request('/api/v1/content/read?' + new URLSearchParams({ uri, limit: '200' }));
  }

  async remember(messages, scope = 'project') {
    if (!['project', 'user'].includes(scope)) throw new Error('scope must be project or user.');
    if (scope === 'project' && !this.identity.peer) throw new Error('Project memory needs a Git project or explicit peer.id.');
    if (!Array.isArray(messages) || !messages.length || messages.length > 100
        || messages.some(message => !['user', 'assistant'].includes(message.role)
          || typeof message.content !== 'string' || !message.content.trim())) {
      throw new Error('Remember expects 1-100 user/assistant messages with nonempty content.');
    }
    const sessionId = `agent-memory-${randomUUID()}`;
    await this.request('/api/v1/sessions', {
      session_id: sessionId,
      memory_policy: { self: { enabled: scope === 'user' }, peer: { enabled: scope === 'project' }, working_memory: { enabled: false } },
      auto_commit_policy: { idle_timeout_seconds: 0, pending_token_threshold: 0, message_count_threshold: 0 },
    });
    await this.request(`/api/v1/sessions/${sessionId}/messages/batch`, {
      messages: messages.map(({ role, content }) => ({ role, content, ...(scope === 'project' ? { peer_id: this.identity.peer } : {}) })),
    });
    const receipt = await this.request(`/api/v1/sessions/${sessionId}/commit`, { keep_recent_count: 0 });
    return { session_id: sessionId, scope, ...receipt };
  }

  task(taskId) {
    if (!/^[A-Za-z0-9_-]+$/.test(taskId)) throw new Error('Invalid task ID.');
    return this.request(`/api/v1/tasks/${taskId}`);
  }
}
