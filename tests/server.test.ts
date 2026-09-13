import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { createApp } from '../server/app.js'
import { configurationMessage, getConfigurationStatus } from '../server/config.js'

test('missing or blank environment values give actionable names without throwing', () => {
  const status = getConfigurationStatus({ LLM_API_KEY: '   ' })
  assert.equal(status.ready, false)
  assert.deepEqual(status.missing, ['LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL', 'DATABASE_URL'])
  assert.match(configurationMessage(status), /配置 .env 后重启后端/)
})

test('configuration reports never contain credential values', () => {
  const status = getConfigurationStatus({
    LLM_API_KEY: 'private-key-sentinel',
    LLM_BASE_URL: 'https://example.com/v1?api_key=private-key-sentinel',
    LLM_MODEL: 'private-model-sentinel',
    DATABASE_URL: 'postgres://user:private-db-sentinel@localhost/demo',
  })
  assert.deepEqual(status.invalid, ['LLM_BASE_URL'])
  assert.equal(status.ready, false)
  assert.doesNotMatch(JSON.stringify(status) + configurationMessage(status), /sentinel/)

  const configured = getConfigurationStatus({
    LLM_API_KEY: 'private-key-sentinel',
    LLM_BASE_URL: 'https://example.com/v1',
    LLM_MODEL: 'private-model-sentinel',
    DATABASE_URL: 'postgres://user:private-db-sentinel@localhost/demo',
  })
  assert.equal(configured.ready, true)
  assert.match(configurationMessage(configured), /尚未验证/)
})

test('API stays available without configuration and does not serve private files or raw errors', async () => {
  const server = createApp().listen(0, '127.0.0.1')
  try {
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}`
    const health = await fetch(`${base}/api/health`)
    assert.equal(health.status, 200)
    assert.equal(health.headers.get('cache-control'), 'no-store')
    const body = await health.json()
    assert.equal(body.status, 'ok')
    assert.equal(body.service, 'interrogation-api')
    assert.deepEqual(Object.keys(body.configuration).sort(), ['invalid', 'missing', 'ready'])

    for (const path of ['/.env', '/server/config.ts', '/tests/fixtures/private/case.txt']) {
      const response = await fetch(`${base}${path}`)
      assert.equal(response.status, 404)
    }
    const invalidJson = await fetch(`${base}/api/health`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"key":"private-key-sentinel",',
    })
    assert.equal(invalidJson.status, 400)
    assert.doesNotMatch(await invalidJson.text(), /sentinel|SyntaxError|stack/)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

/** 案件接口测试共用的临时服务器，避免每个用例重复写 listen/close。 */
async function withServer(run: (base: string) => Promise<void>) {
  const server = createApp().listen(0, '127.0.0.1')
  try {
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

/** 约 400 个字符，满足最小长度；其中一段用作「响应不得回传原文」的探针。 */
const CASE_PROBE = '探针文本不应出现在响应中'
const VALID_CASE_TEXT = [
  '案件名称：接口测试案件',
  CASE_PROBE,
  ...Array.from({ length: 12 }, (_, index) => `线索 ${index + 1}：本段仅用于满足案件文本的最小长度要求。`),
].join('\n')

function submitCase(base: string, payload: unknown) {
  return fetch(`${base}/api/cases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  })
}

