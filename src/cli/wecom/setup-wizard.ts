import qrcode from 'qrcode-terminal';
import { createInterface } from 'node:readline';
import { createWecomPrompter, type WecomPrompter } from './manual-setup.js';
import type { WecomOnboardingSnapshot } from '../../im/wecom/contract/dashboard-dto.js';
import { isWecomManualBotId, isWecomManualSecret } from '../../im/wecom/contract/manual-credentials.js';
import { t } from '../../i18n/index.js';
import { pickChoice, pickCliSelection, type PickChoiceOptions } from '../../setup/interactive-select.js';
import { dashboardIsAbsent, executeDashboardWithFirstUseBootstrap } from '../dashboard-bootstrap.js';
import type { DashboardEndpoint, DashboardResult } from '../dashboard-endpoint.js';
import { WecomSetupRejectedError, type WecomSetupClient } from './onboarding-client.js';

export const WECOM_QR_SETUP_HELP = `用法: botmux setup --platform wecom
  扫码创建机器人 → 私聊配对 → 保存配置并自动上线。
  --name <名称> --cli <CLI> --working-dir <目录> --backend <pty|tmux> --model <模型>
  --resume <任务ID>  续办同一本机管理员登录下的任务（24小时内）
  --cancel <任务ID>  取消本地任务，保留已创建的平台机器人
  --manual          手工配置已有 BotID、Secret、真实 userid；不自动连接
  原有 --config/--bot-id/--secret-file/--secret-env/--allow-user 等参数继续走手工配置。
扫码向导需交互终端。Ctrl-C 取消当前本地流程；重新进入可选择续办。`;

function parseOptions(args: string[]) {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!['--name', '--cli', '--working-dir', '--backend', '--model', '--resume', '--cancel'].includes(flag)
      || flags.has(flag) || !value || value.startsWith('--')) throw new Error('invalid_setup_options');
    flags.set(flag, value);
  }
  if (flags.has('--resume') && flags.has('--cancel')) throw new Error('invalid_setup_options');
  if ((flags.has('--resume') || flags.has('--cancel')) && flags.size !== 1) throw new Error('invalid_setup_options');
  return flags;
}
const LABELS: Record<WecomOnboardingSnapshot['status'], string> = {
  starting: '正在准备企业微信扫码授权…',
  waiting_for_scan: '请用企业微信扫描二维码，创建并确认机器人。',
  verifying: '正在验证机器人凭据…',
  needs_pairing: '发送完整配对码的账号将成为本机器人的管理及审批账号。请用该账号私聊新机器人，仅发送下面的完整配对码（不要发到群聊）：',
  starting_bot: '身份已验证，正在保存配置并启动机器人…',
  completed: '配置已保存，机器人与专用 core 已上线。',
  failed: '流程暂未完成。',
  cancelled: '本地流程已取消；已创建的平台机器人保留。',
};

/** Scan-to-create carries no name: the name typed in the wizard is only botmux's
 * local display name, and the bot keeps the platform default name and avatar
 * inside WeCom. Said once more on success so the user does not read it as a bug. */
export function wecomCompletedNameNote(appName: string | undefined): string {
  const name = appName?.trim();
  return name
    ? t('setup.wecom.completed_name_note', { name })
    : t('setup.wecom.completed_name_note_unnamed');
}

/** No local Dashboard answered and setup deliberately started nothing: the host
 * already has bots configured (or hides host processes). Setup never brings a
 * fleet up as a side effect — the user starts it with `botmux start`, or, from
 * inside a sandbox where `start` is refused, on the host. */
export class WecomSetupDashboardNotRunningError extends Error {
  /** This process cannot see host processes, so the hint must point at the host. */
  readonly hostProcessesHidden: boolean;

  constructor(hostProcessesHidden = false) {
    super('dashboard_not_running');
    this.name = 'WecomSetupDashboardNotRunningError';
    this.hostProcessesHidden = hostProcessesHidden;
  }
}

/** Which hint to print when no Dashboard is running. Inside a sandbox
 * `botmux start` is refused (whether or not the host has bots configured), so
 * telling the user to run it there would send them into a second refusal. */
function dashboardNotRunningHint(error: WecomSetupDashboardNotRunningError): string {
  return error.hostProcessesHidden
    ? t('setup.wecom.dashboard_not_running_sandbox')
    : t('setup.wecom.dashboard_not_running');
}

/** Same code `botmux dashboard` exits with when no Dashboard is reachable; the
 * wizard's other failures exit 2. */
