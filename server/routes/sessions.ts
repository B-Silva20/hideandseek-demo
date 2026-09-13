import { Router } from 'express'
import { createSession, getSession, updateSession } from '../services/sessionStore.js'

const attacks = /忽略之前|ignore previous|system prompt|提示词攻击|jailbreak/i

function readText(value: unknown, maxLength: number) {
  if (typeof value !== 'string') return ''
  return Array.from(value.trim()).slice(0, maxLength).join('')
}

export function createSessionsRouter() {
  const router = Router()

  router.post('/sessions', (req, res) => {
    const session = createSession(req.body?.caseId)
    if (!session) return res.status(404).json({ error: '案件不存在' })
    res.status(201).json(session)
  })

  router.get('/sessions/:sessionId', (req, res) => {
    const session = getSession(req.params.sessionId)
    if (!session) return res.status(404).json({ error: '会话不存在' })
    res.json(session)
  })

  router.post('/sessions/:sessionId/messages', (req, res) => {
    const session = getSession(req.params.sessionId)
    if (!session) return res.status(404).json({ error: '会话不存在' })
    if (session.actionPoints <= 0) return res.status(409).json({ error: '行动点不足', session })

    const suspect = readText(req.body?.suspectId, 120)
    const text = readText(req.body?.text, 500)
    if (!text) return res.status(400).json({ error: '请输入问题' })

    session.currentSubject = suspect || null
    session.actionPoints--
    const reply = attacks.test(text)
      ? '嫌疑人皱眉：我不明白你在说什么。请问与案件有关的问题。'
      : '嫌疑人沉默片刻：关于这个问题，我需要再想想。'
    session.history.push({ role: 'user', content: text }, { role: 'npc', content: reply })
    session.actionLog.push(`向${suspect || '嫌疑人'}提问，消耗1行动点`)
    if (session.trust[suspect] !== undefined) {
      session.trust[suspect] = Math.min(100, session.trust[suspect] + 1)
      session.hostility[suspect] = Math.max(0, session.hostility[suspect])
    }
    updateSession(session)
    res.json({ reply, session })
  })

  router.post('/sessions/:sessionId/evidence', (req, res) => {
    const session = getSession(req.params.sessionId)
    if (!session) return res.status(404).json({ error: '会话不存在' })
    if (session.actionPoints <= 0) return res.status(409).json({ error: '行动点不足', session })

    const evidenceId = readText(req.body?.evidenceId, 120)
    const suspectId = readText(req.body?.suspectId, 120)
    const evidence = session.evidenceCatalog[evidenceId]
    if (!evidence || !session.unlockedEvidence.includes(evidenceId)) {
      return res.status(403).json({ error: '该证物尚未解锁或不存在', session })
    }
    if (!suspectId || session.trust[suspectId] === undefined) {
      return res.status(400).json({ error: '请选择有效的嫌疑人', session })
    }
    if (session.presentedEvidence.includes(evidenceId)) {
      return res.status(409).json({ error: '该证物已经出示过，不能重复消耗行动点', session })
    }

    session.currentSubject = suspectId
    session.actionPoints--
    session.presentedEvidence.push(evidenceId)
    session.trust[suspectId] = Math.max(0, Math.min(100, session.trust[suspectId] + evidence.trustDelta))
    session.hostility[suspectId] = Math.max(0, Math.min(100, session.hostility[suspectId] + evidence.hostilityDelta))
    for (const topic of evidence.unlockTopics) {
      if (!session.unlockedTopics.includes(topic)) session.unlockedTopics.push(topic)
    }

    const breaksLie = evidence.lieSuspects.includes(suspectId)
    const reply = breaksLie
      ? `你将“${evidence.name}”推到对方面前。嫌疑人的表情瞬间失控：这、这件证物不可能出现在这里……`
      : `你出示了“${evidence.name}”。嫌疑人盯着证物看了片刻，态度出现了变化。`
    session.history.push({ role: 'user', content: `出示证物：${evidence.name}` }, { role: 'npc', content: reply })
    session.actionLog.push(`向${suspectId}出示证物“${evidence.name}”，消耗1行动点`)
    if (breaksLie) session.contradictions.push(`${suspectId}关于${evidence.name}的陈述出现矛盾`)
    updateSession(session)
    res.json({ reply, breakthrough: breaksLie, evidence, session })
  })

  return router
}
