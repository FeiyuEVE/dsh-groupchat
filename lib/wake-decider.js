/**
 * wake-decider — 用本地 Jev 风格决策模型回答一个选择题：
 * 「这批新消息该把**谁**叫起来」。
 *
 * 为什么是「选人」而不是「逐人判是/否」：逐人二分类里，小模型对**每一个人**
 * 都容易回答「该叫」（消息看起来确实重要），于是精确率崩到 0.2 量级；而
 * 在 N 个候选之间做多选一正是这类决策模型训练时的形态（choice over
 * candidates），它必须把人**比**出来。同一个 1.7B 换问法后（30 条消息 ×
 * 10 成员），阈值 0.30 上精确率 0.848 / 召回率 0.848，延迟还从 482ms
 * 降到 163ms —— 一次请求问完全员，状态只编码一遍。
 *
 * 三条硬约束，写在代码里而不是提示词里：
 *
 *  1. **只影响「唤醒」，不影响「投递」。** 消息本来就通过 inject 进排队
 *     （不花钱，成员下次自然干活时看到）。这里判的是要不要额外 followup
 *     把它从 idle 拽起来。所以「不被选中」永远不是丢失。
 *  2. **fail-closed。** 决策服务没起来、超时、返回形状不对 —— 一律按「谁都不叫」
 *     处理，退回原来的「只有 @ 才唤醒」。错判成唤醒要花一整轮 token，错判成
 *     不唤醒只是晚点到，代价不对称。
 *  3. **@ 不走模型。** 被人类或验收官 @ 的成员由 @ 机制直接唤醒（确定性、
 *     零延迟）；窗口里只要有人被 @，他也不进候选。
 *
 * 模型只吃英文（上游是英文训练集），所以调用方负责把内容译好再传进来。
 */

/**
 * 决策服务不可达时的默认超时；超过就按 fail-closed 处理。
 * 3s 而不是 1.5s：模型首次调用要吃 CUDA 预热，实测单次能到 0.6s 上下，机器
 * 上再跑着别的 GPU 活时更慢；1.5s 会把「模型其实答得出来」误判成失败。
 */
export const DECIDE_TIMEOUT_MS = 3000
/**
 * 唤醒阈值。概率在「候选成员 + nobody」上归一化，所以阈值远小于 0.5：
 * 10 个候选时均匀分布才 0.09。0.20 是 30 条样本上的平衡点
 * （召回 0.848 / 精确 0.80）；调到 0.15 换更高召回、0.30 换更高精确。
 */
export const DECIDE_THRESHOLD = 0.2
/** 决策请求里带几条历史消息做上下文。 */
const HISTORY_LINES = 6
/** 单行截断，防止一条长贴把 state 撑爆。 */
const LINE_CAP = 200

function clip(text, cap) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length <= cap ? s : `${s.slice(0, cap)}…`
}

/**
 * 把一批消息渲染成模型看的 state。历史在前（上文背景），本批在后并带编号，
 * 这样「这条」指代明确。
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
    lines.push(`${items.length === 1 ? '-' : `${i + 1}.`} ${clip(it.from, 40)}: ${clip(it.text, LINE_CAP)}`)
  })
  return lines.join('\n')
}

/** 一个 choice 问题：候选成员各占一项，外加 nobody。 */
export function buildQuestion(candidates) {
  const criteria = {}
  for (const c of candidates) {
    criteria[c.nick] = `job: ${c.duty}.`
      + (c.task ? ` Currently busy with: ${c.task}.` : '')
  }
  criteria.nobody = 'Nobody. It is an announcement, small talk, or belongs to no one in this group. '
    + 'Waking anyone would waste a turn.'
  return {
    type: 'choice',
    instructions: 'Which member should the new group messages wake up right now? '
      + 'Only pick someone whose own job these messages actually fall in.',
    criteria,
  }
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
  // 服务挂了的话每轮都会失败；只把第一条 warn 打出来，免得刷屏。
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
     * 问一轮。永远 resolve，永不抛 —— 失败就是「谁都不叫」。
     * 返回 `{ picked: Set<nick>, probabilities, reason }`；只有 `reason === 'model'`
     * 时 `probabilities` 才有意义。
     */
    async choose({ candidates, items, history }) {
      const none = { picked: new Set(), probabilities: {}, reason: 'disabled' }
      if (!enabled) return none
      if (candidates.length === 0 || items.length === 0) return none
      const body = {
        state: renderState({ history, items }),
        questions: { wake: buildQuestion(candidates) },
      }
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
          return { ...none, reason: `http-${res.status}` }
        }
        const json = await res.json()
        const probs = json?.answers?.wake?.probabilities
        if (probs === null || typeof probs !== 'object') {
          note('unexpected response shape')
          return { ...none, reason: 'bad-shape' }
        }
        const probabilities = {}
        const picked = new Set()
        let sane = false
        for (const c of candidates) {
          const p = probs[c.nick]
          if (typeof p !== 'number' || !Number.isFinite(p)) continue
          sane = true
          probabilities[c.nick] = p
          if (p >= th) picked.add(c.nick)
        }
        if (!sane) {
          note('no usable probabilities')
          return { ...none, reason: 'bad-shape' }
        }
        warned = false
        return { picked, probabilities, reason: 'model' }
      } catch (error) {
        const timedOut = error?.name === 'AbortError'
        note(timedOut ? `timeout ${budget}ms` : 'fetch failed', error)
        return { ...none, reason: timedOut ? 'timeout' : 'error' }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
