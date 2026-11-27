/**
 * Claude Code 实时模型目录（`cache/model-catalog/published-*.json`）。
 *
 * CLI 没有模型枚举子命令，但会把签名目录缓存到自己的数据根下，`/model`
 * 选择器就按它渲染。这里守住两件事：缓存里的 id 按选择器顺序原样取出，
 * 以及任何坏输入都 fail-soft 回 null（调用方回退静态快照）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectClaudeModels,
  detectModelsViaEndpoint,
  endpointTarget,
  parseClaudeModelCatalog,
  parseEndpointModelsJson,
  readClaudeModelCatalog,
  readClaudeModelCatalogFromRoot,
  resolveEndpointEnvironment,
} from '../src/adapters/cli/claude-model-catalog.js';
import { createClaudeCodeAdapter } from '../src/adapters/cli/claude-code.js';

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'botmux-claude-catalog-'));
  tempRoots.push(root);
  return root;
}

/** 在数据根下写一份 published-*.json。 */
function writeCatalog(root: string, name: string, body: unknown): string {
  const dir = join(root, 'cache', 'model-catalog');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(body));
  return path;
}

/** 与真实缓存同形的目录文档。 */
function catalogDocument(models: { id: string; section?: string }[]): unknown {
  return {
    $schema: 'https://downloads.claude.ai/model-catalog/v1/schema.json',
    schema_version: 1,
    version: 1,
    surfaces: {
      cc: {
        model_selector_config: [
          { id: 'cc', models: models.map(m => ({ id: m.id, name: m.id, section: m.section ?? 'main' })) },
        ],
      },
    },
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('parseClaudeModelCatalog', () => {
  it('按选择器顺序取 cc surface 的模型 id，并去重', () => {
    const doc = catalogDocument([
      { id: 'claude-opus-5-5' },
      { id: 'claude-sonnet-5-5' },
      { id: 'claude-opus-5-5' },
      { id: 'claude-haiku-4-5-20251001', section: 'overflow' },
    ]);
    expect(parseClaudeModelCatalog(doc)).toEqual([
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-haiku-4-5-20251001',
    ]);
  });

  it('接受缓存外壳（document 为对象）', () => {
    const envelope = { version: 2, etag: '"x"', document: catalogDocument([{ id: 'claude-sonnet-5-5' }]) };
    expect(parseClaudeModelCatalog(envelope)).toEqual(['claude-sonnet-5-5']);
  });

  it('接受 document 被落盘成 JSON 字符串的外壳', () => {
    const envelope = { version: 2, document: JSON.stringify(catalogDocument([{ id: 'claude-opus-5-5' }])) };
    expect(parseClaudeModelCatalog(envelope)).toEqual(['claude-opus-5-5']);
  });

  it('cc surface 缺失时退回所有 surface 的并集', () => {
    const doc = {
      surfaces: {
        chat: { model_selector_config: [{ models: [{ id: 'claude-fable-5-2' }] }] },
        cowork: { model_selector_config: [{ models: [{ id: 'claude-opus-5-5' }] }] },
      },
    };
    expect(parseClaudeModelCatalog(doc)).toEqual(['claude-fable-5-2', 'claude-opus-5-5']);
  });

  it('忽略没有 id 的条目与非法结构', () => {
    const doc = {
      surfaces: {
        cc: {
          model_selector_config: [
            { models: [{ name: 'no id' }, { id: '   ' }, { id: 'claude-sonnet-5-5' }] },
            { models: 'not-an-array' },
            null,
          ],
        },
      },
    };
    expect(parseClaudeModelCatalog(doc)).toEqual(['claude-sonnet-5-5']);
  });

  it('没有可用模型时返回 null', () => {
    expect(parseClaudeModelCatalog(null)).toBeNull();
    expect(parseClaudeModelCatalog({})).toBeNull();
    expect(parseClaudeModelCatalog({ surfaces: {} })).toBeNull();
    expect(parseClaudeModelCatalog({ surfaces: { cc: { model_selector_config: [] } } })).toBeNull();
  });
});

describe('readClaudeModelCatalogFromRoot', () => {
  it('读 published-*.json；同一数据根有多份时取 mtime 最新的', () => {
    const root = tempRoot();
    writeCatalog(root, 'published-old.json', catalogDocument([{ id: 'claude-opus-5' }]));
    // 让后写的文件 mtime 严格更大（同毫秒内写入时 utimes 更可靠）
    const newer = writeCatalog(root, 'published-new.json', catalogDocument([{ id: 'claude-opus-5-5' }]));
    const future = new Date(Date.now() + 60_000);
    utimesSync(newer, future, future);

    expect(readClaudeModelCatalogFromRoot(root)).toEqual(['claude-opus-5-5']);
  });

  it('缓存目录缺失或 JSON 损坏时返回 null，不抛异常', () => {
    const root = tempRoot();
    expect(readClaudeModelCatalogFromRoot(root)).toBeNull();

    const dir = join(root, 'cache', 'model-catalog');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'published-broken.json'), '{not json');
    expect(readClaudeModelCatalogFromRoot(root)).toBeNull();
  });
});

