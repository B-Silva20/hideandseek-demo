import { randomUUID } from 'node:crypto'
import { findCase, getCaseCulprit, getCaseTruth, toCaseSummary } from './caseStore.js'
import type { CaseRecord } from './caseStore.js'

/*
 * 会话状态契约（服务端副本）。
 *
 * 前端 src/types/session.ts 保存了字段名完全一致的副本，修改任何字段时两端同步。
 * 会话对象会整体返回给浏览器，因此这里不保存任何只供服务端使用的信息：
 * 案件真相单独放在 caseSecrets 中，只在结局判定和模型提示词里使用。
 *
 *   POST /api/sessions                      -> 201 SessionState
 *   GET  /api/sessions/:sessionId           -> 200 SessionState
 *   POST /api/sessions/:sessionId/messages  -> 200 { reply, session, events }
 */

export interface EvidenceItem {
  evidenceId: string
  title: string
  detail: string
  /** 未解锁的证据可以展示为「未解锁」，但不能出示。 */
  unlocked: boolean
  /** 已经出示给哪些嫌疑人：同一份证据对同一人只结算一次突破。 */
  presentedTo: string[]
}

/** 某个嫌疑人就某个话题给出的一次说法。 */
export interface Testimony {
  suspectId: string
  /** 对应案件话题清单的下标（从 1 开始），是跨嫌疑人比对的唯一依据。 */
  topicIndex: number
  /** 话题短标签，仅用于展示。 */
  label: string
  /** 该嫌疑人在此话题上的立场，取值不同即视为证词冲突。 */
  value: string
  /** 该嫌疑人说法的摘要，用于矛盾板其中一栏。 */
  claim: string
}

/** 矛盾板的一栏：可能来自某位嫌疑人的证词，也可能来自一份证据。 */
export interface ContradictionSide {
  id: string
  label: string
  text: string
}

/** 结构化矛盾：两栏说法互相冲突，可由玩家当面对质。 */
export interface Contradiction {
  contradictionId: string
  topicIndex: number
  topic: string
  left: ContradictionSide
  right: ContradictionSide
  confronted: boolean
}

export type SessionEventType =
  | 'contradiction'
  | 'breakthrough'
  | 'unlock'
  | 'trust'
  | 'hostility'
  | 'ending'
  | 'info'

export interface SessionEvent {
  eventId: string
  type: SessionEventType
  title: string
  detail: string
  createdAt: string
}

export interface SessionState {
  caseConfidence: number
  sessionId: string
  caseId: string
  /** 最近一次行动的时间；存档列表按它排序，显示「上次审讯」用。 */
  updatedAt: string
  currentSubject: string | null
  history: Array<{ role: 'user' | 'npc'; content: string }>
  trust: Record<string, number>
  hostility: Record<string, number>
  evidence: EvidenceItem[]
  /** 结构化的矛盾记录：两栏各自标明来源与说法，界面可直接对质。 */
  contradictions: Contradiction[]
  /** 每个嫌疑人最近一次就某话题的说法，用于跨嫌疑人比对。 */
  testimonies: Testimony[]
  events: SessionEvent[]
  turn: number
  difficulty: Difficulty
  /** null 表示练手模式，不限制行动次数。 */
  actionPoints: number | null
  actionPointsTotal: number | null
  actionLog: string[]
  /** 信任跌破阈值的嫌疑人，拒绝再回答任何问题。 */
  terminated: string[]
  /** 剧情变量：话术使用次数（use:）与已问过的话题（asked:），随存档一起持久化。 */
  variables: Record<string, number>
  gameState: 'active' | 'ended'
  /** 结局分类，供界面决定徽章与标题；审讯进行中为 null。 */
  endingKind: EndingKind | null
  ending: null | string
}

/** 结局分类：由置信度、行动点、终止审讯或玩家申请逮捕决定。 */
export type EndingKind =
  | 'confidence'
  | 'arrest_hit'
  | 'arrest_miss'
  | 'arrest_undecided'
  | 'timeout'
  | 'breakdown'

export type Difficulty = 'hard' | 'normal' | 'easy' | 'practice'

