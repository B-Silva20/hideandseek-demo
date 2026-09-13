import express from 'express'
import type { ErrorRequestHandler } from 'express'
import { createHealthRouter } from './routes/health.js'

export function createApp() {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '1mb' }))
  app.use('/api', createHealthRouter())

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