describe('readClaudeModelCatalog', () => {
  it('优先读 CLAUDE_CONFIG_DIR 指向的数据根', async () => {
    const root = tempRoot();
    writeCatalog(root, 'published-a.json', catalogDocument([{ id: 'claude-fable-5-2' }]));

    expect(await readClaudeModelCatalog({ env: { CLAUDE_CONFIG_DIR: root } })).toEqual(['claude-fable-5-2']);
  });

  it('显式 profile 目录没有缓存时不回退 ~/.claude', async () => {
    // ~/.claude 属于另一个账户；拿它兜底会把那个账户的模型列到当前 bot 上。
    const homeCatalog = writeCatalog(join(homedir(), '.claude'), 'published-home.json', catalogDocument([{ id: 'home-account-model' }]));
    try {
      expect(await readClaudeModelCatalog({ configDir: tempRoot() })).toBeNull();
    } finally {
      rmSync(homeCatalog, { force: true });
    }
  });

  it('显式传入的 configDir 先于环境变量', async () => {
    const explicit = tempRoot();
    const fromEnv = tempRoot();
    writeCatalog(explicit, 'published-a.json', catalogDocument([{ id: 'claude-opus-5-5' }]));
    writeCatalog(fromEnv, 'published-b.json', catalogDocument([{ id: 'claude-sonnet-5-5' }]));

    expect(await readClaudeModelCatalog({ configDir: explicit, env: { CLAUDE_CONFIG_DIR: fromEnv } }))
      .toEqual(['claude-opus-5-5']);

    // 显式 profile 是独占边界：无缓存时也不能落到另一个 env 数据根。
    expect(await readClaudeModelCatalog({ configDir: tempRoot(), env: { CLAUDE_CONFIG_DIR: fromEnv } }))
      .toBeNull();
  });

  it('可禁止隐式宿主根，同时保留显式 profile', async () => {
    const homeCatalog = writeCatalog(join(homedir(), '.claude'), 'published-no-implicit.json', catalogDocument([{ id: 'host-model' }]));
    const explicit = tempRoot();
    writeCatalog(explicit, 'published-a.json', catalogDocument([{ id: 'explicit-model' }]));
    try {
      expect(await readClaudeModelCatalog({ env: {}, allowImplicitConfigRoot: false })).toBeNull();
      expect(await readClaudeModelCatalog({ configDir: explicit, allowImplicitConfigRoot: false }))
        .toEqual(['explicit-model']);
    } finally {
      rmSync(homeCatalog, { force: true });
    }
  });
});

describe('claude-code adapter', () => {
  it('把构造时的 configDir 透传给目录读取，而不是恒读 ~/.claude', async () => {
    const root = tempRoot();
    writeCatalog(root, 'published-a.json', catalogDocument([{ id: 'profile-model' }]));

    const adapter = createClaudeCodeAdapter('/usr/local/bin/claude', root);
    // env 里没有 base URL，探测只能落到 configDir 指向的目录。
    expect(await adapter.detectModels!({ env: {} })).toEqual(['profile-model']);
  });
});

