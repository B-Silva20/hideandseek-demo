import type { CaseBriefing } from './caseStore.js'
import type { SessionState } from './sessionStore.js'

/*
 * 审讯对话图：把「玩家能说什么」建模成一张带条件的选项图。
 *
 * 之前玩家只能面对一个空输入框自由提问，状态机不存在，也就无从体现审讯的战术；
 * 现在每次行动前服务端都会按「剧情变量 + 嫌疑人情绪 + 案件话题 + 证据状态」
 * 算出一组可用话术，前端只负责渲染和回传 choiceId。
 *
 * 设计约定（来自 dialogue-systems 的「别造语言，造图」）：
 *   1. 节点是数据（下面的 CHOICE_TEMPLATES），不是代码分支；
 *   2. 条件是对变量与状态的声明式判断，没有表达式求值器；
 *   3. 变量与流程分离：变量存在 session.variables 里，随存档一起持久化；
 *   4. 提问文本由服务端按当前焦点话题生成，前端传回的是 choiceId，
 *      因此客户端无法伪造一个不满足条件的话术。
 *
 * 追问链是这样形成的：先问「例行询问」会记下话题（asked:<嫌疑人>:<话题>），
 * 之后的「追问细节 / 施加压力」要求该话题已问过，使用次数上限又让同一层
 * 不能无限重复，于是形成一个可穷尽、可测试的对话推进链。
 */

export type DialogueTier = 'open' | 'empathy' | 'press' | 'risky'

export interface DialogueChoice {
  /** 稳定标识；前端回传它，服务端重新校验可用性。 */
  choiceId: string
  /** 按钮文案 */
  label: string
  /** 实际发送给模型的提问文本（服务端权威，含插值后的话题） */
  question: string
  /** 界面用它决定配色与图标 */
  tier: DialogueTier
  /** 本次话术涉及的案件话题下标（从 1 开始）；没有话题时为 0。 */
  topicIndex: number
  /** 需要一并出示的证据；没有则为 null。 */
  evidenceId: string | null
}

/** 话术层级自带的态度修正：叠加在模型/规则结算出的增量之上，让选择有战术意义。 */
export const TIER_MODIFIERS: Record<DialogueTier, { trust: number; hostility: number }> = {
  open: { trust: 0, hostility: 0 },
  empathy: { trust: 4, hostility: -3 },
  press: { trust: -1, hostility: 4 },
  risky: { trust: -6, hostility: 8 },
}

interface ChoiceCondition {
  minTrust?: number
  maxTrust?: number
  minHostility?: number
  /** 需要存在涉及该嫌疑人且尚未对质的矛盾（有破绽才值得施压）。 */
  needsOpenContradiction?: boolean
  /** 需要该嫌疑人还有已解锁但没出示过的证据。 */
  needsUnshownEvidence?: boolean
  /** 需要已经就任意案件话题问过至少一次（追问链的第二层）。 */
  needsTopicAsked?: boolean
  /** 需要案件话题清单至少有这么多条。 */
  minTopics?: number
  /** 对同一嫌疑人的使用次数上限。 */
  maxUses?: number
}

interface ChoiceTemplate {
  id: string
  label: string
  /** {topic} 替换为焦点话题，{suspect} 替换为嫌疑人姓名。 */
  question: string
  tier: DialogueTier
  when: ChoiceCondition
  /** 是否把焦点话题记为「已问过」，只有开场型话术需要。 */
  recordsTopic: boolean
  /** 是否附带一件证据。 */
  attachesEvidence: boolean
}

const NO_TOPIC_TEXT = '案件相关的情况'

/** 选项图本体：顺序即界面上的展示顺序。 */
const CHOICE_TEMPLATES: ChoiceTemplate[] = [
  {
    id: 'routine',
    label: '例行询问',
    question: '请你说明一下关于「{topic}」的情况。',
    tier: 'open',
    when: {},
    recordsTopic: true,
    attachesEvidence: false,
  },
  {
    id: 'detail',
    label: '追问细节',
    question: '关于「{topic}」，你说得太笼统了。请按时间顺序，把你记得的每一件事都说清楚。',
    tier: 'press',
    when: { needsTopicAsked: true, maxUses: 2 },
    recordsTopic: false,
    attachesEvidence: false,
  },
  {
    id: 'empathy',
    label: '缓和气氛',
    question: '我知道回忆这些不容易。但只有你说清楚，我才能把「{topic}」这件事从记录里划掉。',
    tier: 'empathy',
    when: { maxTrust: 70, maxUses: 2 },
    recordsTopic: false,
    attachesEvidence: false,
  },
  {
    id: 'pressure',
    label: '施加压力',
    question: '「{topic}」这件事上你一直在回避。我再问一次：你到底在隐瞒什么？',
    tier: 'press',
    when: { needsTopicAsked: true, minHostility: 5, maxUses: 2 },
    recordsTopic: false,
    attachesEvidence: false,
  },
  {
    id: 'evidence',
    label: '出示证据逼问',
    question: '这份证据和你的说法对不上。你再看一遍，然后告诉我「{topic}」到底是怎么回事。',
    tier: 'press',
    when: { needsUnshownEvidence: true, maxUses: 3 },
    recordsTopic: false,
    attachesEvidence: true,
  },
  {
    id: 'ultimatum',
    label: '最后通牒',
    question: '「{topic}」的问题上，我再给你最后一次机会：要么现在说清楚，要么我按妨碍调查记录在案。',
    tier: 'risky',
    when: { minTrust: 40, maxUses: 1 },
    recordsTopic: false,
    attachesEvidence: false,
  },
]

