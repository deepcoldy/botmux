import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const target = join(root, 'plugin/dist');
mkdirSync(join(target, 'lib'), { recursive: true });
cpSync(join(root, 'plugin/cli'), join(target, 'cli'), { recursive: true });
cpSync(join(root, 'skills'), join(target, 'skills'), { recursive: true });
for (const name of ['client.mjs', 'memory.mjs']) cpSync(join(root, name), join(target, 'lib', name));
console.log('Built optional OpenViking Botmux plugin; it is not installed or enabled.');
