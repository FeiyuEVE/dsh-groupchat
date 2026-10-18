#!/usr/bin/env node
/**
 * wake-decider 的单测：不依赖决策模型本身，用本地 mock 覆盖关键路径。
 *
 * 跑法：node test/wake-decider.test.mjs
 * 退出码 0 = 全过。
 */
import { createServer } from 'node:http'
import assert from 'node:assert'
import { createWakeDecider, renderState, buildQuestion } from '../lib/wake-decider.js'

const silent = { warn() {}, info() {} }

/** 起一个只有 /v1/systemone 的假服务，行为由 handler 决定。 */
async function withServer(handler, fn) {
  const server = createServer((req, res) => handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    return await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

const candidates = [
  { nick: '后端阿杰', duty: 'HTTP API、数据库主从、连接池', task: '给网关加限流' },
  { nick: '小前', duty: 'Web UI、React 组件', task: '重排设置面板' },
  { nick: '运维老张', duty: '代理链路、mihomo 节点', task: '查出口' },
]
const items = [{ from: '用户', text: '登录接口 500，连接池耗尽' }]

/** 统一的应答形状（wev 的 choice 回来就是 probabilities 字典）。 */
const reply = probs => (req, res) => {
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ answers: { wake: { type: 'choice', choice: 'x', confidence: 0.9, probabilities: probs } } }))
}

const checks = []
function check(name, fn) { checks.push({ name, fn }) }

check('阈值以上被选中，其余不进集合', async () => {
  await withServer(reply({ 后端阿杰: 0.93, 小前: 0.02, 运维老张: 0.01, nobody: 0.04 }), async base => {
    const d = createWakeDecider({ endpoint: base, threshold: 0.2, logger: silent })
    const r = await d.choose({ candidates, items, history: [] })
    assert.strictEqual(r.reason, 'model')
    assert.deepStrictEqual([...r.picked], ['后端阿杰'])
    assert.strictEqual(r.probabilities['小前'], 0.02)
  })
})

check('多人过阈值时都选中（多收件人的消息不能只叫一个人）', async () => {
  await withServer(reply({ 后端阿杰: 0.55, 小前: 0.35, 运维老张: 0.02, nobody: 0.08 }), async base => {
    const d = createWakeDecider({ endpoint: base, threshold: 0.2, logger: silent })
    const r = await d.choose({ candidates, items, history: [] })
    assert.deepStrictEqual([...r.picked].sort(), ['后端阿杰', '小前'].sort())
  })
})

check('全都不够阈值 -> 谁都不叫，但仍是 model 判定', async () => {
  await withServer(reply({ 后端阿杰: 0.11, 小前: 0.05, 运维老张: 0.02, nobody: 0.82 }), async base => {
    const d = createWakeDecider({ endpoint: base, threshold: 0.2, logger: silent })
    const r = await d.choose({ candidates, items, history: [] })
    assert.strictEqual(r.reason, 'model')
    assert.strictEqual(r.picked.size, 0)
  })
})

check('返回里没有 probabilities -> fail-closed', async () => {
  await withServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ answers: {} }))
  }, async base => {
    const d = createWakeDecider({ endpoint: base, threshold: 0.2, logger: silent })
    const r = await d.choose({ candidates, items, history: [] })
    assert.strictEqual(r.reason, 'bad-shape')
    assert.strictEqual(r.picked.size, 0)
  })
})

check('probabilities 里一个候选都没有 -> fail-closed（不是「谁都不叫」）', async () => {
  await withServer(reply({ 陌生人: 0.9, nobody: 0.1 }), async base => {
    const d = createWakeDecider({ endpoint: base, threshold: 0.2, logger: silent })
    const r = await d.choose({ candidates, items, history: [] })
    assert.strictEqual(r.reason, 'bad-shape')
  })
})

check('HTTP 5xx -> fail-closed', async () => {
  await withServer((req, res) => {
    res.statusCode = 503
    res.end('nope')
  }, async base => {
    const d = createWakeDecider({ endpoint: base, threshold: 0.2, logger: silent })
    const r = await d.choose({ candidates, items, history: [] })
    assert.strictEqual(r.reason, 'http-503')
    assert.strictEqual(r.picked.size, 0)
  })
})

check('服务不响应 -> 超时 fail-closed，且不悬挂', async () => {
  await withServer(() => { /* 永不响应 */ }, async base => {
    const d = createWakeDecider({ endpoint: base, threshold: 0.2, timeoutMs: 200, logger: silent })
    const t0 = Date.now()
    const r = await d.choose({ candidates, items, history: [] })
    const dt = Date.now() - t0
    assert.strictEqual(r.reason, 'error')
    assert.ok(dt < 1200, `超时应在 200ms 量级返回，实际 ${dt}ms`)
  })
})

check('没配 endpoint -> 禁用，连请求都不发', async () => {
  const d = createWakeDecider({ endpoint: '', logger: silent })
  assert.strictEqual(d.enabled, false)
  const r = await d.choose({ candidates, items, history: [] })
  assert.strictEqual(r.reason, 'disabled')
  assert.strictEqual(r.picked.size, 0)
})

check('没有候选 / 没有消息 -> 不发请求', async () => {
  let hits = 0
  await withServer((req, res) => { hits += 1; reply({})(req, res) }, async base => {
    const d = createWakeDecider({ endpoint: base, threshold: 0.2, logger: silent })
    await d.choose({ candidates: [], items, history: [] })
    await d.choose({ candidates, items: [], history: [] })
    assert.strictEqual(hits, 0)
  })
})

check('请求体形状对得上 wev：state 是字符串、questions.wake 是 choice', async () => {
  let seen = null
  await withServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => { seen = JSON.parse(body); reply({ 后端阿杰: 0.9, nobody: 0.1 })(req, res) })
  }, async base => {
    const d = createWakeDecider({ endpoint: base, threshold: 0.2, logger: silent })
    await d.choose({ candidates, items, history: [{ from: '运维老张', text: '在查出口' }] })
    assert.strictEqual(typeof seen.state, 'string')
    assert.ok(seen.state.includes('Earlier in the group:'))
    assert.ok(seen.state.includes('登录接口 500'))
    const q = seen.questions.wake
    assert.strictEqual(q.type, 'choice')
    assert.ok(Object.keys(q.criteria).includes('后端阿杰'))
    assert.ok(Object.keys(q.criteria).includes('nobody'))
  })
})

check('renderState 带历史、标出条数并编号', async () => {
  const s = renderState({
    history: [{ from: '运维老张', text: '代理在查了' }],
    items: [{ from: '用户', text: '登录 500' }, { from: '用户', text: '主从延迟 3 秒' }],
  })
  assert.ok(s.includes('Earlier in the group:'))
  assert.ok(s.includes('New messages in the group (2):'))
  assert.ok(s.includes('1. 用户: 登录 500'))
  assert.ok(s.includes('2. 用户: 主从延迟 3 秒'))
})

check('buildQuestion 把每个人的职责写进对应选项', () => {
  const q = buildQuestion(candidates)
  assert.ok(q.criteria['后端阿杰'].includes('HTTP API'))
  assert.ok(q.criteria['小前'].includes('React'))
  assert.ok(q.criteria.nobody.length > 0)
})

let failed = 0
for (const { name, fn } of checks) {
  try {
    await fn()
    console.log(`  ok    ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL  ${name}\n        ${error && error.message || error}`)
  }
}
console.log(`\n${checks.length - failed}/${checks.length} 通过`)
process.exit(failed === 0 ? 0 : 1)
