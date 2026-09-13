import { Router } from 'express'
import { createSession, evaluateEnding, getSession, resolveSuspectId, TRUST_TERMINATION_THRESHOLD, updateSession } from '../services/sessionStore.js'
import { findCase } from '../services/caseStore.js'
import { generateInterrogationReply, ModelClientError } from '../services/modelClient.js'

const attacks = /忽略之前|ignore previous|system prompt|提示词攻击|jailbreak/i

function readText(value: unknown, maxLength: number) {
  if (typeof value !== 'string') return ''
  return Array.from(value.trim()).slice(0, maxLength).join('')
}

function registerTestimony(session: import('../services/sessionStore.js').SessionState, testimony: import('../services/sessionStore.js').Testimony) {
  const previous = session.testimonies.find((item) => item.suspectId === testimony.suspectId && item.topicId === testimony.topicId)
  if (previous) {
    const index = session.testimonies.indexOf(previous)
    session.testimonies[index] = testimony
  } else {
    session.testimonies.push(testimony)
  }
  const peers = session.testimonies.filter((item) => item.topicId === testimony.topicId && item.suspectId !== testimony.suspectId && item.normalizedValue !== testimony.normalizedValue)
  for (const peer of peers) {
    const [suspectA, suspectB] = [peer.suspectId, testimony.suspectId].sort()
    const exists = session.contradictionRecords.some((item) => item.topicId === testimony.topicId && item.suspectA === suspectA && item.suspectB === suspectB)
    if (exists) continue
    const contradictionId = `contradiction-${session.contradictionRecords.length + 1}`
    const first = suspectA === peer.suspectId ? peer : testimony
    const second = suspectA === peer.suspectId ? testimony : peer
    session.contradictionRecords.push({ contradictionId, topicId: testimony.topicId, suspectA, suspectB, testimonyA: first, testimonyB: second, description: `关于话题“${testimony.topicId}”，${suspectA}称“${first.claim}”，${suspectB}称“${second.claim}”。`, confronted: false })
    session.contradictions.push(contradictionId)
  }
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

  router.post('/sessions/:sessionId/messages', async (req, res) => {
    const session = getSession(req.params.sessionId)
    if (!session) return res.status(404).json({ error: '会话不存在' })
    if (session.gameState === 'ended') return res.status(409).json({ error: '案件已经结案', session })
    if (session.actionPoints <= 0) return res.status(409).json({ error: '行动点不足', session })

    const suspect = readText(req.body?.suspectId, 120)
    const text = readText(req.body?.text, 500)
    if (!text) return res.status(400).json({ error: '请输入问题' })
    if (!suspect || session.trust[suspect] === undefined) return res.status(400).json({ error: '请选择有效的嫌疑人' })

    session.currentSubject = suspect || null
    session.actionPoints--

    const record = findCase(session.caseId)
    try {
      const generated = attacks.test(text)
        ? { reply: '请围绕案件事实提问。' }
        : await generateInterrogationReply({
            caseTitle: record?.title ?? '当前案件',
            sourceText: record?.sourceText,
            briefing: record?.briefing,
            parsed: record?.parsed,
            suspect,
            trust: session.trust[suspect] ?? 50,
            hostility: session.hostility[suspect] ?? 0,
            actionPoints: session.actionPoints,
            history: session.history,
            question: text,
          })
      const reply = generated.reply
      session.history.push({ role: 'user', content: text }, { role: 'npc', content: reply })
      const topicId = readText(req.body?.topicId ?? generated.topicId, 120)
      const normalizedValue = readText(req.body?.normalizedValue ?? generated.normalizedValue, 200)
      const claim = readText(generated.claim, 500) || text
      if (topicId && normalizedValue) registerTestimony(session, { suspectId: suspect, topicId, claim, normalizedValue })
      session.actionLog.push(`向${suspect}提问，消耗1行动点`)
      if (session.trust[suspect] !== undefined) {
        session.trust[suspect] = Math.min(100, session.trust[suspect] + 1)
        session.hostility[suspect] = Math.max(0, session.hostility[suspect])
      }
      if (session.trust[suspect] <= TRUST_TERMINATION_THRESHOLD) evaluateEnding(session, undefined, 'trust_low')
      else if (session.actionPoints <= 0) evaluateEnding(session)
      updateSession(session)
      return res.json({ reply, topicId: topicId || undefined, normalizedValue: normalizedValue || undefined, session })
    } catch (error) {
      session.actionPoints = Math.min(20, session.actionPoints + 1)
      const modelError = error instanceof ModelClientError ? error : new ModelClientError('LLM_REQUEST_FAILED', '模型调用失败，请稍后重试。')
      updateSession(session)
      return res.status(modelError.status).json({ code: modelError.code, error: modelError.message, session })
    }
  })

  router.post('/sessions/:sessionId/evidence', (req, res) => {
    const session = getSession(req.params.sessionId)
    if (!session) return res.status(404).json({ error: '会话不存在' })
    if (session.gameState === 'ended') return res.status(409).json({ error: '案件已经结案', session })
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
    if (session.trust[suspectId] <= TRUST_TERMINATION_THRESHOLD) evaluateEnding(session, undefined, 'trust_low')
    else if (session.actionPoints <= 0) evaluateEnding(session)
    updateSession(session)
    res.json({ reply, breakthrough: breaksLie, evidence, session })
  })

  router.post('/sessions/:sessionId/contradictions/:contradictionId/confront', (req, res) => {
    const session = getSession(req.params.sessionId)
    if (!session) return res.status(404).json({ error: '会话不存在' })
    if (session.gameState === 'ended') return res.status(409).json({ error: '案件已经结案', session })
    const contradiction = session.contradictionRecords.find((item) => item.contradictionId === req.params.contradictionId)
    if (!contradiction) return res.status(404).json({ error: '矛盾记录不存在', session })
    if (contradiction.confronted) return res.status(409).json({ error: '该矛盾已经对质过', session })
    if (session.actionPoints <= 0) return res.status(409).json({ error: '行动点不足', session })
    session.actionPoints--
    const averageTrust = (session.trust[contradiction.suspectA] + session.trust[contradiction.suspectB]) / 2
    const averageHostility = (session.hostility[contradiction.suspectA] + session.hostility[contradiction.suspectB]) / 2
    const reaction = averageTrust >= 60 ? '其中一人低下头，承认自己的说法需要修正。' : averageHostility >= 30 ? '双方情绪激动，互相指责，但仍坚持原有说法。' : '双方都保持沉默，暂时没有人改口。'
    contradiction.confronted = true
    session.confrontations.push({ contradictionId: contradiction.contradictionId, reaction, createdAt: new Date().toISOString() })
    session.history.push({ role: 'user', content: `对质：${contradiction.description}` }, { role: 'npc', content: reaction })
    session.actionLog.push(`对质${contradiction.contradictionId}，消耗1行动点`)
    if (session.actionPoints <= 0) evaluateEnding(session)
    updateSession(session)
    res.json({ contradiction, reaction, session })
  })

  router.post('/sessions/:sessionId/accuse', (req, res) => {
    const session = getSession(req.params.sessionId)
    if (!session) return res.status(404).json({ error: '会话不存在' })
    if (session.gameState === 'ended') return res.status(409).json({ error: '案件已经结案', session })
    const suspectId = readText(req.body?.suspectId, 120)
    if (!suspectId || !resolveSuspectId(session, suspectId)) return res.status(400).json({ error: '请选择有效的嫌疑人', session })
    const ending = evaluateEnding(session, suspectId, 'insufficient_evidence')
    updateSession(session)
    res.json({ ending, suspectId, session })
  })

  return router
}
