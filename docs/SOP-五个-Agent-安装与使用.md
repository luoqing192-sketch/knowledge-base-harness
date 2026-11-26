# 五个 Agent 的安装与使用 SOP

适用版本：`knowledge-base-harness@0.1.0`　验证日期：2026-11-26

本文覆盖 Claude Code、Codex CLI、Qoder、WorkBuddy、Trae 五个 harness 的完整安装、验证与日常使用流程，末尾附 dsh 的差异说明。

> 文中所有命令、输出片段均来自本机实跑。标注「已实测」的条目经过真实环境验证；标注「约定」的条目是依照各 harness 的公开约定生成，首次使用请按第 3 节的验证步骤确认一次。

---

## 0. 前置条件

| 项 | 要求 | 检查命令 |
|---|---|---|
| Node.js | ≥ 18.18（本机 v24.18.0） | `node -v` |
| Git | 任意版本 | `git --version` |
| 磁盘 | 源码约 1 MB，`npm install` 后加上 `node_modules` 约 55 MB | — |

被管理的知识库本身不依赖任何运行时——它就是一堆 markdown 文件。

---

## 1. 一次性准备（所有 agent 通用）

### 1.1 克隆并构建

```bash
git clone https://github.com/luoqing192-sketch/knowledge-base-harness.git
cd knowledge-base-harness
npm install       # prepare 钩子会自动构建 dist/
```

如果 `dist/` 没有生成（`npm` 版本太旧不跑 prepare），手动补一次：

```bash
npm run build
```

### 1.2 把 `kb` 挂到 PATH

```bash
npm link
kb help           # 能打印用法就说明挂上了
```

> 不 link 也能用：后面所有 `kb xxx` 都可以替换成 `node <仓库绝对路径>/dist/cli.js xxx`。hook 里写的是绝对路径，与 PATH 无关。

### 1.3 决定知识库放在哪

有两种用法，**先选一种，后面所有 agent 都按同一选择安装**：

| 用法 | 命令 | 适合 |
|---|---|---|
| **项目级**（推荐起步） | 在项目根目录 `kb init` | 每个项目一份知识库，跟着仓库提交、可 review、可回滚 |
| **用户级** | 在任意目录 `kb init`，再 `kb install --global` | 所有项目共用一份知识库，跨项目经验累积 |

### 1.4 初始化

```bash
cd D:\your-project        # 项目级用法在此执行；用户级用法可任选目录
kb init
```

`kb` 从当前目录向上找 `.git` 来定位项目根；找不到就退化成当前目录本身。所以**不是 git 仓库也能用**，只是知识库不会跟着版本走——想 review、想回滚就先 `git init`。

实跑输出：

```
Initialised knowledge base
  wiki:   D:\your-project\knowledge
  data:   D:\your-project\.kb
  config: D:\your-project\kb.config.json
```

生成的目录：

```
<project>/
├── knowledge/            ← 知识库（只允许 .md）
│   ├── index.md
│   └── memory/
│       ├── index.md
│       ├── MEMORY.md     ← 每轮全量注入，4000 字符硬上限
│       └── USER.md       ← 每轮全量注入，2000 字符硬上限
├── .kb/                  ← 运行时：会话、索引、统计、锁、隔离区
└── kb.config.json        ← 配置
```

`kb init` 是幂等的，重复执行不会覆盖已有内容。

### 1.5 加入 .gitignore

```gitignore
.kb/                # 运行时状态，不进版本库
kb.config.local.json
```

`knowledge/` **应该提交**——它就是知识本身。

---

## 2. 五个 Agent 的安装

一条命令装全部：

```bash
kb install claude-code codex qoder workbuddy trae
```

实跑输出（六个 harness，共 19 个 artifact）：

```
Claude Code (claude-code)
  + .claude\settings.json (created)
      Adds SessionStart / UserPromptSubmit / PostToolUse / PreCompact / Stop / SessionEnd hooks.
  + .mcp.json (created)
      Registers the kb MCP server for in-session recall/notes.

OpenAI Codex CLI (codex)
  config scope: global only (a project-level config file is ignored by this harness)
  + home\.codex\config.toml (created)
  + AGENTS.md (created)

Qoder (qoder)
  + .qoder\settings.json (created)
      Adds SessionStart / UserPromptSubmit / PostToolUse / PreCompact / Stop / SessionEnd hooks.
  = .mcp.json (already current)
  + .qoder\rules\knowledge-base.md (created)

WorkBuddy (workbuddy) — convention paths, verify before relying on it
  + .workbuddy\knowledge-base-harness.hooks.json (created)
  = .mcp.json (already current)
  + WORKBUDDY.md (created)

…
```

`+` = 新建或更新，`=` = 内容已是最新（幂等，重复执行不会叠加）。

