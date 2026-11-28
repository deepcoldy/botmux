import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { probeTmuxFunctional } from '../src/setup/ensure-tmux.js';
import { fixture, rows, useTraexAutoModelIntegrationCleanup } from './helpers/traex-auto-model-integration.js';

useTraexAutoModelIntegrationCleanup();

describe('trigger to human turn through the real Worker and PTY', () => {
  it.skipIf(!probeTmuxFunctional().ok).each([false, true])('waits for the trigger terminal, then submits the real inbound once (model switch=%s)', async modelSwitch => {
    const f = modelSwitch
      ? await fixture(true, 'ordered', true, undefined, true, undefined, true)
      : await fixture(false, false, false, undefined, false, undefined, true, 'working');
    f.sendInput('synthetic continuation', 'trg_resume');
    await f.wait(() => rows(f.submissions).length === 1, 'trigger input');
    if (modelSwitch) {
      await f.wait(() => rows(f.launches).length === 2, 'model replacement');
      await f.wait(() => rows(f.submissions).length === 2, 'resumed trigger input');
    }
    const triggerInputs = rows(f.submissions).map(row => row.text);
    f.sendInput('create a checkpoint for this request', 'om_checkpoint');
    await f.wait(() => f.messages.some(message => message.type === 'turn_input_received'
      && message.turnId === 'om_checkpoint'), 'worker receipt of real inbound');
    // Allow transcript/viewport drains to run. The real input must remain
    // outside the CLI until the fixture emits the trigger's native terminal.
    await new Promise(resolve => setTimeout(resolve, 1_000));
    expect(rows(f.submissions).map(row => row.text)).toEqual(triggerInputs);
    writeFileSync(f.release, 'finish');
    await f.wait(() => rows(f.submissions).length === triggerInputs.length + 1, 'independent real inbound turn');
    expect(rows(f.submissions).map(row => row.text)).toEqual([
      ...triggerInputs, 'create a checkpoint for this request',
    ]);
    expect(f.messages.filter(message => message.type === 'turn_input_rejected')).toEqual([]);
    await f.wait(() => f.messages.some(message => message.type === 'turn_terminal'
      && message.turnId === 'om_checkpoint'), 'real inbound terminal');
    expect(rows(f.submissions)).toHaveLength(triggerInputs.length + 1);
  }, 60_000);
});
