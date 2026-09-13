import express from 'express'
import type { ErrorRequestHandler } from 'express'
import { createCasesRouter } from './routes/cases.js'
import { createHealthRouter } from './routes/health.js'
import { createPresetRouter } from './routes/preset.js'
import { createModelConfigRouter } from './routes/modelConfig.js'
import { createSessionsRouter } from './routes/sessions.js'

export function createApp() {
  const app = express()
  app.disable('x-powered-by')
  // 案件文本上限 200,000 个字符，UTF-8 中文约 3 字节/字符，为 JSON 转义留出余量。
  app.use(express.json({ limit: '2mb' }))
  app.use('/api', createHealthRouter())
  app.use('/api', createPresetRouter())
  app.use('/api', createCasesRouter())
  app.use('/api', createModelConfigRouter())
  app.use('/api', createSessionsRouter())

  app.use((_request, response) => {
    response.status(404).json({ error: '接口不存在。' })
  })

  const handleError: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    const status = error && typeof error === 'object' && 'status' in error
      ? error.status
      : undefined
    if (status === 400 || status === 413) {
      response.status(status).json({
        error: status === 413 ? '请求内容过大。' : '请求 JSON 格式无效。',
      })
      return
    }
    // Do not serialize errors or requests: they may contain credentials later.
    response.status(500).json({ error: '服务暂时不可用，请稍后重试。' })
  }
  app.use(handleError)
  return app
}
