#!/bin/bash
# 同步前置校验闸示例（event: prompt.submit, mode: sync）
#
# 与其它 hook 不同：daemon 会**等**这个脚本跑完，并按它的裁决决定这条消息
# 要不要提交给 CLI。裁决两种写法，stdout 的 JSON 优先于退出码：
#   1) stdout 打 {"decision":"allow"} 或 {"decision":"deny","reason":"..."}
#      —— 推荐，reason 会回给用户。
#   2) 什么都不打，只用退出码：0 = 放行，非 0 = 拒绝（stderr 当作原因）。
#
# 注意：内置权限模型（allowedUsers / grant / oncall / 额度）已经先跑过了。
# 这个 hook 只能在那之上**再收紧**，不能把内置闸拒掉的人放进来。
set -uo pipefail

payload="$(cat)"

# 没装 jq 就别拦——校验器自身的缺陷不该变成对用户的拒绝。
if ! command -v jq >/dev/null 2>&1; then
  echo '{"decision":"allow"}'
  exit 0
fi

sender="$(printf '%s' "$payload" | jq -r '.senderOpenId // empty')"
content="$(printf '%s' "$payload" | jq -r '.content // empty')"
chat="$(printf '%s' "$payload" | jq -r '.chatId // empty')"

# 例一：工作时间外只让值班同学发起
hour="$(date +%H)"
if [ "$hour" -ge 22 ] || [ "$hour" -lt 7 ]; then
  case "$sender" in
    ou_oncall_person_1|ou_oncall_person_2) ;;
    *)
      echo '{"decision":"deny","reason":"夜间(22:00-07:00)仅值班同学可发起，请白天再试"}'
      exit 0
      ;;
  esac
fi

# 例二：拦住明显危险的指令
if printf '%s' "$content" | grep -qiE 'rm +-rf +/|drop +database|:\(\)\{.*\};:'; then
  echo '{"decision":"deny","reason":"命中高危指令拦截规则"}'
  exit 0
fi

# 例三：把决定权交给公司内部权限服务（超时/不可达时按 onError 兜底，
# 默认 fail-open；要「服务挂了就一律拒绝」在 hooks.json 里写 onError:"deny"）
# verdict="$(curl -sS --max-time 3 -X POST https://perm.internal/check \
#   -H 'content-type: application/json' \
#   -d "{\"user\":\"$sender\",\"chat\":\"$chat\"}")" || exit 0
# [ "$(printf '%s' "$verdict" | jq -r .ok)" = "true" ] \
#   || { echo '{"decision":"deny","reason":"未通过内部权限服务校验"}'; exit 0; }

echo '{"decision":"allow"}'