**五个 agent 的能力差异（决定你的使用体感）**

| harness | 自动注入召回 | 按文件路径推送 | 自动沉淀 | 需要你做什么 |
|---|---|---|---|---|
| Claude Code | ✅ `UserPromptSubmit` 钩子 | ✅ `PostToolUse` 钩子 | ✅ `PreCompact` / `Stop` / `SessionEnd` | 什么都不用做 |
| Qoder | ✅ `UserPromptSubmit` 钩子 | ✅ `PostToolUse` 钩子 | ✅ `PreCompact` / `Stop` / `SessionEnd` | 首次确认 `/memory` 与 `/hooks` 能看到条目 |
| Codex CLI | ⚠️ agent 自己调 `kb_query` | ⚠️ 同上 | ✅ 回合结束 `notify` | 在 `AGENTS.md` 指令下它会主动查 |
| WorkBuddy | ⚠️ 规则文件驱动 agent 调 `kb_query` | ⚠️ 同上 | ⚠️ 靠 agent 调 `kb_note` | 首次确认 `WORKBUDDY.md` 被读 |
| Trae | ⚠️ 同上 | ⚠️ 同上 | ⚠️ 同上 | 首次确认 `.trae/rules/` 被加载 |
| dsh | ✅ shell 钩子 `kb-prompt.sh` | ⚠️ 无文件钩子 | ✅ `kb-stop.sh` / `kb-end.sh` | 首次手工跑一遍 `kb-prompt.sh` |

**「自动注入」与「靠 agent 自觉」的区别很重要**：前者是 harness 把文本塞进上下文，agent 一定看得到；后者是规则文件要求 agent 自己发起工具调用，模型可能忽略。所以 WorkBuddy / Trae 值得在第一次用完后回头 `kb recall "刚才的问题"` 确认召回真的发生了。

也可以逐个装。下面每节的「装了什么」都对应实际生成的文件。

### 2.1 Claude Code　✅ 已按官方文档核对（本机 v2.1.332）

```bash
kb install claude-code
```

**装了什么**

| 文件 | 内容 |
|---|---|
| `.claude/settings.json` | 六个钩子（见下） |
| `.mcp.json` | kb MCP server |

六个钩子（实跑生成原文，路径已缩略）：

```json
{
  "hooks": {
    "SessionStart":     [{ "matcher": "startup|resume|clear|compact",      "hooks": [{"type":"command","command":"…cli.js hook claude-code start","timeout":30}] }],
    "UserPromptSubmit": [{                                                  "hooks": [{"type":"command","command":"…cli.js hook claude-code prompt","timeout":30}] }],
    "PostToolUse":      [{ "matcher": "Read|Write|Edit|MultiEdit",          "hooks": [{"type":"command","command":"…cli.js hook claude-code file","timeout":30}] }],
    "PreCompact":       [{                                                  "hooks": [{"type":"command","command":"…cli.js hook claude-code compact","timeout":30}] }],
    "Stop":             [{                                                  "hooks": [{"type":"command","command":"…cli.js hook claude-code stop","timeout":30}] }],
    "SessionEnd":       [{ "matcher": "clear|logout|prompt_input_exit|other","hooks": [{"type":"command","command":"…cli.js hook claude-code end","timeout":30}] }]
  }
}
```

**工作原理**

| 事件 | 这里做什么 | 输出到对话？ |
|---|---|---|
| `SessionStart` | 开会话 | ✅（记忆 + 召回） |
| `UserPromptSubmit` | 三层注入：常驻记忆 / 片段 / 标题清单 | ✅ |
| `PostToolUse`（`Read\|Write\|Edit`） | 按 `paths:` 推送该文件相关的知识页 | ✅（`PostToolUse` 的 `additionalContext`） |
| `PreCompact` | **只落盘不输出**——把本会话已声明的结论写进 wiki，避免压缩丢证据 | ❌（stdout 会变成摘要指令） |
| `Stop` / `SessionEnd` | 蒸馏 + 沉淀 + 演化 + 体检 | ❌ |

> `PreCompact` 那条最容易踩坑：Claude Code 的 `PreCompact` stdout 是「给压缩摘要的指令」，不是注入的上下文。所以 `kb hook … compact` 分支一律静默，只写盘。

**验证**

```bash
# 1. 钩子已注册
claude
/hooks            # 应看到 4 条 knowledge-base-harness 的钩子

# 2. 注入真的生效（不启动 Claude Code 也能验）
kb note "确认了：本地启动 WES 必须设置 MOCK_ESS=on (commit 4e871a50bb)"
kb memory memory --add "本地 WES 固定用 9102，ESS 用 9000"

# payload 用 node 生成，避免 Windows 反斜杠被 shell 吞掉
node -e "require('fs').writeFileSync('p.json', JSON.stringify({hook_event_name:'UserPromptSubmit',cwd:process.cwd(),prompt:'本地 WES 起不来'}))"
kb hook claude-code prompt < p.json
```

