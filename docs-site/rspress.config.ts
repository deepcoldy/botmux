import { defineConfig } from '@rspress/core';

const zhSidebar = [
  {
    text: '开始',
    collapsed: false,
    items: [
      { text: '介绍', link: '/' },
      { text: '5 分钟快速接入', link: '/quickstart' },
      { text: '前置要求', link: '/prerequisites' },
    ],
  },
  {
    text: '核心概念',
    collapsed: false,
    items: [
      { text: '架构总览', link: '/architecture' },
      { text: '会话与话题模型', link: '/session-model' },
    ],
  },
  {
    text: '功能详解',
    collapsed: false,
    items: [
      { text: '实时流式卡片', link: '/cards' },
      { text: 'Web 终端', link: '/web-terminal' },
      { text: '多机器人协作', link: '/multi-bot' },
      { text: '多话题协作模式', link: '/multi-topic' },
      { text: '本地白板', link: '/whiteboard' },
      { text: '角色与团队', link: '/roles' },
      { text: 'tmux 会话常驻', link: '/tmux' },
      { text: '会话接入 Adopt', link: '/adopt' },
      { text: '会话接力 Relay', link: '/relay' },
      { text: '一键建会话群', link: '/group' },
      { text: '飞书文档评论入口', link: '/doc-comment' },
      { text: '定时任务', link: '/schedule' },
      { text: 'Oncall 模式', link: '/oncall' },
      { text: '文件沙盒', link: '/sandbox' },
      { text: '语音总结', link: '/voice' },
      { text: 'Dashboard 管控面', link: '/dashboard' },
      { text: '接入点（Webhook）', link: '/webhook' },
      { text: 'Workflow（实验性）', link: '/workflow' },
      { text: '生命周期 Hooks', link: '/hooks' },
      { text: 'Skill + CLI 交互', link: '/skill-cli' },
    ],
  },
  {
    text: '命令参考',
    collapsed: false,
    items: [
      { text: '斜杠命令', link: '/slash-commands' },
      { text: 'CLI 命令', link: '/cli-commands' },
    ],
  },
  {
    text: '配置',
    collapsed: false,
    items: [
      { text: 'bots.json 配置', link: '/bots-json' },
      { text: '环境变量与文件位置', link: '/env' },
      { text: '多 CLI 适配器', link: '/adapters' },
    ],
  },
  {
    text: '实践与排错',
    collapsed: false,
    items: [
      { text: '最佳实践', link: '/best-practices' },
      { text: '常见踩坑', link: '/pitfalls' },
      { text: 'FAQ / 排错', link: '/faq' },
      { text: '关于 & 资源', link: '/about' },
    ],
  },
];

const enSidebar = [
  {
    text: 'Getting Started',
    collapsed: false,
    items: [
      { text: 'Introduction', link: '/en/' },
      { text: '5-Minute Quickstart', link: '/en/quickstart' },
      { text: 'Prerequisites', link: '/en/prerequisites' },
    ],
  },
  {
    text: 'Core Concepts',
    collapsed: false,
    items: [
      { text: 'Architecture', link: '/en/architecture' },
      { text: 'Session & Topic Model', link: '/en/session-model' },
    ],
  },
  {
    text: 'Features',
    collapsed: false,
    items: [
      { text: 'Streaming Cards', link: '/en/cards' },
      { text: 'Web Terminal', link: '/en/web-terminal' },
      { text: 'Multi-Bot Collaboration', link: '/en/multi-bot' },
      { text: 'Multi-Topic Orchestration', link: '/en/multi-topic' },
      { text: 'Local Whiteboard', link: '/en/whiteboard' },
      { text: 'Roles & Teams', link: '/en/roles' },
      { text: 'tmux Session Persistence', link: '/en/tmux' },
      { text: 'Adopt a Session', link: '/en/adopt' },
      { text: 'Relay a Session', link: '/en/relay' },
      { text: 'One-Click Session Groups', link: '/en/group' },
      { text: 'Feishu Doc Comment Entry', link: '/en/doc-comment' },
      { text: 'Scheduled Tasks', link: '/en/schedule' },
      { text: 'On-Call Mode', link: '/en/oncall' },
      { text: 'File Sandbox', link: '/en/sandbox' },
      { text: 'Voice Summary', link: '/en/voice' },
      { text: 'Dashboard', link: '/en/dashboard' },
      { text: 'Webhook Ingress', link: '/en/webhook' },
      { text: 'Workflow (Experimental)', link: '/en/workflow' },
      { text: 'Lifecycle Hooks', link: '/en/hooks' },
      { text: 'Skill + CLI Interaction', link: '/en/skill-cli' },
    ],
  },
  {
    text: 'Command Reference',
    collapsed: false,
    items: [
      { text: 'Slash Commands', link: '/en/slash-commands' },
      { text: 'CLI Commands', link: '/en/cli-commands' },
    ],
  },
  {
    text: 'Configuration',
    collapsed: false,
    items: [
      { text: 'bots.json', link: '/en/bots-json' },
      { text: 'Environment & File Locations', link: '/en/env' },
      { text: 'CLI Adapters', link: '/en/adapters' },
    ],
  },
  {
    text: 'Practices & Troubleshooting',
    collapsed: false,
    items: [
      { text: 'Best Practices', link: '/en/best-practices' },
      { text: 'Common Pitfalls', link: '/en/pitfalls' },
      { text: 'FAQ / Troubleshooting', link: '/en/faq' },
      { text: 'About & Resources', link: '/en/about' },
    ],
  },
];

