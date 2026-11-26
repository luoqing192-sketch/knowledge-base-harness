# knowledge-base-harness

个人知识库，以 **markdown wiki** 的形态存在，由 agent harness 的插件体系自动维护。

开启会话时自动注入两层上下文：**常驻记忆**（每轮都进，体积受硬约束）+ **按需召回**（按你的提问检索 wiki）。会话结束时自动把**已经定论**的内容沉淀回去。没有定论的会话不写任何东西。

```
你的提问 ──▶ [memory] 常驻记忆全量注入（MEMORY.md / USER.md）
         ──▶ [recall] 按提问检索 wiki 片段
                    │
                    ▼
             agent 干活（自己调 kb_note / kb_memory 落结论）
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
   显式结论(kb:)           Stop/SessionEnd
        │                       │
        └────────┬──────────────┘
                 ▼
        [distill] 结论门控 ── 只收「已确认/可验证」的陈述
                 ▼
        [route] 复用已有页面 > 新建页面（按目录层级）
                 ▼
        [write] 去重合并 / 取代旧结论 / 压缩超长页
                 ▼
        [evolve] 归纳打法(playbook) / 冷页面报告
```

## 两层结构

借鉴 Hermes 的分层：**常驻的东西必须小，大的东西必须按需**。

| | `memory/MEMORY.md` / `memory/USER.md` | 主题页面树 |
|---|---|---|
| 何时进上下文 | **每一轮都全量注入** | 命中提问才注入片段 |
| 上限 | **4000 / 2000 字符**（硬约束，超了拒绝写入） | 单页 12 KB，超了自动压缩 |
| 放什么 | 环境怪癖、约定、用户画像、沟通偏好 | 具体结论、踩坑、打法 |
| 检索 | **不参与检索**（已经在上下文里，再召回等于花两次钱） | 词法召回 |
| 写入 | `kb_memory` / `kb memory --add` | `kb_note` / `kb_note` MCP 工具 |

超预算时的行为与 Hermes 一致：**整批原子校验**，返回当前条目和用量，让你「先删两条再加一条」一次提交。不会写一半。

## 支持哪些 harness

| Harness | 钩子覆盖 | 配置文件位置 | 规则文件 | MCP |
|---|---|---|---|---|
| **Claude Code** | ✅ 全部四个（`SessionStart` / `UserPromptSubmit` / `Stop` / `SessionEnd`） | 项目 `.claude/settings.json` | `CLAUDE.md` | `.mcp.json` |
| **Codex CLI** | ⚠️ 只有 `notify`（回合结束） | **全局** `$CODEX_HOME/config.toml` | `AGENTS.md` | 同左 |
| **Qoder** | ⚠️ 无公开钩子契约 | 项目 `.qoder/` | `.qoder/rules/*.md` | `.mcp.json` |
| **WorkBuddy** | ⚠️ 同上 | 项目 `.workbuddy/` | `WORKBUDDY.md` | `.mcp.json` |
| **Trae** | ⚠️ 同上 | 项目 `.trae/` | `.trae/rules/*.md` | `.trae/mcp.json` |
| **dsh** | ⚠️ shell 钩子 | 项目 `.dsh/hooks/kb-*.sh` | `DSH.md` | — |
| **generic** | — | 项目 `.kb/` | `AGENTS.md` | `.mcp.json` |

> 已实测核对：**Claude Code**（2.1.332，四个钩子 + `additionalContext` 注入生效）与 **Codex CLI**（0.163.0，`notify` 必须是顶层 key、项目级配置被忽略）。其余五个仍是 `verified: false`——**只写有依据的键**：必需的规则文件，加上该 harness 有文档的 MCP 配置；钩子命令写在自己的 manifest / `.sh` 里，等语法对上时直接接线。安装时会打印提示，不会假装已经生效。

**核心行为全部在引擎里，不在适配器里**：适配器只负责把各家事件体翻译成 `start / prompt / stop / end / note` 五种事件，行为不会在六个集成分支间漂移。

## 安装

```bash
npm install          # 只装 tsc / vitest
npm run build
npm link             # 把 kb 挂到 PATH，下面的命令都靠它

kb init                 # 建 wiki 根 + 运行时目录 + kb.config.json
kb install              # 给全部 harness 装集成
kb install claude-code  # 只装一个
kb install --global     # 装到用户级配置：所有项目共用同一份知识库
```

不 `npm link` 也能用，把 `kb` 换成 `node <仓库路径>/dist/cli.js` 即可——hook 命令里写的是绝对路径，跟 PATH 无关：

