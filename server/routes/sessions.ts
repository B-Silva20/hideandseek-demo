import { Router } from 'express'
import { findCase, toCaseSummary } from '../services/caseStore.js'
import type { CaseRecord } from '../services/caseStore.js'
import { TIER_MODIFIERS, buildDialogueChoices, findDialogueChoice, recordDialogueChoice } from '../services/dialogueGraph.js'
import { observeOutcome, ruleOutcome, runInterrogation } from '../services/interrogation.js'
import type { InterrogationContext } from '../services/interrogation.js'
import {
  TRUST_TERMINATION_THRESHOLD,
  clamp,
  createSession,
  getCaseSecret,
  getSession,
  judgeArrest,
  pushEvent,
  pushHistory,
  terminateOnLowTrust,
  unlockNextEvidence,
  updateSession,
} from '../services/sessionStore.js'
import type { Contradiction, Difficulty, EvidenceItem, SessionEvent, SessionEventType, SessionState } from '../services/sessionStore.js'

const MAX_QUESTION = 500
/** 置信度跨过该值视为一次关键突破。 */
const BREAKTHROUGH_CONFIDENCE = 70

/**
 * 角色模型只获得玩家已经看见、已经出示或已经完成当面对质的资料。
 * 不把 secret.truth 交给模型，避免“不得剧透”的提示词失效时直接招供。
 */
function buildAllowedFacts(
  session: SessionState,
  record: CaseRecord,
  character: { name: string; publicIdentity: string },
  evidence: EvidenceItem | undefined,
  target: Contradiction | undefined,
) {
  const facts: Array<{ id: string; text: string }> = [
    { id: 'public_identity', text: `${character.name}的公开身份：${character.publicIdentity}` },
  ]
  for (const fact of record.parsed?.facts ?? []) {
    if (!fact.holders.includes('all') && !fact.holders.includes(character.name)) continue
    const matchingEvidence = session.evidence.some((item) => item.title === fact.evidenceTitle
      && (item.presentedTo.includes(character.name) || item.evidenceId === evidence?.evidenceId))
    const unlocked = fact.revealAfter === 'initial'
      || (fact.revealAfter === 'evidence' && matchingEvidence)
      || (fact.revealAfter === 'confrontation' && Boolean(target))
    if (unlocked) facts.push({ id: `fact:${fact.factId}`, text: fact.text })
  }
  for (const item of session.evidence) {
    if (!item.presentedTo.includes(character.name)) continue
    facts.push({ id: `evidence:${item.evidenceId}`, text: `调查员此前向你出示过：${item.title}` })
  }
  if (evidence && !facts.some((fact) => fact.id === `evidence:${evidence.evidenceId}`)) {
    facts.push({ id: `evidence:${evidence.evidenceId}`, text: `调查员现在出示：${evidence.title}` })
  }
  if (target?.confronted) {
    facts.push({ id: `confrontation:${target.contradictionId}`, text: `已被当面对质的内容：${target.topic}` })
  }
  return facts
}

/**
 * 用固定大小的服务端状态替代长聊天记录：模型知道当前进度，却不会随着游玩时长接收更多文本。
 */
