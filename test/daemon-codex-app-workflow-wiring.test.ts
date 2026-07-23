import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve('src/daemon.ts'), 'utf8');

function region(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  expect(start, `${startMarker} not found`).toBeGreaterThan(-1);
  expect(end, `${endMarker} not found after ${startMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('daemon Codex App workflow prompt lanes', () => {
  it('keeps a new-topic workflow command visible while hiding the generated skill prompt', () => {
    const block = region(
      'async function handleNewTopic',
      'const autoStartJoinInFlight',
    );

    expect(block.indexOf('const codexAppVisibleText = content;'))
      .toBeLessThan(block.indexOf('content = workflowGrillPrompt;'));
    expect(block).toContain("const codexAppMessageContext = codexAppQuoteContext + (workflowGrillPrompt ?? '');");
    expect(block).toContain('const promptContent = codexAppQuoteContext + codexAppApplicationContext + content;');
    expect(block).toContain('pendingCodexAppText: codexAppVisibleText');
    expect(source).toContain('codexAppText: ds.pendingCodexAppText');
    expect(block.match(/forkReservedInitialSession\(ds, availableBots\)/g)).toHaveLength(2);
  });

  it('retains VC lifecycle context in rewritten legacy prompts without demoting it to untrusted', () => {
    const block = region(
      'async function handleThreadReply',
      'async function autoCreateDocSession',
    );

    expect(block).toMatch(
      /promptContent = initialCodexAppMessageContext\s*\+ initialCodexAppApplicationContext\s*\+ workflowPrompt;/,
    );
    expect(block).toContain(
      'rewrittenCodexAppMessageContext = initialCodexAppMessageContext + workflowPrompt;',
    );
    expect(block).toMatch(
      /const codexAppMessageContext = rewrittenCodexAppMessageContext\s*\?\? initialCodexAppMessageContext;/,
    );
    expect(block).toContain(
      'const codexAppApplicationContext = initialCodexAppApplicationContext;',
    );
  });

  it('does not buffer ordinary turns solely because repo commit UI cleanup is still in flight', () => {
    const block = region(
      'async function handleThreadReply',
      'async function autoCreateDocSession',
    );
    expect(block).toContain('if (ds?.pendingRepo || initialStartPending) {');
    expect(block).not.toContain('if (ds?.pendingRepo || ds?.pendingRepoCommitInFlight || initialStartPending)');
  });
});
