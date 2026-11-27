import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { dirname, join, resolve } from 'node:path';
import { statSync } from 'node:fs';
import { defaultWecomConfigFile, registerWecomConfig } from '../../im/wecom/config/discovery.js';
import { shellQuote } from '../../core/cli-launch-mode.js';
import { createHash } from 'node:crypto';
import { parseWecomConfig, readWecomConfigSnapshot, readWecomCredentialFile, commitWecomConfiguration, type WecomConfig } from '../../im/wecom/config/config.js';

export interface WecomPrompter {
  ask(question: string, options?: { hidden?: boolean; defaultValue?: string }): Promise<string | null>;
  write(message: string): void;
}
/** A dedicated output stream prevents readline from echoing any secret bytes.
 * terminal=true disables the terminal driver's own echo. Ctrl-C/EOF cancel. */
export function createWecomPrompter(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): WecomPrompter {
  return {
    write: message => {
      output.write(`${message}\n`);
    },
    ask(question, options = {}) {
      return new Promise(resolveAnswer => {
        let settled = false;
        const writer = new Writable({
          write(chunk, _encoding, done) {
            if (!options.hidden) {
              output.write(chunk);
            }
            done();
          },
        });
        const rl = createInterface({ input, output: writer, terminal: true });
        const finish = (answer: string | null) => {
          if (settled) return;
          settled = true;
          rl.close();
          writer.end();
          if (options.hidden) output.write('\n');
          resolveAnswer(answer);
        };
        rl.on('SIGINT', () => finish(null));
        rl.on('close', () => finish(null));
        const suffix = options.defaultValue ? ` [${options.defaultValue}]` : '';
        const prompt = `${question}${suffix}: `;
        if (options.hidden) output.write(prompt);
        rl.question(options.hidden ? '' : prompt, answer => finish(answer || options.defaultValue || ''));
      });
    },
  };
}
class SetupCancelled extends Error {}
class SetupInputError extends Error {}
export const WECOM_SETUP_HELP = `用法: botmux setup --platform wecom --manual [--config <文件>]
交互式配置已有企业微信智能机器人，secret 输入不回显；不会创建机器人或建立连接。
非交互用法:
  botmux setup --platform wecom --bot-id <ID> --secret-file <0600文件> --allow-user <真实userid>
    --cli <CLI> --backend <pty|tmux> --working-dir <目录> --core-port <端口> --yes
--allow-user 可重复；禁止通配符。旧外部core配置默认保留，--managed-core 显式迁移至托管core（开启独立新会话）。也可用 --secret-env <变量名> 代替 --secret-file，保存后不再需要 export。
运行: botmux wecom（读取默认配置，自动启动专用本机 core，再连接机器人）。
编辑重跑同一向导；最终确认前取消不会改动已有配置。`;