/** 判断本次逮捕申请的结果。案件材料没有指明凶手时如实返回「无法判定」。 */
export function judgeArrest(culprit: string, suspectId: string): EndingKind {
  if (!culprit) return 'arrest_undecided'
  return culprit === suspectId ? 'arrest_hit' : 'arrest_miss'
}

export const ACTION_POINTS_BY_DIFFICULTY: Readonly<Record<Difficulty, number | null>> = {
  hard: 20,
  normal: 40,
  easy: 80,
  practice: null,
}
/** 置信度达到该值即视为查清真相，直接进入结局。 */
export const WIN_CONFIDENCE = 90
/** 信任值跌破该阈值时，嫌疑人终止审讯；前端 src/components/Interrogation.tsx 的提示阈值需与此一致。 */
export const TRUST_TERMINATION_THRESHOLD = 20
export const MAX_EVENTS = 24

const MAX_HISTORY = 40
const MAX_EVIDENCE = 12
const INITIAL_UNLOCKED = 4

const sessions = new Map<string, SessionState>()

type ChangeListener = () => void
/** 变更订阅：持久化层用它触发节流自动存档。 */
const changeListeners = new Set<ChangeListener>()

export function onSessionsChange(listener: ChangeListener): () => void {
  changeListeners.add(listener)
  return () => { changeListeners.delete(listener) }
}

/** 只在一次行动结算完成后通知，避免把行动执行到一半的状态落盘。 */
function notifySessionsChange() {
  for (const listener of [...changeListeners]) listener()
}
/** 仅供服务端使用的案件机密：真相用于结局结算与模型提示词，绝不随会话返回前端。 */
const caseSecrets = new Map<string, { truth: string; objective: string; culprit: string }>()

