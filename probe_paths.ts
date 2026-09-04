import { isConfigurableReasoningCliId, cliModelSupportsReasoningEffort, reasoningEffortsForCliModel } from './src/services/codex-reasoning-effort.js';
console.log('=== Dashboard IPC 依赖的两个判定（claude-code）===');
console.log('  isConfigurableReasoningCliId  =', isConfigurableReasoningCliId('claude-code'));
for (const e of ['low','medium','high','xhigh','max','ultra'] as const) {
  console.log(`  cliModelSupportsReasoningEffort('claude-code', undefined, '${e}') = ${cliModelSupportsReasoningEffort('claude-code', undefined, e)}`);
}
console.log('\n=== 疑点2：不同 model 下是否返回同一集合 ===');
for (const m of [undefined, 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001', 'model_hub/es1_orange_o50[1m]', '乱写的模型名']) {
  console.log(`  model=${String(m).padEnd(30)} -> ${JSON.stringify(reasoningEffortsForCliModel('claude-code', m))}`);
}
console.log('\n=== 对照：codex 是 model-dependent 的 ===');
for (const m of ['gpt-5.6-sol','gpt-5.6-luna','gpt-5.4']) {
  console.log(`  codex model=${m.padEnd(14)} -> ${JSON.stringify(reasoningEffortsForCliModel('codex', m))}`);
}