```bash
node /path/to/knowledge-base-harness/dist/cli.js init
```

### 三个 harness 的实际安装结果

**Claude Code** —— 装到项目里（`.claude/settings.json` + `.mcp.json`），跟着仓库走：

```json
{
  "hooks": {
    "SessionStart":      [{ "matcher": "startup|resume|clear", "hooks": [{ "type": "command", "command": "…/node …/cli.js hook claude-code start" }] }],
    "UserPromptSubmit":  [{ "hooks": [{ "type": "command", "command": "…/node …/cli.js hook claude-code prompt" }] }],
    "Stop":              [{ "hooks": [{ "type": "command", "command": "…/node …/cli.js hook claude-code stop" }] }],
    "SessionEnd":        [{ "matcher": "clear|logout|prompt_input_exit|other", "hooks": [{ "type": "command", "command": "…/node …/cli.js hook claude-code end" }] }]
  }
}
```

`UserPromptSubmit` 的 stdout 会被注入上下文（`hookSpecificOutput.additionalContext`），这是召回真正生效的通道。装完重启 Claude Code 即可，`/hooks` 能看到这四条。

**Codex CLI** —— **认全局配置**，装到 `$CODEX_HOME/config.toml`（你的机器是 `D:\Program Files\codex\home\config.toml`），外加项目的 `AGENTS.md`：

> 实测 codex-cli 0.163.0 **不读**项目级 `.codex/config.toml`——`codex mcp list` 在项目目录下看不到里面的 server。所以默认写全局，`--scope project` 只是留给以后版本。

写入的块（`notify` 必须在所有 table header **之前**，TOML 会把后面的 key 归到上一个 header 下）：

```toml
# >>> knowledge-base-harness >>>
notify = ["…node.exe", "…cli.js", "hook", "codex", "stop"]

[mcp_servers.kb]
command = "…node.exe"
args = ["…cli.js", "mcp"]

[mcp_servers.kb.env]
KB_ROOT = "…/knowledge"
KB_DATA_DIR = "…/.kb"
# <<< knowledge-base-harness <<<
```

装完 `codex mcp list` 应该能看到 `kb`。Codex 没有 per-prompt hook，所以**召回走 MCP**（agent 调 `kb_query`），`notify` 只在回合结束时触发蒸馏。

**dsh** —— 生成的 shell 包装脚本 + 规则文件：

```
.dsh/
├── knowledge-base-harness.hooks.json   钩子清单（把命令接到 dsh 自己的 hook 设置里）
└── hooks/
    ├── kb-start.sh          exec node …/cli.js hook dsh start
    ├── kb-prompt.sh         stdin 读 payload，stdout 吐注入文本
    ├── kb-stop.sh
    └── kb-end.sh
DSH.md                       规则文件，告诉 agent 先查 wiki
```

dsh 没有 MCP，所以只有规则文件 + 钩子脚本。**首次使用必须先跑一次** `bash .dsh/hooks/kb-prompt.sh < payload.json` 确认 stdin/stdout 契约和你这个 dsh 版本对得上——不同版本的事件名可能不一样，`parsePayload` 已经做了 `sessionStart / userPromptSubmit / agentStop / sessionEnd` 的别名归一化。

装完之后 `kb.config.json` 决定 wiki 与运行时目录位置，默认：

```
<project>/
├── knowledge/        ← wiki（只允许 .md）
│   ├── index.md
│   └── <topic>/
│       ├── index.md
│       └── <page>.md
├── .kb/              ← 运行时：会话、索引缓存、统计、锁、隔离区
└── kb.config.json
```

## 命令

| 命令 | 作用 |
|---|---|
| `kb init` | 建骨架（含 memory 目录），幂等 |
| `kb install [harness…]` | 写 hooks / MCP / 规则文件，按 marker 块幂等合并 |
| `kb recall "<问题>"` | 检索（`--json`、`--limit N`） |
| `kb note "<结论>"` | 手写一条结论（`--page`、`--supersedes "<旧文本>"`） |
| `kb memory [memory\|user]` | 常驻记忆读写（`--add` / `--remove` / `--patch "<旧>=> <新>"`，可重复） |
| `kb summary` | 结束当前会话并沉淀（`--dry-run` 只看不写） |
| `kb compress [page]` | 压缩超预算页面 |
| `kb evolve` | 归纳 playbook / 冷却页报告 |
| `kb curate [--apply]` | 把窄页面合并成大页（默认 **dry run**，`--apply` 才写） |
| `kb demote [page]` | 把过长的「细节」段降级到活文档 `references/`（`--apply`、`--force`、`--min-chars N`） |
| `kb stats` | 每页被召回/采纳次数 |
| `kb tree` | 打印 wiki 树 |
| `kb doctor [--fix]` | 结构体检；`--fix` 隔离非 md 文件、重建索引 |
| `kb mcp` | stdio MCP 服务（`kb_query` / `kb_read` / `kb_note` / `kb_memory` / `kb_tree`） |
| `kb hook <harness> <event>` | hook 入口，stdin 读事件体（内部命令） |

