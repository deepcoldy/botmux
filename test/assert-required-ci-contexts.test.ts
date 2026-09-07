import { describe, expect, it } from 'vitest';

import {
  collectRequiredContexts,
  missingRequiredContexts,
} from '../scripts/assert-required-ci-contexts.mjs';

const onlyBuild = [{
  target: 'branch',
  enforcement: 'active',
  rules: [{
    type: 'required_status_checks',
    parameters: {
      required_status_checks: [{ context: 'build', integration_id: 15368 }],
    },
  }],
}];

const buildAndTest = [{
  target: 'branch',
  enforcement: 'active',
  rules: [{
    type: 'required_status_checks',
    parameters: {
      required_status_checks: [
        { context: 'build', integration_id: 15368 },
        { context: 'test', integration_id: 15368 },
      ],
    },
  }],
}];

describe('missingRequiredContexts', () => {
  it('fails closed when the live ruleset still only requires build', () => {
    expect([...collectRequiredContexts(onlyBuild)]).toEqual(['build']);
    expect(missingRequiredContexts(onlyBuild)).toEqual(['test']);
  });

  it('accepts the aggregator context once it is in the ruleset', () => {
    expect(missingRequiredContexts(buildAndTest)).toEqual([]);
  });

  it('does not treat a disabled or tag ruleset as covering master', () => {
    expect(missingRequiredContexts([
      { target: 'tag', enforcement: 'active', rules: buildAndTest[0].rules },
      { ...buildAndTest[0], enforcement: 'disabled' },
    ])).toEqual(['build', 'test']);
  });
});