describe('parseEndpointModelsJson', () => {
  it('取 OpenAI/Anthropic 的 data[].id', () => {
    expect(parseEndpointModelsJson({
      data: [{ id: 'gpt/gpt-6-astra' }, { id: 'coding-plan/glm-5.3' }, { id: 'gpt/gpt-6-astra' }],
    })).toEqual(['gpt/gpt-6-astra', 'coding-plan/glm-5.3']);
  });

  it('兼容裸 models 数组与纯字符串条目', () => {
    expect(parseEndpointModelsJson({ models: ['a', { id: 'b' }, { name: 'no-id' }] })).toEqual(['a', 'b']);
  });

  it('形状不认识或为空时返回 null', () => {
    expect(parseEndpointModelsJson(null)).toBeNull();
    expect(parseEndpointModelsJson({ data: [] })).toBeNull();
    expect(parseEndpointModelsJson({ nope: 1 })).toBeNull();
  });
});

describe('endpointTarget', () => {
  it('需要 base URL 与凭据同时存在', () => {
    expect(endpointTarget(undefined)).toBeNull();
    expect(endpointTarget({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:3425' })).toBeNull();
    expect(endpointTarget({ ANTHROPIC_AUTH_TOKEN: 't' })).toBeNull();
    expect(endpointTarget({ ANTHROPIC_BASE_URL: 'not a url', ANTHROPIC_AUTH_TOKEN: 't' })).toBeNull();
    expect(endpointTarget({ ANTHROPIC_BASE_URL: 'ftp://x', ANTHROPIC_AUTH_TOKEN: 't' })).toBeNull();
  });

  it('去掉尾部斜杠，API key 也可当凭据', () => {
    expect(endpointTarget({ ANTHROPIC_BASE_URL: 'https://gw.example.com/', ANTHROPIC_API_KEY: 'k' }))
      .toEqual({ base: 'https://gw.example.com', token: 'k' });
  });
});

describe('detectModelsViaEndpoint', () => {
  const env = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:3425', ANTHROPIC_AUTH_TOKEN: 'tok' };

  it('打 <base>/v1/models 并带上凭据', async () => {
    const calls: { url: string; headers: Record<string, string>; redirect?: RequestRedirect }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string>, redirect: init.redirect });
      return { ok: true, text: async () => JSON.stringify({ data: [{ id: 'coding-plan/glm-5.3' }] }) };
    }) as unknown as typeof fetch;

    expect(await detectModelsViaEndpoint(env, fetchImpl)).toEqual(['coding-plan/glm-5.3']);
    expect(calls[0]!.url).toBe('http://127.0.0.1:3425/v1/models');
    expect(calls[0]!.headers.authorization).toBe('Bearer tok');
    // 请求携带网关凭据，不允许 Fetch 把它转发到重定向目标。
    expect(calls[0]!.redirect).toBe('error');
  });

  it('非 2xx / 抛错 / 空清单都返回 null', async () => {
    // 非 2xx 的响应体故意放一份合法清单：没有 ok 守卫时它会被当成功返回。
    const status = (code: number, body = '{}') => (async () => ({
      ok: code >= 200 && code < 300,
      text: async () => body,
    })) as unknown as typeof fetch;
    expect(await detectModelsViaEndpoint(env, status(401, JSON.stringify({ data: [{ id: 'unauthorized-model' }] })))).toBeNull();
    expect(await detectModelsViaEndpoint(env, (async () => { throw new Error('boom'); }) as unknown as typeof fetch)).toBeNull();
    expect(await detectModelsViaEndpoint(env, status(200))).toBeNull();
  });

  it('没有 base override 时不发请求', async () => {
    let called = 0;
    const fetchImpl = (async () => { called++; return { ok: true, text: async () => '{}' }; }) as unknown as typeof fetch;
    expect(await detectModelsViaEndpoint(undefined, fetchImpl)).toBeNull();
    expect(called).toBe(0);
  });

  it('按 has_more/last_id 有界翻页，保序合并并去重', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      const after = new URL(url).searchParams.get('after_id');
      const firstPage = Array.from({ length: 20 }, (_, i) => ({ id: `model-${i + 1}` }));
      return {
        ok: true,
        text: async () => JSON.stringify(after ? {
          data: [{ id: 'model-20' }, { id: 'model-21' }],
          has_more: false,
          last_id: 'model-21',
        } : {
          data: firstPage,
          has_more: true,
          last_id: 'model-20',
        }),
      } as Response;
    }) as unknown as typeof fetch;

    const models = await detectModelsViaEndpoint(env, fetchImpl);
    expect(models).toHaveLength(21);
    expect(models?.at(-1)).toBe('model-21');
    expect(calls).toHaveLength(2);
    expect(new URL(calls[1]!).searchParams.get('after_id')).toBe('model-20');
  });

  it('游标重复或后续页失败时返回 null，不把部分目录当权威结果', async () => {
    let repeatedCalls = 0;
    const repeated = (async () => {
      repeatedCalls++;
      return {
        ok: true,
        text: async () => JSON.stringify({
          data: [{ id: 'only-model' }], has_more: true, last_id: 'same-cursor',
        }),
      } as Response;
    }) as unknown as typeof fetch;
    expect(await detectModelsViaEndpoint(env, repeated)).toBeNull();
    expect(repeatedCalls).toBe(2);

    const secondPageFails = (async (url: string) => ({
      ok: !new URL(url).searchParams.has('after_id'),
      text: async () => JSON.stringify({
        data: [{ id: 'partial-model' }], has_more: true, last_id: 'next',
      }),
    }) as Response) as unknown as typeof fetch;
    expect(await detectModelsViaEndpoint(env, secondPageFails)).toBeNull();
  });

  it('Content-Length 已超限时不读响应体', async () => {
    let readBody = false;
    const fetchImpl = (async () => ({
      ok: true,
      headers: { get: (name: string) => (name === 'content-length' ? '2000000' : null) },
      body: null,
      text: async () => { readBody = true; return '{}'; },
    })) as unknown as typeof fetch;

    expect(await detectModelsViaEndpoint(env, fetchImpl)).toBeNull();
    expect(readBody).toBe(false);
  });

  it('流式响应超限时中途放弃，不把整包读进内存', async () => {
    const chunk = new Uint8Array(64 * 1024);
    // 总量远超任何合理上限：只要读到底就说明没有提前放弃。
    const offered = 1024;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls >= offered) { controller.close(); return; }
        controller.enqueue(chunk);
      },
    });
    const fetchImpl = (async () => ({
      ok: true,
      headers: { get: () => null },
      body,
      // 整读路径会拿到一份合法清单；一旦走 text() 就会「成功」，测试因此咬得住。
      text: async () => JSON.stringify({ data: [{ id: 'should-not-be-used' }] }),
    })) as unknown as typeof fetch;

    expect(await detectModelsViaEndpoint(env, fetchImpl)).toBeNull();
    // 关系断言：必须在上限处停下，而不是把 offered 块全读完再判。
    expect(pulls).toBeGreaterThan(0);
    expect(pulls).toBeLessThan(offered);
  });
});