export async function configureWecom(options: {
  file: string;
  prompt: WecomPrompter;
  values?: Partial<{
    botId: string;
    secret: string;
    allowedUsers: string[];
    cli: string;
    backend: string;
    workingDirectory: string;
    port: string;
  }>;
  nonInteractive?: boolean;
  confirm?: boolean;
  manageCore?: boolean;
  validateCli?: (cli: string) => Promise<boolean>;
  commit?: typeof commitWecomConfiguration;
}): Promise<'saved' | 'cancelled'> {
  const { prompt, file } = options;
  const previous = readWecomConfigSnapshot(file);
  const existing = previous === undefined ? undefined : parseWecomConfig(JSON.parse(previous));
  const values = options.values ?? {};
  const ask = async (name: string, supplied: string | undefined, fallback?: string, hidden = false): Promise<string> => {
    if (supplied !== undefined) return supplied.trim();
    if (options.nonInteractive) {
      throw new SetupInputError(`非交互配置缺少必要参数（${name}），请运行 --help 查看完整用法`);
    }
    const answer = await prompt.ask(name, { hidden, defaultValue: fallback });
    if (answer === null) throw new SetupCancelled();
    return answer.trim();
  };
  try {
    prompt.write('企业微信智能机器人配置。请在企微管理端创建 API 长连接机器人；本向导不会创建或连接机器人。');
    const botId = await ask('BotID', values.botId, existing?.botId);
    if (!botId) throw new SetupInputError('BotID 不能为空');
    const keepCredential = existing?.botId === botId;
    const secret = await ask(keepCredential ? 'Secret（不回显，留空保留原凭据）' : 'Secret（不回显）', values.secret, undefined, true);
    if (!secret && !keepCredential) throw new SetupInputError('首次配置或更换 BotID 必须提供 Secret');
    prompt.write('允许用户必须填写真实企业微信 userid（通讯录账号），不是姓名、飞书 open_id 或机器人 BotID。不会自动认领首个发消息的人。');
    const userText = await ask('允许的 userid（逗号分隔）', values.allowedUsers?.join(','), existing?.allowedUsers.join(','));
    const allowedUsers = [...new Set(userText.split(',').map(value => value.trim()).filter(Boolean))];
    if (!allowedUsers.length || allowedUsers.some(value => value === '*' || /^ou_|^on_/.test(value))) {
      throw new SetupInputError('请显式填写真实企业微信 userid；不支持通配符或飞书身份');
    }
    let manageCore = options.manageCore ?? (!existing || Boolean(existing.managedCore));
    if (existing && !existing.managedCore && options.manageCore === undefined && !options.nonInteractive) {
      prompt.write('现有配置使用外部 core。迁移托管 core 会开启独立新会话，旧状态仍保留。');
      manageCore = (await ask('改为自动启动专用 core？输入 yes 迁移；留空保留外部 core', undefined)).toLowerCase() === 'yes';
    }
    let managedCore = existing?.managedCore;
    let coreUrl = existing?.coreUrl;
    if (manageCore) {
      const cli = await ask('CLI（如 codex、claude-code、pi）', values.cli, existing?.managedCore?.cli ?? 'codex');
      const validateCli = options.validateCli
        ?? (async value => (await import('../../adapters/cli/registry.js')).ALL_CLI_IDS.includes(value as never));
      if (!await validateCli(cli)) throw new SetupInputError('未知 CLI，请填写 botmux 已支持的 CLI 标识');
      const backend = await ask('后端（pty 或 tmux）', values.backend, existing?.managedCore?.backend ?? 'pty');
      if (backend !== 'pty' && backend !== 'tmux') throw new SetupInputError('后端必须为 pty 或 tmux');
      const workingDirectory = resolve(await ask('项目工作目录', values.workingDirectory, existing?.managedCore?.workingDirectory ?? process.cwd()));
      if (!statSync(workingDirectory).isDirectory()) throw new SetupInputError('工作目录不存在或不是目录');
      const rawPort = await ask('专用本机 core 端口', values.port, String(existing?.managedCore?.port ?? 19123));
      const port = Number(rawPort);
      if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new SetupInputError('端口必须为 1–65535 的整数');
      }
      const identity = createHash('sha256').update(botId).digest('hex');
      const coreState = existing?.botId === botId && existing.managedCore
        ? existing.managedCore.stateDir
        : join(dirname(file), identity, 'core');
      managedCore = { cli, backend, workingDirectory, port, stateDir: coreState, botId: `local_wecom_${identity.slice(0, 16)}` };
      coreUrl = `http://127.0.0.1:${port}`;
    }
    const config: WecomConfig = {
      botId, allowedUsers, coreUrl: coreUrl!,
      ...(existing?.botId === botId && existing.stateDir ? { stateDir: existing.stateDir } : {}),
      ...(secret
        ? { secretFile: '/pending-credential-generation' }
        : existing?.secretFile ? { secretFile: existing.secretFile } : { secretEnv: existing!.secretEnv }),
      ...(managedCore ? { managedCore } : {}),
    };
    if (existing && !existing.managedCore && managedCore) {
      const identity = createHash('sha256').update(botId).digest('hex');
      config.stateDir = join(dirname(file), identity, 'managed-bridge');
    }
    parseWecomConfig(config);
    prompt.write(`将保存 BotID 与 ${allowedUsers.length} 位允许用户；${managedCore ? '自动启动专用本机 core' : '保留现有外部 core'}，Secret 不显示。`);
    if (!options.confirm) {
      const answer = await ask('保存配置？输入 yes 确认，其它输入取消', undefined);
      if (answer.toLowerCase() !== 'yes') return 'cancelled';
    }
    await (options.commit ?? commitWecomConfiguration)({ file, previous, config, ...(secret ? { newSecret: secret } : {}) });
    try {
      await registerWecomConfig(file);
    } catch {
      prompt.write('配置已保存，但Dashboard索引更新失败；可继续使用上面的配置路径启动，不会回滚凭据。');
    }
    prompt.write('配置已保存。运行中的连接多数设置无需重启即生效；BotID、Secret、core 端口等连接身份类设置需重启连接后生效。此向导没有建立机器人连接。');
    prompt.write(file === defaultWecomConfigFile() ? '启动：botmux wecom' : `启动：botmux wecom --config ${shellQuote(file)}`);
    return 'saved';
  } catch (error) {
    if (error instanceof SetupCancelled) return 'cancelled';
    throw error;
  }
}

