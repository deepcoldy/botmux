import { describe, it, expect } from 'vitest';

import {
  WORKFLOW_OUTPUT_BEGIN,
  WORKFLOW_OUTPUT_END,
  createDaemonSpawnFn,
  createStubSpawnFn,
  parseWorkflowOutput,
  withWorkflowOutputProtocol,
} from '../src/workflows/spawn-bot.js';

const fakeInput = {
  botName: 'claude-test',
  prompt: 'do thing',
  activityId: 'act-1',
  attemptId: 'att-1',
  nodeId: 'n',
  runId: 'run-x',
};

// ─── output protocol ─────────────────────────────────────────────────────

describe('parseWorkflowOutput', () => {
  it('extracts JSON from marker block', () => {
    const text = `some preamble\n${WORKFLOW_OUTPUT_BEGIN}\n{"a":1,"b":[2,3]}\n${WORKFLOW_OUTPUT_END}\ntrailing junk`;
    const result = parseWorkflowOutput(text);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ a: 1, b: [2, 3] });
  });

  it('picks LAST block when multiple present (retry semantics)', () => {
    const text = `${WORKFLOW_OUTPUT_BEGIN}\n{"version":1}\n${WORKFLOW_OUTPUT_END}\nrevised:\n${WORKFLOW_OUTPUT_BEGIN}\n{"version":2}\n${WORKFLOW_OUTPUT_END}`;
    const result = parseWorkflowOutput(text);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ version: 2 });
  });

  it('survives early malformed block — anchors on last complete block', () => {
    // Agent emitted a half-formed block first, then a clean one
    // (common during streaming retries).  Earlier first-BEGIN→next-END
    // logic spliced the two together; now we anchor from the last END.
    const text =
      `${WORKFLOW_OUTPUT_BEGIN}\nbroken garbage no END here\n` +
      `more text\n` +
      `${WORKFLOW_OUTPUT_BEGIN}\n{"final":true}\n${WORKFLOW_OUTPUT_END}`;
    const result = parseWorkflowOutput(text);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ final: true });
  });

  it('returns no-marker when block is missing', () => {
    expect(parseWorkflowOutput('hi {"a":1}').ok).toBe(false);
  });

  it('returns unclosed-marker when END is missing', () => {
    const result = parseWorkflowOutput(`${WORKFLOW_OUTPUT_BEGIN}\n{"a":1}\n`);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('unclosed-marker');
  });

  it('returns invalid-json when block is not JSON', () => {
    const result = parseWorkflowOutput(
      `${WORKFLOW_OUTPUT_BEGIN}\nnot json\n${WORKFLOW_OUTPUT_END}`,
    );
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('invalid-json');
  });

  it('sanitizes PTY control sequences and hard wraps inside marker JSON', () => {
    const text =
      `\u001b[?25lstatus\r\n${WORKFLOW_OUTPUT_BEGIN}\r\n` +
      `{"plan":"hello\u001b[0K\r\nworld","highlights":["a"]}\r\n` +
      `${WORKFLOW_OUTPUT_END}\u001b[?25h`;
    const result = parseWorkflowOutput(text);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ plan: 'helloworld', highlights: ['a'] });
  });
});

describe('withWorkflowOutputProtocol', () => {
  it('appends the marker footer', () => {
    const out = withWorkflowOutputProtocol('do thing');
    expect(out).toContain(WORKFLOW_OUTPUT_BEGIN);
    expect(out).toContain(WORKFLOW_OUTPUT_END);
  });

  it('is idempotent', () => {
    const once = withWorkflowOutputProtocol('do thing');
    const twice = withWorkflowOutputProtocol(once);
    expect(twice).toBe(once);
  });
});

// ─── stub factory ────────────────────────────────────────────────────────

describe('createStubSpawnFn', () => {
  it('passes input to handler and reports success', async () => {
    const spawn = createStubSpawnFn(async (input) => ({
      echo: input.botName,
      promptLen: input.prompt.length,
    }));
    const result = await spawn(fakeInput);
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.output).toEqual({ echo: 'claude-test', promptLen: 8 });
    expect(result.session.botName).toBe('claude-test');
    expect(result.session.sessionId).toContain('stub-act-1-att-1');
  });
});

// ─── daemon factory (mocked) ─────────────────────────────────────────────

