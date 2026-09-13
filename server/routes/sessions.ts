import { Router } from 'express'
import { findCase } from '../services/caseStore.js'
import { observeOutcome, runInterrogation } from '../services/interrogation.js'
import type { InterrogationContext } from '../services/interrogation.js'
import {
  TRUST_TERMINATION_THRESHOLD,
  WIN_CONFIDENCE,
  addEvidenceContradiction,
  clamp,
  createSession,
  getCaseSecret,
  getSession,
  judgeArrest,
  pushEvent,
  pushHistory,
  registerTestimony,
  terminateOnLowTrust,
  unlockNextEvidence,
  updateSession,
} from '../services/sessionStore.js'
import type { Contradiction, EvidenceItem, SessionEvent, SessionEventType } from '../services/sessionStore.js'

const MAX_QUESTION = 500
/** 置信度跨过该值视为一次关键突破。 */
const BREAKTHROUGH_CONFIDENCE = 70

function readText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function createSessionsRouter() {
  const router = Router()

  router.post('/sessions', (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    const session = createSession(request.body?.caseId)
    if (!session) { response.status(404).json({ error: '案件不存在' }); return }
    response.status(201).json(session)
  })

  router.get('/sessions/:sessionId', (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    const session = getSession(request.params.sessionId)
    if (!session) { response.status(404).json({ error: '会话不存在' }); return }
    response.json(session)
  })

  /*
   * 一次行动 = 提问（text）或出示证据（evidenceId），两者可以同时提交，统一消耗 1 点行动点。
   * 响应返回本次行动产生的全部事件（破绽、突破、新证据、情绪变化），界面据此做即时反馈。
   */
  router.post('/sessions/:sessionId/messages', async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')

    const session = getSession(request.params.sessionId)
    if (!session) { response.status(404).json({ error: '会话不存在' }); return }
    if (session.gameState === 'ended') {
      response.status(409).json({ error: '本局审讯已经结束，请返回首页开启新的一局。', session })
      return
    }
    if (session.actionPoints <= 0) { response.status(409).json({ error: '行动点不足', session }); return }

    const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {}
    const suspectId = readText(body.suspectId)
    const question = Array.from(readText(body.text)).slice(0, MAX_QUESTION).join('')
    const evidenceId = readText(body.evidenceId)
    // 沉默观察是确定性行动：不与提问或出示证据叠加，也不调用模型。
    const observing = body.observe === true && !question && !evidenceId

    if (!question && !evidenceId && !observing) { response.status(400).json({ error: '请输入问题或选择一份证据。' }); return }
    if (!suspectId || !(suspectId in session.trust)) { response.status(400).json({ error: '请选择有效的嫌疑人。' }); return }
    if (session.terminated.includes(suspectId)) { response.status(409).json({ error: '该嫌疑人已终止审讯，拒绝再回答任何问题。', session }); return }

    let evidence: EvidenceItem | undefined
    if (evidenceId) {
      evidence = session.evidence.find((item) => item.evidenceId === evidenceId)
      if (!evidence) { response.status(404).json({ error: '未找到该证据。' }); return }
      if (!evidence.unlocked) { response.status(409).json({ error: '该证据尚未解锁，请先继续搜集线索。' }); return }
    }

    // 当面对质：只标记服务端已记录的矛盾点，不能由前端凭空指定。
    const contradictionId = readText(body.contradictionId)
    const target = contradictionId
      ? session.contradictions.find((item) => item.contradictionId === contradictionId)
      : undefined
    if (contradictionId && !target) { response.status(404).json({ error: '未找到该矛盾点。' }); return }
    if (target?.confronted) { response.status(409).json({ error: '这一点已经对质过了，换一个突破口。', session }); return }

    const record = findCase(session.caseId)
    const character = record?.briefing?.characters.find((person) => person.name === suspectId)
    if (!record || !character) { response.status(409).json({ error: '案件数据已失效，请重新提交案件后再开始审讯。' }); return }

    const secret = getCaseSecret(session.sessionId)
    const alreadyPresented = Boolean(evidence?.presentedTo.includes(suspectId))
    const context: InterrogationContext = {
      suspect: { name: character.name, publicIdentity: character.publicIdentity },
      question,
      evidence: evidence ? { title: evidence.title, detail: evidence.detail } : null,
      evidenceAlreadyPresented: alreadyPresented,
      objective: secret?.objective ?? record.briefing?.objective ?? '',
      truth: secret?.truth ?? '未知',
      suspects: Object.keys(session.trust),
      contradictions: session.contradictions.slice(-6)
        .map((item) => `${item.topic}：${item.left.label} 说「${item.left.text}」，${item.right.label} 说「${item.right.text}」`),
      // 统一话题清单来自案件解析出的问题，保证不同嫌疑人回答同一话题时可比对。
      topics: record.briefing?.questions ?? [],
      transcript: [...session.history],
    }

    const outcome = observing ? observeOutcome(character.name) : await runInterrogation(context)
    const turnEvents: SessionEvent[] = []
    const emit = (type: SessionEventType, title: string, detail: string) => {
      turnEvents.push(pushEvent(session, { type, title, detail }))
    }

    const beforeConfidence = session.caseConfidence
    const suspectCount = Object.keys(session.trust).length
    session.turn += 1
    session.actionPoints -= 1
    session.currentSubject = suspectId
    pushHistory(session, 'user', observing
      ? '【沉默观察】'
      : evidence ? `【出示证据：${evidence.title}】${question}` : question)
    pushHistory(session, 'npc', outcome.reply)

    session.trust[suspectId] = clamp(session.trust[suspectId] + outcome.trustDelta, 0, 100)
    session.hostility[suspectId] = clamp(session.hostility[suspectId] + outcome.hostilityDelta, 0, 100)

    let confidenceDelta = outcome.confidenceDelta
    if (alreadyPresented) {
      confidenceDelta = Math.min(confidenceDelta, 2)
      emit('info', '证据重复出示', `「${evidence?.title ?? ''}」已经向${suspectId}出示过，本次不再计入新的突破。`)
    }

    // 结构化矛盾：优先用模型给出的话题+立场做跨嫌疑人比对；规则回退时用「证据 vs 说法」。
    let newContradiction: Contradiction | null = null
    if (!alreadyPresented) {
      if (outcome.topicIndex > 0 && outcome.topicLabel && outcome.topicValue && outcome.claim) {
        newContradiction = registerTestimony(session, {
          suspectId,
          topicIndex: outcome.topicIndex,
          label: outcome.topicLabel,
          value: outcome.topicValue,
          claim: outcome.claim,
        })
      }
      if (!newContradiction && evidence && outcome.contradiction) {
        newContradiction = addEvidenceContradiction(session, suspectId, outcome.reply, evidence.title)
      }
    }
    if (newContradiction) {
      confidenceDelta += 8
      emit('contradiction', '证词出现破绽', `「${newContradiction.topic}」上，${newContradiction.left.label} 与 ${newContradiction.right.label} 的说法对不上。`)
    }
    if (observing) emit('info', '沉默观察', `你没有追问，${suspectId} 的信任 +${outcome.trustDelta}，敌意 ${outcome.hostilityDelta}。`)
    else if (outcome.hostilityDelta >= 8) emit('hostility', '嫌疑人戒备加深', `${suspectId} 的敌意 +${outcome.hostilityDelta}。`)
    else if (outcome.trustDelta >= 8) emit('trust', '嫌疑人态度松动', `${suspectId} 的信任 +${outcome.trustDelta}。`)
    if (terminateOnLowTrust(session, suspectId)) {
      emit('trust', '审讯被终止', `${suspectId} 的信任跌破 ${TRUST_TERMINATION_THRESHOLD}，拒绝再回答任何问题。`)
    }

    if (target) {
      target.confronted = true
      confidenceDelta += 6
      emit('info', '当面对质', `就「${target.topic}」当面对质，${suspectId} 无法再用原来的说法搪塞。`)
    }

    session.caseConfidence = clamp(beforeConfidence + confidenceDelta, 0, 100)
    if (evidence && !alreadyPresented) evidence.presentedTo.push(suspectId)

    const crossedBreakthrough = beforeConfidence < BREAKTHROUGH_CONFIDENCE && session.caseConfidence >= BREAKTHROUGH_CONFIDENCE
    if (newContradiction) unlockNextEvidence(session, '证词出现破绽')
    else if (crossedBreakthrough) unlockNextEvidence(session, '线索逐渐闭合')
    if (crossedBreakthrough) {
      emit('breakthrough', '关键突破', `案件置信度达到 ${session.caseConfidence}%，真相轮廓已经浮现。`)
    }

    session.actionLog.push(observing
      ? `对${suspectId}沉默观察，消耗 1 行动点`
      : evidence
        ? `向${suspectId}出示证据「${evidence.title}」，消耗 1 行动点`
        : `向${suspectId}提问，消耗 1 行动点`)

    // 结局判定：置信度达标即告破，行动点耗尽则带着当前进度的存档结束。
    if (session.caseConfidence >= WIN_CONFIDENCE) {
      session.gameState = 'ended'
      session.endingKind = 'confidence'
      session.ending = `真相已查明（案件置信度 ${session.caseConfidence}%）：${secret?.truth ?? '未知'}`
      emit('ending', '案件告破', '案件置信度达到 90%，真相已完整还原。')
    } else if (session.actionPoints <= 0) {
      session.gameState = 'ended'
      session.endingKind = 'timeout'
      session.ending = `行动点已用尽，案件置信度停留在 ${session.caseConfidence}%。尚未查明的部分仍留在档案里。`
      emit('ending', '审讯结束', '行动点已用尽，本局审讯到此为止。')
    } else if (suspectCount > 0 && session.terminated.length >= suspectCount) {
      // 所有嫌疑人都拒绝配合时无法再行动，直接收尾，避免卡在无行动可做的状态。
      session.gameState = 'ended'
      session.endingKind = 'breakdown'
      session.ending = `所有嫌疑人都终止了审讯，案件置信度停留在 ${session.caseConfidence}%。真相未能查明。`
      emit('ending', '审讯破裂', '没有嫌疑人愿意继续配合，本局审讯到此为止。')
    }

    updateSession(session)
    response.json({ reply: outcome.reply, source: outcome.source, session, events: turnEvents })
  })

  /*
   * 申请逮捕：由玩家指定一名嫌疑人并结束本局。
   * 只有在案件解析给出明确凶手姓名时才能判定对错，否则如实返回「无法判定」，不猜、不乱指。
   */
  router.post('/sessions/:sessionId/arrest', (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    const session = getSession(request.params.sessionId)
    if (!session) { response.status(404).json({ error: '会话不存在' }); return }
    if (session.gameState === 'ended') { response.status(409).json({ error: '本局审讯已经结束。', session }); return }

    const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {}
    const suspectId = readText(body.suspectId)
    if (!suspectId || !(suspectId in session.trust)) { response.status(400).json({ error: '请选择有效的嫌疑人。' }); return }

    const culprit = getCaseSecret(session.sessionId)?.culprit ?? ''
    const kind = judgeArrest(culprit, suspectId)
    session.gameState = 'ended'
    session.endingKind = kind
    session.ending = kind === 'arrest_hit'
      ? `你申请逮捕 ${suspectId}，与案件材料指向的凶手一致，逮捕获准。`
      : kind === 'arrest_miss'
        // 只说明指认错误，不透露真正的凶手是谁，避免剧透。
        ? `你申请逮捕 ${suspectId}。案件材料指向的是另一个人，检察机关作出不批准逮捕决定。`
        : `你申请逮捕 ${suspectId}。本案材料并未明确指出凶手身份，检察机关以事实不清、证据不足为由作出不批准逮捕决定。`
    const turnEvents = [pushEvent(session, {
      type: 'ending',
      title: kind === 'arrest_hit' ? '逮捕获准' : kind === 'arrest_miss' ? '逮捕被驳回' : '逮捕申请未获支持',
      detail: `案件置信度 ${session.caseConfidence}%。`,
    })]
    session.actionLog.push(`申请逮捕${suspectId}`)
    updateSession(session)
    response.json({ session, events: turnEvents })
  })

  return router
}
