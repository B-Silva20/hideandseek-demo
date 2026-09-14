import assert from 'node:assert/strict'
import { test } from 'node:test'
import { requestChatJson } from '../server/services/chatClient.js'

function responseFor(content: unknown, finishReason: unknown = 'stop', status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ finish_reason: finishReason, message: { content } }] }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

test('chat client accepts normal OpenAI-compatible JSON output', async () => {
  const result = await requestChatJson({
    baseUrl: 'https://example.com/v1', apiKey: 'test-key', model: 'test-model', system: 'system', user: 'user',
  }, async () => responseFor('{"ok":true}'))
  assert.deepEqual(result, { ok: true })
})

test('chat client forwards an explicit generation cap', async () => {
  let requestBody = ''
  await requestChatJson({
    baseUrl: 'https://example.com/v1', apiKey: 'test-key', model: 'test-model', system: 'system', user: 'user', maxTokens: 123,
  }, async (_url, init) => {
    requestBody = String(init?.body)
    return responseFor('{"ok":true}')
  })
  assert.equal(JSON.parse(requestBody).max_tokens, 123)
})

test('chat client accepts missing or null finish_reason from compatible providers', async () => {
  for (const reason of [undefined, null, 'completed']) {
    const result = await requestChatJson({
      baseUrl: 'https://example.com/v1', apiKey: 'test-key', model: 'test-model', system: 'system', user: 'user',
    }, async () => responseFor('{"ok":true}', reason))
    assert.deepEqual(result, { ok: true })
  }
})

test('chat client extracts JSON wrapped in Markdown or explanatory text', async () => {
  const contents = [
    '```json\n{"ok":true}\n```',
    '结果如下：\n{"ok":true}\n以上。',
  ]
  for (const content of contents) {
    const result = await requestChatJson({
      baseUrl: 'https://example.com/v1', apiKey: 'test-key', model: 'test-model', system: 'system', user: 'user',
    }, async () => responseFor(content))
    assert.deepEqual(result, { ok: true })
  }
})

test('chat client reports a truncated response separately', async () => {
  await assert.rejects(
    requestChatJson({
      baseUrl: 'https://example.com/v1', apiKey: 'test-key', model: 'test-model', system: 'system', user: 'user',
    }, async () => responseFor('{"ok":', 'length')),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'LLM_OUTPUT_TRUNCATED',
  )
})

test('chat client never exposes provider error body', async () => {
  await assert.rejects(
    requestChatJson({
      baseUrl: 'https://example.com/v1', apiKey: 'secret-key', model: 'test-model', system: 'system', user: 'user',
    }, async () => new Response('provider-secret-body', { status: 500 })),
    (error: unknown) => error instanceof Error
      && error.message === '模型服务拒绝请求，请检查配置或稍后重试。'
      && !error.message.includes('provider-secret-body'),
  )
})
