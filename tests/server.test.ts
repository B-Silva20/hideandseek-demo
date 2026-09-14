import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { createApp } from '../server/app.js'
import { configurationMessage, getConfigurationStatus } from '../server/config.js'
import { createCase, toCaseSummary, updateCase } from '../server/services/caseStore.js'

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
      const contentType = response.headers.get('content-type') ?? ''
      assert.ok(response.status === 404 || contentType.startsWith('text/html'))
      assert.doesNotMatch(await response.text(), /private-key-sentinel|private-db-sentinel/)
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

function createReadyCase() {
  const created = createCase({ sourceText: VALID_CASE_TEXT, sourceType: 'paste', title: '接口测试案件' })
  assert.equal(created.ok, true)
  if (!created.ok) throw new Error('测试案件创建失败')
  const record = updateCase(created.record.caseId, {
    status: 'ready',
    message: '案件解析完成。',
    parsed: {
      playerRole: '调查人员',
      characters: ['甲：证人', '乙：相关人物'],
      relationships: ['甲与乙认识'],
      evidence: ['门口录像', '现场记录'],
      timeline: ['案发当晚，调查人员抵达现场。'],
      truth: '甲隐瞒了关键事实。',
      culprit: '甲',
    },
  })
  assert.ok(record)
  return toCaseSummary(record)
}