function truncate(value: string, maxLength: number): string {
  const characters = Array.from(value)
  return characters.length <= maxLength ? value : `${characters.slice(0, maxLength).join('')}…`
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

function now() {
  return new Date().toISOString()
}

/** 用 briefing 的可见证据与解析出的证据合并成证据目录，默认公开前几项。 */
function buildEvidence(record: CaseRecord): EvidenceItem[] {
  const visible = record.briefing?.visibleEvidence ?? []
  const source = record.parsed?.evidence?.length ? record.parsed.evidence : visible
  const titles: string[] = []
  for (const raw of source) {
    const title = truncate(raw.trim(), 90)
    if (title && !titles.includes(title)) titles.push(title)
  }
  return titles.slice(0, MAX_EVIDENCE).map((title, index) => ({
    evidenceId: `evidence_${index + 1}`,
    title,
    detail: title,
    unlocked: index < INITIAL_UNLOCKED || visible.some((item) => truncate(item.trim(), 90) === title),
    presentedTo: [],
  }))
}

export function createSession(caseId: unknown, difficulty: Difficulty = 'normal') {
  const record = findCase(caseId)
  if (!record) return null

  const briefing = toCaseSummary(record).briefing
  const characters = briefing?.characters ?? []
  const trust: Record<string, number> = {}
  const hostility: Record<string, number> = {}
  for (const person of characters) { trust[person.name] = 50; hostility[person.name] = 0 }

  const session: SessionState = {
    caseConfidence: 0,
    sessionId: `session_${randomUUID()}`,
    caseId: record.caseId,
    updatedAt: now(),
    currentSubject: null,
    history: [],
    trust,
    hostility,
    evidence: buildEvidence(record),
    contradictions: [],
    testimonies: [],
    events: [],
    turn: 0,
    difficulty,
    actionPoints: ACTION_POINTS_BY_DIFFICULTY[difficulty],
    actionPointsTotal: ACTION_POINTS_BY_DIFFICULTY[difficulty],
    actionLog: [],
    terminated: [],
    variables: {},
    gameState: 'active',
    endingKind: null,
    ending: null,
  }

  sessions.set(session.sessionId, session)
  caseSecrets.set(session.sessionId, {
    truth: truncate(getCaseTruth(record), 600),
    objective: briefing?.objective ?? '',
    culprit: getCaseCulprit(record),
  })
  notifySessionsChange()
  return session
}

export function getSession(id: unknown) {
  return typeof id === 'string' ? sessions.get(id) : undefined
}

export function getCaseSecret(sessionId: string) {
  return caseSecrets.get(sessionId)
}

/** 存档列表：按最近活动时间倒序，最新的存档排在最前。 */
export function listSessions(): SessionState[] {
  return [...sessions.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

/** 删除一个存档；连同它的案件机密一起清掉。 */
export function deleteSession(id: unknown): boolean {
  if (typeof id !== 'string' || !sessions.has(id)) return false
  sessions.delete(id)
  caseSecrets.delete(id)
  notifySessionsChange()
  return true
}

/**
 * 保存会话状态。这里是自动存档唯一的安全边界：调用方都已经把一次行动结算完毕，
 * 所以写盘时不会出现「扣了行动点但没写回复」这类中间状态。
 */
export function updateSession(session: SessionState) {
  session.updatedAt = now()
  sessions.set(session.sessionId, session)
  notifySessionsChange()
  return session
}

/** 追加一条事件反馈，供审讯界面做「破绽 / 突破」提示。 */
export function pushEvent(session: SessionState, event: Omit<SessionEvent, 'eventId' | 'createdAt'>): SessionEvent {
  const record: SessionEvent = { eventId: `event_${randomUUID()}`, createdAt: now(), ...event }
  session.events.push(record)
  if (session.events.length > MAX_EVENTS) session.events.splice(0, session.events.length - MAX_EVENTS)
  return record
}

export function pushHistory(session: SessionState, role: 'user' | 'npc', content: string) {
  session.history.push({ role, content })
  if (session.history.length > MAX_HISTORY) session.history.splice(0, session.history.length - MAX_HISTORY)
}

/**
 * 记录一条证词，并在同一话题上与其他嫌疑人比对。
 * 立场（value）不同即判定为矛盾，返回本次新产生的矛盾记录；没有新矛盾时返回 null。
 */
export function registerTestimony(session: SessionState, next: Testimony): Contradiction | null {
  const existing = session.testimonies.find((item) => item.suspectId === next.suspectId && item.topicIndex === next.topicIndex)
  if (existing) Object.assign(existing, next)
  else session.testimonies.push(next)

  for (const peer of session.testimonies) {
    if (peer.suspectId === next.suspectId) continue
    if (peer.topicIndex !== next.topicIndex) continue
    if (peer.value === next.value) continue
    // 固定左右顺序，避免同一对证词因为提问先后而产生两条记录。
    const [first, second] = [peer, next].sort((a, b) => a.suspectId.localeCompare(b.suspectId))
    const duplicated = session.contradictions.some((item) => item.topicIndex === next.topicIndex
      && item.left.id === first.suspectId && item.right.id === second.suspectId)
    if (duplicated) continue
    const record: Contradiction = {
      contradictionId: `contradiction_${randomUUID()}`,
      topicIndex: next.topicIndex,
      topic: next.label,
      left: { id: first.suspectId, label: first.suspectId, text: first.claim },
      right: { id: second.suspectId, label: second.suspectId, text: second.claim },
      confronted: false,
    }
    session.contradictions.push(record)
    return record
  }
  return null
}

/** 规则回退路径没有话题信息，此时矛盾只能来自「证据与说法冲突」。 */
export function addEvidenceContradiction(
  session: SessionState,
  suspectId: string,
  claim: string,
  evidenceTitle: string,
): Contradiction | null {
  const duplicated = session.contradictions.some((item) => item.left.id === 'evidence' && item.right.id === suspectId && item.left.text === evidenceTitle)
  if (duplicated) return null
  const record: Contradiction = {
    contradictionId: `contradiction_${randomUUID()}`,
    topicIndex: 0,
    topic: `证据「${evidenceTitle}」`,
    left: { id: 'evidence', label: '证据', text: evidenceTitle },
    right: { id: suspectId, label: suspectId, text: truncate(claim, 120) },
    confronted: false,
  }
  session.contradictions.push(record)
  return record
}

/** 信任跌破阈值即终止审讯；返回本次是否刚刚终止。 */
export function terminateOnLowTrust(session: SessionState, suspectId: string): boolean {
  if (session.trust[suspectId] >= TRUST_TERMINATION_THRESHOLD) return false
  if (session.terminated.includes(suspectId)) return false
  session.terminated.push(suspectId)
  return true
}

/** 解锁下一份尚未公开的证据；没有更多证据时返回 null。 */
export function unlockNextEvidence(session: SessionState, reason: string): EvidenceItem | null {
  const next = session.evidence.find((item) => !item.unlocked)
  if (!next) return null
  next.unlocked = true
  pushEvent(session, { type: 'unlock', title: '发现新证据', detail: `${reason}，档案中新增可出示证据：「${next.title}」` })
  return next
}

/*
 * 以下函数只服务于存档恢复（server/services/persistence.ts）。
 * 存档是玩家机器上的本地文件，可能被截断、手工改动，或引用了已不存在的案件，
 * 因此逐字段校验：单条会话不合法只丢弃这一条，不让整份存档作废。
 */

export interface CaseSecret {
  truth: string
  objective: string
  culprit: string
}

export function snapshotSessions(): { sessions: SessionState[]; secrets: Record<string, CaseSecret> } {
  return {
    sessions: [...sessions.values()].map((session) => structuredClone(session)),
    secrets: structuredClone(Object.fromEntries(caseSecrets)),
  }
}

const EVENT_TYPES: readonly SessionEventType[] = ['contradiction', 'breakthrough', 'unlock', 'trust', 'hostility', 'ending', 'info']
const ENDING_KINDS: readonly EndingKind[] = ['confidence', 'arrest_hit', 'arrest_miss', 'arrest_undecided', 'timeout', 'breakdown']

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
}

function readNumberMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, number> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'number' && Number.isFinite(entry)) result[key] = Math.round(entry)
  }
  return result
}

function readStringArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string').slice(0, maxItems)
}

function readHistory(value: unknown): Array<{ role: 'user' | 'npc'; content: string }> {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const line = entry as Record<string, unknown>
    if (typeof line.content !== 'string') return []
    if (line.role !== 'user' && line.role !== 'npc') return []
    const role: 'user' | 'npc' = line.role === 'user' ? 'user' : 'npc'
    return [{ role, content: line.content }]
  }).slice(-MAX_HISTORY)
}

function readEvidence(value: unknown): EvidenceItem[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const item = entry as Record<string, unknown>
    if (typeof item.evidenceId !== 'string' || !item.evidenceId || typeof item.title !== 'string') return []
    return [{
      evidenceId: item.evidenceId,
      title: item.title,
      detail: typeof item.detail === 'string' ? item.detail : item.title,
      unlocked: item.unlocked === true,
      presentedTo: readStringArray(item.presentedTo, 64),
    }]
  }).slice(0, MAX_EVIDENCE)
}

function readSide(value: unknown, fallbackId: string): ContradictionSide {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : fallbackId,
    label: typeof raw.label === 'string' && raw.label ? raw.label : fallbackId,
    text: typeof raw.text === 'string' ? raw.text : '',
  }
}

function readContradictions(value: unknown): Contradiction[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const item = entry as Record<string, unknown>
    if (typeof item.contradictionId !== 'string' || !item.contradictionId) return []
    const left = readSide(item.left, 'left')
    const right = readSide(item.right, 'right')
    if (!left.text && !right.text) return []
    return [{
      contradictionId: item.contradictionId,
      topicIndex: asNumber(item.topicIndex),
      topic: typeof item.topic === 'string' && item.topic ? item.topic : left.label,
      left,
      right,
      confronted: item.confronted === true,
    }]
  })
}

function readTestimonies(value: unknown): Testimony[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const raw = entry as Record<string, unknown>
    if (typeof raw.suspectId !== 'string' || !raw.suspectId) return []
    const topicIndex = asNumber(raw.topicIndex)
    if (topicIndex <= 0) return []
    return [{
      suspectId: raw.suspectId,
      topicIndex,
      label: typeof raw.label === 'string' ? raw.label : '',
      value: typeof raw.value === 'string' ? raw.value : '',
      claim: typeof raw.claim === 'string' ? raw.claim : '',
    }]
  })
}