const EXIT_DASHBOARD_NOT_RUNNING = 1;

/** Reach the local Dashboard the QR wizard drives. Only an unconfigured host
 * may bootstrap one — the zero-bot first-use supervisor, behind the same
 * sandbox gate as `botmux dashboard`. Otherwise a missing Dashboard ends setup
 * with WecomSetupDashboardNotRunningError, and nothing has been started. */
export async function connectWecomSetupDashboard(deps: {
  callEndpoint: (path: DashboardEndpoint, opts?: { rescanWhenUnreachable?: boolean }) => Promise<DashboardResult>;
  hasConfig: () => boolean;
  hostProcessesHidden: () => boolean;
  start: () => Promise<void>;
  createClient: (result: DashboardResult) => Promise<WecomSetupClient>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<WecomSetupClient> {
  let startedSupervisor = false;
  const execution = await executeDashboardWithFirstUseBootstrap([], deps.callEndpoint, async () => null, {
    hasConfig: deps.hasConfig,
    hostProcessesHidden: deps.hostProcessesHidden,
    start: async () => {
      startedSupervisor = true;
      await deps.start();
    },
    now: deps.now,
    sleep: deps.sleep,
  });
  if (execution.kind !== 'endpoint') throw new Error('dashboard_unavailable');
  if (dashboardIsAbsent(execution.result) && !startedSupervisor) {
    throw new WecomSetupDashboardNotRunningError(deps.hostProcessesHidden());
  }
  return deps.createClient(execution.result);
}

/**
 * How the wizard gets the new bot's credentials: `qr` scans to create one
 * (`botmux setup --platform wecom`); `manual` takes the BotID / Secret of a bot
 * already created in WeCom and starts the same Dashboard onboarding job the
 * browser's manual form starts (`mode: 'manual'`) — pairing, saving and going
 * online are the same. Unrelated to `--platform wecom --manual`, which only
 * writes a configuration file.
 */
export type WecomSetupMode = 'qr' | 'manual';

/** The wizard's "pick one of these" questions, on the same selectors as the Feishu setup. */
export interface WecomSetupPicker {
  /** Same as the Feishu setup's pickChoice: the picked item's index; Esc / Ctrl-C gives null. */
  choose(options: PickChoiceOptions): Promise<number | null>;
  /** Same cascading CLI selector as the Feishu setup (pickCliSelection): a selection key; Esc gives null. */
  chooseCli(options: { title: string }): Promise<string | null>;
}

/**
 * The terminal's selectors. The wizard only runs on a TTY, where pickChoice /
 * pickCliSelection draw a raw-mode selector and never read the readline they
 * are given; only their non-TTY fallback calls `question`, and only then is a
 * readline opened, one per question (like createWecomPrompter). So no readline
 * is reading stdin while a selector does. stdin is paused after each pick: the
 * raw selector puts back the listener an earlier readline left on stdin and
 * leaves stdin flowing, which would keep the process alive after the wizard.
 */
export function createWecomSetupPicker(): WecomSetupPicker {
  const fallback = {
    question(query: string, answer: (value: string) => void) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      let answered = false;
      rl.once('close', () => {
        if (!answered) {
          answered = true;
          answer('');
        }
      });
      rl.question(query, value => {
        answered = true;
        rl.close();
        answer(value);
      });
    },
  } as unknown as Parameters<typeof pickChoice>[0];
  const thenPause = async <T>(pick: Promise<T>): Promise<T> => {
    try {
      return await pick;
    } finally {
      process.stdin.pause();
    }
  };
  return {
    choose: options => thenPause(pickChoice(fallback, options)),
    chooseCli: options => thenPause(pickCliSelection(fallback, options)),
  };
}

/** Footer of the wizard's own selectors: leaving one ends the wizard before anything is created. */
const PICK_FOOTER = 'Esc 退出，不创建任何东西';
const CONFIRM_CANCEL = 0;
const CONFIRM_CONTINUE = 1;

/** Said when a start request may have created the task: never start it again blindly. */
export const WECOM_START_UNCONFIRMED = '创建请求未确认，任务可能已创建。重新运行 setup 选择已有任务续办；不要重复创建。';

/**
 * Refusals of `POST /api/bot-onboarding/start` that prove nothing was created,
 * with the reason shown. Every one is thrown by WecomOnboardingManager.start
 * (dashboard/wecom/onboarding.ts) before it writes the job's receipt —
 * preflightWecomOnboarding, the login check, the manual-credential check — and
 * before anything reaches the platform; only a throw from start() itself becomes
 * that route's `400 { error }`. Left out on purpose: `wecom_onboarding_stale_generation`
 * (thrown by the receipt write itself) and `wecom_invalid_onboarding` (the route's
 * catch-all, which also covers a failed receipt write); those, and any code not
 * listed, keep WECOM_START_UNCONFIRMED.
 */
const WECOM_START_REFUSALS: ReadonlyMap<string, string> = new Map([
  ['wecom_cli_unavailable', '所选 CLI 在本机无法启动（可能未安装，或不在本机 Dashboard 的 PATH 里）。'],
  ['wecom_invalid_backend', '后端只能是 pty 或 tmux。'],
  ['wecom_backend_unavailable', '本机没有可用的 tmux。'],
  ['wecom_working_directory_unavailable', '项目工作目录不存在或不是目录。'],
  ['wecom_invalid_display_name', '机器人名称最长 64 个字符，且不能含控制字符。'],
  ['wecom_invalid_model', '模型名最长 200 个字符，且不能含控制字符。'],
  ['wecom_invalid_dir_mode', '本机 Dashboard 不认可这次的目录模式。'],
  ['wecom_invalid_onboarding_mode', '本机 Dashboard 不认可这次的接入方式。'],
  ['wecom_core_port_unavailable', '本机暂时分配不到专用 core 端口，请稍后重试。'],
  ['wecom_invalid_credentials', 'BotID 或 Secret 的格式不被本机 Dashboard 接受。'],
  ['wecom_onboarding_cancelled', '本机 Dashboard 的管理登录已失效，请重新运行 setup。'],
]);

export async function runWecomQrSetup(args: string[], options: {
  connect: () => Promise<WecomSetupClient>;
  /** Defaults to `qr`; only the setup source menu passes `manual`. */
  mode?: WecomSetupMode;
  tty?: boolean;
  prompt?: WecomPrompter;
  picker?: WecomSetupPicker;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  renderQr?: (url: string) => void;
}): Promise<number> {
  const prompt = options.prompt ?? createWecomPrompter();
  const mode = options.mode ?? 'qr';
  if (args.some(arg => ['--help', '-h', 'help'].includes(arg))) {
    prompt.write(WECOM_QR_SETUP_HELP);
    return 0;
  }
  let flags: Map<string, string>;
  try {
    flags = parseOptions(args);
  } catch {
    prompt.write(WECOM_QR_SETUP_HELP);
    return 2;
  }
  if (!(options.tty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY))) {
    prompt.write('扫码 setup 需要交互终端；脚本配置请使用 --manual 及凭据文件参数。');
    return 2;
  }
  const interrupted = new AbortController();
  const stop = () => interrupted.abort();
  if (options.signal) {
    options.signal.addEventListener('abort', stop);
    if (options.signal.aborted) stop();
  } else {
    process.on('SIGINT', stop);
  }
  let client: WecomSetupClient | undefined;
  let job: WecomOnboardingSnapshot | undefined;
  let starting = false;
  /** This run started a manual-credentials job (resumed tasks keep the generic labels). */
  let startedManual = false;
  let cancelRequested = false;
  const ask = async (question: string, fallback?: string, hidden = false): Promise<string> => {
    if (interrupted.signal.aborted) throw new Error('cancelled');
    const answer = await prompt.ask(question, { defaultValue: fallback, hidden });
    if (answer === null) {
      stop();
      throw new Error('cancelled');
    }
    return answer.trim();
  };
  const picker = options.picker ?? createWecomSetupPicker();
  // A selector left with Esc / Ctrl-C returns null: the wizard ends there (exit 0)
  // before anything is created.
  const choose = async (question: PickChoiceOptions): Promise<number | null> => {
    if (interrupted.signal.aborted) throw new Error('cancelled');
    return picker.choose(question);
  };
  /** Ask until the value passes `valid` (the Dashboard's own rules), never echoing it in the hint. */
  const askValid = async (question: string, hidden: boolean, valid: (value: string) => boolean, hint: string): Promise<string> => {
    for (;;) {
      const value = await ask(question, undefined, hidden);
      if (valid(value)) return value;
      prompt.write(hint);
    }
  };
  try {
    if (interrupted.signal.aborted) return 0;
    try {
      client = await options.connect();
    } catch (error) {
      if (interrupted.signal.aborted || !(error instanceof WecomSetupDashboardNotRunningError)) throw error;
      prompt.write(dashboardNotRunningHint(error));
      return EXIT_DASHBOARD_NOT_RUNNING;
    }
    if (interrupted.signal.aborted) return 0;
    if (flags.has('--cancel')) {
      job = await client.action(flags.get('--cancel')!, 'cancel');
      prompt.write(LABELS.cancelled);
      return 0;
    }
    if (flags.has('--resume')) job = await client.get(flags.get('--resume')!);
    else {
      const pending = (await client.list()).filter(row => row.status !== 'completed').sort((a, b) => b.updatedAt - a.updatedAt);
      if (pending.length) {
        // Most recent task first, so resuming it stays the default; creating a new
        // bot is the last item and has to be picked on purpose.
        const picked = await choose({
          title: '找到同一管理员登录下的未完成任务：选择要续办的任务，或创建新机器人',
          items: [
            ...pending.map(row => ({ label: row.id, hint: LABELS[row.status] })),
            { label: '创建新机器人', hint: '不续办上面的任务' },
          ],
          defaultIndex: 0,
          footer: PICK_FOOTER,
        });
        if (picked === null) return 0;
        job = pending[picked];
      }
      if (!job) {
        // Manual mode: the credentials of a bot already created in WeCom, checked
        // with the Dashboard's own rules before anything is sent. The Secret is
        // never echoed and appears nowhere but in the start request below.
        let manual: { botId: string; secret: string } | undefined;
        if (mode === 'manual') {
          prompt.write('接入已在企业微信里创建好的智能机器人（需支持 API 长连接）：请输入它的 BotID 与 Secret，Secret 输入不回显。');
          manual = {
            botId: await askValid('BotID', false, isWecomManualBotId, 'BotID 不能为空、不能含空白或控制字符，最长 200 个字符；请重新输入。'),
            secret: await askValid('Secret（不回显）', true, isWecomManualSecret, 'Secret 不能为空、不能含换行，最长 8192 字节；请重新输入。'),
          };
        }
        const askName = () => ask('机器人名称（可留空）');
        const askDir = () => ask('项目工作目录', process.cwd());
        // The selection key goes to the Dashboard as `cliId`, exactly like the
        // browser form's CLI menu; the Dashboard resolves wrapper / launch-mode variants.
        const pickCli = async (): Promise<string | null> => {
          if (interrupted.signal.aborted) throw new Error('cancelled');
          return picker.chooseCli({ title: t('setup.cli.select_title') });
        };
        const pickBackend = async (): Promise<string | null> => {
          const picked = await choose({
            title: '会话后端',
            items: [{ label: 'pty', hint: '默认' }, { label: 'tmux' }],
            defaultIndex: 0,
            footer: PICK_FOOTER,
          });
          return picked === null ? null : picked === 1 ? 'tmux' : 'pty';
        };
        let appName = flags.get('--name') ?? await askName();
        const pickedCli = flags.get('--cli') ?? await pickCli();
        if (pickedCli === null) return 0;
        let cliId = pickedCli;
        let workingDir = flags.get('--working-dir') ?? await askDir();
        const pickedBackend = flags.get('--backend') ?? await pickBackend();
        if (pickedBackend === null) return 0;
        let backend = pickedBackend;
        // A refusal the Dashboard gave before creating anything (WECOM_START_REFUSALS)
        // asks again only the answer it is about, when that answer was asked here
        // rather than given as a flag; every other answer — the manual credentials
        // included — is kept, and the confirmation comes again before the next start.
        for (;;) {
          const input = {
            appName,
            cliId,
            workingDir,
            backend,
            ...(flags.has('--model') ? { model: flags.get('--model') } : {}),
            ...(manual ? { mode: 'manual', botId: manual.botId, secret: manual.secret } : {}),
          };
          // 「取消」 comes first, so a stray Enter never starts anything — the same
          // as the old prompt, where anything but `yes` cancelled.
          const confirmed = await choose({
            title: manual
              ? '即将用刚填写的 BotID 与 Secret（不显示）接入已有机器人，私聊配对后保存并自动启动'
              : '即将扫码创建平台机器人，配对后保存并自动启动',
            items: [
              { label: '取消', hint: '不创建任何东西，直接退出' },
              { label: '继续', hint: manual ? '提交凭据并开始私聊配对' : '开始扫码创建' },
            ],
            defaultIndex: CONFIRM_CANCEL,
            footer: PICK_FOOTER,
          });
          if (confirmed !== CONFIRM_CONTINUE) return 0;
          if (interrupted.signal.aborted) return 0;
          starting = true;
          try {
            // Do not abort this HTTP exchange on Ctrl-C: a successful late response
            // carries the id needed to cancel the already-created local task.
            job = await client.start(input);
          } catch (error) {
            const reason = error instanceof WecomSetupRejectedError ? WECOM_START_REFUSALS.get(error.code) : undefined;
            // Anything else may have created the task: the unconfirmed-start message below.
            if (!reason) throw error;
            starting = false;
            prompt.write(`未创建任何东西：${reason}`);
            const code = (error as WecomSetupRejectedError).code;
            if (code === 'wecom_cli_unavailable' && !flags.has('--cli')) {
              const next = await pickCli();
              if (next === null) return 0;
              cliId = next;
            } else if ((code === 'wecom_invalid_backend' || code === 'wecom_backend_unavailable') && !flags.has('--backend')) {
              const next = await pickBackend();
              if (next === null) return 0;
              backend = next;
            } else if (code === 'wecom_working_directory_unavailable' && !flags.has('--working-dir')) {
              workingDir = await askDir();
            } else if (code === 'wecom_invalid_display_name' && !flags.has('--name')) {
              appName = await askName();
            } else {
              return 2;
            }
            continue;
          }
          starting = false;
          break;
        }
        startedManual = Boolean(manual);
      }
    }
    prompt.write(`本地任务：${job.id}`);
    prompt.write(`续办：botmux setup --platform wecom --resume ${job.id}`);
    let displayed = '';
    for (;;) {
      if (interrupted.signal.aborted) {
        cancelRequested = true;
        break;
      }
      const displayKey = JSON.stringify([job.status, job.qrUrl, job.pairingCode]);
      if (displayKey !== displayed) {
        displayed = displayKey;
        // A manual job has no QR step: it starts by handing over the credentials.
        prompt.write(startedManual && job.status === 'starting' ? '正在提交机器人凭据…' : LABELS[job.status]);
        if (job.status === 'waiting_for_scan' && job.qrUrl) {
          const url = new URL(job.qrUrl);
          if (url.origin !== 'https://work.weixin.qq.com' || url.username || url.password || /[\x00-\x20\x7f]/.test(job.qrUrl)) {
            throw new Error('invalid_qr');
          }
          (options.renderQr ?? (value => qrcode.generate(value, { small: true }, qr => prompt.write(qr))))(url.href);
          prompt.write(`也可在浏览器打开官方授权页：${url.href}`);
        }
        if (job.status === 'needs_pairing' && job.pairingCode && /^BOTMUX-ID-[A-F0-9]{32}$/.test(job.pairingCode)) {
          prompt.write(job.pairingCode);
        }
      }
      if (job.status === 'completed') {
        prompt.write(wecomCompletedNameNote(job.appName));
        return 0;
      }
      if (job.status === 'failed' || job.status === 'cancelled') {
        // A scan-created job holds credentials only once the platform bot exists
        // (externalBotCreated); a manual job holds them from the start, and is
        // retryable without having created anything on the platform.
        prompt.write(job.saved
          ? '配置已保存；续办只重试启动同一机器人。'
          : job.externalBotCreated ? '平台机器人已创建；续办只继续配对与保存，不会再次创建。'
            : job.retryable ? '已收到机器人凭据；续办只继续配对与保存。' : '尚未收到机器人凭据；续办会刷新二维码。');
        const action = (await ask('输入 r 续办、c 取消本地任务、q 退出稍后续办', 'q')).toLowerCase();
        if (action === 'q') return 0;
        if (action === 'c') {
          cancelRequested = true;
          break;
        }
        if (action !== 'r') continue;
        job = await client.action(job.id, job.retryable ? 'retry' : 'refresh');
      } else {
        await (options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(1000);
        if (!interrupted.signal.aborted) job = await client.get(job.id);
      }
    }
  } catch {
    if (interrupted.signal.aborted && job) cancelRequested = true;
    else {
      prompt.write(starting
        ? WECOM_START_UNCONFIRMED
        : '本地向导未完成或管理授权已失效。重新运行 setup 查看已有任务；不会自动重新创建。');
      return interrupted.signal.aborted ? 0 : 2;
    }
  } finally {
    options.signal?.removeEventListener('abort', stop);
    if (!options.signal) process.off('SIGINT', stop);
    if (cancelRequested && client && job) {
      try {
        await client.action(job.id, 'cancel');
        prompt.write(LABELS.cancelled);
      } catch {
        prompt.write('取消未确认；任务可能仍在运行。重新进入 setup 或 Dashboard 查看并取消，平台机器人保留。');
      }
    }
  }
  return 0;
}
