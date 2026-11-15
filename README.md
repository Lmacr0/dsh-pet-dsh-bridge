# dsh-pet-dsh-bridge 🐟

[English](#english) | [中文](#中文)

> **免责声明 / Disclaimer**
>
> 本项目是社区第三方插件，与 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 的作者 PC2005-cloud 无任何隶属或合作关系，也未获其背书。
> 本项目按「现状」提供，不附带任何明示或暗示的担保；使用风险由使用者自行承担。
>
> This is a community third-party plugin. It is **not affiliated with, endorsed by, or sponsored by** the author of dsh-pet (PC2005-cloud).
> It is provided "AS IS", without warranty of any kind; you use it at your own risk.

A two-way bridge between [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) (the desk-pet plugin for DeepSeek Harness) and DSH sessions.

---

## 中文

### 它解决什么问题

`dsh-pet` 是一只住在 DSH 里的桌面宠物，它有自己的聊天记忆（`memory.json`），但**跟你的 DSH 会话完全隔离**：

- 你在 DSH 里聊过的内容，宠物不知道
- 你和小宠物聊的内容，DSH 里看不到
- 重开一个新对话，宠物像第一次见你

这个插件在两者之间搭一座桥。

### 功能

**① 宠物能读到你的 DSH 会话（DSH → 宠物）**

宠物每次开口前，插件会用你的问题去检索 DSH 的全部会话历史，把最相关的最近 20 条拼进它的上下文。

效果：你跟它说「上次那个插件问题解决了没」，它知道你指的是什么。

**② 宠物对话归档成双方可读的文件（宠物 → DSH）**

宠物每轮问答后，写进一个 Markdown 文件：

```
$DSH_HOME/dsh-pet/dsh-chat-archive.md
```

你可以直接打开看，也可以让我（AI）读取它。

> ⚠️ 刻意**不**往正在运行的 DSH 会话里追加消息。会话日志是 append-only 的事件流，凭空插入宠物消息会污染模型可见的历史（也会被算作你本人说的话）。

### 安装

需要先安装 `dsh-pet`（本插件依赖它提供的 `petApi7340` 服务）。

> 🔒 **建议先备份数据。** 本插件仍在 `0.x` 实验阶段，行为可能随版本调整。
> 归档文件写入 `$DSH_HOME/dsh-pet/`，不改动宠物自己的 `memory.json`；但**任何插件都无法保证 100% 无副作用**，重要对话请自行留档。

```bash
# 1. 克隆到本地
git clone https://github.com/Lmacr0/dsh-pet-dsh-bridge.git D:\DSH\pet-dsh-bridge

# 2. 在 DSH 插件页面安装本地目录
#    Plugins → Add plugin → 填 D:\DSH\pet-dsh-bridge → Install

# 3. 重启 DSH
```

或者用命令行：

```bash
dsh plugin --profile desktop add D:\DSH\pet-dsh-bridge
```

### 配置

**无需配置。** 所有路径跟随 `$DSH_HOME`：

| 项目 | 位置 |
|---|---|
| 归档文件 | `$DSH_HOME/dsh-pet/dsh-chat-archive.md` |
| 召回条数 | 固定 20 条 |
| 单条截断 | 500 字符 |

代码里的常量（`lib/index.js` 顶部）：

| 常量 | 默认 | 作用 |
|---|---|---|
| `MAX_HISTORY_TURNS` | `20` | 每次召回最多带回多少条历史 |
| `MAX_TURN_CHARS` | `500` | 单条历史正文截断长度 |
| `RECALL_TIMEOUT_MS` | `2500` | 召回总超时，超时视为不修改 |
| `MAX_ARCHIVE_ENTRIES` | `2000` | 归档文件最大保留条数 |

### 已知限制

| 限制 | 说明 |
|---|---|
| **依赖 `sessionQuery` 服务** | 如果 DSH 没挂载会话检索能力，召回会降级为「无历史」，不会报错 |
| **检索是关键词匹配** | 不是语义理解。你说的话越具体，召回越准 |
| **归档只增不查** | 宠物不会读回自己的归档文件（读的是它自己的 `memory.json`） |
| **只支持 dsh-pet** | 不支持其他宠物插件 |
| **归档不自动清理** | 超过 2000 条时截掉最旧的 |
| **依赖非公开 API** | `petApi7340` 是 dsh-pet 提供的宿主服务，**不是 DSH 官方稳定接口**。dsh-pet 若调整该服务，本插件可能随之失效 |

### 兼容性

| 项目 | 版本 |
|---|---|
| 已验证 DSH | `0.2.2-rc.3` |
| 依赖 dsh-pet | 提供 `petApi7340.memory.register` 的版本（`0.4.9` 已验证） |
| Node.js | `>=20` |

> ⚠️ 这是 `0.x` 版本，API 与行为都可能在后续版本中变化，不保证向后兼容。

### 工作原理

```
你的问题
   ↓
recall(input)  →  ctx.sessionQuery.searchSessions({ text, limit: 20 })
   ↓                （检索 DSH 会话）
宠物看到历史 → 生成回复
   ↓
capture(input) →  追加写入 dsh-chat-archive.md
```

插件通过 `dsh-pet` 暴露的 `petApi7340.memory.register()` 注册一个记忆提供者（provider），实现两个可选钩子：

- `recall(input)` — 对话前修改内容，返回要覆盖的字段
- `capture(input)` — 落盘后接收这一轮问答

### 隐私说明

| 数据 | 去向 |
|---|---|
| 你的 DSH 会话历史 | 只在内存中检索，**不发送到任何外部服务** |
| 宠物对话 | 写入本地 `dsh-chat-archive.md` |

**本插件不联网。** 所有操作都在本地文件系统内完成。

---

## English

### What it does

[dsh-pet](https://github.com/PC2005-cloud/dsh-pet) is a desk-pet plugin for DeepSeek Harness with its own chat memory, fully isolated from your DSH sessions:

- The pet doesn't know what you discussed in DSH
- You can't see pet conversations in DSH
- A new session means the pet meets you for the first time again

This plugin builds a bridge between the two.

### Features

**① The pet can read your DSH sessions (DSH → pet)**

Before the pet replies, the plugin searches your entire DSH session history with your question and injects the 20 most relevant turns into its context.

**② Pet conversations are archived to a file both sides can read (pet → DSH)**

After each exchange the plugin appends to a Markdown file:

```
$DSH_HOME/dsh-pet/dsh-chat-archive.md
```

> ⚠️ It deliberately does **not** append messages to a running DSH session. A session log is an append-only event stream; injecting pet messages would pollute the model-visible history (and be attributed to you).

### Install

Requires `dsh-pet` first — this plugin depends on the `petApi7340` service it provides.

```bash
git clone https://github.com/Lmacr0/dsh-pet-dsh-bridge.git D:\DSH\pet-dsh-bridge
```

Then open **Plugins → Add plugin**, enter the local path, and install. Restart DSH afterwards.

Or from the CLI:

```bash
dsh plugin --profile desktop add D:\DSH\pet-dsh-bridge
```

### Configuration

**None required.** All paths follow `$DSH_HOME`.

| Setting | Default | Purpose |
|---|---|---|
| `MAX_HISTORY_TURNS` | `20` | Max history turns per recall |
| `MAX_TURN_CHARS` | `500` | Max characters per turn |
| `RECALL_TIMEOUT_MS` | `2500` | Recall timeout; a timeout means "no change" |
| `MAX_ARCHIVE_ENTRIES` | `2000` | Max entries kept in the archive |

Edit these constants at the top of `lib/index.js`.

### Known limitations

| Limitation | Detail |
|---|---|
| **Requires `sessionQuery`** | Without DSH's session search the recall degrades to "no history" rather than erroring |
| **Keyword matching, not semantic** | The more specific your question, the better the recall |
| **Archive is write-only** | The pet doesn't read its own archive back (it reads its own `memory.json`) |
| **dsh-pet only** | No support for other pet plugins |
| **No automatic pruning** | Beyond 2000 entries the oldest are dropped |

### How it works

```
your question
   ↓
recall(input)  →  ctx.sessionQuery.searchSessions({ text, limit: 20 })
   ↓
pet sees history → generates a reply
   ↓
capture(input) →  append to dsh-chat-archive.md
```

The plugin registers a memory provider through `petApi7340.memory.register()`, implementing two optional hooks:

- `recall(input)` — modify content before the call; return the fields to override
- `capture(input)` — receive the exchange after it is persisted

### Privacy

| Data | Destination |
|---|---|
| Your DSH session history | Searched in memory only — **never sent to any external service** |
| Pet conversations | Written to the local `dsh-chat-archive.md` |

**This plugin makes no network requests.** Everything happens on the local filesystem.

---

## License

[MIT](LICENSE)
