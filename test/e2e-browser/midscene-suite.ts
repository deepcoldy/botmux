type Hook = () => void | Promise<void>;
type TestBody = () => void | Promise<void>;

interface RegisteredTest {
  name: string;
  run: TestBody;
}

interface RegisteredSuite {
  name: string;
  beforeAll: Hook[];
  afterAll: Hook[];
  tests: RegisteredTest[];
}

export const FEISHU_SCENARIOS = [
  'bot-aiden-basic',
  'bot-claude-basic',
  'bot-coco-basic',
  'bot-codex-basic',
  'bot-codex-prompt',
  'bot-opencode-basic',
  'bot-reply-smoke',
  'bot-collaboration',
  'card-lifecycle',
  'consecutive-messages',
  'group-without-mention',
  'group-single-mention',
  'group-topic-reply',
  'image-text-mixing',
  'private-topic-reply',
  'scheduled-task-thread',
  'web-terminal',
] as const;

export type FeishuScenario = (typeof FEISHU_SCENARIOS)[number];

interface ScenarioTarget {
  module: string;
  suite: string;
  test: string;
}

const SCENARIO_TARGETS: Record<FeishuScenario, ScenarioTarget> = {
  'bot-aiden-basic': {
    module: 'feishu-bot-aiden.e2e.ts',
    suite: 'Aiden basic flow',
    test: 'sends hello, receives streaming card and actual reply from Aiden',
  },
  'bot-claude-basic': {
    module: 'feishu-bot-claude.e2e.ts',
    suite: 'Claude basic flow',
    test: 'sends hello, receives streaming card and actual reply from Claude',
  },
  'bot-coco-basic': {
    module: 'feishu-bot-coco.e2e.ts',
    suite: 'CoCo basic flow',
    test: 'sends hello, receives streaming card and actual reply from CoCo',
  },
  'bot-codex-basic': {
    module: 'feishu-bot-codex.e2e.ts',
    suite: 'Codex basic flow',
    test: 'sends hello, opens the current thread, and receives a Codex-side response',
  },
  'bot-codex-prompt': {
    module: 'feishu-bot-codex.e2e.ts',
    suite: 'Codex prompt submission',
    test: 'submits the wrapped Codex prompt and receives a Codex-side response',
  },
  'bot-opencode-basic': {
    module: 'feishu-bot-opencode.e2e.ts',
    suite: 'OpenCode basic flow',
    test: 'sends hello, receives streaming card and actual reply from OpenCode',
  },
  'bot-reply-smoke': {
    module: 'feishu-bot-reply.e2e.ts',
    suite: 'feishu bot reply (smoke test)',
    test: 'should receive bot reply after sending a message',
  },
  'bot-collaboration': {
    module: 'feishu-bot-collab.e2e.ts',
    suite: 'bot-to-bot collaboration (@Aiden ↔ @CoCo)',
    test: 'Aiden and CoCo collaborate with 3+ rounds of back-and-forth',
  },
  'card-lifecycle': {
    module: 'feishu-card-lifecycle.e2e.ts',
    suite: 'feishu card lifecycle',
    test: 'full card lifecycle: active status → toggle → no artifacts → idle',
  },
  'consecutive-messages': {
    module: 'feishu-consecutive-messages.e2e.ts',
    suite: 'consecutive messages',
    test: 'should process 3 rapidly sent messages in sequence',
  },
  'group-without-mention': {
    module: 'feishu-group-mention.e2e.ts',
    suite: 'feishu group @mention routing',
    test: 'no @mention in multi-bot group → no bot responds',
  },
  'group-single-mention': {
    module: 'feishu-group-mention.e2e.ts',
    suite: 'feishu group @mention routing',
    test: '@mention a single bot → only that bot responds',
  },
  'group-topic-reply': {
    module: 'feishu-group-topic.e2e.ts',
    suite: 'group chat topic reply mode',
    test: 'bot uses topic replies in a regular group',
  },
  'image-text-mixing': {
    module: 'feishu-image-mix.e2e.ts',
    suite: 'botmux send image and text mixing via ![](img:N)',
    test: 'uses botmux send placeholders to interleave two images with Markdown',
  },
  'private-topic-reply': {
    module: 'feishu-private-topic.e2e.ts',
    suite: 'private chat topic reply mode',
    test: 'bot uses topic replies in a private chat',
  },
  'scheduled-task-thread': {
    module: 'feishu-schedule.e2e.ts',
    suite: 'scheduled task thread continuity',
    test: 'scheduled task replies inside the original thread when triggered',
  },
  'web-terminal': {
    module: 'feishu-web-terminal.e2e.ts',
    suite: 'feishu web terminal',
    test: 'web terminal opens from the current streaming card',
  },
};

