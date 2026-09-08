// slogan.mjs —— `botmux flow` 的 M2 演示脚本（设计文档 §4.1，去掉命名会话）。
// 纯 ESM，无 import，无 Node API；只通过 ctx 与外界交互。
//
// 话题里触发（脚本路径相对该话题的工作目录）：
//   /flow run examples/flow/slogan.mjs --input {"topic": "tea"}
// 终端触发（没有话题绑定 → signal() 会以 signal_unbound 硬错误结束；终端演示请去掉 signal 段）：
//   botmux flow run examples/flow/slogan.mjs --input '{"topic":"tea"}'
export default async function (ctx) {
  const { input, parallel, signal, agent, log } = ctx;
  const topic = (input && input.topic) || 'tea';

  // 并发必须经组合器；每个分支拿到自己的 ctx（c），结果靠返回值汇总
  const drafts = await parallel(['warm', 'bold', 'minimal'].map((tone) => (c) =>
    c.agent({
      cli: 'claude-code',
      prompt: `Write one ${tone} slogan for ${topic}. Reply as JSON.`,
      schema: { type: 'object', required: ['slogan'], properties: { slogan: { type: 'string' } } },
    })));

  const ok = drafts.filter((d) => d.ok);
  await log(`${ok.length}/${drafts.length} drafts ok`);
  if (ok.length === 0) return { result: 'no drafts', failures: drafts };

  // 人在回路：话题里出现信号卡（按钮 / 表单），也可用 `botmux flow signal` 从终端提交
  const pick = await signal({
    prompt: `Pick one:\n${ok.map((d, i) => `${i + 1}. ${d.value.slogan}`).join('\n')}`,
    schema: { type: 'object', required: ['index'], properties: { index: { type: 'integer', minimum: 1, maximum: ok.length } } },
  });
  if (!pick.ok) return { result: 'canceled', reason: pick.category };

  const chosen = ok[pick.value.index - 1].value.slogan;
  const review = await agent({ cli: 'codex', prompt: `Critique in two sentences: ${chosen}` });
  return { slogan: chosen, review: review.ok ? review.value : review.category };
}
