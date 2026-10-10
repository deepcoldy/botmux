import { defineNode, z } from '@midscene/test';
import { defineTestProject } from '@midscene/test/config';
import {
  FEISHU_SCENARIOS,
  runFeishuScenario,
} from './midscene-suite.js';

const runScenario = defineNode({
  name: 'feishu.runScenario',
  description: 'Run one migrated Botmux Feishu browser scenario',
  inputSchema: z.object({
    scenario: z.enum(FEISHU_SCENARIOS),
  }),
  async execute({ input }) {
    await runFeishuScenario(input.scenario);
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
      nodes: [runScenario],
    },
  ],
});