describe('createDaemonSpawnFn', () => {
  it('parses worker transcript via marker → returns success', async () => {
    const spawn = createDaemonSpawnFn({
      async runOneShot(_opts) {
        return {
          finalTranscript: `chain-of-thought...\n${WORKFLOW_OUTPUT_BEGIN}\n{"city":"sf"}\n${WORKFLOW_OUTPUT_END}`,
          session: {
            sessionId: 'sess-real',
            botName: 'claude-real',
            startedAt: 0,
            endedAt: 1,
          },
        };
      },
    });
    const result = await spawn(fakeInput);
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.output).toEqual({ city: 'sf' });
    expect(result.session.sessionId).toBe('sess-real');
  });

  it('worker returns no marker → OutputSchemaViolation, manual class', async () => {
    const spawn = createDaemonSpawnFn({
      async runOneShot() {
        return {
          finalTranscript: 'sorry I forgot the marker',
          session: { sessionId: 's', botName: 'b', startedAt: 0 },
        };
      },
    });
    const result = await spawn(fakeInput);
    expect(result.kind).toBe('failure');
    if (result.kind !== 'failure') return;
    expect(result.errorCode).toBe('OutputSchemaViolation');
    expect(result.errorClass).toBe('manual');
  });

  it('runOneShot throws → WorkerCrashed, retryable class', async () => {
    const spawn = createDaemonSpawnFn({
      async runOneShot() {
        throw new Error('worker died');
      },
    });
    const result = await spawn(fakeInput);
    expect(result.kind).toBe('failure');
    if (result.kind !== 'failure') return;
    expect(result.errorCode).toBe('WorkerCrashed');
    expect(result.errorClass).toBe('retryable');
    expect(result.errorMessage).toContain('worker died');
  });

  it('prepends output protocol to the prompt passed to worker', async () => {
    const seen: string[] = [];
    const spawn = createDaemonSpawnFn({
      async runOneShot(opts) {
        seen.push(opts.prompt);
        return {
          finalTranscript: `${WORKFLOW_OUTPUT_BEGIN}{}${WORKFLOW_OUTPUT_END}`,
          session: { sessionId: 's', botName: 'b', startedAt: 0 },
        };
      },
    });
    await spawn({ ...fakeInput, prompt: 'analyze the weather' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('analyze the weather');
    expect(seen[0]).toContain(WORKFLOW_OUTPUT_BEGIN);
  });

  it('forwards frozen identity + execution policy through runOneShot', async () => {
    let received: Parameters<
      NonNullable<Parameters<typeof createDaemonSpawnFn>[0]>['runOneShot']
    >[0] | undefined;
    const spawn = createDaemonSpawnFn({
      async runOneShot(opts) {
        received = opts;
        return {
          finalTranscript: `${WORKFLOW_OUTPUT_BEGIN}{}${WORKFLOW_OUTPUT_END}`,
          session: { sessionId: 's', botName: 'b', startedAt: 0 },
        };
      },
    });
    await spawn({
      ...fakeInput,
      botSnapshot: {
        larkAppId: 'cli_frozen',
        cliId: 'codex',
        displayName: 'Frozen',
        workingDir: '/frozen-cwd',
      },
      workingDir: '/explicit-cwd',
      modelOverrides: { model: 'o3-mini', reasoningEffort: 'high' },
      toolPolicy: { allow: ['web_search'], deny: ['shell'] },
    });
    expect(received?.botSnapshot).toEqual({
      larkAppId: 'cli_frozen',
      cliId: 'codex',
      displayName: 'Frozen',
      workingDir: '/frozen-cwd',
    });
    expect(received?.workingDir).toBe('/explicit-cwd');
    expect(received?.modelOverrides).toEqual({ model: 'o3-mini', reasoningEffort: 'high' });
    expect(received?.toolPolicy).toEqual({ allow: ['web_search'], deny: ['shell'] });
    expect(received?.runId).toBe(fakeInput.runId);
    expect(received?.nodeId).toBe(fakeInput.nodeId);
  });

  it('parse-failure errorMessage includes reason + transcript snippet', async () => {
    const spawn = createDaemonSpawnFn({
      async runOneShot() {
        return {
          finalTranscript: 'agent talked about cats and forgot the marker',
          session: { sessionId: 's', botName: 'b', startedAt: 0 },
        };
      },
    });
    const result = await spawn(fakeInput);
    if (result.kind !== 'failure') throw new Error();
    expect(result.errorMessage).toContain('no-marker');
    expect(result.errorMessage).toContain('cats and forgot');
  });
});
