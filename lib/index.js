/**
 * dsh-pet-dsh-bridge —— 在 dsh-pet（大肥鱼）与 DSH 会话之间做双向桥接。
 *
 * 两条链路：
 *   1. recall（DSH → 宠物）：宠物每次开口前，把 DSH 会话历史拼进它的上下文，
 *      让它知道你在 DSH 里聊过什么。
 *   2. capture（宠物 → 归档）：宠物每轮问答后，追加写进一份双方都能读的
 *      Markdown 归档，DSH 侧需要时可直接读取。
 *
 * 设计约束：
 *   - 绝不向正在运行的 DSH 会话 append 事件。真实会话是 append-only 的事件流，
 *     凭空插入宠物消息会污染模型可见历史（也会算作你本人说的话）。
 *   - 所有外部依赖（petApi7340、ctx.sessionQuery、文件系统）都按“可缺失”处理，
 *     任一环节不可用时降级并记日志，不影响宠物正常聊天。
 *   - 不导入 DSH 内部包：插件目录的模块解析看不到宿主依赖，硬依赖会让整个插件
 *     在加载阶段失败。
 *
 * @module dsh-pet-dsh-bridge
 */

import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'dsh-pet-dsh-bridge'

/** 宠物侧只有存在这个服务时才谈得上桥接；缺失即整个插件空转。 */
export const inject = ['petApi7340']

/** 单次 recall 最多带回多少条历史，防止把上下文撑爆。 */
const MAX_HISTORY_TURNS = 20
/** 单条历史正文截断长度（字符）。 */
const MAX_TURN_CHARS = 500
/** recall 的总超时；超时就当作“不修改”，不能拖慢宠物回复。 */
const RECALL_TIMEOUT_MS = 2500
/** 归档文件保留的最大轮数，防止无限增长。 */
const MAX_ARCHIVE_ENTRIES = 2000

/** 归档里统一使用的分隔标题。 */
const ARCHIVE_TITLE = '# 大肥鱼 × DSH 对话归档'

/**
 * 解析 DSH 主目录，规则与 DSH 自身一致：先看 $DSH_HOME，再回落 ~/.dsh。
 *
 * @returns DSH 主目录的绝对路径。
 */
function resolveDshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') {
    return configured.trim()
  }
  return join(homedir(), '.dsh')
}

/** 归档文件路径：跟随 DSH 主目录，和宠物自己的 memory.json 并列。 */
function archivePathOf() {
  return join(resolveDshHome(), 'dsh-pet', 'dsh-chat-archive.md')
}

/**
 * 从 DSH 会话查询服务里取最近的对话。
 *
 * 服务或检索能力缺失时返回空数组——桥接是增强项，不能因此报错。
 *
 * @param ctx - 插件上下文。
 * @param query - 本次用户说的话，用来检索最相关的历史。
 * @returns 按时间顺序排列的 { role, content } 列表。
 */
async function readDshHistory(ctx, query) {
  const sessionQuery = ctx.get?.('sessionQuery')
  if (sessionQuery === undefined || typeof sessionQuery.searchSessions !== 'function') {
    return []
  }

  try {
    const text = String(query ?? '').trim()
    if (text === '') return []

    // 分页结果可能是 { items: [...] } 或 { hits: [...] }，两者都兼容。
    const page = await sessionQuery.searchSessions({ text, limit: MAX_HISTORY_TURNS })
    const hits = Array.isArray(page?.items)
      ? page.items
      : Array.isArray(page?.hits) ? page.hits : []

    const turns = []
    for (const hit of hits) {
      // 实测结构：命中项是 { header, live, persisted, bestMatch }，正文与类型在 bestMatch 里。
      const match = hit?.bestMatch ?? hit
      const content = typeof match?.snippet === 'string' ? match.snippet.trim() : ''
      if (content === '') continue
      const role = match?.type === 'assistant/message' ? 'assistant' : 'user'
      turns.push({
        role,
        content: content.length > MAX_TURN_CHARS ? `${content.slice(0, MAX_TURN_CHARS)}…` : content,
      })
    }
    return turns
  } catch (error) {
    ctx.logger?.warn?.(`[pet-dsh-bridge] 读取 DSH 历史失败：${error instanceof Error ? error.message : String(error)}`)
    return []
  }
}

/**
 * 把 DSH 历史渲染成一段可注入人设的正文。
 *
 * @param turns - readDshHistory 的结果。
 * @returns 要拼进 system 的文本；无历史时为空串。
 */