export async function runWecomSetup(args: string[], options: { tty?: boolean; prompt?: WecomPrompter } = {}): Promise<number> {
  const prompt = options.prompt ?? createWecomPrompter();
  if (args.some(value => ['--help', '-h', 'help'].includes(value))) {
    prompt.write(WECOM_SETUP_HELP);
    return 0;
  }
  try {
    const flags = new Map<string, string[]>();
    let confirm = false;
    let manageCore: boolean | undefined;
    for (let index = 0; index < args.length; index++) {
      const flag = args[index];
      if (flag === '--managed-core') {
        manageCore = true;
        continue;
      }
      if (flag === '--yes') {
        confirm = true;
        continue;
      }
      if (!['--config', '--bot-id', '--secret-file', '--secret-env', '--allow-user', '--cli', '--backend', '--working-dir', '--core-port'].includes(flag)
        || !args[index + 1] || args[index + 1].startsWith('--')) {
        throw new SetupInputError('未知或缺失参数，请运行 --help');
      }
      if (flags.has(flag) && flag !== '--allow-user') throw new SetupInputError('参数重复，请运行 --help');
      flags.set(flag, [...(flags.get(flag) ?? []), args[++index]]);
    }
    const get = (flag: string) => flags.get(flag)?.[0];
    if (get('--secret-file') && get('--secret-env')) throw new SetupInputError('只能指定一种 Secret 来源');
    const secret = get('--secret-file') ? readWecomCredentialFile(resolve(get('--secret-file')!))
      : get('--secret-env') ? process.env[get('--secret-env')!] : undefined;
    if (get('--secret-env') && !secret) throw new SetupInputError('指定的凭据环境变量未设置');
    const result = await configureWecom({
      file: resolve(get('--config') ?? defaultWecomConfigFile()), prompt,
      nonInteractive: !(options.tty ?? (process.stdin.isTTY && process.stdout.isTTY)), confirm, manageCore,
      values: {
        botId: get('--bot-id'),
        secret,
        allowedUsers: flags.get('--allow-user'),
        cli: get('--cli'),
        backend: get('--backend'),
        workingDirectory: get('--working-dir'),
        port: get('--core-port'),
      },
    });
    if (result === 'cancelled') prompt.write('已取消，原配置与凭据保持不变。');
    return 0;
  } catch (error) {
    if (error instanceof SetupInputError) prompt.write(error.message);
    // User input, credential file contents, and exception strings are never logged.
    prompt.write('企业微信配置未保存或保存未确认。请检查必要参数、真实 userid、工作目录和文件权限；可运行 --help 查看用法。原有凭据不会删除。');
    return 2;
  }
}
