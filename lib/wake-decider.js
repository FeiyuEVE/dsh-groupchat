/**
 * wake-decider — 用本地 Jev 风格决策模型回答一个二选一：
 * 「这条群消息该不该**现在唤醒**这个成员」。
 *
 * 为什么不是让模型生成一句话：Jev 类模型一次前向就给出「类型化问题」的
 * 校准概率（choice / noul / score），不产出任何文字。我们只要一个 0..1 的
 * 数来决定要不要花掉这个成员一整个 turn 的 token，正是它的场景。
 *
 * 三条硬约束，写在代码里而不是提示词里：
 *
 *  1. **只影响「唤醒」，不影响「投递」。** 消息本来就通过 inject 进排队
 *     （不花钱，成员下次自然干活时看到）。这里判的是要不要额外 followup
 *     把它从 idle 拽起来。所以「不唤醒」永远不是丢失。
 *  2. **fail-closed。** 决策服务没起来、超时、返回形状不对 —— 一律按「不唤醒」
 *     处理，退回原来的「只有 @ 才唤醒」。错判成唤醒要花 token，错判成不唤醒
 *     只是晚点到，代价不对称。
 *  3. **@ 不走模型。** 被人类或验收官 @ 的成员由 @ 机制直接唤醒（确定性、
 *     零延迟）。只有**没有任何 @ 指向它**的批次才来这里问一句。
 *
 * 模型只吃英文（上游是英文训练集），所以这里要求调用方传入已译好的
 * 英文文本；中文原文的代价由调用方在 config 里量过再决定。
 */

/** 决策服务不可达时的默认超时；超过就按 fail-closed 处理。 */
export const DECIDE_TIMEOUT_MS = 1500
/**
 * 唤醒阈值。0.5 是模型自己的 argmax 分界，但「误唤醒」的代价是**一整轮
 * turn 的 token**，而「漏唤醒」只是一条消息晚到 —— 所以默认往上抬。
 * 具体值由 eval 的阈值扫描定，配置项可覆盖。
 */
export const DECIDE_THRESHOLD = 0.7
/** 决策请求里带几条历史消息做上下文。 */
const HISTORY_LINES = 6
/** 单行截断，防止一条长贴把 state 撑爆。 */
const LINE_CAP = 200

function clip(text, cap) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length <= cap ? s : `${s.slice(0, cap)}…`
}

/**
 * 一个成员一条 noul 问题。noul 直接给 p(yes)，比 choice 的
 * confidence=(p-1/k)/(1-1/k) 好解释，阈值也好定。
 */
function questionFor(member) {
  const who = member.nick
  return {
    type: 'noul',
    instructions:
      `Should ${who} be woken up now to deal with these messages?\n`
      + `${who}'s job: ${member.duty}.\n`
      + `${who} is currently busy with: ${member.task}.`,
    criteria: {
      true: `Yes. This message is ${who}'s to handle, or they are the one who must act on it right now.`,
      false: 'No. It belongs to someone else, it is an announcement, or it is small talk. '
        + 'Waking them burns a whole turn for nothing.',
    },
  }
}

/**
 * 把一批消息渲染成模型看的 state。历史在前面（它是上文的背景），
 * 本批在后面并带编号，这样「这条」指代明确。
 */
export function renderState({ history = [], items }) {
  const lines = []
  if (history.length > 0) {
    lines.push('Earlier in the group:')
    for (const h of history.slice(-HISTORY_LINES)) {
      lines.push(`- ${clip(h.from, 40)}: ${clip(h.text, LINE_CAP)}`)
    }
    lines.push('')
  }
  lines.push(items.length === 1 ? 'New message in the group:' : `New messages in the group (${items.length}):`)
  items.forEach((it, i) => {
    const tag = it.addressed ? ' (addressed to you)' : ''
    lines.push(`${items.length === 1 ? '-' : `${i + 1}.`} ${clip(it.from, 40)}${tag}: ${clip(it.text, LINE_CAP)}`)
  })
  return lines.join('\n')
}

/**
 * 建一个决策器。`endpoint` 是 wev serve 的根（如 http://127.0.0.1:8009），
 * 空字符串表示未配置 —— 此时 `enabled` 为 false，调用方走原有的「只有 @ 唤醒」。
 */
export function createWakeDecider({ endpoint, threshold = DECIDE_THRESHOLD, timeoutMs = DECIDE_TIMEOUT_MS, logger } = {}) {
  const base = typeof endpoint === 'string' ? endpoint.trim().replace(/\/+$/, '') : ''
  const enabled = base.length > 0
  const th = Number.isFinite(threshold) ? threshold : DECIDE_THRESHOLD
  const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DECIDE_TIMEOUT_MS
  // 服务挂了的话每个批次都会失败；只把第一条 warn 打出来，免得刷一屏。
  let warned = false

  function note(why, error) {
    if (warned) return
    warned = true
    logger?.warn?.(`groupchat: wake decider unavailable (${why}); falling back to "@ only" wakes`, error)
  }

  return {
    enabled,
    threshold: th,
    endpoint: base,

    /**
     * 问一次。永远 resolve，永不抛 —— 失败就是 `{ wake: false }`。
     * 一个成员一条问题：状态编码一次，问题各看各的，答案与提问顺序无关。
     */
    async decide({ member, items, history }) {
      if (!enabled) return { wake: false, p: null, reason: 'disabled' }
      const state = renderState({ history, items })
      const body = { state, questions: { wake: questionFor(member) } }
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), budget)
      if (typeof timer.unref === 'function') timer.unref()
      try {
        const res = await fetch(`${base}/v1/systemone`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: ctl.signal,
        })
        if (!res.ok) {
          note(`HTTP ${res.status}`)
          return { wake: false, p: null, reason: `http-${res.status}` }
        }
        const json = await res.json()
        const p = json?.answers?.wake?.noul
        if (typeof p !== 'number' || !Number.isFinite(p)) {
          note('unexpected response shape')
          return { wake: false, p: null, reason: 'bad-shape' }
        }
        warned = false
        return { wake: p >= th, p, reason: 'model' }
      } catch (error) {
        note(error?.name === 'AbortError' ? `timeout ${budget}ms` : 'fetch failed', error)
        return { wake: false, p: null, reason: 'error' }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
