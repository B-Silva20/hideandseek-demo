import { Router } from 'express'
import { findCase } from '../services/caseStore.js'
import { deleteSession, listSessions } from '../services/sessionStore.js'
import type { Difficulty } from '../services/sessionStore.js'

/*
 * 存档槽：一局审讯就是一份存档。
 * 会话本身由持久化层自动保存（每次行动结算完写盘），这里只提供
 * 「看有哪些存档」与「删掉一份存档」两个操作。
 *
 *   GET    /api/saves              -> 200 { saves: SaveSlot[] }
 *   DELETE /api/saves/:sessionId   -> 204 | 404
 *
 * 响应只含界面需要的进度摘要，不含案件原文，也不含案件真相。
 */

export interface SaveSlot {
  sessionId: string
  caseId: string
  caseTitle: string
  updatedAt: string
  turn: number
  difficulty: Difficulty
  actionPoints: number | null
  actionPointsTotal: number | null
  caseConfidence: number
  gameState: 'active' | 'ended'
  endingKind: string | null
  suspects: number
  contradictions: number
}

export function createSavesRouter() {
  const router = Router()

  router.get('/saves', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    const saves: SaveSlot[] = listSessions().map((session) => {
      const record = findCase(session.caseId)
      return {
        sessionId: session.sessionId,
        caseId: session.caseId,
        // 案件不在内存中时给一个可读的占位标题，而不是空白。
        caseTitle: record?.title ?? '（案件已不存在）',
        updatedAt: session.updatedAt,
        turn: session.turn,
        difficulty: session.difficulty,
        actionPoints: session.actionPoints,
        actionPointsTotal: session.actionPointsTotal,
        caseConfidence: session.caseConfidence,
        gameState: session.gameState,
        endingKind: session.endingKind,
        suspects: Object.keys(session.trust).length,
        contradictions: session.contradictions.length,
      }
    })
    response.json({ saves })
  })

  router.delete('/saves/:sessionId', (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    if (!deleteSession(request.params.sessionId)) {
      response.status(404).json({ error: '未找到该存档。' })
      return
    }
    response.status(204).end()
  })

  return router
}
