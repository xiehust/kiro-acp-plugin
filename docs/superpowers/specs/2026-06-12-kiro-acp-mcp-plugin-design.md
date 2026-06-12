# kiro-acp-mcp:让 kiro-cli 成为 Claude Code 的可委派子代理

日期:2026-06-12
状态:已批准

## 背景与目标

Claude Code 需要把一部分任务(独立、边界清晰的实现类工作)委派给本机的
`kiro-cli`(Kiro CLI Agent,已验证 v2.6.0)执行,并支持多轮跟进。

`kiro-cli acp` 在 stdio 上暴露标准 Agent Client Protocol(JSON-RPC)。
已通过冒烟测试验证:initialize 握手成功,`loadSession: true`,
支持图片输入与 HTTP MCP 透传。

本项目构建一个 Claude Code 插件,核心是一个 **MCP↔ACP 桥**:
对 Claude Code 是 stdio MCP server,对 kiro-cli 是 ACP client。

## 非目标

- 不把 kiro 的权限请求转发给用户审批(直接 `--trust-all-tools`,见"权限")。
- 不定义 kiro-delegate subagent 类型(收益存疑,纯增加一层 Claude wrapper)。
- 不支持反向集成(kiro 调 Claude Code)。
- 不做无头 CLI(`chat --no-interactive`)包装——那是 ACP 路线受阻时的降级备选。

## 架构

```
Claude Code
  ├─ plugin: kiro-acp-mcp
  │   ├─ .mcp.json                       → 注册 MCP server (stdio)
  │   ├─ skills/delegating-to-kiro/      → 委派指南 skill
  │   └─ commands/kiro.md                → /kiro 斜杠命令
  │
  └─ MCP server (Node.js / TypeScript)
      ├─ @modelcontextprotocol/sdk             (MCP 服务端)
      ├─ @zed-industries/agent-client-protocol (ACP 客户端 SDK)
      └─ spawn: kiro-cli acp --trust-all-tools (常驻子进程,懒加载)
            └─ 多个 ACP session 复用同一子进程
```

- kiro 子进程在**第一次工具调用时**才 spawn(懒加载),之后常驻。
- 子进程崩溃:自动重启;受影响会话标记为失效,下次引用时返回明确错误。

## MCP 工具面

### kiro_prompt

核心工具,同步阻塞直至 kiro 完成本轮。

参数:
- `prompt`(必填,string)— 委派的任务描述。
- `session_id`(可选,string)— 省略则自动 `session/new` 新建会话;
  提供则在既有会话上续聊(ACP `loadSession` 已确认支持)。
- `cwd`(可选,string)— 新建会话的工作目录,默认 Claude Code 当前项目目录。
- `model` / `agent` / `effort`(可选,string)— 仅新建会话时生效,
  对应 `kiro-cli acp` 的同名启动语义;在已有会话上传入则忽略并在结果中注明。

行为:
- 执行期间把 ACP `session/update` 通知(计划、工具调用、文本增量)转成
  MCP progress 通知:既防客户端超时,也让用户实时看到 kiro 的进展。
- 返回值(结构化文本):
  1. kiro 最终回复全文;
  2. `session_id`(供续聊);
  3. 执行摘要——kiro 修改了哪些文件、运行了哪些命令(从 `session/update`
     的 tool_call 事件聚合)。

### kiro_cancel

参数:`session_id`(必填)。转发 ACP `session/cancel`,终止正在执行的轮次。
对空闲会话调用返回无害的"无进行中任务"。

### kiro_list_sessions

无参数。列出本 server 实例管理的会话:`session_id`、cwd、状态
(idle / running / dead)、最近一次活动时间。

## 权限策略

启动 kiro 子进程时传 `--trust-all-tools`。理由:委派出去的任务本来就期望
自主完成,与 Claude Code 自身 subagent 的行为一致;风险由"用户/Claude
选择委派什么任务"控制,且 skill 明确要求委派后验收。预留 env
`KIRO_MCP_TRUST_TOOLS` 可改为静态白名单(映射到 `--trust-tools=...`)。

## 封装层

### skills/delegating-to-kiro/SKILL.md

指导 Claude:
- **何时委派**:独立、边界清晰、可并行、不需要与当前会话上下文深度交织的
  实现类任务;不适合委派强依赖当前对话历史或需要频繁来回确认的任务。
- **怎么写委派 prompt**:给足背景(相关文件路径、约束、风格),
  明确验收标准,一次一个聚焦的任务。
- **必须验收**:拿到结果后自己读 diff、跑测试,不盲信 kiro 的自述。
- **多轮跟进**:复用返回的 `session_id` 续聊,避免重述上下文。

### commands/kiro.md(/kiro 斜杠命令)

`/kiro <任务>` 展开为:调用 `kiro_prompt` 委派该任务,完成后按 skill
的验收要求检查结果并向用户汇报。

## 配置项(env,经 .mcp.json 传入)

- `KIRO_MCP_TIMEOUT_MS` — 单轮 prompt 超时,默认 1_800_000(30 分钟)。
- `KIRO_MCP_TRUST_TOOLS` — 设置后改用 `--trust-tools=<值>`。
- `KIRO_MCP_BIN` — kiro-cli 可执行文件路径,默认 PATH 查找 `kiro-cli`。

## 错误处理

- **kiro-cli 未安装**:工具返回错误,附安装指引。
- **未登录**:识别 ACP 错误/authMethods,返回"请运行 `kiro-cli login`"。
- **子进程 prompt 中途崩溃**:返回已收到的部分输出 + 明确的崩溃说明,
  会话标记 dead;子进程重启供后续调用。
- **超时**:到达 `KIRO_MCP_TIMEOUT_MS` 后发 `session/cancel`,
  返回部分输出并注明超时。
- **引用失效/未知 session_id**:明确报错并提示可新建会话。

## 测试策略

- **单元测试**:用脚本化 fake ACP agent(stdio 回放预设 JSON-RPC 序列)
  覆盖:握手、建会话、prompt 往返、progress 转发、取消、崩溃恢复、超时。
- **集成冒烟测试**:env flag(如 `KIRO_MCP_E2E=1`)开启,打真实
  `kiro-cli acp` 跑一个最小 prompt,验证协议兼容性;CI 默认跳过。
- **插件手测清单**:`/kiro` 命令、skill 触发、progress 在 Claude Code UI
  中的呈现。

## 仓库结构

```
kiro-acp-mcp/
├─ .claude-plugin/plugin.json
├─ .mcp.json
├─ commands/kiro.md
├─ skills/delegating-to-kiro/SKILL.md
├─ server/
│   ├─ package.json  tsconfig.json
│   ├─ src/
│   │   ├─ index.ts       # MCP server 入口,注册 3 个工具
│   │   ├─ acp-client.ts  # kiro 子进程 spawn/重启 + ACP 连接
│   │   ├─ sessions.ts    # 会话注册表与生命周期
│   │   └─ tools.ts       # 工具实现:prompt/cancel/list
│   └─ test/
└─ docs/superpowers/specs/
```

## 风险与备选

- **ACP 字段/语义与 SDK 版本不匹配**:kiro 实现的是 protocolVersion 1,
  以真实握手响应为准对齐 SDK 版本;集成冒烟测试兜底。
- **长任务体验**:MCP progress 通知能否在 Claude Code UI 充分呈现存在
  不确定性;最坏情况下用户只看到工具在转,结果仍完整返回。
- **降级路径**:若 ACP 路线遇到不可绕过的坑,保留方案 B——同一工具面
  改为子进程跑 `kiro-cli chat --no-interactive --resume-id` 实现,
  工具 API 不变,仅替换传输层。
