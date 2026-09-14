import express from 'express'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ErrorRequestHandler } from 'express'
import { createCasesRouter } from './routes/cases.js'
import { createHealthRouter } from './routes/health.js'
import { createModelConfigRouter } from './routes/modelConfig.js'
import { createSavesRouter } from './routes/saves.js'
import { createSessionsRouter } from './routes/sessions.js'

export function createApp() {
  const app = express()
  app.disable('x-powered-by')
  // 支持书籍级 TXT；正文仅在提交时进入请求体，后续审讯不会重复传输。
  app.use(express.json({ limit: '12mb' }))
  app.use('/api', createHealthRouter())
  app.use('/api', createCasesRouter())
  app.use('/api', createModelConfigRouter())
  app.use('/api', createSavesRouter())
  app.use('/api', createSessionsRouter())

  // 发布版将 dist 与 dist-server 并列放置；开发模式没有 dist 时不注册静态托管。
  const distDirectory = fileURLToPath(new URL('../dist/', import.meta.url))
  if (existsSync(join(distDirectory, 'index.html'))) {
    app.use(express.static(distDirectory, { index: false }))
    app.get('*splat', (_request, response) => response.sendFile(join(distDirectory, 'index.html')))
  } else {
    app.use((_request, response) => {
      response.status(404).json({ error: '接口不存在。' })
    })
  }

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
