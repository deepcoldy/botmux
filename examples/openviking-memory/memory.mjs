#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConnection, MemoryClient, resolveIdentity } from './client.mjs';

const HELP = `OpenViking memory — shared by coding agents
  node memory.mjs [--config /path/ovcli.conf] [--cwd /project] search "query"
  node memory.mjs [options] find "query"
  node memory.mjs [options] read "viking://..."
  node memory.mjs [options] remember --scope project|user --text "fact"
  node memory.mjs [options] remember --scope project|user --messages-file /path/messages.json
  node memory.mjs [options] status TASK_ID
  node memory.mjs [options] identity
Configuration alone does not load prompts, search memory, or capture dialogue.`;

export async function runMemoryCommand(args, defaults = {}) {
  if (!args.length || args.includes('--help')) return HELP;
  const positionals = [], options = { scope: 'project', ...defaults };
  const names = { '--config': 'config', '--cwd': 'cwd', '--scope': 'scope', '--text': 'text', '--messages-file': 'messagesFile', '--max-tokens': 'maxTokens' };
  for (let i = 0; i < args.length; i++) {
    const key = names[args[i]];
    if (key) {
      if (i + 1 === args.length) throw new Error(`Missing value for ${args[i]}.`);
      if ((key === 'config' || key === 'cwd') && defaults[key]) throw new Error(`The Botmux session fixes ${key}.`);
      options[key] = args[++i];
    } else if (args[i].startsWith('--')) throw new Error(`Unknown option: ${args[i]}`);
    else positionals.push(args[i]);
  }
  const [action, ...values] = positionals;
  if (!['search', 'find', 'read', 'remember', 'status', 'identity'].includes(action)) throw new Error(HELP);
  const connection = loadConnection(options.config);
  const identity = resolveIdentity(connection, options.cwd);
  const client = new MemoryClient(connection, identity);
  if (action === 'identity') return identity;
  if (action === 'search') return client.search(values.join(' '), options.maxTokens ? Number(options.maxTokens) : 2500);
  if (action === 'find') return client.find(values.join(' '));
  if (action === 'read') {
    if (values.length !== 1) throw new Error('read requires one memory URI.');
    return client.read(values[0]);
  }
  if (action === 'status') {
    if (values.length !== 1) throw new Error('status requires one extraction task ID.');
    return client.task(values[0]);
  }
  if (!!options.text === !!options.messagesFile || values.length) throw new Error('remember requires exactly one --text or --messages-file.');
  const messages = options.messagesFile ? JSON.parse(readFileSync(options.messagesFile, 'utf8')) : [{ role: 'user', content: options.text }];
  return client.remember(messages, options.scope);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runMemoryCommand(process.argv.slice(2));
    console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
