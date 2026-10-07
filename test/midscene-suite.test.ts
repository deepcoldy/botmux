import { describe, expect, it } from 'vitest';
import {
  FEISHU_SCENARIOS,
  validateFeishuScenarioRegistry,
} from './e2e-browser/midscene-suite.js';

describe('Midscene Test Feishu scenario registry', () => {
  it('maps every migrated YAML scenario to an existing browser case', async () => {
    await validateFeishuScenarioRegistry();
    // Repeated attempts must register every suite even with a cached module.
    await validateFeishuScenarioRegistry();
    expect(FEISHU_SCENARIOS).toHaveLength(17);
  });
});
