// Fixture child for test/ts-runner-helper.test.ts: echoes its argv back as JSON.
// TypeScript-specific syntax below is deliberate — it proves the child was
// transpiled (via tsx on Node, natively on Bun) rather than merely executed.
interface EchoResult {
  ok: true;
  args: string[];
  runtime: 'bun' | 'node';
}

const result: EchoResult = {
  ok: true,
  args: process.argv.slice(2),
  runtime: typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined' ? 'bun' : 'node',
};

console.log(JSON.stringify(result));