## 五条硬约束怎么落地

### 1. 有明确结论才更新

三道闸门，任何一道不过就不写：

- **语句门控**（`distill.judgeConclusion`）：问句、模糊限定（`可能/也许/大概`）、试探（`试试看/待定/我再确认下`）、纯告诫（`别乱改/注意一下安全`）一律拒收。
- **置信度分层**：只有「记录型证据」（确认/实测/修复/改判 + 数字或代码引用）能到 `high`；只含 `必须/禁止` 这类规则词的封顶 `medium`——因为泛泛的建议最容易混在这类词里。
- **空会话零写入**：一条都没通过时 wiki 字节不变，报告写 `no settled conclusions — knowledge base untouched`。

实测（`npm run eval`，两套人工标注集共 28 条）：精确率 100%，召回率 86–100%。留出集上唯一的漏判是「那个报错是端口没开」——太短且没有任何标记词，规则拿不到信号，属于已知边界。

### 2. 文档不能超长，自动压缩

`compressPage` 四级递进，**只搬不删**：近似重复合并 → 最旧结论进 `_archive/<page>-YYYY-MM.md` 留指针 → 超段预算归档 → 兜底截断。常驻记忆不压缩，超预算直接拒绝写入并要求腾挪。

### 3. 知识库目录不允许临时文件

所有写入走 `dataDir/tmp` 暂存后原子 `rename`；读路径只认 `.md`；`doctor --fix` 把非 md 文件移进 `.kb/quarantine/`（不删）；会话/索引/统计/锁全在 `.kb/`。

### 4. 严格层级结构，类似 wiki

每层目录必须有自己的 `index.md`，自动列子项；深度受 `maxDepth` 约束；`_archive/` 是唯一特例目录；召回时给父级 index 加成。

### 5. 自进化（借鉴 Hermes 的 curator）

- **使用统计**：`pageWeight = 采纳×3 + 召回×0.5 + 写入 − 矛盾×0.5`
- **提升为打法（promotion）**：同一条**操作性**结论在两个以上页面重复 → 自动沉淀到 `playbooks/<theme>.md`，形成有序步骤，并在来源页 `## 相关` 回链
- **取代而非覆盖（supersession）**：两条路径——agent 显式声明 `supersedes`（权威），或启发式识别「同主题 + 异判断」。旧条目打删除线留痕，绝不删
- **衰减报告（decay）**：冷页面只报告不删除
- **总括合并（curation，`kb curate`）**：见下

#### 总括合并怎么工作

窄页面泛滥是个人 wiki 最常见的死法——每聊一次就多一个「pr-1234-fix.md」。curator 把它们收成大页：

```
规则聚类（确定性）              校验                    落盘
├─ 同目录 + 文件名带会话痕迹    ├─ 源页面必须存在        ├─ 源页面 → _archive/（原文保留）
├─ 同目录 + 共享具体标签        ├─ 大页路径不能已存在    ├─ 写 absorbedInto 指回大页
└─ 同目录 + 文件名共享主题词    ├─ 合并后须 ≤ target    ├─ 生成大页（结论 + 来源清单）
                              └─ 至少 2 个源页面      └─ 重建各级 index
```

**默认 dry run。** 错误合并比一长串小页面更糟——它会把一个事实埋进不相干的标题下。所以先打印计划（合并去向、理由、每个源页面、预计体积），确认后 `--apply`。

和 Hermes 的三条护栏一致：

| 护栏 | 实现 |
|---|---|
| 绝不删除 | 源页面整体搬进 `_archive/`，正文原样保留 |
| 方向可机器读 | archive 页 front matter 写 `absorbedInto: <大页>`，不只写在正文里 |
| 只动自己的 | memory / `playbooks/` / `_archive/` 一律不进候选；已有路径永不被覆盖 |

**LLM 是可选接缝**：`kb curate --complete "<命令>"`，命令从 stdin 读 prompt、往 stdout 吐 JSON。模型只能**提议**，每条提议都要过上面同一套校验（伪造路径、覆盖已有页、只给一个源、想吸收归档页——全部拒绝并说明原因）。钩子路径永远不联网。

