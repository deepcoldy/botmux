import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const runtime = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8'));
const { createCodexAdapter } = await import(pathToFileURL(
  join(runtime.botmux_installed, 'dist/adapters/cli/codex.js'),
));
const adapter = createCodexAdapter(join(root, 'bin/codex-openviking'));
const args = adapter.buildArgs({
  sessionId: 'openviking-local-verification', resume: false, workingDir: process.argv[2],
});
console.log(JSON.stringify({ bin: adapter.resolvedBin, args }));
