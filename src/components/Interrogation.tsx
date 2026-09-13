import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { CaseBriefing } from '../types/api'
import type { Contradiction, EndingKind, SessionEvent, SessionState, SessionTurnResponse } from '../types/session'
import ModelConfig from './ModelConfig'
import { AlertIcon, BoltIcon, CheckIcon, CloseIcon, EyeIcon, GearIcon, LockIcon } from './icons'
import './Interrogation.css'

const MAX_QUESTION_LENGTH = 500
/** 与后端 WIN_CONFIDENCE 保持一致，仅用于结局文案判定。 */
const WIN_CONFIDENCE = 90
/** 与后端 TRUST_TERMINATION_THRESHOLD 保持一致：信任跌破该值嫌疑人会终止审讯。 */
const TRUST_WARNING = 20

/** 结局分类到界面文案的映射，tone 决定徽章配色。 */
const ENDING_VIEW: Record<EndingKind, { badge: string; title: string; tone: string }> = {
  confidence: { badge: 'CASE CLOSED', title: '案件告破', tone: 'solved' },
  arrest_hit: { badge: 'ARRESTED', title: '逮捕获准', tone: 'solved' },
  arrest_miss: { badge: 'WRONG ARREST', title: '逮捕被驳回', tone: 'failed' },
  arrest_undecided: { badge: 'UNDECIDED', title: '不予逮捕', tone: 'unresolved' },
  timeout: { badge: 'TIME OUT', title: '审讯结束', tone: 'unresolved' },
  breakdown: { badge: 'BREAKDOWN', title: '审讯破裂', tone: 'failed' },
}

type ChatKind = 'user' | 'npc' | 'system'
type MobileTab = 'suspect' | 'chat' | 'board'

interface ChatItem {
  id: string
  kind: ChatKind
  text: string
  /** 服务端历史不带说话人，只有本次会话产生的回复能补上名字。 */
  speaker?: string
  fresh?: boolean
}

interface Props {
  session: SessionState
  briefing: CaseBriefing
  onBack: () => void
  onModelConnected?: () => void
}

function toTimeline(history: SessionState['history']): ChatItem[] {
  return history.map((line, index) => ({ id: `history_${index}`, kind: line.role, text: line.content }))
}

