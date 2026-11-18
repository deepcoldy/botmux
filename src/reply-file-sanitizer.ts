import { buffer } from 'node:stream/consumers';
import { sanitizeLocalAddressText, type LocalAddressContext } from './im/lark/local-address-policy.js';

// Keep Markdown parsing outside the daemon event loop. The IPC pipes contain
// only text, so quotes and NULs do not expand on the wire.
const context: LocalAddressContext = JSON.parse(process.argv.at(-1)!);
const source = await buffer(process.stdin);
const clean = sanitizeLocalAddressText(source.toString('utf8'), context);
await new Promise<void>((done, reject) => {
  process.stdout.write(clean, error => error ? reject(error) : done());
});
