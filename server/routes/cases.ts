import { Router } from 'express'
import { CASE_NOT_FOUND_ERROR, createCase, findCase, toCaseSummary, updateCase } from '../services/caseStore.js'
import { parseCaseText, type CaseParseProgress } from '../services/caseParser.js'
import { ModelError } from '../services/modelError.js'

export function createCasesRouter() {
  const router = Router()
  const jobs = new Map<string, { controller: AbortController; progress: CaseParseProgress }>()

  function startParse(caseId: string) {
    const record = findCase(caseId)
    if (!record || jobs.has(caseId)) return false
    const controller = new AbortController()
    const initial: CaseParseProgress = { completedChunks: 0, totalChunks: 1, phase: 'extracting', message: '正在准备案件材料。' }
    jobs.set(caseId, { controller, progress: initial })
    updateCase(caseId, { status: 'parsing', message: initial.message, parseError: undefined })
    void (async () => {
      try {
        const parsed = await parseCaseText(record.sourceText, process.env, fetch, {
          signal: controller.signal,
          onProgress: (progress) => {
            const job = jobs.get(caseId)
            if (!job) return
            job.progress = progress
            updateCase(caseId, { status: 'parsing', message: progress.message, parseError: undefined })
          },
        })
        updateCase(caseId, { status: 'ready', message: '案件解析完成。', parsed })
      } catch (error) {
        const modelError = error instanceof ModelError ? error : new ModelError('LLM_REQUEST_FAILED', '模型调用失败。')
        updateCase(caseId, { status: 'failed', message: modelError.message, parseError: modelError.code })
      } finally {
        jobs.delete(caseId)
      }
    })()
    return true
  }

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

  router.post('/cases/:caseId/parse', (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    const record = findCase(request.params.caseId)
    if (!record) {
      response.status(404).json(CASE_NOT_FOUND_ERROR)
      return
    }
    if (jobs.has(record.caseId)) {
      response.status(409).json({ code: 'PARSE_IN_PROGRESS', error: '该案件正在解析，请稍后查询状态。' })
      return
    }
    startParse(record.caseId)
    response.status(202).json(toCaseSummary(findCase(record.caseId) ?? record))
  })

  router.get('/cases/:caseId/parse-status', (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    const record = findCase(request.params.caseId)
    if (!record) return response.status(404).json(CASE_NOT_FOUND_ERROR)
    const job = jobs.get(record.caseId)
    response.json({
      status: record.status,
      message: record.message,
      progress: job?.progress,
      canCancel: Boolean(job),
      briefing: toCaseSummary(record).briefing,
    })
  })

  router.delete('/cases/:caseId/parse', (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    const record = findCase(request.params.caseId)
    if (!record) return response.status(404).json(CASE_NOT_FOUND_ERROR)
    const job = jobs.get(record.caseId)
    if (!job) return response.status(409).json({ code: 'PARSE_NOT_RUNNING', error: '当前没有可取消的解析任务。' })
    job.controller.abort()
    response.status(202).json({ message: '正在停止案件解析。' })
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
