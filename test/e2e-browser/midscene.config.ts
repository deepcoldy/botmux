import { defineNode, z } from '@midscene/test';
import { defineTestProject } from '@midscene/test/config';
import { setE2EVideoLabel } from './e2e-video.js';
import {
  FEISHU_PHASE_SCENARIOS,
  closeFeishuPhase,
  openAndSend,
  showStreamingOutputPhase,
  waitForBotResponse,
  waitForStreamingCardPhase,
} from './feishu-report-phases.js';
import {
  FEISHU_SCENARIOS,
  runFeishuScenario,
} from './midscene-suite.js';

const phaseInput = z.object({
  scenario: z.enum(FEISHU_PHASE_SCENARIOS),
});

const runScenario = defineNode({
  name: 'feishu.runScenario',
  description: 'Run one migrated Botmux Feishu browser scenario',
  inputSchema: z.object({
    scenario: z.enum(FEISHU_SCENARIOS),
  }),
  async execute(ctx) {
    if (ctx.scope === 'case') setE2EVideoLabel(ctx.case.name, ctx.input.scenario);
    await runFeishuScenario(ctx.input.scenario);
  },
});

const openAndSendNode = defineNode({
  name: 'feishu.openAndSend',
  description: 'Open Feishu Messenger and send the case prompt. Codex also opens the thread and clicks 直接开启会话 before any streaming-card wait.',
  inputSchema: phaseInput,
  async execute(ctx) {
    return openAndSend(ctx);
  },
});

const waitForStreamingCardNode = defineNode({
  name: 'feishu.waitForStreamingCard',
  description: 'Wait until the current session streaming card is visible. Codex cases skip this.',
  inputSchema: phaseInput,
  async execute(ctx) {
    return waitForStreamingCardPhase(ctx);
  },
});

const waitForBotResponseNode = defineNode({
  name: 'feishu.waitForBotResponse',
  description: 'Wait for the Claude ACK reply bubble, or a Codex-side response. The card title 等待输入 is not the success gate.',
  inputSchema: phaseInput,
  async execute(ctx) {
    return waitForBotResponse(ctx);
  },
});

const showStreamingOutputNode = defineNode({
  name: 'feishu.showStreamingOutput',
  description: 'Scroll the streaming card into view and toggle 显示输出. Codex cases skip this.',
  inputSchema: phaseInput,
  async execute(ctx) {
    return showStreamingOutputPhase(ctx);
  },
});

const closeNode = defineNode({
  name: 'feishu.close',
  description: 'Click 关闭会话. The screen recording is published when the browser context closes.',
  inputSchema: phaseInput,
  async execute(ctx) {
    return closeFeishuPhase(ctx);
  },
});

export default defineTestProject({
  test: {
    maxConcurrency: 1,
    testTimeout: 15 * 60_000,
  },
  projects: [
    {
      name: 'feishu-browser',
      retry: process.env.CI ? 1 : 0,
      // CI runs the stable Claude/Codex core set (single-chat bot flows). Set
      // FEISHU_E2E_CASES=all (or run locally) to select every migrated case
      // in cases/bot-flows.yaml + cases/messaging.yaml.
      files: {
        include:
          process.env.FEISHU_E2E_CASES === 'all'
            ? ['cases/**/*.yaml']
            : ['cases/ci-claude-codex.yaml'],
      },
      nodes: [
        runScenario,
        openAndSendNode,
        waitForStreamingCardNode,
        waitForBotResponseNode,
        showStreamingOutputNode,
        closeNode,
      ],
    },
  ],
});