function renderHistoryForPet(turns) {
  if (turns.length === 0) return ''
  const lines = turns.map(turn => `- ${turn.role === 'user' ? '主人' : 'DSH'}：${turn.content}`)
  return [
    '【你主人最近在 DSH 里聊过的内容】',
    ...lines,
    '（以上来自 DSH 会话记录，供你了解主人的近况；不要逐条复述，自然地融入对话即可。）',
  ].join('\n')
}

/**
 * 把一轮宠物问答追加进归档文件。
 *
 * 失败只记日志：归档是旁路，不能影响宠物回复。
 *
 * @param ctx - 插件上下文。
 * @param input - capture 钩子收到的这一轮问答。
 */
async function appendArchive(ctx, input) {
  let file
  try {
    file = archivePathOf()
  } catch (error) {
    ctx.logger?.warn?.(`[pet-dsh-bridge] 解析归档路径失败：${error instanceof Error ? error.message : String(error)}`)
    return
  }

  try {
    await mkdir(join(file, '..'), { recursive: true })

    let exists = true
    try {
      await stat(file)
    } catch {
      exists = false
    }

    const stamp = new Date(input.ts || Date.now()).toISOString()
    const messages = [
      `### ${stamp} · ${input.petId || 'pet'}`,
      '',
      `**你**：${String(input.userText ?? '').trim()}`,
      '',
      `**大肥鱼**：${String(input.replyText ?? '').trim()}`,
      '',
    ]
    if (typeof input.action === 'string' && input.action !== '') {
      messages.push(`> 动作：${input.action}`, '')
    }
    if (typeof input.image === 'string' && input.image !== '') {
      messages.push(`> 表情：${input.image}`, '')
    }

    const header = exists ? '' : `${ARCHIVE_TITLE}\n\n（本文件由 dsh-pet-dsh-bridge 自动维护）\n\n`
    await appendFile(file, header + messages.join('\n'), 'utf8')

    await trimArchive(file)
  } catch (error) {
    ctx.logger?.warn?.(`[pet-dsh-bridge] 写入归档失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * 归档超长时截掉最旧的条目，只保留最近 MAX_ARCHIVE_ENTRIES 条。
 *
 * @param file - 归档文件路径。
 */
async function trimArchive(file) {
  const raw = await readFile(file, 'utf8')
  const parts = raw.split(/^### /m)
  if (parts.length <= MAX_ARCHIVE_ENTRIES + 1) return

  const head = parts[0]
  const kept = parts.slice(-MAX_ARCHIVE_ENTRIES)
  await writeFile(file, head + kept.map(part => '### ' + part).join(''), 'utf8')
}

/**
 * 包一层超时，超时返回 undefined（语义等同“不修改”）。
 *
 * @param promise - 要限时的任务。
 * @param ms - 超时毫秒数。
 * @returns 任务结果或 undefined。
 */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise(resolve => {
      const timer = setTimeout(() => resolve(undefined), ms)
      timer.unref?.()
    }),
  ])
}

export function apply(ctx) {
  const petApi = ctx.get('petApi7340')
  const register = petApi?.memory?.register
  if (typeof register !== 'function') {
    ctx.logger?.warn?.('[pet-dsh-bridge] petApi7340.memory.register 不可用，桥接未启用')
    return
  }

  const provider = {
    id: 'dsh-bridge',

    /**
     * 宠物开口前：把手里的近期历史替换为「宠物自己的近期历史 + DSH 会话摘要」。
     * 只扩展 system，不动 history——宠物的人设与说话风格不能被 DSH 的记录覆盖。
     */
    async recall(input) {
      const turns = await withTimeout(readDshHistory(ctx, input.userText), RECALL_TIMEOUT_MS)
      if (!Array.isArray(turns) || turns.length === 0) return undefined

      const rendered = renderHistoryForPet(turns)
      if (rendered === '') return undefined

      return { system: `${input.system}\n\n${rendered}` }
    },

    /** 宠物说完后：把这一轮归档，供 DSH 侧读取。 */
    async capture(input) {
      await appendArchive(ctx, input)
    },
  }

  const dispose = register(provider)
  ctx.logger?.info?.('[pet-dsh-bridge] 已接入 dsh-pet 对话记忆，双向桥接启用')

  // 插件卸载时注销，避免残留 provider 指向已销毁的 ctx。
  if (typeof dispose === 'function') {
    ctx.on?.('dispose', () => {
      try {
        dispose()
      } catch {
        /* 卸载清理失败不应阻塞关停 */
      }
    })
  }
}
