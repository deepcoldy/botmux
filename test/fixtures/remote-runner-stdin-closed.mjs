#!/usr/bin/env node

import { closeSync } from 'node:fs';
import readline from 'node:readline';

const protocol = 'botmux.remote-runner';
const version = 1;
const emit = event => process.stdout.write(`${JSON.stringify({ protocol, version, ...event })}\n`);

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', line => {
  const command = JSON.parse(line);
  if (command.type === 'hello') {
    emit({
      type: 'hello',
      requestId: command.requestId,
      provider: 'stdin-closed',
      capabilities: ['start', 'resume', 'turn', 'cancel', 'detach', 'status'],
    });
  } else if (command.type === 'start') {
    // 先关读端再回 ready：backend 就绪时管道已无人读，之后的任何写入都是 EPIPE。
    // libuv 不会替 stdin.destroy() 关掉 0 号 fd，所以显式 closeSync(0)。
    // 进程本身保持存活，由 backend 负责回收。
    lines.close();
    process.stdin.destroy();
    closeSync(0);
    setTimeout(() => {}, 60_000);
    emit({
      type: 'ready',
      requestId: command.requestId,
      state: {
        version,
        provider: 'stdin-closed',
        generation: 1,
        remoteSessionId: 'remote-stdin-closed',
      },
    });
  }
});
