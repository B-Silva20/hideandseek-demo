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

/** 话术层级：界面据此决定配色，服务端据此叠加态度修正。 */
export type DialogueTier = 'open' | 'empathy' | 'press' | 'risky'
export type Difficulty = 'hard' | 'normal' | 'easy' | 'practice'

/*
 * 一条可用话术。属于派生数据：不随 SessionState 返回，
 * 而是由 GET /api/sessions/:sessionId/choices?suspect=名字 按「会话 + 嫌疑人」现算。
 * question 由服务端权威生成，前端只负责展示并回传 choiceId。
 */
export interface DialogueChoice {
  choiceId: string
  label: string
  question: string
  tier: DialogueTier
  /** 涉及的案件话题下标（从 1 开始）；没有话题时为 0。 */
  topicIndex: number
  /** 需要一并出示的证据；没有则为 null。 */
  evidenceId: string | null
}

export interface SessionState {
  caseConfidence: number
  sessionId: string
  caseId: string
  /** 最近一次行动时间，存档列表用它排序。 */
  updatedAt: string
  currentSubject: string | null
  history: Array<{ role: 'user' | 'npc'; content: string }>
  trust: Record<string, number>
  hostility: Record<string, number>
  evidence: EvidenceItem[]
  /** 结构化矛盾：两栏各自标明来源与说法，可直接对质。 */
  contradictions: Contradiction[]
  events: SessionEvent[]
  turn: number
  difficulty: Difficulty
  actionPoints: number | null
  actionPointsTotal: number | null
  actionLog: string[]
  /** 信任跌破阈值的嫌疑人，拒绝再回答任何问题。 */
  terminated: string[]
  /** 剧情变量：话术使用次数（use:）与已问过的话题（asked:），与服务端同构。 */
  variables: Record<string, number>
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