/** 变量键：同一话术对同一嫌疑人的使用次数。 */
function choiceUseKey(suspect: string, choiceId: string): string {
  return `use:${suspect}:${choiceId}`
}

/** 变量键：某个话题是否已经问过该嫌疑人。 */
function askedKey(suspect: string, topicIndex: number): string {
  return `asked:${suspect}:${topicIndex}`
}

function count(session: SessionState, key: string): number {
  const value = session.variables[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function hasAskedTopic(session: SessionState, suspect: string): boolean {
  return Object.keys(session.variables).some((key) => key.startsWith(`asked:${suspect}:`) && count(session, key) > 0)
}

/** 该嫌疑人第一次可用作出示的已解锁证据（未向其出示过）。 */
export function evidenceFor(session: SessionState, suspect: string) {
  return session.evidence.find((item) => item.unlocked && !item.presentedTo.includes(suspect)) ?? null
}

function hasOpenContradiction(session: SessionState, suspect: string): boolean {
  return session.contradictions.some((item) => !item.confronted
    && (item.left.id === suspect || item.right.id === suspect))
}

/**
 * 焦点话题的选取顺序：
 *   1. 涉及该嫌疑人的未对质破绽（追问链优先咬住已有矛盾）；
 *   2. 还没问过的话题（按案件话题清单顺序推进）；
 *   3. 都问过了就回到最近问过的那一个。
 */
function resolveFocusTopic(session: SessionState, suspect: string, topics: string[]): { index: number; text: string } {
  if (topics.length === 0) return { index: 0, text: NO_TOPIC_TEXT }

  const open = session.contradictions.find((item) => !item.confronted && item.topicIndex > 0
    && (item.left.id === suspect || item.right.id === suspect))
  if (open) return { index: open.topicIndex, text: topics[open.topicIndex - 1] ?? open.topic }

  for (let index = 1; index <= topics.length; index += 1) {
    if (count(session, askedKey(suspect, index)) === 0) return { index, text: topics[index - 1] }
  }

  const asked = Object.keys(session.variables)
    .filter((key) => key.startsWith(`asked:${suspect}:`))
    .map((key) => Number(key.slice(key.lastIndexOf(':') + 1)))
    .filter((value) => Number.isInteger(value) && value > 0 && value <= topics.length)
  const last = asked.length ? Math.max(...asked) : 1
  return { index: last, text: topics[last - 1] }
}

/**
 * 按当前状态算出这名嫌疑人此刻可用的全部话术。
 * 纯函数：同样的 session / suspect / briefing 一定得到同样的结果，便于测试与复现。
 */
export function buildDialogueChoices(session: SessionState, suspect: string, briefing: CaseBriefing): DialogueChoice[] {
  if (!suspect) return []
  const topics = briefing.questions.filter((topic) => typeof topic === 'string' && topic.trim()).slice(0, 12)
  const focus = resolveFocusTopic(session, suspect, topics)
  const trust = session.trust[suspect] ?? 0
  const hostility = session.hostility[suspect] ?? 0
  const contradicted = hasOpenContradiction(session, suspect)
  const attachable = evidenceFor(session, suspect)

  const choices: DialogueChoice[] = []
  for (const template of CHOICE_TEMPLATES) {
    const when = template.when
    if (session.terminated.includes(suspect)) break
    if (when.minTrust !== undefined && trust < when.minTrust) continue
    if (when.maxTrust !== undefined && trust > when.maxTrust) continue
    if (when.minHostility !== undefined && hostility < when.minHostility) continue
    if (when.minTopics !== undefined && topics.length < when.minTopics) continue
    if (when.maxUses !== undefined && count(session, choiceUseKey(suspect, template.id)) >= when.maxUses) continue
    if (when.needsOpenContradiction && !contradicted) continue
    if (when.needsUnshownEvidence && !attachable) continue
    if (when.needsTopicAsked && !hasAskedTopic(session, suspect)) continue

    choices.push({
      choiceId: template.id,
      label: template.label,
      question: template.question.replaceAll('{topic}', focus.text).replaceAll('{suspect}', suspect),
      tier: template.tier,
      topicIndex: focus.index,
      evidenceId: template.attachesEvidence ? attachable?.evidenceId ?? null : null,
    })
  }
  return choices
}

/** 行动时重新校验：只有此刻仍然可用的 choiceId 才会被采纳。 */
export function findDialogueChoice(session: SessionState, suspect: string, briefing: CaseBriefing, choiceId: string): DialogueChoice | null {
  return buildDialogueChoices(session, suspect, briefing).find((choice) => choice.choiceId === choiceId) ?? null
}

/** 记一次话术使用；开场型话术同时把焦点话题标记为「已问过」，这就是追问链的前置条件。 */
export function recordDialogueChoice(session: SessionState, suspect: string, choice: DialogueChoice) {
  const key = choiceUseKey(suspect, choice.choiceId)
  session.variables[key] = count(session, key) + 1
  const template = CHOICE_TEMPLATES.find((item) => item.id === choice.choiceId)
  if (template?.recordsTopic && choice.topicIndex > 0) {
    const topicKey = askedKey(suspect, choice.topicIndex)
    session.variables[topicKey] = count(session, topicKey) + 1
  }
}