#### 细节降级（`kb demote`）

页面要短才好读，但长解释往往才是值钱的部分——复现步骤、日志片段、试错记录。Hermes 的做法是把这些降级到技能的 `references/`，主页面保持一屏，证据只差一跳。

这里同一个动作，但**目标不同**：`_archive/` 是**历史**（不再检索、不再更新），`references/` 是**活文档**（仍被索引、仍被召回、还会继续追加）。把细节归档等于让它消失；降级则保住可检索性。

```
wes/rate-limit.md          2.3KB → 500B     结论留在原地
  └─ 细节 → references/wes__rate-limit.md    原文逐字搬走，derivedFrom 指回源页
```

- 只搬 `## 细节`，**结论永不搬走**——这就是拆分的目的
- 原文逐字搬，不改写
- 同一页第二次降级**追加**到已有 reference，不新建
- 指针是真 markdown 链接，`doctor` 能查断链
- 源页被删 → reference 变孤儿，`orphanReferences()` 报出来

**这些页面受保护**：curate 不合并它、compress 不压缩它、evolve 不把冷页面算进去——它是长文本的正当归宿，压回去等于白搬。

`demote` 也是 **dry run 默认**；会话结束时只对**本次写过的页面**自动跑一次（`--min-chars` 默认 800），不碰会话没看过的页。

## 代码结构

```
src/
├── cli.ts                 # 命令入口；hook 只做分发，出错绝不打断会话
├── core/
│   ├── types.ts           # 领域类型
│   ├── yaml.ts            # 无依赖 front matter 解析/序列化（可回环）
│   ├── markdown.ts        # 解析/序列化/段落合并/去重
│   ├── text.ts            # 中英混合分词、归一化、slug
│   ├── fsx.ts             # 原子写、跨进程锁、路径越界检查
│   ├── config.ts          # 路径解析与配置
│   ├── store.ts           # wiki 读写、索引、目录 index 同步、隔离
│   ├── memory.ts          # 常驻记忆：两层结构的上一层，硬预算 + 原子批
│   ├── recall.ts          # 词法召回 + 上下文渲染
│   ├── distill.ts         # 结论门控与蒸馏
│   ├── router.ts          # 结论进入哪个页面 / 新建页面 / 显式取代
│   ├── compress.ts        # 分级压缩与归档
│   ├── evolve.ts          # 统计、提升、取代、衰减
│   ├── curator.ts         # 窄页面总括合并（规则聚类 + 可选模型接缝）
│   ├── references.ts      # 细节降级：长文进 references/，主页面保持一屏
│   ├── transcript.ts      # 各家会话记录解析
│   ├── session.ts         # 会话状态机
│   ├── lint.ts            # 结构体检
│   └── engine.ts          # 唯一编排入口
├── adapters/              # 六家 harness 的安装与事件翻译
└── mcp/                   # 依赖为零的 MCP server + 工具
```

## 开发

```bash
npm run typecheck
npm test          # 163 个用例
npm run eval      # 结论门控的精确率/召回率（两套标注集）
npm run demo      # 端到端演示：真的走 CLI + hook
```

`npm run demo` 会在临时目录里跑一遍 init → install → 写入 → 取代 → 提升 → doctor，然后打印落盘的 wiki。

## 已知取舍

- **召回是词法的**（中英 bigram + Jaccard），不引入向量库：零依赖、可解释、离线可用。页面数量到几千级时再考虑加一层向量召回。
- **实时路径不调模型**。结论由 agent 自己通过 `kb_note` 提交（它手里有全量上下文），规则蒸馏只在 agent 没提交时兜底。hooks 全程零网络，所以 `/exit` 永远不会被一次超时挂住。
- **合并默认规则聚类**。Hermes 的 curator 用 LLM 判断「这两个窄页面该并成什么语义上的宽主题」，并按内容把细节降级到 `references/`；我们的规则聚类只看目录/标签/文件名，语义合并走 `--complete` 这个可选接缝，且必须人工确认。
- **还没有离线优化器**。Hermes 的 GEPA 会用真实会话记录建评测集、演化技能文本、过测试门禁再提 PR。我们只有统计反馈（`kb stats`）与门控评测（`npm run eval`）。
- **未经核对的 harness 不假装支持**。Codex/Qoder/WorkBuddy/Trae/dsh 的规则文件与 MCP 注册是稳的，钩子语法需要你确认一次：`kb install <harness>` 会打印要核对的命令。