describe('resolveEndpointEnvironment', () => {
  it('botmux --settings overlay 覆盖用户 settings 与普通继承 env', () => {
    const root = tempRoot();
    writeFileSync(join(root, 'settings.json'), JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'https://from-settings', ANTHROPIC_AUTH_TOKEN: 's' },
    }));
    const resolved = resolveEndpointEnvironment({
      ANTHROPIC_BASE_URL: 'https://inherited',
      ANTHROPIC_AUTH_TOKEN: 'i',
    }, root, {
      ANTHROPIC_BASE_URL: 'https://from-bot',
      ANTHROPIC_AUTH_TOKEN: 'b',
    });
    expect(resolved).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://from-bot',
      ANTHROPIC_AUTH_TOKEN: 'b',
    });
  });

  it('没有 botmux overlay 时，用户 settings 覆盖普通继承 env', () => {
    const root = tempRoot();
    writeFileSync(join(root, 'settings.json'), JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'https://from-settings', ANTHROPIC_AUTH_TOKEN: 's' },
    }));
    expect(resolveEndpointEnvironment({
      ANTHROPIC_BASE_URL: 'https://inherited',
      ANTHROPIC_AUTH_TOKEN: 'i',
    }, root)).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://from-settings',
      ANTHROPIC_AUTH_TOKEN: 's',
    });
  });

  it('base-only botmux overlay 仍逐 key 继承 settings-only token', () => {
    const root = tempRoot();
    writeFileSync(join(root, 'settings.json'), JSON.stringify({
      env: { ANTHROPIC_AUTH_TOKEN: 'from-settings' },
    }));
    const resolved = resolveEndpointEnvironment({
      ANTHROPIC_BASE_URL: 'https://from-bot',
    }, root, { ANTHROPIC_BASE_URL: 'https://from-bot' });
    expect(resolved).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://from-bot',
      ANTHROPIC_AUTH_TOKEN: 'from-settings',
    });
  });
});

