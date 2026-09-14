import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInterrogation } from '../server/services/interrogation.js'

const context = {
  suspect: { name: '赵振阳', publicIdentity: '物业人员' },
  question: '你进楼后发生了什么？',
  evidence: null,
  evidenceAlreadyPresented: false,
  objective: '查明案件真相',
  allowedFacts: [{ id: 'public_identity', text: '赵振阳的公开身份：物业人员' }],
  stateSummary: '第 1 轮；该人物信任 50；敌意 0；已出示证物：无；已解锁证物 2/2；已记录矛盾 0 处',
  transcript: [],
}

function modelResponse(payload: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(payload) } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

test('interrogation prompt never contains the canonical case truth', async () => {
  let requestText = ''
  const outcome = await runInterrogation(context, {
    LLM_BASE_URL: 'https://example.com/v1', LLM_API_KEY: 'test-key', LLM_MODEL: 'test-model',
  }, async (_url, init) => {
    requestText = String(init?.body)
    return modelResponse({ reply: '我只是负责这栋楼的日常事务。', trustDelta: 0, hostilityDelta: 0, factIds: ['public_identity'] })
  })

  assert.equal(outcome.source, 'model')
  assert.doesNotMatch(requestText, /案发当晚我杀了林青/)
  assert.doesNotMatch(requestText, /案件真相/)
  assert.match(requestText, /赵振阳的公开身份/)
})

test('interrogation keeps a bounded recent transcript and uses compact server state', async () => {
  let requestText = ''
  await runInterrogation({
    ...context,
    transcript: Array.from({ length: 10 }, (_, index) => ({ role: index % 2 === 0 ? 'user' as const : 'npc' as const, content: `第${index}段历史`.padEnd(220, '甲') })),
  }, { LLM_BASE_URL: 'https://example.com/v1', LLM_API_KEY: 'test-key', LLM_MODEL: 'test-model' }, async (_url, init) => {
    requestText = String(init?.body)
    return modelResponse({ reply: '我只能说明自己知道的部分。', trustDelta: 0, hostilityDelta: 0, factIds: [] })
  })
  assert.match(requestText, /当前审讯状态/)
  assert.match(requestText, /第9段历史/)
  assert.doesNotMatch(requestText, /第0段历史/)
})

test('a model cannot cite an unreleased fact and falls back without advancing story state', async () => {
  const outcome = await runInterrogation(context, {
    LLM_BASE_URL: 'https://example.com/v1', LLM_API_KEY: 'test-key', LLM_MODEL: 'test-model',
  }, async () => modelResponse({
    reply: '是我杀了她。', trustDelta: 20, hostilityDelta: -20, factIds: ['secret_truth'],
  }))

  assert.equal(outcome.source, 'rule')
  assert.equal(outcome.factIds.length, 0)
  assert.doesNotMatch(outcome.reply, /杀了她/)
})
