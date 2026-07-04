import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { worktreeSlugFromContextAI } from '../src/services/worktree-slug-ai.js';

describe('worktreeSlugFromContextAI', () => {
  const original = { ...config.worktreeSlugAI };
  const originalDescriptor = Object.getOwnPropertyDescriptor(config, 'worktreeSlugAI');
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    Object.assign(config.worktreeSlugAI, {
      enabled: true,
      baseUrl: 'https://ai.example/v1',
      apiKey: 'test-key',
      model: 'test-model',
      timeoutMs: 1000,
      extraHeaders: {},
      extraBody: {},
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    const currentConfig = config.worktreeSlugAI;
    if (currentConfig) {
      Object.assign(currentConfig, original);
    } else if (originalDescriptor) {
      Object.defineProperty(config, 'worktreeSlugAI', { ...originalDescriptor, value: { ...original } });
    }
    vi.restoreAllMocks();
  });

  it('uses the AI generated English slug for Chinese input', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'worktree-naming-logic' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as any;

    await expect(worktreeSlugFromContextAI('看下新开 worktree 的时候，命名逻辑是啥？')).resolves.toBe('worktree-naming-logic');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('sanitizes invalid model output', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: ' Worktree Naming Logic!!! ' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as any;

    await expect(worktreeSlugFromContextAI('看下新开 worktree 的时候，命名逻辑是啥？')).resolves.toBe('worktree-naming-logic');
  });

  it('falls back locally when AI is disabled or fails', async () => {
    config.worktreeSlugAI.enabled = false;
    globalThis.fetch = vi.fn() as any;
    await expect(worktreeSlugFromContextAI('看下新开 worktree 的时候，命名逻辑是啥？')).resolves.toBe('worktree');
    expect(globalThis.fetch).not.toHaveBeenCalled();

    config.worktreeSlugAI.enabled = true;
    globalThis.fetch = vi.fn(async () => new Response('bad gateway', { status: 502 })) as any;
    await expect(worktreeSlugFromContextAI('看下新开 worktree 的时候，命名逻辑是啥？')).resolves.toBe('worktree');
  });

  it('falls back locally when the deployed config has no worktree slug AI section', async () => {
    Reflect.deleteProperty(config, 'worktreeSlugAI');
    globalThis.fetch = vi.fn();

    await expect(worktreeSlugFromContextAI('repo test')).resolves.toBe('repo-test');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