describe('detectClaudeModels（优先级：端点 → 目录 → null）', () => {
  it('端点成功时优先用端点，不读目录', async () => {
    const root = tempRoot();
    writeCatalog(root, 'published-a.json', catalogDocument([{ id: 'claude-opus-5-5' }]));
    const fetchImpl = (async () => ({
      ok: true,
      text: async () => JSON.stringify({ data: [{ id: 'coding-plan/deepseek-v4.1-flash' }] }),
    })) as unknown as typeof fetch;

    expect(await detectClaudeModels({
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:3425', ANTHROPIC_AUTH_TOKEN: 'tok' },
      configDir: root,
      fetchImpl,
    })).toEqual(['coding-plan/deepseek-v4.1-flash']);
  });

  it('base-only overlay 能搭配 settings token 完成端点探测', async () => {
    const root = tempRoot();
    writeFileSync(join(root, 'settings.json'), JSON.stringify({
      env: { ANTHROPIC_AUTH_TOKEN: 'settings-token' },
    }));
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({ data: [{ id: 'gateway-only-model' }] }),
    })) as unknown as typeof fetch;
    const overlay = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:3425' };

    expect(await detectClaudeModels({
      env: overlay,
      settingsEnv: overlay,
      configDir: root,
      fetchImpl,
    })).toEqual(['gateway-only-model']);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('官方账户（无 base override）直接读磁盘目录', async () => {
    const root = tempRoot();
    writeCatalog(root, 'published-a.json', catalogDocument([{ id: 'claude-sonnet-5-5' }]));
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    expect(await detectClaudeModels({ env: {}, configDir: root, fetchImpl }))
      .toEqual(['claude-sonnet-5-5']);
    // 没有 base URL 就不该发请求。
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
  });

  it('bot 注入 base URL 时，端点失败不回退官方磁盘目录', async () => {
    const root = tempRoot();
    writeCatalog(root, 'published-a.json', catalogDocument([{ id: 'claude-sonnet-5-5' }]));
    const fetchImpl = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;

    // 网关 bot 的可选集合只有网关知道；官方目录里的 id 它根本跑不到。
    expect(await detectClaudeModels({
      env: { ANTHROPIC_BASE_URL: 'https://gw.example.com', ANTHROPIC_AUTH_TOKEN: 'tok' },
      configDir: root,
      fetchImpl,
    })).toBeNull();
  });

  it('base URL 来自用户 settings.json 时，端点失败仍可回退磁盘目录', async () => {
    const root = tempRoot();
    writeFileSync(join(root, 'settings.json'), JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:3425', ANTHROPIC_AUTH_TOKEN: 'from-settings' },
    }));
    writeCatalog(root, 'published-a.json', catalogDocument([{ id: 'claude-sonnet-5-5' }]));
    const fetchImpl = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;

    expect(await detectClaudeModels({ env: {}, configDir: root, fetchImpl }))
      .toEqual(['claude-sonnet-5-5']);
  });

  it('端点与目录都不可用时返回 null（调用方回退静态表）', async () => {
    const root = tempRoot();
    const fetchImpl = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect(await detectClaudeModels({ configDir: root, fetchImpl })).toBeNull();
  });
});
