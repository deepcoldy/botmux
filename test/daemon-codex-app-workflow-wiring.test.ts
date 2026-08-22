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
    // 话题上下文 (topicThreadContext) 必须双 lane 下发：既进 legacy promptContent，
    // 也进 codex-app 结构化 sidecar codexAppMessageContext，否则 codex-app bot 静默丢话题历史。
    expect(block).toContain("const codexAppMessageContext = topicThreadContext + codexAppQuoteContext + (workflowGrillPrompt ?? '');");
    expect(block).toContain('const promptContent = topicThreadContext + codexAppQuoteContext + codexAppApplicationContext + content;');
    expect(block).toContain('pendingCodexAppText: codexAppVisibleText');
    expect(source).toContain('codexAppText: ds.pendingCodexAppText');
    // Pinned (oncall/inherited/default-dir) new topics still fork immediately via
    // forkReservedInitialSession(ds, availableBots, trustedCaller). The no-project
    // fork now happens off the critical path: repo scanning is async, so an empty
    // scan folds into commitRepoSelection inside the detached scan-completion
    // handler rather than a second inline forkReservedInitialSession call.
    expect(block.match(/forkReservedInitialSession\(ds, availableBots, trustedCaller\)/g)).toHaveLength(1);
    expect(block).toContain('await commitRepoSelection(');
    expect(block).toContain('scanMultipleProjectsAsync(scanDirs');
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