期望输出（实跑）：

```json
{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"## Long-term memory (always injected)\n### Agent memory (219/4000 chars)\n- 本地 WES 固定用 9102，ESS 用 9000\n\n## Knowledge base hits (from knowledge-base-harness)\n\n1. 本地启动 WES 必须设置 MOCK_ESS=on — `wes-mock-ess-on.md`\n   - 确认了：本地启动 WES 必须设置 MOCK_ESS=on (commit 4e871a50bb)\n\nRead the full page with the kb tool before acting if a hit looks relevant."}}
```

把 JSON 里的 `\n` 还原后，`additionalContext` 的内容是：

```
## Long-term memory (always injected)
### Agent memory (219/4000 chars)
- 本地 WES 固定用 9102，ESS 用 9000

## Knowledge base hits (from knowledge-base-harness)

1. 本地启动 WES 必须设置 MOCK_ESS=on — `wes-mock-ess-on.md`
   - 确认了：本地启动 WES 必须设置 MOCK_ESS=on (commit 4e871a50bb)

Read the full page with the kb tool before acting if a hit looks relevant.
```

看到 `Long-term memory` 和 `Knowledge base hits` 两段就说明整条链路通了。

**验按文件路径推送**（`PostToolUse`）：页面的 front matter 写 `paths: ["src/api/**"]`，agent 读/写 `src/api/handler.ts` 时不用在提问里提"api"也会收到提示。

```bash
node -e "require('fs').writeFileSync('f.json', JSON.stringify({hook_event_name:'PostToolUse',cwd:process.cwd(),tool_name:'Read',tool_input:{file_path:'src/api/handler.ts'}}))"
kb hook claude-code file < f.json
```

实跑输出：

```json
{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"## Knowledge pages that apply to `api/handler.ts`\n\n- `api/handler.md` — API handler 约定: 统一错误结构，请求体必须过共享 schema\n\nRead one with the kb tool if it looks relevant; do not assume the summary is complete."}}
```

同一会话内同一页只提醒一次——第二次读 `src/api/other.ts` 时输出为空，这是设计如此，不是坏了。

**验压缩前落盘**（`PreCompact`）：

```bash
node -e "require('fs').writeFileSync('c.json', JSON.stringify({hook_event_name:'PreCompact',cwd:process.cwd(),trigger:'auto'}))"
KB_HOOK_VERBOSE=1 kb hook claude-code compact < c.json
```

实跑输出（`KB_HOOK_VERBOSE=1` 才打，正常静默）：

```
knowledge-base-harness: flush — settled 1 conclusion(s) into 1 page(s) before compaction
```

紧接着的 `Stop` 会报告 `no settled conclusions`——同一个结论不会被写两遍。

**用户级安装**

```bash
kb install --global claude-code
```

MCP 走 `claude mcp add --scope user`，因为 `~/.claude.json` 是 Claude Code 自己也在改写的大状态文件，手改容易坏。实测通过 `claude mcp list` 显示 `✔ Connected`。

### 2.2 Codex CLI　✅ 已实测（v0.163.0）

```bash
kb install codex
```

> **注意：Codex 只认全局配置。** 实测在项目目录下放 `.codex/config.toml`，`codex mcp list` 看不到里面的 server。所以适配器默认写到 `$CODEX_HOME/config.toml`。

**装了什么**

| 文件 | 内容 |
|---|---|
| `$CODEX_HOME/config.toml` | MCP server + `notify`（回合结束） |
| `AGENTS.md`（项目根） | 给 agent 的指令块 |

生成的 TOML（实跑原文，两块，marker 不同）：

文件**最顶部**：

```toml
# >>> knowledge-base-harness >>>
# Managed by knowledge-base-harness. Regenerate with: kb install codex

notify = ["C:\\Program Files\\nodejs\\node.exe", "…\\cli.js", "hook", "codex", "stop"]
# <<< knowledge-base-harness <<<
```

文件**最末尾**：

```toml
# >>> knowledge-base-harness-mcp >>>
# Managed by knowledge-base-harness. Regenerate with: kb install codex

[mcp_servers.kb]
command = "C:\\Program Files\\nodejs\\node.exe"
args = ["…\\cli.js", "mcp"]

[mcp_servers.kb.env]
KB_ROOT = "…\\knowledge"
KB_DATA_DIR = "…\\.kb"
# <<< knowledge-base-harness-mcp <<<
```

**为什么必须拆成两块**：TOML 的 key 归属于它上面最近的 table header，而且**没有回到根表的语法**，所以一个块没法同时表达「顶部顶层 key」和「末尾 table」。

