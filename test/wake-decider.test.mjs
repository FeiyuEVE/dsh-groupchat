#!/usr/bin/env node
/**
 * wake-decider 的单测：不依赖决策模型本身，用本地 mock 覆盖四条关键路径。
 *
 * 跑法：node test/wake-decider.test.mjs
 * 退出码 0 = 全过。
 */
import { createServer } from 'node:http'
import assert from 'node:assert'
import { createWakeDecider, renderState } from '../lib/wake-decider.js'

const passthrough = { warn() {}, info() {} }

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

const member = { nick: '后端阿杰', duty: 'HTTP API、数据库主从、连接池', task: '给网关加限流' }
const items = [{ from: '用户', text: '登录接口 500，连接池耗尽', addressed: false }]

const checks = []
function check(name, fn) { checks.push({ name, fn }) }

check('阈值内 p 高 → 唤醒', async () => {
  await withServer((req, res) => {
    assert.strictEqual(req.url, '/v1/systemone')
    assert.strictEqual(req.method, 'POST')
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ answers: { wake: { type: 'noul', noul: 0.93 } } }))
  }, async base => {
    const d = createWakeDecider({ endpoint: base, threshold: 0.7, logger: passthrough })
    const r = await d.decide({ member, items, history: [] })
    assert.strictEqual(r.reason, 'model')
    assert.strictEqual(r.wake, true)
    assert.ok(Math.abs(r.p - 0.93) < 1e-9)
  })
})

check('p 低于阈值 → 不唤醒（但仍然是 model 判定，不是 fallback）', async () => {
  await withServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ answers: { wake: { type: 'noul', noul: 0.41 } } }))
  }, async base => {
    const d = createWakeDecider({ endpoint: base, threshold: 0.7, logger: passthrough })
    const r = await d.decide({ member, items, history: [] })
    assert.strictEqual(r.reason, 'model')
    assert.strictEqual(r.wake, false)
  })
})

check('返回形状不对 → fail-closed', async () => {
  await withServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ answers: {} }))
  }, async base => {
    const d = createWakeDecider({ endpoint: base, threshold: 0.5, logger: passthrough })
    const r = await d.decide({ member, items, history: [] })
    assert.strictEqual(r.wake, false)
    assert.strictEqual(r.reason, 'bad-shape')
  })
})

check('HTTP 5xx → fail-closed', async () => {
  await withServer((req, res) => {
    res.statusCode = 503
    res.end('nope')
  }, async base => {
    const d = createWakeDecider({ endpoint: base, threshold: 0.5, logger: passthrough })
    const r = await d.decide({ member, items, history: [] })
    assert.strictEqual(r.wake, false)
    assert.strictEqual(r.reason, 'http-503')
  })
})

check('服务不响应 → 超时 fail-closed，且不悬挂', async () => {
  await withServer(() => { /* 永不响应 */ }, async base => {
    const d = createWakeDecider({ endpoint: base, threshold: 0.5, timeoutMs: 200, logger: passthrough })
    const t0 = Date.now()
    const r = await d.decide({ member, items, history: [] })
    const dt = Date.now() - t0
    assert.strictEqual(r.wake, false)
    assert.strictEqual(r.reason, 'error')
    assert.ok(dt < 1200, `超时应在 200ms 量级返回，实际 ${dt}ms`)
  })
})

check('没配 endpoint → 禁用，连请求都不发', async () => {
  const d = createWakeDecider({ endpoint: '', logger: passthrough })
  assert.strictEqual(d.enabled, false)
  const r = await d.decide({ member, items, history: [] })
  assert.strictEqual(r.wake, false)
  assert.strictEqual(r.reason, 'disabled')
})

check('renderState 带历史、标出「这条」', async () => {
  const s = renderState({
    history: [{ from: '运维老张', text: '代理在查了' }],
    items: [{ from: '用户', text: '登录 500', addressed: false }, { from: '用户', text: '主从延迟 3 秒', addressed: false }],
  })
  assert.ok(s.includes('Earlier in the group:'), '应带历史')
  assert.ok(s.includes('New messages in the group (2):'), '应标条数')
  assert.ok(s.includes('1. 用户: 登录 500'), '应编号')
  assert.ok(s.includes('2. 用户: 主从延迟 3 秒'), '应编号')
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
