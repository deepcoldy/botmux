import { Socket } from 'node:net';

const id = process.argv[2] ?? '';
process.stdout.write('READY\n');
await new Promise(resolve => process.stdin.once('data', resolve));

const header = Buffer.alloc(16);
const body = Buffer.alloc(16 * 1024);
const socket = new Socket({ fd: 3, readable: true, writable: true });
try {
  const length = await new Promise((resolve, reject) => {
    let headerLength = 0;
    let expectedLength;
    let bodyLength = 0;
    const timeout = setTimeout(() => reject(new Error('channel timed out')), 3_000);
    timeout.unref();
    socket.on('data', chunk => {
      let offset = 0;
      while (offset < chunk.length) {
        if (expectedLength === undefined) {
          const byte = chunk[offset];
          offset += 1;
          if (byte === 10) {
            const lengthText = header.subarray(0, headerLength).toString('ascii');
            expectedLength = Number(lengthText);
            if (!/^\d+$/.test(lengthText) || expectedLength < 1 || expectedLength > body.length) {
              reject(new Error(`invalid header: ${JSON.stringify(lengthText)}`));
              return;
            }
          } else if (headerLength === header.length) {
            reject(new Error('header too long'));
            return;
          } else {
            header[headerLength] = byte;
            headerLength += 1;
          }
          continue;
        }
        const copyLength = Math.min(expectedLength - bodyLength, chunk.length - offset);
        chunk.copy(body, bodyLength, offset, offset + copyLength);
        bodyLength += copyLength;
        offset += copyLength;
        if (bodyLength === expectedLength) {
          clearTimeout(timeout);
          resolve(expectedLength);
          return;
        }
      }
    });
    socket.once('error', reject);
    socket.once('end', () => reject(new Error('channel closed before secret')));
    socket.write('KEY\n');
  });
  const secret = body.subarray(0, length).toString('utf8');
  process.stdout.write(`${JSON.stringify({
    id,
    secret,
    secretInEnv: process.env.FIXTURE_SECRET !== undefined,
    secretInArgv: process.argv.includes(secret),
    fdEnv: process.env.BOTMUX_PROTECTED_SECRET_FD,
  })}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
} finally {
  header.fill(0);
  body.fill(0);
  socket.destroy();
}
