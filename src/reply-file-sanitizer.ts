import { buffer } from 'node:stream/consumers';
import { sanitizeLocalAddressText, type LocalAddressContext } from './im/lark/local-address-policy.js';

// Keep Markdown parsing outside the daemon event loop. The IPC pipes contain
// only text, so quotes and NULs do not expand on the wire.
let stage = 'policy';
try {
  const context: LocalAddressContext = JSON.parse(process.argv.at(-1)!);
  stage = 'input';
  const source = await buffer(process.stdin);
  stage = 'sanitize';
  const clean = sanitizeLocalAddressText(source.toString('utf8'), context);
  stage = 'output';
  await new Promise<void>((done, reject) => {
    process.stdout.write(clean, error => error ? reject(error) : done());
  });
} catch {
  await new Promise<void>(done => { process.stderr.write(`reply-file-sanitizer ${stage}\n`, () => done()); });
  process.exitCode = 1;
}
