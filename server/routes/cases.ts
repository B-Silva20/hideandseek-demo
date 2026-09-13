import { Router } from 'express'
import { CASE_NOT_FOUND_ERROR, createCase, findCase, toCaseSummary, updateCase } from '../services/caseStore.js'
import { parseCaseText } from '../services/caseParser.js'
import { ModelError } from '../services/modelError.js'

export function createCasesRouter() {
  const router = Router()

  router.post('/cases', (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    const result = createCase(request.body)

    if (!result.ok) {
      // 只返回错误码与面向用户的文案，不带原始请求内容或异常堆栈。
      response.status(400).json({ code: result.code, error: result.error })
      return
    }

    response.status(201).json(toCaseSummary(result.record))
  })

  router.post('/cases/:caseId/parse', async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    const record = findCase(request.params.caseId)
    if (!record) {
      response.status(404).json(CASE_NOT_FOUND_ERROR)
      return
    }
    if (record.status === 'parsing' && record.message !== '案件文本已接收，正在解析。') {
      response.status(409).json({ code: 'PARSE_IN_PROGRESS', error: '该案件正在解析，请稍后查询状态。' })
      return
    }
    updateCase(record.caseId, { status: 'parsing', message: '正在调用模型解析案件。', parseError: undefined })
    try {
      const parsed = await parseCaseText(record.sourceText)
      updateCase(record.caseId, { status: 'ready', message: '案件解析完成。', parsed })
    } catch (error) {
      const modelError = error instanceof ModelError ? error : new ModelError('LLM_REQUEST_FAILED', '模型调用失败。')
      updateCase(record.caseId, { status: 'failed', message: modelError.message, parseError: modelError.code })
      response.status(modelError.status).json({ code: modelError.code, error: modelError.message })
      return
    }
    response.json(toCaseSummary(record))
  })

  router.get('/cases/:caseId', (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    const record = findCase(request.params.caseId)

    if (!record) {
      response.status(404).json(CASE_NOT_FOUND_ERROR)
      return
    }

    response.json(toCaseSummary(record))
  })

  return router
}
