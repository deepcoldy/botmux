/**
 * 文件输出契约：PTY 后端拿不到 ACP 那种结构化的「最终助手消息」，从终端屏幕刮
 * 回复既有损又不可靠（滚屏、TUI 重绘、状态栏）。所以每一轮在 prompt 尾部附加
 * 一段约定，让 CLI 把最终回复完整写进 stateDir 下的独立文件；worker 结算时以
 * 文件为第一真相源，屏幕只作 fallback 与证据。
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export interface OutputContract {
  /** CLI 应写入最终回复的绝对路径。 */
  readonly path: string;
  /** 追加到 prompt 尾部的约定文本。 */
  readonly promptSuffix: string;
}

const CONTRACT_TAG = 'botmux-output-contract';

/** turnId 可能含 `/` `:` `#` 等字符（flow 的 `scopePath#seq` 形态），落盘前归一化。 */
function fileSafeTurnId(turnId: string): string {
  const safe = turnId.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return safe.length > 0 ? safe.slice(0, 120) : 'turn';
}

/**
 * @param fileName 显式文件名（纯 basename，不含目录）。flow 要求契约文件名唯一到每次
 *   提交并记录在 journal（§8），由 runner 指定；不传则按 turnId 派生。
 */
export function createOutputContract(stateDir: string, turnId: string, fileName?: string): OutputContract {
  if (fileName !== undefined && (fileName !== basename(fileName) || fileName.length === 0)) {
    throw new Error(`output contract file name must be a bare basename, got ${JSON.stringify(fileName)}`);
  }
  const path = join(stateDir, fileName ?? `turn-${fileSafeTurnId(turnId)}.response.md`);
  const promptSuffix = [
    '',
    '',
    `<${CONTRACT_TAG}>`,
    'When your work for this turn is complete, write your COMPLETE final response into this file (overwrite it; response body only, no commentary about the file itself):',
    path,
    'The orchestrator reads your result ONLY from that file. Text printed to the terminal is not read.',
    `</${CONTRACT_TAG}>`,
  ].join('\n');
  return { path, promptSuffix };
}

export function appendOutputContract(prompt: string, contract: OutputContract): string {
  return prompt + contract.promptSuffix;
}

/**
 * 读取契约文件。缺失或空白一律返回 null——空文件与「没写」对上游是同一件事
 * （都需要走屏幕 fallback 并标记低置信度），不要把空串当成合法回复。
 */
export function readOutputContract(contract: OutputContract): string | null {
  if (!existsSync(contract.path)) return null;
  let raw: string;
  try {
    raw = readFileSync(contract.path, 'utf8');
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}
