import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const runtime = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8'));
if (!runtime.plugin_root) throw new Error('Run install-plugin.mjs to locate the installed OpenViking adapter.');
const { loadConfig } = await import(pathToFileURL(join(runtime.plugin_root, 'scripts/config.mjs')));
const { resolveEffectivePeerId } = await import(pathToFileURL(join(runtime.plugin_root, 'scripts/shared/workspace-peer.mjs')));
const { forwardConnectionEnv } = await import(pathToFileURL(join(runtime.plugin_root, 'scripts/shared/mcp-proxy-config.mjs')));
const cwd = process.argv[2];
const cfg = loadConfig(cwd, { env: {
  ...process.env,
  OPENVIKING_CLI_CONFIG_FILE: runtime.client_config,
  OPENVIKING_CREDENTIAL_SOURCE: 'cli',
} });
const { peerId } = resolveEffectivePeerId({ cfg, cwd });
if (!peerId) throw new Error('This example requires an explicit or derived project peer for memory tools.');
// Resolve the session's project before starting Codex, so hooks and MCP reads agree.
const connectionEnv = { ...forwardConnectionEnv({ ...cfg, peerId }), OPENVIKING_RECALL_PEER_SCOPE: 'actor' };
process.stdout.write(JSON.stringify(connectionEnv) + '\n');