- `notify` 是顶层 key（数组）。整块追加到文件末尾时，它落在 `[notice.model_migrations]` 下面，codex 启动即失败：
  ```
  invalid type: sequence, expected a string
  in `notice.model_migrations.notify`
  ```
- 只把整块挪到顶部也不对：以 `[mcp_servers.kb.env]` 结尾的块会把**后面**的顶层 key 吞进这张表。实测紧随其后的 `disable_response_storage = true` 变成 `mcp_servers.kb.env.disable_response_storage`，报 `invalid type: boolean \`true\`, expected a string`。

**能力说明**

Codex 没有 per-prompt hook，所以：

- **召回走 MCP**——agent 自己调 `kb_query`
- **沉淀走 `notify`**——回合结束时触发蒸馏

**验证**

```bash
codex mcp list              # 应有一行 kb
codex mcp list | grep kb
```

期望：

```
kb    C:\Program Files\nodejs\node.exe  …/cli.js mcp  KB_DATA_DIR=*****, KB_ROOT=*****  -  enabled
```

### 2.3 Qoder　✅ 已按官方 hooks 文档核对

```bash
kb install qoder
```

**装了什么**

| 文件 | 内容 |
|---|---|
| `.qoder/settings.json` | 六个钩子（与 Claude Code 同构） |
| `.mcp.json` | kb MCP server（Qoder 的项目级 MCP 路径就是 `${project}/.mcp.json`） |
| `.qoder/rules/knowledge-base.md` | agent 指令（无 frontmatter = `always_on`） |

**为什么能装钩子**：Qoder CLI 的 hooks 参考文档给了完整契约——`settings.json` 下的 `hooks` 分组、`UserPromptSubmit` / `PostToolUse` / `PreCompact` 等事件、stdin 的 `hook_event_name` / `cwd` / `session_id` / `transcript_path`、以及 `hookSpecificOutput.additionalContext`。**与 Claude Code 逐项一致**，所以适配器直接复用同一套事件翻译。

**装出来的 settings.json**（实跑原文）：

```json
{
  "hooks": {
    "SessionStart":     [{ "matcher": "startup|resume|clear|compact" }],
    "UserPromptSubmit": [{}],
    "PostToolUse":      [{ "matcher": "Read|Write|Edit|MultiEdit" }],
    "PreCompact":       [{}],
    "Stop":             [{}],
    "SessionEnd":       [{ "matcher": "clear|logout|prompt_input_exit|other" }]
  }
}
```

（每条里是 `{"type":"command","command":"…cli.js hook qoder <事件>","timeout":30}`，省略了。）

**验证**

```bash
cat .qoder/settings.json      # 应有六个事件
cat .mcp.json                 # 应有 mcpServers.kb
# 在 Qoder 里跑：/hooks 应能看到六条；/memory 应能看到 rules/
```

Qoder 的配置是多层合并的（用户级 `~/.qoder/settings.json` → 项目 `.qoder/settings.json` → 本地 `.qoder/settings.local.json`），同名 hooks 都会触发，所以装在项目层不会覆盖你个人的钩子。

> 注意：Qoder 只有在**可信文件夹**里才加载项目级配置（`security.folderTrust.enabled`，默认开）。如果钩子不生效，先确认这个项目被信任了。

### 2.4 WorkBuddy　⚠️ 约定

```bash
kb install workbuddy
```

**装了什么**

| 文件 | 内容 |
|---|---|
| `.workbuddy/knowledge-base-harness.hooks.json` | 钩子命令清单（无公开契约，需自行接线） |
| `.mcp.json` | kb MCP server |
| `WORKBUDDY.md`（项目根） | agent 指令 |

**生效路径**：规则文件 + MCP。WorkBuddy 没有公开的 hooks 文档，所以钩子只写进自己的 manifest，不假装已经生效。

**验证**：`cat WORKBUDDY.md` 应含 `## Personal knowledge base` 段；`.mcp.json` 应有 kb。

### 2.5 Trae　⚠️ 约定

```bash
kb install trae
```

**装了什么**

| 文件 | 内容 |
|---|---|
| `.trae/knowledge-base-harness.hooks.json` | 钩子命令清单 |
| `.trae/mcp.json` | kb MCP server（Trae 自己的路径，不是根目录 `.mcp.json`） |
| `.trae/rules/knowledge-base.md` | agent 指令 |

**验证**

```bash
ls .trae/rules/ .trae/mcp.json
```

在 Trae 里打开项目，确认 MCP 面板能看到 `kb`。

### 2.6 附：dsh　⚠️ 约定

dsh 没有 MCP，只有规则文件 + shell 钩子：

```
.dsh/
├── knowledge-base-harness.hooks.json
└── hooks/
    ├── kb-start.sh
    ├── kb-prompt.sh      stdin 读 payload，stdout 吐注入文本
    ├── kb-stop.sh
    └── kb-end.sh
DSH.md
```