export default defineConfig({
  root: 'docs',
  base: process.env.BOTMUX_DOCS_BASE || '/',
  lang: 'zh',
  title: 'botmux 文档',
  description: '飞书话题群 ↔ AI 编程 CLI 桥接',
  icon: 'https://magic-builder.tos-cn-beijing.volces.com/uploads/1780767592185_botmux-favicon.svg',
  logo: 'https://magic-builder.tos-cn-beijing.volces.com/uploads/1780767592185_botmux-favicon.svg',
  logoText: 'botmux 文档',
  // 多语言：zh 为默认语（无前缀），en 走 /en/ 前缀
  locales: [
    { lang: 'zh', label: '简体中文', title: 'botmux 文档', description: '飞书话题群 ↔ AI 编程 CLI 桥接' },
    { lang: 'en', label: 'English', title: 'botmux Docs', description: 'Bridge Lark topic groups to AI coding CLIs' },
  ],
  // og:title / og:description 由 rspress 按页自动生成，这里只补它不处理的
  head: [
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:url', content: 'https://github.com/deepcoldy/botmux/tree/master/docs-site/docs' }],
    ['meta', { property: 'og:image', content: 'https://magic-builder.tos-cn-beijing.volces.com/uploads/1780767592455_botmux-logo.svg' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:image', content: 'https://magic-builder.tos-cn-beijing.volces.com/uploads/1780767592455_botmux-logo.svg' }],
    ['meta', { name: 'theme-color', content: '#06b6d4' }],
  ],
  search: { codeBlocks: true },
  markdown: { link: { checkDeadLinks: true } },
  builderConfig: {
    // 默认（妙搭发布）：static 走 jsDelivr CDN。GitHub Pages 发布时用 BOTMUX_DOCS_ASSET_PREFIX
    // 覆盖成同源子路径（Pages 原生服务 static，无需 CDN）。
    output: { assetPrefix: process.env.BOTMUX_DOCS_ASSET_PREFIX || "https://cdn.jsdelivr.net/gh/deepcoldy/botmux@docs-assets-v28/" },
  },
  themeConfig: {
    editLink: {
      docRepoBaseUrl: 'https://github.com/deepcoldy/botmux/tree/master/docs-site/docs',
    },
    socialLinks: [
      { icon: 'github', mode: 'link', content: 'https://github.com/deepcoldy/botmux' },
    ],
    lastUpdated: true,
    locales: [
      {
        lang: 'zh',
        label: '简体中文',
        outlineTitle: '本页目录',
        lastUpdatedText: '最后更新于',
        prevPageText: '上一页',
        nextPageText: '下一页',
        sidebar: { '/': zhSidebar },
      },
      {
        lang: 'en',
        label: 'English',
        outlineTitle: 'On This Page',
        lastUpdatedText: 'Last Updated',
        prevPageText: 'Previous',
        nextPageText: 'Next',
        sidebar: { '/en/': enSidebar },
      },
    ],
  },
});
