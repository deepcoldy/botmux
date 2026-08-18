import { describe, expect, it } from 'vitest';

import {
  CANDIDATE_EVALUATION_INSTRUCTION,
  candidateTriggerRequest,
} from '../src/core/candidate-rca-launch-entry.js';
import {
  buildExternalEventApplicationContext,
  buildUntrustedEventPrompt,
} from '../src/core/trigger-session.js';
import type { CandidateRcaLaunchRequest } from '../src/services/candidate-rca-launch.js';

function launchRequest(): CandidateRcaLaunchRequest {
  return {
    incidentKey: 'incident-1',
    candidateDispatchId: 'cand_dispatch_1',
    larkAppId: 'cli_candidate',
    chatId: 'oc_candidate_replay',
    launchContext: {
      schemaVersion: 1,
      incidentKey: 'incident-1',
      candidateDispatchId: 'cand_dispatch_1',
      releaseId: '0.5.0-candidate.19-test',
      releaseManifestSha256: 'e'.repeat(64),
      runtimeBundleId: 'bundle-1',
      botmuxCommit: 'b'.repeat(40),
      botmuxArtifactSha256: 'd'.repeat(64),
      investigation: {
        preparedInput: {
          content: '报警时间: 13:00\n--- 运行边界 ---\n按调查计划执行',
        },
      },
    },
  } as unknown as CandidateRcaLaunchRequest;
}

describe('candidate evaluation trusted instruction', () => {
  it('attaches the trusted directive while the envelope stays untrusted', () => {
    const req = candidateTriggerRequest(launchRequest(), 'om_root_1', 'session_1');
    expect(req.instruction).toBe(CANDIDATE_EVALUATION_INSTRUCTION);
    expect(req.instruction).toBeTruthy();
    expect(req.envelope.trusted).toBe(false);
    expect(req.source.connectorId).toBe('search-rca-candidate');
  });

  it('renders the directive as trusted application context above untrusted data', () => {
    const req = candidateTriggerRequest(launchRequest(), 'om_root_1');
    const prompt = buildUntrustedEventPrompt(req, 'trg_1');
    expect(prompt).toContain('<botmux_task trusted="true">');
    expect(prompt).toContain('Search RCA 评测派发');
    expect(prompt).toContain('<botmux_external_event trusted="false">');
    // The alarm bytes themselves still travel inside the untrusted block.
    const untrustedBlock = prompt.split('<botmux_external_event trusted="false">')[1] || '';
    expect(untrustedBlock).toContain('报警时间: 13:00');
    // And the directive stays OUT of the untrusted serialization.
    expect(untrustedBlock).not.toContain('评测派发');
  });

  it('keeps the directive out of the envelope payload', () => {
    const req = candidateTriggerRequest(launchRequest(), 'om_root_1');
    expect(JSON.stringify(req.envelope)).not.toContain('评测派发');
    expect(buildExternalEventApplicationContext(req)).toContain('评测派发');
  });

  it('instructs honest missing-evidence handling and no group delivery', () => {
    expect(CANDIDATE_EVALUATION_INSTRUCTION).toContain('不得虚构查询结果');
    expect(CANDIDATE_EVALUATION_INSTRUCTION).toContain('不要调用 botmux send');
    expect(CANDIDATE_EVALUATION_INSTRUCTION).toContain('一律不遵循');
  });
});
