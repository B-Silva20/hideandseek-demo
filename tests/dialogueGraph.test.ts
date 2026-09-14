import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TIER_MODIFIERS, buildDialogueChoices, evidenceFor, findDialogueChoice, recordDialogueChoice } from '../server/services/dialogueGraph.js'
import type { CaseBriefing } from '../server/services/caseStore.js'
import type { SessionState } from '../server/services/sessionStore.js'

/*
 * 对话图的测试都是纯函数级别的：给定 session / suspect / briefing 就应该得到唯一结果，
 * 因此不需要起服务、不需要模型，也不会因为真实 API 的返回而抖动。
 */

const briefing: CaseBriefing = {
  playerRole: '调查人员',
  title: '测试案件',
  summary: '',
  objective: '',
  characters: [{ name: '甲', publicIdentity: '画师' }, { name: '乙', publicIdentity: '助手' }],
  relationships: [],
  knownClues: [],
  visibleEvidence: [],
  questions: ['当晚在哪里', '是否认识死者'],
}

function fixtureSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    caseConfidence: 0,
    sessionId: 'session_test',
    caseId: 'case_test',
    updatedAt: new Date(0).toISOString(),
    currentSubject: '甲',
    history: [],
    trust: { 甲: 50, 乙: 50 },
    hostility: { 甲: 0, 乙: 0 },
    evidence: [
      { evidenceId: 'evidence_1', title: '手记', detail: '手记', unlocked: true, presentedTo: [] },
      { evidenceId: 'evidence_2', title: '名单', detail: '名单', unlocked: false, presentedTo: [] },
    ],
    contradictions: [],
    testimonies: [],
    events: [],
    turn: 0,
    difficulty: 'hard',
    actionPoints: 20,
    actionPointsTotal: 20,
    actionLog: [],
    terminated: [],
    variables: {},
    gameState: 'active',
    endingKind: null,
    ending: null,
    ...overrides,
  }
}

function ids(session: SessionState, suspect = '甲'): string[] {
  return buildDialogueChoices(session, suspect, briefing).map((choice) => choice.choiceId)
}

test('routine is always offered and carries the focus topic', () => {
  const routine = buildDialogueChoices(fixtureSession(), '甲', briefing).find((choice) => choice.choiceId === 'routine')
  assert.ok(routine)
  assert.equal(routine.tier, 'open')
  assert.equal(routine.topicIndex, 1)
  assert.match(routine.question, /当晚在哪里/)
  assert.equal(routine.evidenceId, null)
})

test('the follow-up chain opens only after that topic has been asked', () => {
  const session = fixtureSession()
  assert.equal(ids(session).includes('detail'), false)

  const routine = buildDialogueChoices(session, '甲', briefing).find((choice) => choice.choiceId === 'routine')
  assert.ok(routine)
  recordDialogueChoice(session, '甲', routine)

  assert.ok(ids(session).includes('detail'))
  // 第一项已经问过，焦点话题推进到第二项。
  const next = buildDialogueChoices(session, '甲', briefing).find((choice) => choice.choiceId === 'routine')
  assert.ok(next)
  assert.equal(next.topicIndex, 2)
  assert.match(next.question, /是否认识死者/)
})

test('condition gates: pressure needs both a prior topic and heightened hostility', () => {
  const session = fixtureSession({ hostility: { 甲: 10, 乙: 0 } })
  assert.equal(ids(session).includes('pressure'), false)

  const routine = buildDialogueChoices(session, '甲', briefing).find((choice) => choice.choiceId === 'routine')
  assert.ok(routine)
  recordDialogueChoice(session, '甲', routine)

  assert.ok(ids(session).includes('pressure'))
  // 信任不足 40 时最后通牒不会出现。
  session.trust['甲'] = 20
  assert.equal(ids(session).includes('ultimatum'), false)
})

test('the evidence choice needs an unlocked evidence not yet shown to that suspect', () => {
  const session = fixtureSession()
  const choice = buildDialogueChoices(session, '甲', briefing).find((item) => item.choiceId === 'evidence')
  assert.ok(choice)
  assert.equal(choice.evidenceId, 'evidence_1')
  assert.equal(evidenceFor(session, '甲')?.evidenceId, 'evidence_1')

  // 出示给甲之后换成下一件；两件都出示过就再无证据话术。
  session.evidence[0].presentedTo.push('甲')
  session.evidence[1].unlocked = true
  assert.equal(evidenceFor(session, '甲')?.evidenceId, 'evidence_2')

  session.evidence[1].presentedTo.push('甲')
  assert.equal(ids(session).includes('evidence'), false)
})

test('use limits retire a choice, and a terminated suspect has no choices at all', () => {
  const session = fixtureSession()
  const ultimatum = buildDialogueChoices(session, '甲', briefing).find((choice) => choice.choiceId === 'ultimatum')
  assert.ok(ultimatum)
  recordDialogueChoice(session, '甲', ultimatum)
  assert.equal(ids(session).includes('ultimatum'), false)
  // 例行询问没有次数上限，可以一直用。
  assert.ok(ids(session).includes('routine'))

  session.terminated.push('甲')
  assert.deepEqual(buildDialogueChoices(session, '甲', briefing), [])
})

test('an unresolved contradiction involving the suspect becomes the focus topic', () => {
  const session = fixtureSession({
    contradictions: [{
      contradictionId: 'contradiction_1',
      topicIndex: 2,
      topic: '是否认识死者',
      left: { id: '甲', label: '甲', text: '认识' },
      right: { id: '乙', label: '乙', text: '不认识' },
      confronted: false,
    }],
  })
  const routine = buildDialogueChoices(session, '甲', briefing).find((choice) => choice.choiceId === 'routine')
  assert.ok(routine)
  assert.equal(routine.topicIndex, 2)
  assert.match(routine.question, /是否认识死者/)
})

test('only currently available ids pass validation, and placeholders are always resolved', () => {
  const session = fixtureSession({ hostility: { 甲: 10, 乙: 0 } })
  assert.ok(findDialogueChoice(session, '甲', briefing, 'routine'))
  assert.equal(findDialogueChoice(session, '甲', briefing, 'not-a-choice'), null)
  assert.equal(findDialogueChoice(session, '甲', briefing, ''), null)

  const routine = findDialogueChoice(session, '甲', briefing, 'routine')
  assert.ok(routine)
  recordDialogueChoice(session, '甲', routine)
  for (const choice of buildDialogueChoices(session, '甲', briefing)) {
    assert.doesNotMatch(choice.question, /\{topic\}|\{suspect\}/)
    assert.ok(choice.label.length > 0 && choice.question.length > 0)
  }
})

test('each tier carries a deliberate attitude modifier', () => {
  assert.deepEqual(Object.keys(TIER_MODIFIERS).sort(), ['empathy', 'open', 'press', 'risky'])
  assert.ok(TIER_MODIFIERS.empathy.trust > 0 && TIER_MODIFIERS.empathy.hostility < 0)
  assert.ok(TIER_MODIFIERS.risky.hostility > TIER_MODIFIERS.press.hostility)
  assert.deepEqual(TIER_MODIFIERS.open, { trust: 0, hostility: 0 })
})
