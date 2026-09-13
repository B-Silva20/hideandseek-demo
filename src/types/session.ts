/*
 * 会话契约（前端副本）。
 *
 * 后端 tsconfig 的 rootDir 限定为 server/，无法直接引用本文件，
 * 因此 server/services/sessionStore.ts 与 server/routes/sessions.ts 保存了字段名
 * 完全一致的副本。修改任何字段名时必须两端同步修改。
 *
 *   POST /api/sessions                      -> 201 SessionState
 *   GET  /api/sessions/:sessionId           -> 200 SessionState
 *   POST /api/sessions/:sessionId/messages  -> 200 SessionTurnResponse | 400/404/409 SessionErrorResponse
 */

export interface EvidenceItem {
  evidenceId: string
  title: string
  detail: string
  /** 未解锁的证据会显示为「未解锁」，不能出示。 */
  unlocked: boolean
  /** 已经出示给哪些嫌疑人。 */
  presentedTo: string[]
}

/** 某个嫌疑人就某个话题给出的一次说法。 */
export interface Testimony {
  suspectId: string
  topicIndex: number
  label: string
  value: string
  claim: string
}

/** 矛盾板的一栏：可能来自某位嫌疑人的证词，也可能来自一份证据。 */
export interface ContradictionSide {
  id: string
  label: string
  text: string
}

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
  currentSubject: string | null
  history: Array<{ role: 'user' | 'npc'; content: string }>
  trust: Record<string, number>
  hostility: Record<string, number>
  evidence: EvidenceItem[]
  /** 结构化矛盾：两栏各自标明来源与说法，可直接对质。 */
  contradictions: Contradiction[]
  events: SessionEvent[]
  turn: number
  actionPoints: number
  actionPointsTotal: number
  actionLog: string[]
  /** 信任跌破阈值的嫌疑人，拒绝再回答任何问题。 */
  terminated: string[]
  gameState: 'active' | 'ended'
  /** 结局分类，供界面决定徽章与标题；审讯进行中为 null。 */
  endingKind: EndingKind | null
  ending: string | null
}

/** 结局分类：由置信度、行动点、终止审讯或玩家申请逮捕决定。 */
export type EndingKind =
  | 'confidence'
  | 'arrest_hit'
  | 'arrest_miss'
  | 'arrest_undecided'
  | 'timeout'
  | 'breakdown'

/** 一次行动的响应：reply 为嫌疑人回答，events 为本次结算产生的反馈事件。 */
export interface SessionTurnResponse {
  reply: string
  source: 'model' | 'rule'
  session: SessionState
  events: SessionEvent[]
}
