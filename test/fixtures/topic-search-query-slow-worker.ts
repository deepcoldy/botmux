import { readFileSync,writeFileSync } from 'node:fs';

readFileSync(0,'utf8');
setTimeout(() => {
  writeFileSync(process.argv.at(-1)!,JSON.stringify({ ok: true,result: { query: 'slow',results: [],truncated: false } }));
  process.exit(0);
},100);
