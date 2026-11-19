# FAQ / 排错

> 汇总自 README 和交流群里的高频问题，持续补充。更多坑见 [常见踩坑](/pitfalls)。

本页按主题分组：

| 想解决 | 看这里 |
|------|------|
| 机器人不回、别人用不了、结果没发出来 | [机器人不回复](#机器人不回复怎么排查) |
| 授权、@ 策略、拉群 | [权限与 @](#权限与-) |
| 重启、休眠、打断、目录、手机终端打不开 | [会话](#会话) |
| 登录报错、升级、字体、wrapper | [安装与环境](#安装与环境) |

## 机器人不回复怎么排查？

先按**症状**对号入座，不同症状根因不同：

| 症状 | 大概率原因 | 跳转 |
|------|-----------|------|
| 发消息**完全没反应**（连表情都没有） | 事件订阅、发版或长连接没通 | [A. 完全收不到消息](#a-完全收不到消息) |
| 只有**我（owner）**能触发，别人 @ 它弹授权卡或不回 | 别人没有对话权 | [B. 别人用不了](#b-别人用不了) |
| 群里**必须 @ 才回**，想免 @ | 群的 @ 策略 | [B. 别人用不了](#b-别人用不了) |
| 卡片显示「工作中」，终端里有输出，但**结果没发到飞书** | 模型没调用 `botmux send` | [C. 终端有输出但没发飞书](#c-终端有输出但没发飞书) |
| 会话**起不来**，首条消息报 `zsh: parse error` | 登录 shell 的启动文件切了 shell | [会话起不来](#会话起不来) |

### A. 完全收不到消息

按顺序检查（PersonalAgent 默认已配好，一般不用动）：

1. **事件订阅**：开放平台 → 事件与回调，订阅 `im.message.receive_v1` 和 `card.action.trigger`，方式选「长连接（WebSocket）」，并确认 daemon 在运行。
2. **机器人能力**：开放平台 → 应用功能 → 机器人，已开通。
3. **发版**：应用要创建并发布过版本（可用范围选「仅自己可见」会自动通过）。改了权限或事件后，**必须重新发版**才生效。
4. **长连接被占**：确认没有别的程序在用同一个应用的长连接。
5. 都确认后，在干净的 shell 里执行 `botmux restart`。

> 想让 agent 帮你查，见 [常见踩坑](/pitfalls) 里的「排查通用手法」：用 `botmux logs` 找到启动命令在本地复现，再用 Web 终端看真实报错。

### B. 别人用不了

botmux 的权限分两层：

- **对话权**：谁能跟它说话。
- **操作权**：谁能用 `/cd`、`/restart`、`/close` 这类管理命令、点卡片按钮。

默认只有 `allowedUsers` 名单里的人有对话权，别人 @ 它会被拦，并给 owner 发一张授权申请卡。**把 bot 拉进群不会自动授权任何人。**

| 想做 | 这样做 |
|------|------|
| 让整个群都能用 | 群里发 `@bot /grant`，或在 Dashboard「群组管理」里打开群的管理弹窗，点「整群授权」 |
| 只给某个人试用 | `@bot /grant @某人`，默认 3 条消息 / 1 小时，卡片上可改 |
| 一次给多个人授权 | Dashboard 群成员列表多选，批量授权（最多 50 人） |
| 群里不 @ 也能回 | 用 `/mention-mode` 改 @ 策略，见下文 [能不能免 @](#为什么群里必须--机器人能不能免-) |
| 值班答疑，每个工单一个群 | 用 [Oncall 模式](/oncall) |
| 拉黑某人 | Dashboard「Bot 配置」里的黑名单 `blockedUsers`，群聊和私聊都会拦，也不再弹申请卡 |

完整规则见 [权限与授权](/permissions)。

### C. 终端有输出但没发飞书

终端里打印出来的内容不等于发到了飞书。对需要显式发送的 CLI（Claude Code、Codex CLI、Antigravity、CoCo 等），模型必须执行 `botmux send`，群里才看得到：

- 每条都要带 `--mention-back`、`--mention`、`--no-mention` 三者之一，否则会报错、不发送。
- 只用 `echo` / `print`，或者忘了调 `botmux send`，就什么都不会发出。
- 多行内容用 heredoc 传，别写成 `"第一行\n第二行"`。

两种情况不需要模型自己发：

- **`codex-app`**（Codex App 协议）：最终回复由 botmux 自动转发。常规回复别再调 `botmux send`，否则会发两遍；只在中途推进度、发附件、跨 bot @ 时才用。
- **零注入模式**（`promptInjection: "none"`）：botmux 从 CLI 的对话记录里自动取最终回答发回飞书，见 [bots.json 配置](/bots-json)。

## 权限与 @

### 权限怎么分？谁能操作？

| 来源 | 给的权限 | 说明 |
|------|------|------|
| `allowedUsers` | 操作权 + 对话权 | owner 和管理员。能用管理命令、点按钮，改 `/card` `/cot` `/mention-mode` |
| `allowedChatGroups`（`@bot /grant`） | 对话权 | 整群，不限额、不过期 |
| Oncall 群 | 对话权 | 整群放行，并把群绑定到一个工作目录 |
| `chatGrants` / `globalGrants`（`/grant @某人`） | 对话权 | 按人，默认 3 条 / 1 小时 |
| `blockedUsers` | 全部拒绝 | 优先于上面所有放行规则 |

额度、有效期和申请卡的细节见 [权限与授权](/permissions)。

### 怎么让整个群都能用？

在群里发 `@bot /grant`（等同于 `/grant all`）：

- 这个群会加入 `allowedChatGroups`，群里所有人马上能对话，不限条数、不过期。
- 新成员自动生效，退群的人自动失去权限。
- 话题群按整个群生效，覆盖群里所有话题。
- 收回用 `@bot /revoke`。

Dashboard「群组管理」的群管理弹窗里也有「整群授权」按钮。注意它只给对话权，操作权仍然只在 `allowedUsers`。

### 只想让某人先试几条怎么配？

发 `@bot /grant @某人`，bot 会回一张授权卡，默认**每人 3 条 / 1 小时**。

- 想直接指定条数：`@bot /grant @某人 20`。
- 有效期可选 1 小时、8 小时、1 天、7 天、永久；额度留空表示不限。

### Oncall 和 `/grant` 有什么区别？

两者都只给对话权、都不限额。区别在于工作目录：

- `/oncall bind <目录>` 会把群绑定到一个目录，新话题跳过选仓库，直接开工。适合值班答疑。
- `/grant` 只放开对话，不绑目录。适合让群成员在已经选好仓库的话题里提问。

### 为什么群里必须 @ 机器人？能不能免 @？

默认策略是 `always`：普通群里只有明确 @ 它才回，避免多个 bot、多个人的群里抢答。群里发 `/mention-mode` 可以改：

| 模式 | 效果 |
|------|------|
| `always`（默认） | 必须 @ |
| `topic` | 在它自己的话题里回复免 @ |
| `never` | 全群免 @ |
| `ambient` | 免 @，但有人点名别人时它不插话 |

- 修改需要操作权，只能在普通群设置。
- 「1 个人 + 1 个 bot」的群默认免 @，这个例外可以用 `soloGroupMentionBypass` 关掉。
- 另有几种免 @ 的例外（消息监听器、免 @ 命令等），完整说明见 [@ 策略](/mention-mode)。

### 多个机器人怎么协作？

默认就支持，把要协作的 bot 拉进同一个群即可：

- 群里只有你和一个 bot：直接说话，不用 @。
- 多个 bot 或多个人的群：@ 你想交给的那个 bot。
- bot 之间接力（比如一个写、一个 review）：由 bot 互相 @ 触发，你只需把活交给第一个。

详见 [多机器人协作](/multi-bot)。

### 能禁止别人把 bot 拉进群吗？

不能在 botmux 里禁止。「谁能把机器人加进群」由飞书平台控制（应用可用范围、群机器人添加权限）。bot 这边能做的是：

- **拉进群也不自动开工**：Dashboard「Bot 配置 → 主动开工」里关掉「被拉进新群自动开工」（`autoStartOnGroupJoin`）。即使开着，也要求群里至少有一个 `allowedUsers` 里的人。
- **保持限制**：拉群不等于授权，没权限的人 @ 它会被拦，owner 收到申请卡。
- **不把 owner 拉进新群**：bot 被拉进新群时默认会把 owner 也拉进去（`autoInviteOwnerOnGroupAdd`）。告警或 oncall 平台批量建群、不想打扰 owner 时，可以在「Bot 配置 → 主动开工」关掉「自动拉管理员进群」，或发 `/botconfig set autoInviteOwnerOnGroupAdd off`，或改 `bots.json`。

### 把 bot 拉进新群，能看之前的聊天记录吗？

能。直接跟它说「看下历史聊天」，或者引用某条消息。前提是飞书应用的权限开全（包括读取群消息）。

### 普通群消息太多，能改成话题群吗？

能，但要群主或群管理员操作：群设置 → 群管理 → 群消息形式 → 选「话题消息」。机器人没法替你改群设置。

## 会话

### daemon 重启会丢上下文吗？

用默认的 tmux 后端就不会。CLI 一直跑在 tmux 里，`botmux restart` 之后下一条消息会自动接回原来的进程。

- 没装 tmux 时，botmux **不会**悄悄改用 pty，而是弹卡片让你先装 tmux。
- 只有显式配置 `BACKEND_TYPE=pty`（或单个 bot 配 `backendType: "pty"`）才会用 pty。pty 会话**扛不过 daemon 重启**，重启后要重新拉起。

### CLI 中途被重启，进行中的工作会怎样？

CLI 意外退出（崩溃、tmux server 掉线等）后，botmux 会用原来的上下文重新拉起它，并读旧进程留下的对话记录（transcript），检查有没有被打断的工作：

- **上一轮还没做完**，比如 review 做到一半；
- **后台任务跟着旧进程一起没了**，比如 Claude Code 的后台命令、Monitor、后台子代理。

如果有，恢复后的 CLI 会先收到一段说明（刚重启过、哪些后台任务中断了、请核对后继续），话题里也会出现一条提示。没有被打断的工作就什么都不发。

- 休眠后或 daemon 重启后冷启动时也会做同样的检查，说明会放在下一条消息前面交给 CLI。像 Pi 这样把首条消息放进启动参数的 CLI，只发话题提示。
- 只看对话记录，不读屏幕。目前支持 Claude Code，以及 Pi、Codex 等有结构化记录的 CLI（这些只判断回合是否做完）。

**没送进 CLI 的消息不会丢：**

- 首条消息作为启动参数交给 CLI、CLI 还没开始处理就退出了的，重启后会重新输入一次。
- daemon 重启时还排在队列里的消息，会由同一会话的下一个 worker 补投。
- 超过 24 小时的消息不再补投，改为在话题里说明没送达；补投途中又遇到重启、无法确认是否送达的，也会说明。
- 已经送进 CLI、CLI 也开始处理了的消息，重启后不会再输入一遍，而是用上面的说明提醒它接着做。只有重启后只能开新会话、旧上下文没了时，才会重新输入。

### 会话不关会一直占内存吗？

不会无限增长。每个 bot 有两道自动回收，被回收的会话叫「休眠」：CLI 进程退出、释放内存，但话题还在，下一条消息会从磁盘记录恢复上下文（通常几秒）。

| 规则 | 默认 | 在哪改 |
|------|------|------|
| 最大常驻会话数：超出后，最久没用的会话自动休眠 | 30 | Dashboard「Bot 配置 → 会话常驻上限」，或 `bots.json` 的 `maxLiveWorkers` |
| 空闲自动休眠：持续空闲超过 N 分钟就休眠 | 关闭 | 同一处的「空闲自动休眠（分钟）」，或 `bots.json` 的 `idleSuspendMinutes` |

- 正在出答案的会话不会被打断。
- 主回合已结束、但后台任务还在跑的会话（卡片显示「⏳ 主回合已结束 · 后台子任务运行中」）也不会被休眠，因为休眠会杀掉这些任务，恢复后也找不回来。
- 接管的外部终端（adopt）和不能恢复的会话不受影响。

想手动清理：

| 想做 | 命令 |
|------|------|
| 预览、再批量休眠 7 天没动的会话 | `botmux maintenance suspend-idle --older-than 7d --dry-run`，确认后把 `--dry-run` 换成 `--yes` |
| 关闭某个会话 | 话题里发 `/close`，或 `botmux delete <id>` |
| 关闭全部会话 | `botmux delete all`，或在 Dashboard 批量关闭 |
| 清理进程已退出的会话 | `botmux delete stopped` |

更多命令见 [CLI 命令](/cli-commands)。

### 会话在跑，能追问或打断吗？

默认不打断。新消息会排队，当前这一轮结束后再按顺序输入。

想马上停下来纠偏：

- 点卡片上的「⏹ 停止」，或在话题里发 `/stop`。它只中断当前这一轮，会话和上下文都保留。
- 卡片展开终端截图时，也可以点 `Esc`、`^C` 快捷键；Web 终端里同样可以直接按键。

停下后再发新的要求即可。

### 工作目录 / 仓库选错了？

- `workingDir` 会从这个目录**往下**找 git 仓库（最多 3 层），不会往上找。指向一个放很多仓库的目录（如 `~/projects`）会列出全部；指向单个仓库只列这个仓库（含它的 worktree）。
- 临时换目录：`/cd <路径>`。
- 想跳过选仓库卡片，直接进某个仓库：配 `defaultWorkingDir`（副作用见 [常见踩坑](/pitfalls)）。
- 别把 `workingDir` 设成 `~`，要扫的目录太多。
- `/repo` 的编号会变，指定仓库时用 `/repo <项目名>`。

### 会话起不来

症状：会话一直起不来，或者首条消息报 `zsh: parse error near '\n'`。

多半是登录 shell（`$SHELL`，常见是 bash）的启动文件里有「切到另一个 shell」的逻辑，最典型的是 `~/.bashrc` 里：

```bash
if [ -t 1 ]; then exec zsh; fi   # chsh 不生效时常见的写法
```

botmux 在 tmux 里用 `<$SHELL> -i -c '…启动 CLI'` 拉起会话。`-i` 会加载这个启动文件，`exec zsh` 把 shell 换掉了，真正启动 CLI 的命令没机会执行，于是首条消息被打进了一个空 shell。botmux 能识别这种情况，会发一张诊断卡，不再把消息打进空 shell。

两种修法，选一个：

- **配 `launchShell`（推荐）**：让这个 bot 直接用目标 shell 启动，绕开会跳转的启动文件。
  - 飞书里发 `/botconfig set launchShell zsh`；
  - 或在 Dashboard「Bot 配置 → 启动 Shell」里填；
  - 或在 `bots.json` 里加 `"launchShell": "zsh"`。

  PATH、nvm 等要写进所选 shell 自己的启动文件（如 `.zshrc`；fish 写 `~/.config/fish/config.fish`）。
- **改启动文件**：给跳转加个条件，只在手动开终端时才切：`[ -z "$BASH_EXECUTION_STRING" ] && [ -t 1 ] && exec zsh`（PATH、nvm 等放在这行前面）。

改完执行 `botmux restart`，再发一条消息。这个问题只影响要靠 shell 拉起的后端（`tmux` / `zellij` / `zmx`）；`pty` 后端直接启动 CLI，不受影响。

### 手机上驾驶舱或终端打不开？

电脑上正常、手机上驾驶舱空白或终端一直不出来时，在手机浏览器里打开 `<你的 Dashboard 地址>/workbench-doctor`。

- 这个诊断页不需要登录，会自动检查服务版本、登录状态（Cookie）、终端链接和实时连接。
- 跑完截一张图发给机器人或维护者，就能看出是网络、登录状态还是旧缓存的问题。
- 页面不显示任何 token 或密钥，截图可以放心发。

每项检查的含义见 [驾驶舱 · 手机打不开？用自助诊断页](/workbench#手机打不开用自助诊断页)。

## 安装与环境

### 怎么升级？

最稳的办法是**重跑安装命令**，不管当初怎么装的（npm / pnpm 全局安装也适用）：

```bash
curl -fsSL https://raw.githubusercontent.com/deepcoldy/botmux/master/install.sh | sh
```

- 它会把 `~/.botmux/bin/botmux` 原地换成新版本。下载后先在本机试跑，跑不起来就报错并**保留旧版本**。
- 可以重复执行，不会重复写 PATH，也不需要 Node。
- 装完**开一个新终端**再执行 `botmux restart`。安装脚本把 `~/.botmux/bin` 放到了 PATH 最前面，新终端才能保证用上新版本。
- 会话里的 `botmux` 命令始终跟 daemon 同版本，不用单独升级。

已经是 v3.18.0 及以上的版本，也可以直接用内置命令：

| 想做 | 命令 |
|------|------|
| 升到最新正式版 | `botmux update`（`botmux upgrade` 同义） |
| 切到预览版 | `botmux update canary`（也支持 `beta`、`rc`、`next`） |
| 装指定版本 | `botmux update 3.28.0` |

用 curl 装指定版本（回滚、锁版本也一样；版本号要带 `v`）：

```bash
curl -fsSL https://raw.githubusercontent.com/deepcoldy/botmux/master/install.sh | BOTMUX_VERSION=v3.18.8 sh
```

> ⚠️ `BOTMUX_VERSION` 要写在管道**右边的 `sh` 前面**。写成 `BOTMUX_VERSION=… curl … | sh` 时变量只传给了 curl，`sh` 收不到，会悄悄装成最新版。

#### 为什么 v3.18.0 之前的老版本只能用 curl 升？

v3.18.0 起，npm 包从「Node + 源码」改成了**平台二进制**，`node-pty` 也移出了依赖。老版本的 `botmux upgrade` 是交给 npm 去装的：npm 跨过这个版本时会删掉旧目录里的 `node-pty`，而旧 daemon 重启时还要加载它，结果报 `ERR_MODULE_NOT_FOUND`，所有 bot 都起不来（输出里可能已经显示「正在重启以应用更新」）。curl 直接放下新二进制，不依赖旧目录，所以是跨这个版本唯一稳妥的方式。不确定自己是哪种安装方式，就统一用 curl。

### 报 `Please run /login · API Error: 403` 怎么办？

先分清是哪一边要登录：

- **飞书授权被拒**（用户身份调飞书 API 失败）：在话题里发 `/login`，点授权链接，然后把浏览器跳转后的地址（`http://127.0.0.1:9768/callback?...`，页面打不开是正常的）复制回话题。
- **模型网关返回 403**：跟飞书无关，多半是环境变量或网关 token 的问题。常见原因是 bash 用户把变量写在 `.bash_profile` 里，`bash -i` 读不到（见 [常见踩坑](/pitfalls)）。

**macOS 上 claude 反复要求 `/login`**

claude 的登录 token 存在两个地方，两边不一致是 macOS 上报 `Please run /login` 的主要原因：

| 存储位置 | 谁会用 |
|------|------|
| 钥匙串条目 `Claude Code-credentials` | 在图形界面里跑的 claude，以及 botmux 默认（非隔离）配置 |
| 文件 `~/.claude/.credentials.json` | 通过 SSH 跑 `/login` 时只能写到这里 |

只要钥匙串条目存在，claude 就只读钥匙串，不读文件。所以会出现「SSH 里 `/login` 成功了（只写进了文件），图形界面和 bot 却还在用钥匙串里的旧 token」。再加上 claude 刷新 token 时会轮换，谁先刷新就把另一边的作废，于是大家一起掉登录。

建议统一只用文件这一份：

1. 不要在图形界面里用 claude code，它会往钥匙串写 token。
2. 统一通过 SSH 跑 `/login` 更新 token。
3. 钥匙串里如果已经有旧条目，删掉它。

### `botmux history` 报 400，或飞书网关报 411？

- **400**：通常是飞书应用缺权限（如 `im:message.group_msg`），把权限清单全部开通。
- **411**：旧版本发 GET 请求时带了空 body，被飞书网关拒绝。升级到新版本即可。

### 支持 Lark 国际版（larksuite.com）吗？

支持。飞书（feishu.cn）和 Lark 国际版（larksuite.com）都能用：

- 扫码创建应用时会**自动识别**是国内还是国际版；手动粘贴 AppID / Secret 时会让你选一次。
- 每个 bot 按自己的版本连对应的域名。同一台机器可以同时跑飞书和 Lark 的 bot，登录凭证互不干扰。

### 能用 ccr、自定义网关或 wrapper 启动 CLI 吗？

能。写一个把参数（`"$@"`）原样传下去的 wrapper 脚本，在 `botmux setup` 编辑机器人时，把 `cliPathOverride` 设成这个脚本的路径。

### 截图里中文 / emoji 显示成方块？

缺中文字体。Debian / Ubuntu 上 daemon 会尝试自动安装 `fonts-noto-cjk` 和 `fonts-noto-color-emoji`（需要 root 或免密 sudo）；其它 Linux 请手动装 Noto CJK 和 Noto Color Emoji，然后重启 daemon。

### 原来 `cliId: "gemini"` 的 bot 起不来了？

Gemini CLI 已下线，`gemini` 适配器已移除。这个 bot 会拒绝启动并提示改用 Antigravity，其它 bot 照常运行。迁移步骤：

1. 装好 `agy`，用 Google 账号登录（或在 `~/.gemini/antigravity-cli/settings.json` 里设 `modelProvider: "gemini"`，并提供 `GEMINI_API_KEY`）。
2. 把 `cliId` 改成 `"antigravity"`（改 `bots.json` 或用 `botmux setup`）。
3. 执行 `botmux restart`。

原来的 `cliPathOverride` / `wrapperCli`（如 `ttadk gemini`）、Gemini 的 `model` 名和 `GEMINI_CLI_HOME` 不会沿用。详见 [CLI 适配器](/adapters)。

### CoCo 忙的时候发的消息丢了？

升级到 **CoCo 0.120.32 或更高版本**。忙时发的消息要进 CoCo 自己的队列，依赖这个版本的行为。

### Windows 能用吗？

不支持原生 Windows：daemon 只能跑在类 Unix 系统上，也没有 Windows 版的安装包（curl 和 npm 都装不上）。请在 **WSL2** 里安装，WSL2 里按 Linux 的方式装即可。
