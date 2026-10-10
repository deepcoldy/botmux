export const AUTH_REQUEST_USAGE = `用法: botmux auth request [--scope "<scope1 scope2,...>"] [--json]
      botmux auth wait --request-id <id> [--json]

为当前会话的本轮发起人生成飞书授权链接，返回 daemon 的 JSON 结果。
--scope 指定本次所需权限，以空格或逗号分隔；省略时使用默认授权。
由 Agent 通过 botmux send 将 authUrl 发给用户，再用 auth wait 等待授权就绪。
wait 每 2 秒查询一次，最多等待 5 分钟，返回 JSON。`;

export function parseAuthRequestArgs(args: string[]):
  | { help: true }
  | { help: false; command: 'request'; scopes: string[] }
  | { help: false; command: 'wait'; requestId: string } {
  if (args.length === 1 && args[0] === '--help'
    || args.length === 2 && ['request', 'wait'].includes(args[0]) && args[1] === '--help') {
    return { help: true };
  }
  const command = args[0];
  if (command !== 'request' && command !== 'wait') throw new Error('需要 auth request 或 auth wait 子命令');
  let scopes: string[] | undefined;
  let requestId: string | undefined;
  let json = false;
  for (let index = 1; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--json' && !json) {
      json = true;
    } else if (command === 'request' && argument === '--scope' && scopes === undefined) {
      const value = args[++index];
      if (!value || value.startsWith('-')) throw new Error('--scope 需要权限名称');
      scopes = [...new Set(value.split(/[\s,]+/).filter(Boolean))];
      if (scopes.length === 0) throw new Error('--scope 需要权限名称');
    } else if (command === 'wait' && argument === '--request-id' && requestId === undefined) {
      requestId = args[++index]?.trim();
      if (!requestId || requestId.startsWith('-')) throw new Error('--request-id 需要授权请求 ID');
    } else {
      throw new Error(`未知或重复参数: ${argument}`);
    }
  }
  if (command === 'wait') {
    if (!requestId) throw new Error('--request-id 需要授权请求 ID');
    return { help: false, command, requestId };
  }
  return { help: false, command, scopes: scopes ?? [] };
}
