import { defineConfig } from 'rspress/config';

export default defineConfig({
  root: 'docs',
  base: "/app/app_4k9smq6rdxher/",
  lang: 'zh',
  title: 'botmux 文档',
  description: '飞书话题群 ↔ AI 编程 CLI 桥接',
  builderConfig: {
    output: { assetPrefix: "https://cdn.jsdelivr.net/gh/deepcoldy/botmux@docs-assets-v5/" },
  },
  themeConfig: {
    socialLinks: [
      { icon: 'github', mode: 'link', content: 'https://github.com/deepcoldy/botmux' },
    ],
    sidebar: { '/': [
      {
            "text": "开始",
            "collapsed": false,
            "items": [
                  {
                        "text": "介绍",
                        "link": "/"
                  },
                  {
                        "text": "5 分钟快速接入",
                        "link": "/quickstart"
                  },
                  {
                        "text": "前置要求",
                        "link": "/prerequisites"
                  }
            ]
      },
      {
            "text": "核心概念",
            "collapsed": false,
            "items": [
                  {
                        "text": "架构总览",
                        "link": "/architecture"
                  },
                  {
                        "text": "会话与话题模型",
                        "link": "/session-model"
                  }
            ]
      },
      {
            "text": "功能详解",
            "collapsed": false,
            "items": [
                  {
                        "text": "实时流式卡片",
                        "link": "/cards"
                  },
                  {
                        "text": "Web 终端",
                        "link": "/web-terminal"
                  },
                  {
                        "text": "多机器人协作",
                        "link": "/multi-bot"
                  },
                  {
                        "text": "多话题协作模式",
                        "link": "/multi-topic"
                  },
                  {
                        "text": "角色与团队",
                        "link": "/roles"
                  },
                  {
                        "text": "tmux 会话常驻",
                        "link": "/tmux"
                  },
                  {
                        "text": "会话接入 Adopt",
                        "link": "/adopt"
                  },
                  {
                        "text": "会话接力 Relay",
                        "link": "/relay"
                  },
                  {
                        "text": "一键建会话群",
                        "link": "/group"
                  },
                  {
                        "text": "定时任务",
                        "link": "/schedule"
                  },
                  {
                        "text": "Oncall 模式",
                        "link": "/oncall"
                  },
                  {
                        "text": "语音总结",
                        "link": "/voice"
                  },
                  {
                        "text": "Dashboard 管控面",
                        "link": "/dashboard"
                  },
                  {
                        "text": "Workflow（实验性）",
                        "link": "/workflow"
                  },
                  {
                        "text": "Skill + CLI 交互",
                        "link": "/skill-cli"
                  }
            ]
      },
      {
            "text": "命令参考",
            "collapsed": false,
            "items": [
                  {
                        "text": "斜杠命令",
                        "link": "/slash-commands"
                  },
                  {
                        "text": "CLI 命令",
                        "link": "/cli-commands"
                  }
            ]
      },
      {
            "text": "配置",
            "collapsed": false,
            "items": [
                  {
                        "text": "bots.json 配置",
                        "link": "/bots-json"
                  },
                  {
                        "text": "环境变量与文件位置",
                        "link": "/env"
                  },
                  {
                        "text": "多 CLI 适配器",
                        "link": "/adapters"
                  }
            ]
      },
      {
            "text": "实践与排错",
            "collapsed": false,
            "items": [
                  {
                        "text": "最佳实践",
                        "link": "/best-practices"
                  },
                  {
                        "text": "常见踩坑",
                        "link": "/pitfalls"
                  },
                  {
                        "text": "FAQ / 排错",
                        "link": "/faq"
                  },
                  {
                        "text": "关于 & 资源",
                        "link": "/about"
                  }
            ]
      }
] },
    prevPageText: '上一页',
    nextPageText: '下一页',
    outlineTitle: '本页大纲',
    searchPlaceholderText: '搜索文档',
    lastUpdated: false,
  },
});
