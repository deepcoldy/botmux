import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Pi accepts JSON with line comments and trailing commas. Keep quoted strings
 * intact; JSON.parse still rejects malformed JSON and block comments. */
function parseConfig(text: string): unknown {
  const tokens = (text.replace(/^\uFEFF/, '').match(/"(?:\\[\s\S]|[^"\\])*"|\/\/[^\r\n]*|\s+|[^\s]/g) ?? [])
    .map(token => token.startsWith('//') ? ' ' : token);
  let previous = '';
  return JSON.parse(tokens.map((token, index) => {
    if (/^\s+$/.test(token)) return token;
    const before = previous;
    previous = token;
    if (token !== ',' || !before || ['{', '[', ':', ','].includes(before)) return token;
    let next = index + 1;
    while (next < tokens.length && /^\s+$/.test(tokens[next]!)) next++;
    return tokens[next] === '}' || tokens[next] === ']' ? '' : token;
  }).join(''));
}

/** Only explicitly declared models.json candidates, not an authenticated model
 * catalogue. No Pi process, auth helpers, extensions or network requests. */
export async function discoverPiLocalModels(options?: {
  env?: NodeJS.ProcessEnv;
}): Promise<readonly string[] | null> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const env = options?.env ?? process.env;
    const home = env.HOME?.trim() || homedir();
    const configured = env.PI_CODING_AGENT_DIR?.trim() || join(home, '.pi', 'agent');
    const directory = configured === '~' ? home
      : configured.startsWith('~/') ? join(home, configured.slice(2)) : configured;
    file = await open(join(directory, 'models.json'), constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) return null;
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > stat.size) return null;
    const providers = object(object(parseConfig(buffer.toString('utf8', 0, bytesRead)))?.providers);
    const models = new Set<string>();
    for (const [provider, value] of Object.entries(providers ?? {})) {
      if (!provider || /[\s/\x00-\x1f\x7f]/.test(provider)) continue;
      const entries = object(value)?.models;
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const model = object(entry);
        if (typeof model?.id !== 'string' || !model.id || /[\s\x00-\x1f\x7f]/.test(model.id)
          || model.type !== undefined && model.type !== 'chat') continue;
        models.add(`${provider}/${model.id}`);
      }
    }
    return models.size ? [...models] : null;
  } catch {
    // Config parse errors can contain credential text; never log or forward it.
    return null;
  } finally {
    await file?.close().catch(() => {});
  }
}
