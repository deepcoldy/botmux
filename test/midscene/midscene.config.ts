import type { ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defineProjectSetup, defineTestProject } from '@midscene/test/config';
import { createMidsceneNodes } from '@midscene/test/midscene';
import { PlaywrightAgent } from '@midscene/web/playwright';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright';
import { spawnTsScript } from '../helpers/ts-runner.js';

interface DashboardContext {
  agent?: PlaywrightAgent;
  browser: Browser;
  browserContext: BrowserContext;
  page: Page;
}

const projectRoot = resolve(import.meta.dirname, '../..');
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((done) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done();
    }, 5_000);
    child.once('close', () => {
      clearTimeout(timer);
      done();
    });
    child.kill('SIGTERM');
  });
}

async function waitForDashboard(
  portFile: string,
  child: ChildProcess,
  logs: () => string,
): Promise<number> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Dashboard exited before it became ready:\n${logs()}`);
    }
    try {
      const port = Number((await readFile(portFile, 'utf8')).trim());
      if (Number.isSafeInteger(port) && port > 0 && port <= 65_535) {
        const response = await fetch(`http://127.0.0.1:${port}/__health`);
        if (response.ok) return port;
      }
    } catch {
      // The dashboard is still starting.
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for the Dashboard:\n${logs()}`);
}

const dashboardSetup = defineProjectSetup<DashboardContext>({
  name: 'botmux-dashboard',
  async setup({ onTeardown }) {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'botmux-midscene-'));
    const fixtureHome = join(fixtureRoot, 'home');
    const botmuxDir = join(fixtureHome, '.botmux');
    const dataDir = join(botmuxDir, 'data');
    // Teardowns run in reverse registration order. Register directory removal
    // first so the browser and Dashboard release their handles before cleanup.
    onTeardown(() => rm(fixtureRoot, { recursive: true, force: true }));
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(botmuxDir, '.data-dir'), `${dataDir}\n`, { mode: 0o600 });
    await writeFile(
      join(botmuxDir, 'bots.json'),
      JSON.stringify([
        {
          larkAppId: 'cli_midscene_fixture',
          larkAppSecret: 'synthetic-midscene-secret',
          botName: 'Midscene Smoke Bot',
          cliId: 'codex',
          allowedUsers: ['tester@example.com'],
          workingDir: projectRoot,
        },
      ], null, 2),
    );

    let stdout = '';
    let stderr = '';
    // `test:midscene` builds first. Running the compiled entry keeps
    // dashboard.ts's module-relative `dashboard-web/` lookup on the same path
    // that production uses; the source entry would look under src/ and 404.
    const dashboard = spawnTsScript(resolve(projectRoot, 'dist/index-dashboard.js'), [], {
      cwd: projectRoot,
      env: {
        ...process.env,
        HOME: fixtureHome,
        USERPROFILE: fixtureHome,
        SESSION_DATA_DIR: dataDir,
        BOTS_CONFIG: join(botmuxDir, 'bots.json'),
        BOTMUX_DASHBOARD_HOST: '127.0.0.1',
        BOTMUX_DASHBOARD_PORT: '7891',
        BOTMUX_DASHBOARD_PUBLIC_READONLY: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    dashboard.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    dashboard.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    onTeardown(() => stopChild(dashboard));

    const port = await waitForDashboard(
      join(botmuxDir, '.dashboard-port'),
      dashboard,
      () => `${stdout}\n${stderr}`,
    );

    const browser = await chromium.launch({
      headless: process.env.HEADLESS !== 'false',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    onTeardown(() => browser.close());
    const browserContext = await browser.newContext({
      locale: 'zh-CN',
      viewport: { width: 1440, height: 960 },
    });
    onTeardown(() => browserContext.close());
    const page = await browserContext.newPage();
    const response = await page.goto(`http://127.0.0.1:${port}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    if (!response?.ok()) {
      throw new Error(`Dashboard returned HTTP ${response?.status() ?? 'unknown'}`);
    }
    await page.waitForSelector('#app-root', { timeout: 15_000 });

    const context: DashboardContext = { browser, browserContext, page };
    onTeardown(() => context.agent?.destroy());
    return context;
  },
});

export default defineTestProject<DashboardContext>({
  test: {
    maxConcurrency: 1,
    testTimeout: 5 * 60_000,
  },
  projects: [
    {
      name: 'dashboard-smoke',
      retry: process.env.CI ? 1 : 0,
      files: { include: ['cases/dashboard-smoke.yaml'] },
      setup: dashboardSetup,
    },
  ],
  nodes: createMidsceneNodes<DashboardContext>({
    agentClass: PlaywrightAgent,
    getAgent: ({ context }) => {
      context.agent ??= new PlaywrightAgent(context.page);
      return context.agent;
    },
  }),
});