test('submitting pasted text returns statistics and never echoes the case text', async () => {
  await withServer(async (base) => {
    const response = await submitCase(base, {
      sourceText: VALID_CASE_TEXT,
      sourceType: 'paste',
      title: '接口测试案件',
    })

    assert.equal(response.status, 201)
    assert.equal(response.headers.get('cache-control'), 'no-store')

    const body = await response.json()
    assert.match(body.caseId, /^case_[0-9a-f-]{36}$/)
    assert.equal(body.title, '接口测试案件')
    assert.equal(body.status, 'parsing')
    assert.equal(body.sourceType, 'paste')
    assert.equal(body.textStats.charCount, Array.from(VALID_CASE_TEXT).length)
    assert.equal(body.textStats.lineCount, VALID_CASE_TEXT.split('\n').length)
    assert.ok(!Number.isNaN(Date.parse(body.createdAt)))
    assert.equal(typeof body.message, 'string')

    // 字段集合固定：既保证契约稳定，也确认没有多余字段（例如 sourceText）泄漏出去。
    assert.deepEqual(
      Object.keys(body).sort(),
      ['caseId', 'createdAt', 'message', 'sourceType', 'status', 'textStats', 'title'],
    )
    assert.doesNotMatch(JSON.stringify(body), new RegExp(CASE_PROBE))
  })
})

test('uploaded .txt files go through the same endpoint and derive the title from the file name', async () => {
  await withServer(async (base) => {
    const response = await submitCase(base, {
      sourceText: VALID_CASE_TEXT,
      sourceType: 'file',
      fileName: '占星术杀人魔法.txt',
    })

    assert.equal(response.status, 201)
    const body = await response.json()
    assert.equal(body.sourceType, 'file')
    assert.equal(body.fileName, '占星术杀人魔法.txt')
    assert.equal(body.title, '占星术杀人魔法')
    assert.doesNotMatch(JSON.stringify(body), new RegExp(CASE_PROBE))
  })
})

test('case submission rejects empty, short, oversized and unknown payloads with actionable codes', async () => {
  await withServer(async (base) => {
    const scenarios: Array<[unknown, string]> = [
      [{ sourceText: '   ', sourceType: 'paste' }, 'TEXT_REQUIRED'],
      [{ sourceType: 'paste' }, 'TEXT_REQUIRED'],
      [{ sourceText: '文本过短', sourceType: 'paste' }, 'TEXT_TOO_SHORT'],
      [{ sourceText: '甲'.repeat(200_001), sourceType: 'paste' }, 'TEXT_TOO_LONG'],
      [{ sourceText: VALID_CASE_TEXT, sourceType: 'unknown' }, 'INVALID_SOURCE_TYPE'],
      [{ sourceText: VALID_CASE_TEXT }, 'INVALID_SOURCE_TYPE'],
    ]

    for (const [payload, code] of scenarios) {
      const response = await submitCase(base, payload)
      assert.equal(response.status, 400)
      const body = await response.json()
      assert.equal(body.code, code)
      assert.equal(typeof body.error, 'string')
      assert.ok(body.error.length > 0)
      assert.doesNotMatch(JSON.stringify(body), /SyntaxError|stack|sentinel/)
    }

    // 请求体不是对象（例如顶层字符串）时由 JSON 解析层拒绝，但仍返回安全的 400。
    const notAnObject = await submitCase(base, '"不是对象"')
    assert.equal(notAnObject.status, 400)
    const notAnObjectBody = await notAnObject.json()
    assert.equal(notAnObjectBody.error, '请求 JSON 格式无效。')
    assert.doesNotMatch(JSON.stringify(notAnObjectBody), /SyntaxError|stack/)
  })
})

test('case lookup returns the submitted case and a clear error for unknown ids', async () => {
  await withServer(async (base) => {
    const created = await submitCase(base, {
      sourceText: VALID_CASE_TEXT,
      sourceType: 'preset',
      title: '预置案件',
    })
    const summary = await created.json()

    const found = await fetch(`${base}/api/cases/${summary.caseId}`)
    assert.equal(found.status, 200)
    assert.equal(found.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await found.json(), summary)

    const missing = await fetch(`${base}/api/cases/case_00000000-0000-0000-0000-000000000000`)
    assert.equal(missing.status, 404)
    const missingBody = await missing.json()
    assert.equal(missingBody.code, 'CASE_NOT_FOUND')
    assert.doesNotMatch(JSON.stringify(missingBody), /SyntaxError|stack/)
  })
})