function submitCase(base: string, payload: unknown) {
  return fetch(`${base}/api/cases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  })
}

function postJson(base: string, path: string, payload: unknown) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

/**
 * 临时清空模型环境变量，强制走规则回退。
 * 审讯接口在模型不可用时会回退到确定性回复，所以这样测出来的结果是稳定且不联网的；
 * 否则一旦本机配了密钥，测试会真的调用模型（甚至等满 45 秒超时）。
 */
async function withoutModel<T>(run: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {
    LLM_API_KEY: process.env.LLM_API_KEY,
    LLM_BASE_URL: process.env.LLM_BASE_URL,
    LLM_MODEL: process.env.LLM_MODEL,
  }
  for (const key of Object.keys(saved)) delete process.env[key]
  try {
    return await run()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
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

test('uploaded .txt files go through the same endpoint and derive the title from their text', async () => {
  await withServer(async (base) => {
    const response = await submitCase(base, {
      sourceText: VALID_CASE_TEXT,
      sourceType: 'file',
      fileName: '测试案件.txt',
    })

    assert.equal(response.status, 201)
    const body = await response.json()
    assert.equal(body.sourceType, 'file')
    assert.equal(body.fileName, '测试案件.txt')
    assert.equal(body.title, '接口测试案件')
    assert.doesNotMatch(JSON.stringify(body), new RegExp(CASE_PROBE))
  })
})

test('case title prefers a clearly marked title in the supplied text over a generic file name', async () => {
  await withServer(async (base) => {
    const titledText = ['案件名称：占星术杀人事件', VALID_CASE_TEXT].join('\n')
    const response = await submitCase(base, {
      sourceText: titledText,
      sourceType: 'file',
      fileName: '未命名案件.txt',
    })
    assert.equal(response.status, 201)
    assert.equal((await response.json()).title, '占星术杀人事件')
  })
})

test('case title uses a short first line in a supplied text file when no label is present', async () => {
  await withServer(async (base) => {
    const titledText = ['占星术杀人事件', VALID_CASE_TEXT].join('\n')
    const response = await submitCase(base, {
      sourceText: titledText,
      sourceType: 'file',
      fileName: '未命名案件.txt',
    })
    assert.equal(response.status, 201)
    assert.equal((await response.json()).title, '占星术杀人事件')
  })
})

test('case title skips ebook boilerplate and uses the book title before its author line', async () => {
  await withServer(async (base) => {
    const titledText = [
      '声明：本书由用户上传，本站仅提供文本存储服务。',
      '---------------------------用户上传内容开始--------------------------------',
      '',
      '占星术杀人魔法',
      '作者：岛田庄司',
      VALID_CASE_TEXT,
    ].join('\n')
    const response = await submitCase(base, {
      sourceText: titledText,
      sourceType: 'file',
      fileName: '未命名案件.txt',
    })
    assert.equal(response.status, 201)
    assert.equal((await response.json()).title, '占星术杀人魔法')
  })
})

test('case submission rejects empty, short, oversized and unknown payloads with actionable codes', async () => {
  await withServer(async (base) => {
    const scenarios: Array<[unknown, string]> = [
      [{ sourceText: '   ', sourceType: 'paste' }, 'TEXT_REQUIRED'],
      [{ sourceType: 'paste' }, 'TEXT_REQUIRED'],
      [{ sourceText: '文本过短', sourceType: 'paste' }, 'TEXT_TOO_SHORT'],
      [{ sourceText: '甲'.repeat(1_000_001), sourceType: 'paste' }, 'TEXT_TOO_LONG'],
      [{ sourceText: VALID_CASE_TEXT, sourceType: 'preset' }, 'INVALID_SOURCE_TYPE'],
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
      sourceType: 'paste',
      title: '接口测试案件',
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

test('saves API lists progress only, then deletes a save by id', async () => {
  await withServer(async (base) => {
    const summary = createReadyCase()
    const sessionResponse = await postJson(base, '/api/sessions', { caseId: summary.caseId })
    assert.equal(sessionResponse.status, 201)
    const session = await sessionResponse.json()

    const listResponse = await fetch(`${base}/api/saves`)
    assert.equal(listResponse.status, 200)
    assert.equal(listResponse.headers.get('cache-control'), 'no-store')
    const list = await listResponse.json()
    const slot = list.saves.find((item: { sessionId: string }) => item.sessionId === session.sessionId)
    assert.ok(slot)
    assert.equal(slot.caseTitle, summary.title)
    assert.equal(slot.turn, 0)
    assert.equal(slot.actionPoints, slot.actionPointsTotal)
    assert.equal(slot.caseConfidence, 0)
    assert.equal(slot.gameState, 'active')
    assert.equal(slot.endingKind, null)
    assert.ok(slot.suspects >= 1)
    // 存档摘要只带进度：既不回传案件原文，也不泄露案件真相。
    assert.doesNotMatch(JSON.stringify(slot), /sourceText|凶手|手记制造/)

    const removed = await fetch(`${base}/api/saves/${session.sessionId}`, { method: 'DELETE' })
    assert.equal(removed.status, 204)
    const after = await (await fetch(`${base}/api/saves`)).json()
    assert.equal(after.saves.some((item: { sessionId: string }) => item.sessionId === session.sessionId), false)

    const missing = await fetch(`${base}/api/saves/${session.sessionId}`, { method: 'DELETE' })
    assert.equal(missing.status, 404)
    assert.equal((await missing.json()).error, '未找到该存档。')
  })
})

test('session difficulty controls the action-point limit and practice mode never consumes it', async () => {
  await withoutModel(() => withServer(async (base) => {
    const summary = createReadyCase()
    const limits = { hard: 20, normal: 40, easy: 80 } as const
    for (const [difficulty, points] of Object.entries(limits)) {
      const response = await postJson(base, '/api/sessions', { caseId: summary.caseId, difficulty })
      assert.equal(response.status, 201)
      const session = await response.json()
      assert.equal(session.difficulty, difficulty)
      assert.equal(session.actionPoints, points)
      assert.equal(session.actionPointsTotal, points)
    }

    const practiceResponse = await postJson(base, '/api/sessions', { caseId: summary.caseId, difficulty: 'practice' })
    assert.equal(practiceResponse.status, 201)
    const practice = await practiceResponse.json()
    const suspect = summary.briefing.characters[0].name
    const turnResponse = await postJson(base, `/api/sessions/${practice.sessionId}/messages`, { suspectId: suspect, choiceId: 'routine', useRuleFallback: true })
    assert.equal(turnResponse.status, 200)
    const turn = await turnResponse.json()
    assert.equal(turn.session.actionPoints, null)
    assert.equal(turn.session.actionPointsTotal, null)

    const invalid = await postJson(base, '/api/sessions', { caseId: summary.caseId, difficulty: 'impossible' })
    assert.equal(invalid.status, 400)
    assert.equal((await invalid.json()).error, '请选择有效的断案难度。')
  }))
})

test('dialogue choices are derived per suspect and only server-generated questions are accepted', async () => {
  await withoutModel(() => withServer(async (base) => {
    const summary = createReadyCase()
    const session = await (await postJson(base, '/api/sessions', { caseId: summary.caseId })).json()
    const suspect = summary.briefing.characters[0].name
    const choicesUrl = `${base}/api/sessions/${session.sessionId}/choices?suspect=${encodeURIComponent(suspect)}`

    const choicesResponse = await fetch(choicesUrl)
    assert.equal(choicesResponse.status, 200)
    const { choices } = await choicesResponse.json()
    const routine = choices.find((choice: { choiceId: string }) => choice.choiceId === 'routine')
    assert.ok(routine)
    // 焦点话题会被插进提问文本：案件话题清单的第一项。
    assert.match(routine.question, /谁有作案动机与机会/)

    // 不存在的话术直接拒绝，且不会消耗行动点。
    const rejected = await postJson(base, `/api/sessions/${session.sessionId}/messages`, { suspectId: suspect, choiceId: 'not-a-choice' })
    assert.equal(rejected.status, 409)
    assert.equal((await rejected.json()).session.actionPoints, session.actionPoints)

    const unavailable = await postJson(base, `/api/sessions/${session.sessionId}/messages`, { suspectId: suspect, choiceId: 'routine' })
    assert.equal(unavailable.status, 503)
    const unavailableBody = await unavailable.json()
    assert.equal(unavailableBody.fallbackAvailable, true)
    assert.equal(unavailableBody.session, undefined)

    const accepted = await postJson(base, `/api/sessions/${session.sessionId}/messages`, { suspectId: suspect, choiceId: 'routine', useRuleFallback: true })
    assert.equal(accepted.status, 200)
    const turn = await accepted.json()
    assert.equal(turn.source, 'rule')
    assert.equal(turn.session.actionPoints, session.actionPoints - 1)
    // 剧情变量记下了话术次数与已问话题，它们是追问链的前置条件。
    assert.equal(turn.session.variables[`use:${suspect}:routine`], 1)
    assert.equal(turn.session.variables[`asked:${suspect}:1`], 1)
    assert.match(turn.session.history[0].content, /^【例行询问】/)

    const refreshed = await (await fetch(choicesUrl)).json()
    assert.ok(refreshed.choices.some((choice: { choiceId: string }) => choice.choiceId === 'detail'))
    const nextRoutine = refreshed.choices.find((choice: { choiceId: string }) => choice.choiceId === 'routine')
    assert.equal(nextRoutine.topicIndex, 2)

    // 层级自带的态度修正：共情题至少带来 +4 信任。
    const empathy = refreshed.choices.find((choice: { choiceId: string }) => choice.choiceId === 'empathy')
    assert.ok(empathy)
    const empathyTurn = await (await postJson(base, `/api/sessions/${session.sessionId}/messages`, { suspectId: suspect, choiceId: 'empathy', useRuleFallback: true })).json()
    assert.ok(empathyTurn.session.trust[suspect] >= 54)
  }))
})