**首次必须先手动验一次**：

```bash
node -e "require('fs').writeFileSync('p.json', JSON.stringify({kind:'prompt',cwd:process.cwd(),prompt:'测试问题'}))"
bash .dsh/hooks/kb-prompt.sh < p.json
```

（先 `kb install dsh` 让 `.dsh/hooks/kb-prompt.sh` 落地。）

实跑输出：

```
## Long-term memory (always injected)
### Agent memory (219/4000 chars)
- 本地 WES 固定用 9102，ESS 用 9000

## Knowledge base hits (from knowledge-base-harness)

1. 本地启动 WES 必须设置 MOCK_ESS=on — `wes-mock-ess-on.md`
   - 确认了：本地启动 WES 必须设置 MOCK_ESS=on (commit 4e871a50bb)

Read the full page with the kb tool before acting if a hit looks relevant.
```

注意 dsh 输出的是**纯文本**，不是 Claude Code 那种 JSON 信封——各 harness 的注入协议不同，适配器分别处理。

事件名已在 `parsePayload` 里做了别名归一化（`sessionStart` / `userPromptSubmit` / `agentStop` / `sessionEnd`），若你的 dsh 版本用别的名字，告诉我可加映射。payload 结构不合法时钩子**降级成只注入记忆**，不报错、不中断会话。

> ⚠️ Windows 上用 shell 拼接 JSON 时反斜杠会被吞掉。用 `node -e` 生成 payload 文件，不要写 `echo '{"cwd":"D:\\x"}'`。

### 2.7 用户级安装（所有 agent 共用一份知识库）

```bash
kb install --global claude-code codex qoder workbuddy trae dsh
```

含义：**钩子/MCP/规则写到用户目录，知识库本体仍在当前项目**（`--global` 改的是配置落点，不是 wiki 位置）。所有项目都读同一份 `knowledge/`。

实跑落点（`~` = 用户目录）：

| harness | 落点 |
|---|---|
| Claude Code | `~/.claude/settings.json` + `claude mcp add --scope user` |
| Codex | `$CODEX_HOME/config.toml`（与项目级安装同一份，本来就是全局） |
| Qoder | `~/.qoder/settings.json`（钩子 + `mcpServers.kb`）+ `~/.qoder/rules/knowledge-base.md` |
| WorkBuddy | `~/.workbuddy/{knowledge-base-harness.hooks.json, mcp.json, rules/…}` |
| Trae | `~/.trae/{…同上}` |
| dsh | `~/.dsh/{knowledge-base-harness.hooks.json, rules/…, hooks/kb-*.sh}` |

用户级安装**不往项目根写 AGENTS.md / WORKBUDDY.md / DSH.md**——从一条全局命令去改任意项目的工作区文件太意外。规则文件改放各 harness 的 `rules/` 下。

---

## 3. 安装后统一验收

三步，五分钟：

```bash
# 1. 结构体检：0 error 为正常（no-tags 之类的 warn 可以忽略）
kb doctor

# 2. 写入 → 召回闭环
kb note "确认了：SSO 网关的超时是 30 秒，超过会返回 504 (commit abc1234)"
kb recall "SSO 超时"

# 3. 记忆注入
kb memory memory --add "本项目统一用中文提交信息"
kb memory memory          # 应看到内容与字符用量
```

实跑输出：

```
$ kb note "确认了：SSO 网关的超时是 30 秒，超过会返回 504 (commit abc1234)"
created sso-30.md (+1, 0 duplicate, 461B)

$ kb recall "SSO 超时"
## Knowledge base hits (from knowledge-base-harness)

1. SSO 网关的超时是 30 秒 — `sso-30.md`
   - 确认了：SSO 网关的超时是 30 秒，超过会返回 504 (commit abc1234)

Read the full page with the kb tool before acting if a hit looks relevant.

$ kb memory memory
MEMORY.md — 238/4000 chars

## 其他
- 本地 WES 固定用 9102，ESS 用 9000

## 沟通
- 本项目统一用中文提交信息
```

两点值得注意：

- **页面文件名是自动生成的**：取标题里的英文/数字片段转小写连字符（`SSO 网关的超时是 30 秒` → `sso-30.md`）；纯中文标题没有可用片段时退回 `p<hash>` 形式的稳定短名。想指定落点用 `--page <path>`
- 召回片段挑的是**与提问词命中最多的行**，标题行也在候选里；重复时保留更长的那条，所以你会看到完整结论而不是被截短的标题

写入后的页面长这样：

