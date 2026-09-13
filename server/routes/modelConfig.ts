import { Router } from 'express'
import { listModels, testModelConnection } from '../services/modelClient.js'

export function createModelConfigRouter() {
  const router = Router()
  router.post('/config/model', (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {}
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
    const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : ''
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    if (!apiKey || !baseUrl || !model) { response.status(400).json({ error: '请完整填写 Base URL、模型名称和 API Key。' }); return }
    try {
      const parsed = new URL(baseUrl)
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error()
    } catch { response.status(400).json({ error: 'Base URL 格式无效。' }); return }
    process.env.LLM_API_KEY = apiKey
    process.env.LLM_BASE_URL = baseUrl
    process.env.LLM_MODEL = model
    response.json({ message: '模型配置已保存到当前后端进程。重启后需要重新配置。' })
  })

  router.post('/config/model/models', async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {}
    const result = await listModels({ LLM_API_KEY: typeof body.apiKey === 'string' ? body.apiKey : '', LLM_BASE_URL: typeof body.baseUrl === 'string' ? body.baseUrl : '' })
    if (!result.ok) { response.status(result.status).json({ error: result.message }); return }
    response.json({ models: result.models })
  })

  router.post('/config/model/test', async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {}
    const environment = {
      LLM_API_KEY: typeof body.apiKey === 'string' ? body.apiKey : '',
      LLM_BASE_URL: typeof body.baseUrl === 'string' ? body.baseUrl : '',
      LLM_MODEL: typeof body.model === 'string' ? body.model : '',
    }
    const result = await testModelConnection(environment)
    if (!result.ok) { response.status(result.status).json({ connected: false, error: result.message }); return }
    response.json({ connected: true, model: result.model, message: '模型 API 连接成功。' })
  })
  return router
}