function buildStateSummary(session: SessionState, suspectId: string): string {
  const shown = session.evidence
    .filter((item) => item.presentedTo.includes(suspectId))
    .map((item) => item.title)
    .slice(-4)
  const unlocked = session.evidence.filter((item) => item.unlocked).length
  return [
    `第 ${session.turn} 轮`,
    `该人物信任 ${session.trust[suspectId] ?? 0}`,
    `敌意 ${session.hostility[suspectId] ?? 0}`,
    `已出示证物：${shown.length ? shown.join('、') : '无'}`,
    `已解锁证物 ${unlocked}/${session.evidence.length}`,
    `已记录矛盾 ${session.contradictions.length} 处`,
  ].join('；')
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readDifficulty(value: unknown): Difficulty | null {
  return value === 'hard' || value === 'normal' || value === 'easy' || value === 'practice' ? value : null
}

export function createSessionsRouter() {
  const router = Router()

  router.post('/sessions', (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {}
    const difficulty = body.difficulty === undefined ? 'normal' : readDifficulty(body.difficulty)
    if (!difficulty) { response.status(400).json({ error: '请选择有效的断案难度。' }); return }
    const session = createSession(body.caseId, difficulty)
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
   * 当前可用话术。
   * 这是派生数据，不进 SessionState：同一个会话在不同嫌疑人、不同进度下的选项完全不同，
   * 所以按「会话 + 嫌疑人」现算。前端在切人、每次行动后各取一次。
   *
   *   GET /api/sessions/:sessionId/choices?suspect=名字 -> 200 { choices: DialogueChoice[] }
   */
  router.get('/sessions/:sessionId/choices', (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    const session = getSession(request.params.sessionId)
    if (!session) { response.status(404).json({ error: '会话不存在' }); return }
    const record = findCase(session.caseId)
    const briefing = record ? toCaseSummary(record).briefing : undefined
    if (!briefing) { response.status(409).json({ error: '案件数据已失效，请重新提交案件后再开始审讯。' }); return }
    const requested = readText(request.query.suspect)
    const suspect = requested && requested in session.trust ? requested : session.currentSubject ?? Object.keys(session.trust)[0] ?? ''
    if (!suspect) { response.json({ choices: [] }); return }
    response.json({ choices: buildDialogueChoices(session, suspect, briefing) })
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
    if (session.actionPoints !== null && session.actionPoints <= 0) { response.status(409).json({ error: '行动点不足', session }); return }

    const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {}
    const suspectId = readText(body.suspectId)
    if (!suspectId || !(suspectId in session.trust)) { response.status(400).json({ error: '请选择有效的嫌疑人。' }); return }
    if (session.terminated.includes(suspectId)) { response.status(409).json({ error: '该嫌疑人已终止审讯，拒绝再回答任何问题。', session }); return }

    const record = findCase(session.caseId)
    const briefing = record ? toCaseSummary(record).briefing : undefined
    const character = briefing?.characters.find((person) => person.name === suspectId)
    if (!record || !briefing || !character) { response.status(409).json({ error: '案件数据已失效，请重新提交案件后再开始审讯。' }); return }

    /*
     * 话术选项：前端只回传 choiceId，提问文本与附带证据都由服务端按当前状态重新生成。
     * 所以客户端既拼不出一段不存在的提问，也无法用一个已经用尽或用不起的话术绕过条件。
     */
    const choiceId = readText(body.choiceId)
    const choice = choiceId ? findDialogueChoice(session, suspectId, briefing, choiceId) : null
    if (choiceId && !choice) { response.status(409).json({ error: '这个话术当前不可用，请重新选择。', session }); return }

    const question = choice ? choice.question : Array.from(readText(body.text)).slice(0, MAX_QUESTION).join('')
    const evidenceId = choice?.evidenceId ?? readText(body.evidenceId)
    // 沉默观察是确定性行动：不与提问或出示证据叠加，也不调用模型。
    const observing = body.observe === true && !question && !evidenceId

    if (!question && !evidenceId && !observing) { response.status(400).json({ error: '请输入问题或选择一份证据。' }); return }

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

    const alreadyPresented = Boolean(evidence?.presentedTo.includes(suspectId))
    const context: InterrogationContext = {
      suspect: { name: character.name, publicIdentity: character.publicIdentity },
      question,
      evidence: evidence ? { title: evidence.title, detail: evidence.detail } : null,
      evidenceAlreadyPresented: alreadyPresented,
      objective: briefing.objective,
      allowedFacts: buildAllowedFacts(session, record, character, evidence, target),
      stateSummary: buildStateSummary(session, suspectId),
      transcript: [...session.history],
    }

    const useRuleFallback = body.useRuleFallback === true
    const outcome = observing
      ? observeOutcome(character.name)
      : useRuleFallback
        ? ruleOutcome(context)
        : await runInterrogation(context)
    if (outcome.fallbackReason && !useRuleFallback) {
      response.status(503).json({
        error: `${outcome.fallbackReason} 本次行动尚未消耗；你可以重试，或继续使用规则回复。`,
        fallbackAvailable: true,
      })
      return
    }
    const turnEvents: SessionEvent[] = []
    const emit = (type: SessionEventType, title: string, detail: string) => {
      turnEvents.push(pushEvent(session, { type, title, detail }))
    }

    const beforeConfidence = session.caseConfidence
    const suspectCount = Object.keys(session.trust).length
    session.turn += 1
    if (session.actionPoints !== null) session.actionPoints -= 1
    session.currentSubject = suspectId
    // 玩家侧的时间线文案与实际提问保持一致：话术选项显示成「【标签】问题」。
    const spokenLine = choice
      ? `【${choice.label}】${question}`
      : evidence ? `【出示证据：${evidence.title}】${question}` : question
    pushHistory(session, 'user', observing ? '【沉默观察】' : spokenLine)
    pushHistory(session, 'npc', outcome.reply)

    // 话术层级自带的态度修正：叠加在模型/规则算出的增量之上，让「说什么」本身成为一种战术。
    const tierModifier = choice ? TIER_MODIFIERS[choice.tier] : { trust: 0, hostility: 0 }
    const trustDelta = outcome.trustDelta + tierModifier.trust
    const hostilityDelta = outcome.hostilityDelta + tierModifier.hostility
    session.trust[suspectId] = clamp(session.trust[suspectId] + trustDelta, 0, 100)
    session.hostility[suspectId] = clamp(session.hostility[suspectId] + hostilityDelta, 0, 100)

    // 案件进度只由玩家实际使用的新证据和已存在的当面对质结算。
    // 对话模型的文字与情绪不能直接加分、更不能直接触发结局。
    let confidenceDelta = 0
    if (evidence && !alreadyPresented) {
      confidenceDelta = 8
    } else if (alreadyPresented) {
      emit('info', '证据重复出示', `「${evidence?.title ?? ''}」已经向${suspectId}出示过，本次不再计入新的突破。`)
    }

    if (observing) emit('info', '沉默观察', `你没有追问，${suspectId} 的信任 +${outcome.trustDelta}，敌意 ${outcome.hostilityDelta}。`)
    else if (hostilityDelta >= 8) emit('hostility', '嫌疑人戒备加深', `${suspectId} 的敌意 +${hostilityDelta}。`)
    else if (trustDelta >= 8) emit('trust', '嫌疑人态度松动', `${suspectId} 的信任 +${trustDelta}。`)
    if (terminateOnLowTrust(session, suspectId)) {
      emit('trust', '审讯被终止', `${suspectId} 的信任跌破 ${TRUST_TERMINATION_THRESHOLD}，拒绝再回答任何问题。`)
    }

    if (target) {
      target.confronted = true
      confidenceDelta += 12
      emit('info', '当面对质', `就「${target.topic}」当面对质，${suspectId} 无法再用原来的说法搪塞。`)
    }

    session.caseConfidence = clamp(beforeConfidence + confidenceDelta, 0, 100)
    if (evidence && !alreadyPresented) evidence.presentedTo.push(suspectId)

    const crossedBreakthrough = beforeConfidence < BREAKTHROUGH_CONFIDENCE && session.caseConfidence >= BREAKTHROUGH_CONFIDENCE
    if (evidence && !alreadyPresented) unlockNextEvidence(session, '已核对一份新证据')
    else if (crossedBreakthrough) unlockNextEvidence(session, '线索逐渐闭合')
    if (crossedBreakthrough) {
      emit('breakthrough', '关键突破', `案件置信度达到 ${session.caseConfidence}%，真相轮廓已经浮现。`)
    }

    session.actionLog.push(observing
      ? `对${suspectId}沉默观察，消耗 1 行动点`
      : evidence
        ? `向${suspectId}出示证据「${evidence.title}」，消耗 1 行动点`
        : `向${suspectId}提问，消耗 1 行动点`)

    // 话术使用次数与「已问过的话题」写进剧情变量，它们决定下一轮还有哪些话术可选。
    if (choice) recordDialogueChoice(session, suspectId, choice)

    // 自动结局只处理明确的资源耗尽；案件告破必须由玩家提出逮捕，
    // 再由服务端的 culprit 规则判定，避免模型随机把案件提前结束。
    if (session.actionPoints !== null && session.actionPoints <= 0) {
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