export default function Interrogation({ session, briefing, onBack, onModelConnected }: Props) {
  const [state, setState] = useState(session)
  const [suspect, setSuspect] = useState(session.currentSubject ?? briefing.characters[0]?.name ?? '')
  const [timeline, setTimeline] = useState<ChatItem[]>(() => toTimeline(session.history))
  const [question, setQuestion] = useState('')
  const [source, setSource] = useState<'model' | 'rule' | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [mobileTab, setMobileTab] = useState<MobileTab>('chat')
  const [showModel, setShowModel] = useState(false)
  const [flashEvidenceId, setFlashEvidenceId] = useState('')
  const [flashTrust, setFlashTrust] = useState(false)
  const [showReplay, setShowReplay] = useState(false)
  /** 与后端无关：只用来给「本局新解锁」的证据打标。 */
  const [lockedAtStart] = useState(() => new Set(session.evidence.filter((item) => !item.unlocked).map((item) => item.evidenceId)))
  const sequence = useRef(0)
  const historyRef = useRef<HTMLDivElement>(null)

  const ended = state.gameState === 'ended'
  const actionPoints = state.actionPoints
  /** 该嫌疑人信任跌破阈值后拒绝再回答，任何行动都会被后端拒绝。 */
  const terminated = state.terminated.includes(suspect)
  const canAct = !busy && !ended && !terminated && actionPoints > 0 && Boolean(suspect)
  const confidence = Math.max(0, Math.min(100, state.caseConfidence))
  const currentTrust = state.trust[suspect] ?? 0
  const currentHostility = state.hostility[suspect] ?? 0
  const presentedToCurrent = state.evidence.filter((item) => item.presentedTo.includes(suspect)).length

  useEffect(() => {
    const element = historyRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [timeline, busy])

  // 动画类播完就移除，避免下次渲染残留。
  useEffect(() => {
    if (!flashEvidenceId) return
    const timer = window.setTimeout(() => setFlashEvidenceId(''), 600)
    return () => window.clearTimeout(timer)
  }, [flashEvidenceId])

  useEffect(() => {
    if (!flashTrust) return
    const timer = window.setTimeout(() => setFlashTrust(false), 460)
    return () => window.clearTimeout(timer)
  }, [flashTrust])

  function nextId(prefix: string) {
    sequence.current += 1
    return `${prefix}_${sequence.current}`
  }

  /** 一次行动 = 提问 / 出示证据 / 沉默观察，统一消耗 1 行动点。 */
  async function act(payload: { text?: string; evidenceId?: string; observe?: boolean; contradictionId?: string }): Promise<boolean> {
    if (!canAct) return false
    const submittedText = payload.text ?? ''
    const actionEvidence = payload.evidenceId
      ? state.evidence.find((item) => item.evidenceId === payload.evidenceId) ?? null
      : null
    const playerText = payload.observe
      ? '【沉默观察】'
      : actionEvidence ? `【出示证据：${actionEvidence.title}】${submittedText}` : submittedText

    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/sessions/${state.sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suspectId: suspect, ...payload }),
      })
      // 响应体不是 JSON（例如代理返回 HTML 错误页）时按失败处理，不把 SyntaxError 抛给用户。
      const body = await response.json().catch(() => ({})) as Partial<SessionTurnResponse> & { error?: string }
      if (!response.ok) throw new Error(body.error || '审讯失败，请重试。')
      if (!body.session) throw new Error('审讯失败，请重试。')

      setState(body.session)
      setSource(body.source ?? null)
      // 只清空本次提交的内容：等待服务端返回期间用户新输入的文字不能丢。
      setQuestion((current) => (current.trim() === submittedText.trim() ? '' : current))
      if (actionEvidence) setFlashEvidenceId(actionEvidence.evidenceId)

      const appended: ChatItem[] = []
      if (playerText) appended.push({ id: nextId('local'), kind: 'user', text: playerText, fresh: true })
      if (body.reply) appended.push({ id: nextId('local'), kind: 'npc', text: body.reply, speaker: suspect, fresh: true })
      for (const event of body.events ?? []) {
        appended.push({ id: event.eventId, kind: 'system', text: `${event.title}｜${event.detail}`, fresh: true })
      }
      if (appended.length) setTimeline((current) => [...current, ...appended])
      setFlashTrust(true)
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '审讯失败，请重试。')
      return false
    } finally {
      setBusy(false)
    }
  }

  function send() {
    const text = question.trim()
    if (!text) return
    void act({ text })
  }

  function presentEvidence(evidenceId: string) {
    if (!canAct) return
    const text = question.trim()
    void act(text ? { evidenceId, text } : { evidenceId })
  }

  /** 申请逮捕：交给服务端判定并直接结束本局，界面随后切到结局页。 */
  async function arrest(person: string) {
    if (busy || ended) return
    if (!window.confirm(`确定申请逮捕 ${person} 吗？本局审讯将立即结束。`)) return
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/sessions/${state.sessionId}/arrest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suspectId: person }),
      })
      const body = await response.json().catch(() => ({})) as { session?: SessionState; events?: SessionEvent[]; error?: string }
      if (!response.ok) throw new Error(body.error || '申请逮捕失败，请重试。')
      if (!body.session) throw new Error('申请逮捕失败，请重试。')
      setState(body.session)
      const appended = (body.events ?? []).map((event) => ({ id: event.eventId, kind: 'system' as const, text: `${event.title}｜${event.detail}` }))
      if (appended.length) setTimeline((current) => [...current, ...appended])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '申请逮捕失败，请重试。')
    } finally {
      setBusy(false)
    }
  }

  /** 当面对质：把服务端记录的两栏说法摆到嫌疑人面前，已对质状态由服务端保存。 */
  async function confront(item: Contradiction) {
    if (item.confronted || !canAct) return
    const text = `关于「${item.topic}」，${item.left.label} 说「${item.left.text}」，而你说「${item.right.text}」。请你解释这一点。`
    if (await act({ text, contradictionId: item.contradictionId })) {
      // 窄屏下矛盾板和对话区不同屏，对质后切回对话区才能看到回应。
      setMobileTab('chat')
    }
  }

  function switchSuspect(next: string) {
    if (busy || next === suspect) return
    setSuspect(next)
    setMobileTab('chat')
  }

  function onInputKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send()
    }
  }

  /* ------------------------------ 结局 ------------------------------ */

  if (ended) {
    const outcome = ENDING_VIEW[state.endingKind ?? (confidence >= WIN_CONFIDENCE ? 'confidence' : 'timeout')]
    const consumed = state.actionPointsTotal - state.actionPoints
    const presented = state.evidence.filter((item) => item.presentedTo.length > 0).length
    return <main className="ending-page">
      <div className="ending-inner">
        <span className={`ending-badge ${outcome.tone}`}>{outcome.badge}</span>
        <h1>{outcome.title}</h1>
        <p className="ending-desc">{state.ending ?? '审讯到此为止。'}</p>

        <section className="ending-review">
          <h2>你的审讯记录</h2>
          <ul>
            <li><span>消耗行动点</span><b>{consumed} / {state.actionPointsTotal}</b></li>
            <li><span>案件置信度</span><b>{confidence}%</b></li>
            <li><span>发现矛盾</span><b>{state.contradictions.length} 处</b></li>
            <li><span>出示证据</span><b>{presented} / {state.evidence.length} 件</b></li>
          </ul>
        </section>

        {showReplay && <div className="chat-replay">
          {timeline.map((item) => <Bubble key={item.id} item={item} />)}
        </div>}

        <div className="ending-actions">
          <button className="refresh-button" type="button" onClick={() => setShowReplay((current) => !current)}>
            {showReplay ? '收起审讯记录' : '回看审讯记录'}
          </button>
          <button className="test-button" type="button" onClick={onBack}>返回首页</button>
        </div>
      </div>
    </main>
  }

  /* ------------------------------ 审讯室 ------------------------------ */

  // 解析结果没有人物时无法选择嫌疑人，任何行动都会被后端拒绝，这里给出明确出口。
  if (briefing.characters.length === 0) {
    return <main className="ending-page">
      <div className="ending-inner">
        <span className="ending-badge unresolved">NO SUSPECTS</span>
        <h1>无法开始审讯</h1>
        <p className="ending-desc">这次案件解析没有识别出任何人物，没有可以审讯的对象。请返回首页重新解析案件，或换一段人物信息更完整的案件文本。</p>
        <div className="ending-actions">
          <button className="refresh-button" type="button" onClick={onBack}>返回首页</button>
        </div>
      </div>
    </main>
  }


  return <main className="interrogation" data-mobile-view={mobileTab}>
    <div className="room-topbar">
      <div className="room-topbar-main">
        <button className="room-back" type="button" onClick={onBack}>返回</button>
        <span className="room-title">{briefing.title}<small>审讯进行中</small></span>
        {source && <span className={`room-source ${source}`}>{source === 'model' ? '模型生成' : '内置逻辑'}</span>}
        <span className={`countdown ${actionPoints <= 5 ? 'danger' : ''}`}>剩余行动点 {actionPoints} / {state.actionPointsTotal}</span>
        <button className={`model-btn ${showModel ? 'on' : ''}`} type="button" onClick={() => setShowModel(true)}>
          <GearIcon size={14} />模型
        </button>
      </div>

      <div className="room-meters">
        <div className="meter">
          <div className="meter-head"><span>案件置信度</span><b>{confidence}%</b></div>
          <div className="meter-track"><span className="meter-fill confidence" style={{ width: `${confidence}%` }} /></div>
        </div>
        <div className="meter">
          <div className="meter-head"><span>{suspect || '当前嫌疑人'} · 信任</span><b>{currentTrust}</b></div>
          <div className="meter-track">
            <span className={`meter-fill trust ${flashTrust ? 'trust-flash' : ''}`} style={{ width: `${currentTrust}%` }} />
          </div>
          <div className="meter-head" style={{ marginTop: '8px' }}><span>敌意</span><b>{currentHostility}</b></div>
          <div className="meter-track">
            <span className="meter-fill hostility" style={{ width: `${currentHostility}%` }} />
          </div>
          {terminated
            ? <span className="meter-terminated"><AlertIcon size={12} />该嫌疑人已终止审讯，拒绝再回答</span>
            : currentTrust < TRUST_WARNING && <span className="meter-warn"><AlertIcon size={12} />信任偏低，跌破 {TRUST_WARNING} 将终止审讯</span>}
        </div>
      </div>
    </div>

    <div className="room-body">
      <aside className="room-left">
        <h2 className="column-title">嫌疑人 <span>{briefing.characters.length}</span></h2>
        {briefing.characters.map((person) => {
          const active = person.name === suspect
          const count = state.evidence.filter((item) => item.presentedTo.includes(person.name)).length
          const stopped = state.terminated.includes(person.name)
          return <div key={person.name} className={`suspect-card ${active ? 'active' : ''}`}>
            <div className="suspect-head">
              <span className="suspect-initial" aria-hidden="true">{Array.from(person.name)[0]}</span>
              <div>
                <div className="suspect-name">{person.name}</div>
                <div className="suspect-meta">{person.publicIdentity}</div>
              </div>
            </div>
            <div className="suspect-stats">
              <span>信任 {state.trust[person.name] ?? 0}</span>
              <span>敌意 {state.hostility[person.name] ?? 0}</span>
              <span>已出示 {count}</span>
              {stopped && <span className="terminated">已终止审讯</span>}
            </div>
            <div className="suspect-btnrow">
              <button className="suspect-btn" type="button" disabled={active || busy} onClick={() => switchSuspect(person.name)}>
                {active ? '审讯中' : '切换审讯'}
              </button>
              <button className="arrest-btn" type="button" disabled={busy} onClick={() => void arrest(person.name)}>申请逮捕</button>
            </div>
          </div>
        })}
      </aside>

      <section className="room-main">
        <div className="chat-history" ref={historyRef} aria-live="polite">
          {timeline.length === 0 && <p className="bubble-empty">选择嫌疑人后开始提问，或直接出示证据戳破证词。</p>}
          {timeline.map((item) => <Bubble key={item.id} item={item} />)}
          {busy && <p className="bubble system">对方正在组织语言…</p>}
        </div>

        <div className="room-actions">
          <button className="observe-btn" type="button" disabled={!canAct} onClick={() => void act({ observe: true })}>
            <EyeIcon size={14} />沉默观察
          </button>
          <span className="action-hint">不追问，只看着对方：信任 +2，敌意 -1。提问或出示证据同样消耗 1 行动点。</span>
        </div>

        <div className="evidence-bar">
          <div className="evidence-bar-head">
            <h3>证物栏</h3>
            <span>{presentedToCurrent} 件已向{suspect || '当前嫌疑人'}出示 · 已解锁 {state.evidence.filter((item) => item.unlocked).length} / {state.evidence.length}</span>
          </div>
          {state.evidence.length === 0
            ? <p className="bubble-empty">本案尚未提取到可出示的证据。</p>
            : <div className="evidence-row">
              {state.evidence.map((item) => {
                const shown = item.presentedTo.includes(suspect)
                const isNew = item.unlocked && lockedAtStart.has(item.evidenceId)
                return <button
                  key={item.evidenceId}
                  type="button"
                  className={`evidence-chip ${shown ? 'presented' : ''} ${isNew ? 'fresh' : ''} ${flashEvidenceId === item.evidenceId ? 'evidence-submit' : ''}`}
                  disabled={!item.unlocked || !canAct}
                  title={item.detail}
                  onClick={() => presentEvidence(item.evidenceId)}
                >
                  {isNew && <span className="chip-badge">新</span>}
                  <strong>{item.unlocked ? item.title : '未解锁'}</strong>
                  <small>{item.unlocked ? (shown ? <><CheckIcon size={11} /> 已向{suspect}出示</> : '点击出示') : <><LockIcon size={11} /> 继续搜集线索</>}</small>
                </button>
              })}
            </div>}
        </div>

        {error && <p className="entry-error" role="alert">{error}</p>}

        <div className="chat-input-wrap">
          <textarea
            value={question}
            maxLength={MAX_QUESTION_LENGTH}
            rows={2}
            placeholder={suspect ? `向 ${suspect} 提问…（Enter 发送，Shift + Enter 换行）` : '请先选择一名嫌疑人'}
            disabled={!suspect}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={onInputKeyDown}
          />
          <button className="send-btn" type="button" disabled={!canAct || !question.trim()} onClick={send}>
            {busy ? '询问中…' : actionPoints <= 0 ? '行动点已尽' : '发送'}
          </button>
        </div>
      </section>

      <aside className="room-right">
        <div className="contra-board">
          <h2 className="contra-title">
            <BoltIcon size={14} />证词矛盾板
            <span>{state.contradictions.length} 处</span>
          </h2>
          {state.contradictions.length === 0
            ? <p className="contra-empty">尚未发现矛盾。继续讯问、出示证据，让证词之间互相打架。</p>
            : <div className="contra-list">
              {state.contradictions.map((item) => <div key={item.contradictionId} className={`contra-item ${item.confronted ? 'done' : ''}`}>
                <p className="contra-topic">{item.topic}</p>
                <div className="contra-cols">
                  <div className="contra-col">
                    <span className="contra-name">{item.left.label}</span>
                    <p>{item.left.text}</p>
                  </div>
                  <span className="contra-bolt"><BoltIcon size={18} /></span>
                  <div className="contra-col right">
                    <span className="contra-name">{item.right.label}</span>
                    <p>{item.right.text}</p>
                  </div>
                </div>
                <div className="contra-actions">
                  <button className="contra-btn" type="button" disabled={item.confronted || !canAct} onClick={() => void confront(item)}>
                    <BoltIcon size={12} />{item.confronted ? '已对质' : '当面对质'}
                  </button>
                </div>
              </div>)}
            </div>}
        </div>

        <div className="objective">
          <h4>案件目标</h4>
          <p>{briefing.objective || '查明案件真相，并核对人物证词与现有证据。'}</p>
        </div>
      </aside>
    </div>

    <nav className="mobile-tabs" aria-label="审讯室分区">
      {([['suspect', '嫌疑人'], ['chat', '审讯'], ['board', '矛盾板']] as Array<[MobileTab, string]>).map(([key, label]) =>
        <button key={key} type="button" className={`mobile-tab ${mobileTab === key ? 'active' : ''}`} onClick={() => setMobileTab(key)}>{label}</button>)}
    </nav>

    {showModel && <div className="room-modal" role="dialog" aria-modal="true" aria-label="模型配置">
      <div className="room-modal-inner">
        <button className="room-modal-close" type="button" onClick={() => setShowModel(false)}><CloseIcon size={14} />关闭</button>
        <ModelConfig onConnected={() => onModelConnected?.()} />
      </div>
    </div>}
  </main>
}

function Bubble({ item }: { item: ChatItem }) {
  return <div className={`bubble ${item.kind}${item.fresh ? ' msg-enter' : ''}`}>
    {item.kind === 'npc' && item.speaker && <div className="bubble-speaker">{item.speaker}</div>}
    <div>{item.text}</div>
  </div>
}