```markdown
---
id: "sso-30"
title: SSO 网关的超时是 30 秒
summary: 确认了：SSO 网关的超时是 30 秒，超过会返回 504 (commit abc1234)
tags: []
level: 0
parent: "-"
created: "2026-11-26"
updated: "2026-11-26"
revision: 2
confidence: high
---

# SSO 网关的超时是 30 秒

确认了：SSO 网关的超时是 30 秒，超过会返回 504 (commit abc1234)

## 结论

- 确认了：SSO 网关的超时是 30 秒，超过会返回 504 (commit abc1234)
```

MCP 单独验（不依赖任何 agent）：

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
              '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | kb mcp
```

实跑返回：

```json
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"kb","version":"0.1.0"}}}
{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"kb_query",…},…]}}
```

5 个工具：`kb_query` / `kb_index` / `kb_read` / `kb_note` / `kb_memory` / `kb_tree`（6 个）。

> `kb_index` 只回标题+摘要，不读正文——想先知道「库里有什么」时用它，比 `kb_query` 便宜一半以上。

> Windows 的 `cmd` 里没有 `printf`，用 Git Bash 或换成 `node -e` 拼 payload 文件。

---

## 4. 日常使用 SOP

### 4.1 一次会话的完整流程

```
① 你提问
     ↓
② [自动] 常驻记忆（MEMORY.md + USER.md）全量注入
   [自动] 按你的提问检索 wiki 片段并注入
     ↓
③ agent 干活（此时它已经知道项目背景和历史结论）
     ↓
④ 出现定论时，agent 调 kb_note 记录（或你说 kb: …）
     ↓
⑤ 会话结束（/exit、Stop、SessionEnd）
     ↓
⑥ [自动] 蒸馏 → 门控 → 路由 → 写入 → 取代留痕 → 压缩/降级
     ↓
⑦ 报告：写了几页、丢了几条、有没有 lint 问题
```

### 4.2 你只需要记住三件事

**① 有定论就说 `kb:`**

```
kb: 返仓入参必须回传 SN，否则 ESS 拒单
```

支持的前缀：`kb:` / `kb ` / `结论:` / `知识库：` / `conclusion:`。行内带证据（commit、工单号、日期、文件路径）会自动判为 high。

> **`kb:` 什么时候生效**：`UserPromptSubmit` 时该行就被抽进本次会话的待沉淀列表（`extractExplicitNotes`），但**写进 wiki 是在会话结束**。所以本轮 `kb recall` 看不到它，下次开新会话才出现在注入里。想立刻验证就手工 `kb note "…"`。

**② 要长期记住的（每轮都要的）单独说**

```
kb memory memory --add "本地 WES 固定用 9102，ESS 用 9000"
```

判断标准：**换一个话题还需要它吗？** 需要 → memory；只跟当前任务有关 → 页面。

**③ 改主意了说清楚**

```bash
kb note "确认了：缓存前缀改为按 environmentCode 拼接 (commit bbb2222)" \
        --supersedes "缓存前缀必须带租户标识"
```

实跑输出与写入结果：

```
updated p13maobz.md (+1, 0 duplicate, 597B), superseded 1
```

```markdown
## 结论

- ~~确认了：缓存前缀必须带租户标识 (commit aaa1111)~~ (2026-11-26 已被取代：确认了：缓存前缀改为按 environmentCode 拼接 (commit bbb2222))
- 确认了：缓存前缀改为按 environmentCode 拼接 (commit bbb2222)
```

旧结论**打删除线保留**，永远不物理删除——这是「为什么改」的证据。

`--supersedes` 用的是**片段匹配**，不必逐字完整。若片段在同页里命中多条，工具会拒绝而不是猜错一条。旧文本在库里不存在时不会报错，只当普通新增处理。

### 4.3 agent 侧的使用（无需你干预）

| 场景 | agent 调用的工具 |
|---|---|
| 回答项目问题前 | `kb_query` |
| 只想看库里有什么 | `kb_index`（标题+摘要，便宜） |
| 需要看完整页面 | `kb_read` |
| 拿到定论 | `kb_note`（可带 `supersedes`） |
| 需要长期记住 | `kb_memory` |
| 迷路时看结构 | `kb_tree` |

### 4.4 让页面自己找上门（`paths:`）

页面可以在 front matter 里声明生效范围：

```yaml
---
id: api-handler
title: API handler 约定
summary: 统一错误结构，请求体必须过共享 schema
paths: ["src/api/**", "**/*.schema.ts"]
---
```

此后 agent 只要**读或改**匹配的文件，`PostToolUse` 钩子就会把这一页的标题+摘要推进上下文，不需要你在提问里提到 "api"。同一会话内每页只提醒一次。

判断标准：**这一页只在动某些文件时才有用吗？** 是 → 加 `paths`；是通用背景 → 不加，让它走提问召回。

`kb path-recall` 可以手工试匹配：

```bash
kb path-recall src/api/handler.ts     # 列出会命中哪些页面
```

### 4.4 手工写页面、建目录

知识库就是普通 markdown，你要手动整理完全可以，只要守住四条：

1. **目录层级 ≤ 4 层**，每层都得有 `index.md`
2. **目录里只放 `.md`**，图片、导出文件一律放外面
3. 每个页面 front matter 至少有 `title` 和 `summary`（`summary` 参与召回打分，缺了召回质量会掉）
4. 结论写在 `## 结论` 下面，一条一个 bullet

