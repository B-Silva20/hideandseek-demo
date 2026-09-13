import { Router } from 'express'
import { listModels, testModelConnection } from '../services/modelClient.js'

/*
 * 模型配置只在当前后端进程内保存（写入 process.env，供案件解析与审讯引擎读取），
 * 后端重启即清空。这里额外记录「是否已通过真实连接测试」，让前端刷新页面后能恢复
 * 已连接状态，而不需要把 API Key 存进浏览器或 localStorage。
 *
 *   GET  /api/config/model/status   -> { configured, verified, hasApiKey, baseUrl, model, updatedAt, message }
 *   POST /api/config/model          -> 保存配置
 *   POST /api/config/model/test     -> 真实调用一次；成功且配置完整时直接落盘生效
 *   POST /api/config/model/models   -> 读取服务端可用模型列表
 *
 * 所有响应都只返回地址、模型名与布尔值，绝不返回 API Key。
 * 三个写接口的 apiKey 都允许留空，此时沿用进程内已保存的密钥，让前端在刷新或重开面板后
 * 不必重新粘贴密钥；密钥本身始终只存在于后端内存，不进入浏览器存储。
 */

interface ModelConfigSnapshot {
  baseUrl: string
  model: string
  verified: boolean
  updatedAt: string | null
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isValidBaseUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol)
      && !url.username && !url.password && !url.search && !url.hash
  } catch { return false }
}

/** 请求未携带密钥时沿用后端已保存的密钥，避免为了少填一次而把密钥写进浏览器存储。 */
function resolveApiKey(requested: string): string {
  return requested || process.env.LLM_API_KEY?.trim() || ''
}

export function createModelConfigRouter() {
  const router = Router()
  const snapshot: ModelConfigSnapshot = { baseUrl: '', model: '', verified: false, updatedAt: null }

  /** 只有三项齐备时才写入进程配置，避免出现半份配置让解析接口报错。 */
  function persist(baseUrl: string, model: string, apiKey: string) {
    process.env.LLM_API_KEY = apiKey
    process.env.LLM_BASE_URL = baseUrl
    process.env.LLM_MODEL = model
    snapshot.baseUrl = baseUrl
    snapshot.model = model
    snapshot.updatedAt = new Date().toISOString()
  }

  router.get('/config/model/status', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    const storedKey = process.env.LLM_API_KEY?.trim() ?? ''
    const configured = Boolean(snapshot.baseUrl && snapshot.model && storedKey)
    response.json({
      configured,
      verified: configured && snapshot.verified,
      // 只暴露「是否已保存」，让前端恢复表单状态，但不透露密钥内容。
      hasApiKey: Boolean(storedKey),
      baseUrl: snapshot.baseUrl,
      model: snapshot.model,
      updatedAt: snapshot.updatedAt,
      message: !configured
        ? '后端尚未保存可用的模型配置。'
        : snapshot.verified
          ? '模型配置已保存，并通过过一次真实连接测试。'
          : '模型配置已保存，尚未验证真实连接。',
    })
  })

  router.post('/config/model', (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {}
    const apiKey = resolveApiKey(readText(body.apiKey))
    const baseUrl = readText(body.baseUrl)
    const model = readText(body.model)
    if (!apiKey || !baseUrl || !model) { response.status(400).json({ error: '请完整填写 Base URL、模型名称和 API Key。' }); return }
    if (!isValidBaseUrl(baseUrl)) { response.status(400).json({ error: 'Base URL 格式无效。' }); return }
    persist(baseUrl, model, apiKey)
    snapshot.verified = false
    response.json({ configured: true, verified: false, model, message: '模型配置已保存到当前后端进程。重启后需要重新配置。' })
  })

  router.post('/config/model/models', async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {}
    const result = await listModels({ LLM_API_KEY: resolveApiKey(readText(body.apiKey)), LLM_BASE_URL: readText(body.baseUrl) })
    if (!result.ok) { response.status(result.status).json({ error: result.message }); return }
    response.json({ models: result.models })
  })

  router.post('/config/model/test', async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {}
    const apiKey = resolveApiKey(readText(body.apiKey))
    const baseUrl = readText(body.baseUrl)
    const requestedModel = readText(body.model)
    if (!apiKey || !baseUrl) { response.status(400).json({ connected: false, error: '请填写 Base URL 和 API Key。' }); return }
    if (!isValidBaseUrl(baseUrl)) { response.status(400).json({ connected: false, error: 'Base URL 格式无效。' }); return }

    const result = await testModelConnection({ LLM_API_KEY: apiKey, LLM_BASE_URL: baseUrl, LLM_MODEL: requestedModel })
    if (!result.ok) { response.status(result.status).json({ connected: false, error: result.message }); return }

    // 测试通过即视为可用：未手填模型名时采用服务端返回的第一个模型，避免「测试成功但解析失败」。
    const model = requestedModel || result.model
    const saved = Boolean(model)
    if (saved) persist(baseUrl, model, apiKey)
    snapshot.verified = saved
    response.json({
      connected: true,
      saved,
      model,
      verified: saved,
      message: saved
        ? '模型连接成功，配置已在后端生效。'
        : '模型服务可访问，但未返回可用模型名称，请手动填写模型后保存配置。',
    })
  })

  return router
}