function readEvents(value: unknown): SessionEvent[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const raw = entry as Record<string, unknown>
    if (typeof raw.eventId !== 'string' || !raw.eventId) return []
    if (typeof raw.type !== 'string' || !EVENT_TYPES.includes(raw.type as SessionEventType)) return []
    return [{
      eventId: raw.eventId,
      type: raw.type as SessionEventType,
      title: typeof raw.title === 'string' ? raw.title : '',
      detail: typeof raw.detail === 'string' ? raw.detail : '',
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now(),
    }]
  }).slice(-MAX_EVENTS)
}

function readEndingKind(value: unknown): EndingKind | null {
  return typeof value === 'string' && ENDING_KINDS.includes(value as EndingKind) ? value as EndingKind : null
}

function readDifficulty(value: unknown, actionPointsTotal: unknown): Difficulty {
  if (value === 'hard' || value === 'normal' || value === 'easy' || value === 'practice') return value
  if (actionPointsTotal === null) return 'practice'
  if (actionPointsTotal === 20) return 'hard'
  if (actionPointsTotal === 80) return 'easy'
  return 'normal'
}

function readStoredSession(value: unknown): SessionState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId.trim() : ''
  const caseId = typeof raw.caseId === 'string' ? raw.caseId.trim() : ''
  if (!sessionId || !caseId) return null
  // 案件不在存档里时这条会话无法继续（没有人物就没有话题），丢弃而不是留下一间空房间。
  if (!findCase(caseId)) return null
  const trust = readNumberMap(raw.trust)
  if (Object.keys(trust).length === 0) return null

  const difficulty = readDifficulty(raw.difficulty, raw.actionPointsTotal)
  const actionPointsTotal = ACTION_POINTS_BY_DIFFICULTY[difficulty]
  const gameState = raw.gameState === 'ended' ? 'ended' : 'active'
  const session: SessionState = {
    caseConfidence: clamp(asNumber(raw.caseConfidence), 0, 100),
    sessionId,
    caseId,
    updatedAt: typeof raw.updatedAt === 'string' && !Number.isNaN(Date.parse(raw.updatedAt)) ? raw.updatedAt : now(),
    currentSubject: typeof raw.currentSubject === 'string' && raw.currentSubject in trust ? raw.currentSubject : null,
    history: readHistory(raw.history),
    trust,
    hostility: readNumberMap(raw.hostility),
    evidence: readEvidence(raw.evidence),
    contradictions: readContradictions(raw.contradictions),
    testimonies: readTestimonies(raw.testimonies),
    events: readEvents(raw.events),
    turn: Math.max(0, asNumber(raw.turn)),
    difficulty,
    actionPoints: actionPointsTotal === null ? null : clamp(asNumber(raw.actionPoints, actionPointsTotal), 0, actionPointsTotal),
    actionPointsTotal,
    actionLog: readStringArray(raw.actionLog, 200),
    terminated: readStringArray(raw.terminated, 64).filter((name) => name in trust),
    variables: readNumberMap(raw.variables),
    gameState,
    endingKind: gameState === 'ended' ? readEndingKind(raw.endingKind) : null,
    ending: typeof raw.ending === 'string' ? raw.ending : null,
  }
  return session
}

/** 从存档恢复会话与案件机密；必须在 hydrateCases 之后调用（会话会校验案件是否存在）。 */
export function hydrateSessions(payload: unknown): { sessions: number; secrets: number } {
  const container = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {}
  const list = Array.isArray(container.sessions) ? container.sessions : []
  const rawSecrets = container.secrets && typeof container.secrets === 'object' && !Array.isArray(container.secrets)
    ? container.secrets as Record<string, unknown>
    : {}
  let restored = 0
  let secrets = 0
  for (const entry of list) {
    const session = readStoredSession(entry)
    if (!session) continue
    sessions.set(session.sessionId, session)
    const secret = rawSecrets[session.sessionId]
    const parsed = secret && typeof secret === 'object' && !Array.isArray(secret) ? secret as Record<string, unknown> : null
    caseSecrets.set(session.sessionId, {
      truth: typeof parsed?.truth === 'string' ? parsed.truth : '',
      objective: typeof parsed?.objective === 'string' ? parsed.objective : '',
      culprit: typeof parsed?.culprit === 'string' ? parsed.culprit : '',
    })
    restored += 1
    secrets += 1
  }
  return { sessions: restored, secrets }
}
