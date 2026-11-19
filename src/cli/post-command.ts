import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fetchDaemonIpc } from '../core/daemon-ipc-auth.js';
import { HOST_POST_MAX_TEXT_BYTES, HOST_POST_PATH, hostPostRequest } from '../core/host-post-request.js';
import { findOnlineDaemon, parseDaemonIpcPort } from '../utils/daemon-discovery.js';

const USAGE = `botmux post — 从宿主 shell 以指定 Bot 的身份发送飞书文本

用法
  botmux post --bot <cli_...> --chat-id <oc_...> [--into <om_...>] --text <正文>
  botmux post --bot <cli_...> --user-open-id <ou_...> --text <正文>

--into 是目标群中话题的根消息 ID。私聊 open_id 必须属于发送 Bot 的应用。
--bot 只接受 cli_ 开头的飞书 App ID。
自动化可用 --request-id 指定稳定的事件 ID（8–64 个字母、数字、下划线或连字符），省略则自动生成。
超时或连接中断返回 outcome_unknown。retryable 为 true 时，用原 ID、目的地和正文在首次尝试后 50 分钟内重试。
retryable 为 false 时请检查错误并核对投递结果。
用 --text-file <路径> 从 UTF-8 文件读正文，--text-file - 从 stdin 读。
正文不能全为空白，最多 ${HOST_POST_MAX_TEXT_BYTES} 字节。成功后在 stdout 输出 JSON 回执。`;

function fail(code: 1 | 2, error: string, extra?: Record<string, unknown>): number {
  console.error(JSON.stringify({ ok: false, error, ...extra }));
  return code;
}

export async function cmdPost(args: string[]): Promise<number> {
  let request;
  try {
    const { values, tokens } = parseArgs({
      args,
      tokens: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        bot: { type: 'string' },
        'request-id': { type: 'string' },
        'chat-id': { type: 'string' },
        into: { type: 'string' },
        'user-open-id': { type: 'string' },
        text: { type: 'string' },
        'text-file': { type: 'string' },
      },
    });
    const seen = new Set<string>();
    for (const token of tokens) {
      if (token.kind !== 'option') continue;
      if (seen.has(token.name)) throw new Error(`--${token.name} 只能指定一次`);
      seen.add(token.name);
    }
    if (values.help) {
      console.log(USAGE);
      return 0;
    }
    const textFile = values['text-file'];
    if ((values.text === undefined) === (textFile === undefined)) {
      throw new Error('请指定 --text 或 --text-file');
    }
    const parsed = hostPostRequest.safeParse({
      larkAppId: values.bot,
      requestId: values['request-id'] ?? randomUUID(),
      chatId: values['chat-id'],
      rootMessageId: values.into,
      userOpenId: values['user-open-id'],
      text: textFile === undefined ? values.text : readFileSync(textFile === '-' ? 0 : textFile, 'utf8'),
    });
    if (!parsed.success) throw new Error('Bot App ID、目的地或正文无效，请查看 botmux post --help');
    request = parsed.data;
  } catch (error) {
    return fail(2, 'invalid_arguments', { detail: error instanceof Error ? error.message : String(error) });
  }

  const daemon = findOnlineDaemon(request.larkAppId);
  const port = parseDaemonIpcPort(daemon?.ipcPort);
  const { requestId } = request;
  if (!port) return fail(1, 'daemon_offline', { larkAppId: request.larkAppId, requestId, retryable: true });

  try {
    const response = await fetchDaemonIpc(port, HOST_POST_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(60_000),
    });
    const receipt = await response.json().catch(() => null);
    if (!response.ok && typeof receipt?.error === 'string') {
      const error = response.status === 404 && receipt.error === 'not_found' ? 'daemon_post_unsupported' : receipt.error;
      return fail(1, error, {
        requestId, status: response.status, retryable: receipt.retryable === true,
        ...(typeof receipt.providerCode === 'number' ? { providerCode: receipt.providerCode } : {}),
      });
    }
    if (!response.ok || receipt?.ok !== true || receipt.larkAppId !== request.larkAppId
      || receipt.requestId !== requestId || receipt.chatId !== request.chatId
      || receipt.rootMessageId !== request.rootMessageId || receipt.userOpenId !== request.userOpenId
      || typeof receipt.messageId !== 'string' || !receipt.messageId) {
      return fail(1, 'outcome_unknown', { requestId, retryable: true, status: response.status });
    }
    console.log(JSON.stringify(receipt));
    return 0;
  } catch (error) {
    return fail(1, 'outcome_unknown', { requestId, retryable: true, detail: error instanceof Error ? error.message : String(error) });
  }
}
