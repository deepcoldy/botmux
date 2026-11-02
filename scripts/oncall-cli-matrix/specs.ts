/**
 * Per-CLI setup for the oncall-sandbox matrix: what a user would configure to
 * point the CLI at a custom endpoint (bot `env`, or the CLI's own config file
 * under $HOME), here aimed at the lab's mock model with fake keys. Runs inside
 * the lab's throwaway $HOME overlay (lab.sh), so writing under $HOME is safe.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface SetupInput { home: string; mockUrl: string; workDir: string }
export interface SetupOutput { env?: Record<string, string>; cliPathOverride?: string }
export interface CliSpec {
  /** Row name; also the cliId unless `cliId` is set (config variants). */
  id: string;
  cliId?: string;
  setup(input: SetupInput): SetupOutput;
  /** Extra init fields (e.g. model). */
  initExtra?: Record<string, unknown>;
  settleMs?: number;
  /** $HOME-relative state dirs to list after the run. */
  stateDirs?: string[];
  sendOk?(send: string): { verdict: 'pass' | 'fail' | 'skip'; detail?: string };
}

const FAKE_KEY = 'sk-fake-oncall-matrix';

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export const CLI_SPECS: CliSpec[] = [
  {
    id: 'claude-code',
    setup: ({ mockUrl }) => ({
      env: { ANTHROPIC_BASE_URL: mockUrl, ANTHROPIC_AUTH_TOKEN: FAKE_KEY, ANTHROPIC_MODEL: 'mock-model', DISABLE_AUTOUPDATER: '1' },
    }),
  },
  {
    id: 'codex',
    setup: ({ home, mockUrl }) => {
      write(join(home, '.codex/config.toml'), [
        'model = "mock-model"',
        'model_provider = "mock"',
        'check_for_update_on_startup = false',
        '',
        '[model_providers.mock]',
        'name = "mock"',
        `base_url = "${mockUrl}/v1"`,
        'wire_api = "responses"',
        'env_key = "MOCK_API_KEY"',
        '',
      ].join('\n'));
      return { env: { MOCK_API_KEY: FAKE_KEY } };
    },
  },
  {
    id: 'codex-app',
    setup: ({ home, mockUrl }) => {
      write(join(home, '.codex/config.toml'), [
        'model = "mock-model"',
        'model_provider = "mock"',
        'check_for_update_on_startup = false',
        '',
        '[model_providers.mock]',
        'name = "mock"',
        `base_url = "${mockUrl}/v1"`,
        'wire_api = "responses"',
        'env_key = "MOCK_API_KEY"',
        '',
      ].join('\n'));
      return { env: { MOCK_API_KEY: FAKE_KEY } };
    },
  },
  {
    id: 'antigravity',
    stateDirs: ['.gemini/antigravity-cli'],
    setup: ({ home, mockUrl }) => {
      // modelProvider "gemini" + GEMINI_API_KEY: agy runs against the Gemini
      // API without a Google sign-in, at GOOGLE_GEMINI_BASE_URL. The
      // onboarding cache skips the first-run colour-scheme / terms screens.
      // AGY_CLI_DISABLE_AUTO_UPDATE must be the literal "true": with "1" agy
      // 1.4.12 still spawns its background updater.
      write(join(home, '.gemini/antigravity-cli/settings.json'), JSON.stringify({ modelProvider: 'gemini' }));
      write(join(home, '.gemini/antigravity-cli/cache/onboarding.json'), JSON.stringify({ consumerOnboardingComplete: true, enterpriseOnboardingComplete: false, onboardingComplete: true }));
      return { env: { GOOGLE_GEMINI_BASE_URL: mockUrl, GEMINI_API_KEY: FAKE_KEY, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' } };
    },
  },
  {
    id: 'opencode',
    setup: ({ mockUrl }) => ({
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          $schema: 'https://opencode.ai/config.json',
          model: 'mock/mock-model',
          autoupdate: false,
          share: 'disabled',
          provider: {
            mock: {
              npm: '@ai-sdk/openai-compatible',
              name: 'Mock',
              options: { baseURL: `${mockUrl}/v1`, apiKey: FAKE_KEY },
              models: { 'mock-model': { name: 'Mock Model', tool_call: true } },
            },
          },
        }),
        OPENCODE_DISABLE_AUTOUPDATE: '1',
      },
    }),
  },
  {
    id: 'opencode2',
    setup: ({ mockUrl }) => ({
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          $schema: 'https://opencode.ai/config.json',
          model: 'mock/mock-model',
          autoupdate: false,
          share: 'disabled',
          provider: {
            mock: {
              npm: '@ai-sdk/openai-compatible',
              name: 'Mock',
              options: { baseURL: `${mockUrl}/v1`, apiKey: FAKE_KEY },
              models: { 'mock-model': { name: 'Mock Model', tool_call: true } },
            },
          },
        }),
        OPENCODE_DISABLE_AUTOUPDATE: '1',
      },
    }),
  },
  // How OpenCode users usually configure a provider: the global config file,
  // not OPENCODE_CONFIG_CONTENT.
  ...(['opencode', 'opencode2'] as const).map((cliId): CliSpec => ({
    id: `${cliId}:config-file`,
    cliId,
    setup: ({ home, mockUrl }) => {
      write(join(home, '.config/opencode/opencode.json'), JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        model: 'mock/mock-model',
        autoupdate: false,
        share: 'disabled',
        provider: { mock: { npm: '@ai-sdk/openai-compatible', name: 'Mock', options: { baseURL: `${mockUrl}/v1`, apiKey: FAKE_KEY }, models: { 'mock-model': { name: 'Mock Model', tool_call: true } } } },
      }));
      return { env: { OPENCODE_DISABLE_AUTOUPDATE: '1' } };
    },
  })),
  {
    id: 'kimi',
    stateDirs: ['.kimi-code'],
    setup: ({ mockUrl }) => ({
      env: {
        KIMI_MODEL_NAME: 'mock-model',
        KIMI_MODEL_API_KEY: FAKE_KEY,
        KIMI_MODEL_PROVIDER_TYPE: 'anthropic',
        KIMI_MODEL_BASE_URL: mockUrl,
        KIMI_MODEL_CAPABILITIES: 'tool_use',
        KIMI_CODE_NO_AUTO_UPDATE: '1',
        KIMI_DISABLE_TELEMETRY: '1',
      },
    }),
  },
  {
    id: 'pi',
    stateDirs: ['.pi'],
    setup: ({ home, mockUrl }) => {
      write(join(home, '.pi/agent/models.json'), JSON.stringify({ providers: { mock: { baseUrl: `${mockUrl}/v1`, api: 'openai-completions', apiKey: FAKE_KEY, models: [{ id: 'mock-model' }] } } }));
      write(join(home, '.pi/agent/settings.json'), JSON.stringify({ defaultProvider: 'mock', defaultModel: 'mock-model', defaultProjectTrust: 'always', enableInstallTelemetry: false }));
      return { env: { PI_SKIP_VERSION_CHECK: '1' } };
    },
  },
  {
    id: 'oh-my-pi',
    setup: ({ home, mockUrl }) => {
      write(join(home, '.omp/agent/models.yml'), `providers:\n  mock:\n    baseUrl: ${mockUrl}/v1\n    api: openai-completions\n    apiKey: ${FAKE_KEY}\n    models:\n      - id: mock-model\n`);
      write(join(home, '.omp/agent/config.yml'), 'setupVersion: 2\nmodelRoles:\n  default: mock/mock-model\nstartup:\n  checkUpdate: false\n');
      return {};
    },
  },
  {
    id: 'grok',
    setup: ({ home, mockUrl }) => {
      write(join(home, '.grok/config.toml'), `[cli]\nauto_update = false\nshow_tips = false\n\n[features]\ntelemetry = false\n\n[models]\ndefault = "mock"\n\n[model.mock]\nmodel = "mock-model"\nname = "Mock"\nbase_url = "${mockUrl}/v1"\napi_backend = "messages"\napi_key = "${FAKE_KEY}"\ncontext_window = 200000\n`);
      return {};
    },
  },
  {
    id: 'hermes',
    stateDirs: ['.hermes'],
    setup: ({ home, mockUrl }) => {
      write(join(home, '.hermes/config.yaml'), [
        'model:',
        '  default: mock-model',
        '  provider: mock',
        `  base_url: ${mockUrl}/v1`,
        'providers:',
        '  mock:',
        '    name: Mock',
        `    base_url: ${mockUrl}/v1`,
        '    api_mode: chat_completions',
        '    key_env: MOCK_API_KEY',
        '    model: mock-model',
        '    discover_models: false',
        '',
      ].join('\n'));
      return { env: { MOCK_API_KEY: FAKE_KEY } };
    },
  },
];