建新目录后跑 `kb doctor` 会告诉你缺哪个 `index.md`；手工建页面后索引是自动重建的（写入时失效缓存），不用手动跑什么。

```bash
mkdir -p knowledge/wes/troubleshooting
# 写 knowledge/wes/index.md、knowledge/wes/troubleshooting/index.md 和具体页面
kb doctor                       # 检查结构和索引
kb recall "刚写的那个问题"        # 确认能被召回
```

---

## 5. 维护

### 5.1 周期性

| 频率 | 命令 | 作用 |
|---|---|---|
| 每周 | `kb doctor` | 结构体检（0 error 为正常） |
| 每月 | `kb curate` | **预览**窄页面合并计划 |
| 每月 | `kb curate --apply` | 执行合并（源页面归档，不删除） |
| 需要时 | `kb demote` / `kb demote --apply` | 把过长的「细节」段搬进 `references/` |
| 需要时 | `kb compress` | 压缩超预算页面 |
| 需要时 | `kb promote-memory` / `--apply` | 把长大成流程的记忆条目搬到页面，腾出常驻预算 |
| 每季度 | `kb evolve` | 归纳 playbook、报告冷页面 |
| 每季度 | `kb stats` | 看哪些页面真被用到 |

**除 `doctor` 外，全部默认 dry run**，加 `--apply` 才写盘。

实跑「空库」输出（说明这些命令在没有素材时是安静的，不会乱动）：

```
$ kb curate
knowledge-base-harness: curator — 3 narrow page(s) considered
  nothing worth consolidating

$ kb demote
knowledge-base-harness: demote — 0 page(s) with heavy details
  nothing above minDetailChars=800

$ kb compress
Nothing above the size budget.

$ kb evolve
knowledge-base-harness: evolution pass
  nothing to evolve

$ kb stats
page                                  recalls  adopted  writes  last
wes-mock-ess-on.md                          3        0       0  2026-11-26
sso-30.md                                   2        0       0  2026-11-26
```

### 5.1.1 记忆腾挪（`kb promote-memory`）

常驻记忆是最贵的文本——每一轮都要为它付 token。一句事实值得；一段流程不值得。

```bash
$ kb promote-memory
knowledge-base-harness: promote-memory — 1 entry(s) outgrew memory
  would move [memory] 排查上架异常要先看 ESS 的 container 状态，再对照 WES 的 putaway 记录，最后确认库位是否被锁
      reads like a procedure, not a fact
  (dry run — re-run with --apply to write)

$ kb promote-memory --apply
knowledge-base-harness: promote-memory — 1 entry(s) outgrew memory
  moved [memory] 排查上架异常要先看 ESS 的 container 状态，再对照 WES 的 putaway 记录，最后确认库位是否被锁
      reads like a procedure, not a fact → ess-container.md
```

判定标准两条，任一命中即为候选：

- **读起来像流程**（先/然后/步骤/执行/配置/部署…）——流程属于按需层
- **超过 80 字符**——这么长已经不是一句事实了

写入顺序是**先建页、再删记忆**：页面写失败时记忆还在，不会两头落空。

### 5.2 什么时候该做什么

| 症状 | 处理 |
|---|---|
| `kb doctor` 报 `non-markdown-file` | `kb doctor --fix`（隔离到 `.kb/quarantine/`） |
| 一个目录下堆了几十个一句话页面 | `kb curate` 看计划 → `--apply` |
| 某页越写越长，翻半天 | `kb demote <page> --apply` |
| 页面超过 12 KB | `kb compress <page>` |
| 结论互相矛盾 | 用 `--supersedes` 重写，不要直接删 |
| 记忆快满了（>85%） | `kb promote-memory` 把长条目搬走；或 `kb memory memory --remove "<旧条目>"` |
| 想删掉某页 | 手工删文件 + `kb doctor --fix` 重建索引 |
| 某页只在改特定文件时有用 | 加 `paths: ["<glob>"]`，让它自己找上门 |

---

## 6. 卸载与回滚

**回滚到装之前**：所有写入都以 marker 块或独立文件存在，删掉即可。