let collectingSuites: RegisteredSuite[] | undefined;
let activeSuite: RegisteredSuite | undefined;
let suiteLoadSequence = 0;

export function describe(name: string, register: () => void): void {
  if (!collectingSuites) {
    throw new Error('Midscene suite definitions must be loaded by the scenario runner');
  }
  const suite: RegisteredSuite = {
    name,
    beforeAll: [],
    afterAll: [],
    tests: [],
  };
  collectingSuites.push(suite);
  const previousSuite = activeSuite;
  activeSuite = suite;
  try {
    register();
  } finally {
    activeSuite = previousSuite;
  }
}

export function beforeAll(hook: Hook, _timeout?: number): void {
  requireActiveSuite().beforeAll.push(hook);
}

export function afterAll(hook: Hook, _timeout?: number): void {
  requireActiveSuite().afterAll.push(hook);
}

export function it(name: string, run: TestBody, _timeout?: number): void {
  requireActiveSuite().tests.push({ name, run });
}

function requireActiveSuite(): RegisteredSuite {
  if (!activeSuite) {
    throw new Error('Midscene suite hook or case was declared outside describe()');
  }
  return activeSuite;
}

async function loadSuites(moduleName: string): Promise<RegisteredSuite[]> {
  const suites: RegisteredSuite[] = [];
  collectingSuites = suites;
  try {
    // Each Midscene retry needs its own hook closures. A timed-out attempt may
    // still be running its finally block when the runner starts the retry;
    // reusing the module would let that cleanup close the new browser.
    const moduleUrl = new URL(moduleName, import.meta.url);
    moduleUrl.searchParams.set('suite-load', String(++suiteLoadSequence));
    await import(moduleUrl.href);
  } finally {
    collectingSuites = undefined;
    activeSuite = undefined;
  }
  return suites;
}

export async function runFeishuScenario(scenario: FeishuScenario): Promise<void> {
  const { suite, test } = await resolveScenario(scenario);

  try {
    for (const hook of suite.beforeAll) await hook();
    await test.run();
  } finally {
    // Match test-runner teardown semantics: a partially completed beforeAll may
    // already have created a browser, context, page, or agent. Always execute
    // cleanup so a setup failure cannot leave Chromium handles alive and keep
    // the Midscene CLI process running after it has printed the final summary.
    for (const hook of [...suite.afterAll].reverse()) await hook();
  }
}

async function resolveScenario(scenario: FeishuScenario): Promise<{
  suite: RegisteredSuite;
  test: RegisteredTest;
}> {
  const target = SCENARIO_TARGETS[scenario];
  const suites = await loadSuites(target.module);
  const suite = suites.find((candidate) => candidate.name === target.suite);
  if (!suite) {
    throw new Error(`Suite not found for ${scenario}: ${target.suite}`);
  }
  const test = suite.tests.find((candidate) => candidate.name === target.test);
  if (!test) {
    throw new Error(`Case not found for ${scenario}: ${target.test}`);
  }
  return { suite, test };
}

export async function validateFeishuScenarioRegistry(): Promise<void> {
  for (const scenario of FEISHU_SCENARIOS) {
    await resolveScenario(scenario);
  }
}
