// Chinese phrase fixes from high-visibility UI audit round 5.
export const ZH_PHRASE_FIXES_ROUND5 = [
  { pattern: /Botmux集成开发环境/g, replacement: 'Botmux IDE', whenEnIncludes: 'Botmux IDE' },
  { pattern: /Botmux第一/g, replacement: 'Botmux 优先', whenEnIncludes: 'Botmux first' },
  { pattern: /Botmux移动/g, replacement: 'Botmux Mobile', whenEnIncludes: 'Botmux Mobile' },
  { pattern: /Botmux归属/g, replacement: 'Botmux 归因', whenEnIncludes: 'Botmux Attribution' },
  { pattern: /Botmux标志/g, replacement: 'Botmux 标志', whenEnIncludes: 'Botmux logo' },
  { pattern: /喜欢Botmux/g, replacement: '喜欢 Botmux', whenEnIncludes: 'Enjoying Botmux' },
  { pattern: /认识Botmux/g, replacement: '了解 Botmux', whenEnIncludes: 'Get to know Botmux' },
  { pattern: /支持Botmux/g, replacement: '支持 Botmux', whenEnIncludes: 'Support Botmux' },
  { pattern: /展开Botmux/g, replacement: '展开 Botmux', whenEnIncludes: 'Expand Botmux' },
  { pattern: /来自Botmux/g, replacement: '来自 Botmux', whenEnIncludes: 'from Botmux' },
  {
    pattern: /正在重新启动Botmux/g,
    replacement: '正在重启 Botmux',
    whenEnIncludes: 'Restarting Botmux'
  },
  { pattern: /Botmux([\u4e00-\u9fff])/g, replacement: 'Botmux $1', whenEnIncludes: 'botmux' },
  { pattern: /Linear([\u4e00-\u9fff])/g, replacement: 'Linear $1', whenEnIncludes: 'Linear' },
  { pattern: /Codex([\u4e00-\u9fff])/g, replacement: 'Codex $1', whenEnIncludes: 'Codex' },
  { pattern: /Claude([\u4e00-\u9fff])/g, replacement: 'Claude $1', whenEnIncludes: 'Claude' },
  { pattern: /Claude代码/g, replacement: 'Claude Code', whenEnIncludes: 'Claude Code' },
  { pattern: /GitHub 和Linear/g, replacement: 'GitHub 和 Linear', whenEnIncludes: 'Linear tasks' },
  { pattern: /托管审阅/g, replacement: '托管评审', whenEnIncludes: 'hosted-review' },
  { pattern: /托管审阅/g, replacement: '托管评审', whenEnIncludes: 'Hosted-review' },
  { pattern: /审阅笔记/g, replacement: '评审笔记', whenEnIncludes: 'review note' },
  { pattern: /审阅任务/g, replacement: '评审任务', whenEnIncludes: 'review task' },
  { pattern: /待审阅/g, replacement: '待评审', whenEnIncludes: 'need review' },
  { pattern: /重新审核/g, replacement: '重新评审', whenEnIncludes: 'Re-review' },
  { pattern: /依赖项审核/g, replacement: '依赖项审计', whenEnIncludes: 'dependency audit' },
  { pattern: /Git AI 作者/g, replacement: 'Git AI Author', whenEnIncludes: 'Git AI Author' },
  { pattern: /基本引用/g, replacement: '基础引用', whenEnIncludes: 'base ref' },
  { pattern: /重新开放PR/g, replacement: '重新打开 PR', whenEnIncludes: 'Reopen PR' },
  { pattern: /重新开放/g, replacement: '重新打开', whenEnIncludes: 'reopen' },
  { pattern: /受限制的钥匙/g, replacement: '受限制的密钥', whenEnIncludes: 'restricted keys' },
  { pattern: /更换钥匙/g, replacement: '更换密钥', whenEnIncludes: 'Replace key' },
  {
    pattern: /根据所看到的内容采取行动/g,
    replacement: '根据所看到的内容执行操作',
    whenEnIncludes: 'act on what they see'
  },
  {
    pattern: /建议下一步行动/g,
    replacement: '建议下一步操作',
    whenEnIncludes: 'suggest next actions'
  },
  {
    pattern: /可操作的问题/g,
    replacement: '需处理的问题',
    whenEnIncludes: 'actionable issues'
  },
  {
    pattern: /显示 Botmux 移动按钮/g,
    replacement: '显示 Botmux Mobile 按钮',
    whenEnIncludes: 'Show Botmux Mobile Button'
  }
]