```bash
# Claude Code / Qoder
# 删除 settings.json 中 marker 块内的钩子条目，删除 .mcp.json 中的 kb

# Codex
# 删除 $CODEX_HOME/config.toml 中两个 marker 块（顶部的 knowledge-base-harness
# 与末尾的 knowledge-base-harness-mcp）

# 其他
rm -rf .workbuddy .trae .dsh WORKBUDDY.md DSH.md
```

用户级安装的清理：

```bash
claude mcp remove --scope user kb          # 撤掉用户级 MCP 注册
rm -rf ~/.qoder ~/.workbuddy ~/.trae ~/.dsh
# ~/.claude/settings.json 与 $CODEX_HOME/config.toml 里的 marker 块手工删
```

**知识库本身不受影响**——`knowledge/` 是纯 markdown，卸载工具后照样能读。

---

## 7. 排障

### 7.1 `kb: command not found`

`npm link` 没成功。用长路径替代：

```bash
node <仓库>/dist/cli.js install claude-code
```

### 7.2 钩子不触发

| 检查 | 命令 |
|---|---|
| 钩子在不在 | Claude Code / Qoder 里 `/hooks`（Qoder 也可 `cat .qoder/settings.json`） |
| 命令能不能跑 | 复制 `settings.json` 里的 command，手工执行一次 |
| 实际报错 | 设环境变量 `KB_HOOK_VERBOSE=1`，stderr 会打堆栈 |
| Qoder 项目级配置被忽略 | 确认该文件夹已信任（`security.folderTrust.enabled`） |

**设计上钩子失败不影响你的会话**：`cmdHook` 捕获所有异常，只在 `KB_HOOK_VERBOSE=1` 时才输出。

### 7.3 注入了记忆但没有知识库片段

说明 `kb recall` 没命中。直接用同样的问题手工查：

```bash
kb recall "你的问题" --json      # 看每页得分
```

- 都是 0 分 → 知识库里确实没有相关内容，属正常
- 有分数但没注入 → 检查 `minScore`（默认 0.01）、`snippetHitCount`（默认只给前 2 条正文），或页面被 `_archive/` 排除
- 只有标题清单没有正文 → 那是第三层注入，正常；说明这几页相关度不够高，agent 可以自己 `kb_read`

### 7.4 `paths:` 推送没反应

```bash
kb path-recall src/api/handler.ts     # 手工试匹配
```

- 输出"No page routes" → glob 没命中，或那页没写 `paths`
- 有输出但钩子没触发 → 确认装了新版本（`PostToolUse` 是后加的），重新 `kb install`

项目根按「KB 目录的父目录」推断。知识库不在项目根下的 `knowledge/` 时，glob 会对不上——要么把 KB 放回默认位置，要么用相对项目根的路径写 `paths`。

### 7.5 装了两次钩子，触发两遍

marker 名变了（例如从旧名 `knowlege-base-harness` 升级过来）会导致新旧两个块并存。定位并手工删掉旧的：

```bash
grep -rn ">>> knowlege-base-harness >>>" .claude ~/.claude "$CODEX_HOME" 2>/dev/null
```

### 7.6 MCP 显示 `✘ Failed to connect`

```bash
# 手工验一次（Git Bash / PowerShell 都可）
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' | kb mcp
```

能返回 `serverInfo` 说明 server 本身没问题；此时问题在 agent 侧的路径或环境变量。检查 `.mcp.json` 里 `args[0]` 是不是绝对路径、文件是否存在。

> 直接敲 `kb mcp` 不带输入会一直阻塞等 stdin，看起来像卡死，`Ctrl+C` 退出即可——这是 MCP stdio 的正常行为。

### 7.7 Windows 反斜杠丢失

`claude mcp add` 会吞掉参数里的反斜杠（`D:\a\b` → `D:ab`）。用正斜杠：

```bash
claude mcp add --scope user kb -e 'KB_ROOT=D:/proj/knowledge' -- node D:/proj/cli.js mcp
```

本工具的 `--global` 安装已经自动转成正斜杠。

### 7.8 会话结束后什么都没写

正常行为——**没有定论就不写**。看报告：

```bash
kb summary --dry-run      # 只看不写，会列出「会写到哪里」
```

若报告说 `no settled conclusions`，说明这段对话没产生定论，或产生的都是问句/模糊表述/试探性说法。

---

## 8. 一页速查

```bash
# 安装
npm install && npm link
kb init
kb install claude-code codex qoder workbuddy trae

# 验收
kb doctor
kb note "确认了：…"
kb recall "…"

# 日常
echo "kb: 结论…"                    # 会话里直接说
kb memory memory --add "…"          # 每轮都要的事实
kb path-recall src/api/x.ts         # 这个文件会命中哪些知识页

# 维护（全部默认 dry run）
kb curate [--apply]
kb demote [page] [--apply]
kb promote-memory [--apply]         # 记忆里长成流程的条目搬到页面
kb compress [page]
kb evolve
kb stats
```
