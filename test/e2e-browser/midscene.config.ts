import { defineNode, z } from '@midscene/test';
import { defineTestProject } from '@midscene/test/config';
import { runWithE2EVideoLabel } from './e2e-video.js';
import { runWithReportScope, type ReportScopeContext } from './report-scope.js';
import { laneProject, selectedCaseFiles } from './lanes.js';
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
    if (ctx.scope !== 'case') {
      await runFeishuScenario(ctx.input.scenario);
      return;
    }
    // The report scope gives the Pages index and Summary this step's
    // screenshots and deep link; the video label names its recording.
    await runWithReportScope(ctx as ReportScopeContext, () =>
      runWithE2EVideoLabel(ctx.case.name, ctx.input.scenario, () =>
        runFeishuScenario(ctx.input.scenario),
      ),
    );
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

// Every cases/*.yaml file is one lane: its own Midscene project. Midscene runs
// projects concurrently (up to test.maxConcurrency) and the cases inside one
// project serially, so a lane groups cases that must not overlap — e.g. the
// group-chat routing cases assert that *no* bot answered — while lanes that
// talk to different topics run side by side against the same daemon fleet.
//
// Parallelism stays inside this one process on purpose: Feishu delivers each
// app's events to only one of its WebSocket connections, so two CI jobs with
// their own daemons for the same bots would receive each other's messages.
//
// Lane selection (FEISHU_E2E_CASES) lives in lanes.ts; `--project
// feishu-<stem>` also works through `bun run test:e2e-browser`.
//
// Each lane holds one Chromium context and polls the vision model; 4 keeps a
// 4-vCPU runner and a rate-limited model endpoint comfortable.
const concurrency = Number.parseInt(process.env.FEISHU_E2E_CONCURRENCY ?? '', 10);

export default defineTestProject({
  test: {
    maxConcurrency: Number.isInteger(concurrency) && concurrency > 0 ? concurrency : 4,
    // Mode cases may wait for a chat lease (chat-lease.ts) before they start.
    testTimeout: 30 * 60_000,
  },
  nodes: [
    runScenario,
    openAndSendNode,
    waitForStreamingCardNode,
    waitForBotResponseNode,
    showStreamingOutputNode,
    closeNode,
  ],
  projects: selectedCaseFiles(process.env.FEISHU_E2E_CASES).map((file) => ({
    name: laneProject(file),
    // The group-mode lane runs 16 cases one after another in one shared group;
    // a retry there doubles the slowest lane, so it reports first attempts.
    retry: process.env.CI && !file.includes('group-modes') ? 1 : 0,
    files: { include: [file] },
  })),
});
