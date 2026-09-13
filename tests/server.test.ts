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
