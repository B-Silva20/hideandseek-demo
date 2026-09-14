import './App.css'
import CaseEntry from './components/CaseEntry'
import ModelConfig from './components/ModelConfig'
import { useEffect, useState } from 'react'
import type { CaseInput } from './types/case'
import Briefing from './components/Briefing'
import type { CaseBriefing, CaseSourceType, CaseSummary } from './types/api'
import Interrogation from './components/Interrogation'
import Saves from './components/Saves'
import ParseProgress, { type ParseProgressState } from './components/ParseProgress'
import type { Difficulty, SessionState } from './types/session'

/** 只保存会话 ID：案件、模型配置都留在后端内存里，刷新后重新拉取。 */
const SESSION_STORAGE_KEY = 'interrogation.sessionId'

type ParseStage = 'idle' | 'pending' | 'parsing' | 'ready' | 'failed'

/** 响应体不是 JSON（例如代理返回 HTML 错误页）时返回空串，由调用方给出可读提示。 */
async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: string }
    return typeof body.error === 'string' ? body.error : ''
  } catch {
    return ''
  }
}

/**
 * 前端输入方式到后端来源契约的映射。
 * 两者的取值不同（前端 text/txt，后端 paste/file），逐项列出可让类型检查兜住遗漏。
 */
const CASE_SOURCE_TYPE: Record<CaseInput['sourceType'], CaseSourceType> = {
  text: 'paste',
  txt: 'file',
}

function App() {
  const [caseInput, setCaseInput] = useState<CaseInput | null>(null)
  const [briefing, setBriefing] = useState<CaseBriefing | null>(null)
  const [interrogation, setInterrogation] = useState(false)
  const [parseError, setParseError] = useState('')
  const [parseStage, setParseStage] = useState<ParseStage>('idle')
  const [session, setSession] = useState<SessionState | null>(null)
  const [caseId, setCaseId] = useState<string | null>(null)
  const [parseProgress, setParseProgress] = useState<ParseProgressState | null>(null)
  const [openPanel, setOpenPanel] = useState<'case' | 'api' | 'saves' | null>(null)
  const [apiConnected, setApiConnected] = useState(false)
  const readyToStart = Boolean(caseInput && briefing && apiConnected)

  /**
   * 读档：会话与 briefing 都留在后端，按 sessionId 重新取一次就能继续。
   * 自动恢复（localStorage 记的上一局）与存档面板的手动「继续审讯」共用这一条路径。
   */
  async function restoreSession(sessionId: string): Promise<boolean> {
    try {
      const sessionResponse = await fetch(`/api/sessions/${sessionId}`, { cache: 'no-store' })
      if (!sessionResponse.ok) throw new Error('该存档已失效')
      const restored = await sessionResponse.json() as SessionState
      const caseResponse = await fetch(`/api/cases/${restored.caseId}`, { cache: 'no-store' })
      if (!caseResponse.ok) throw new Error('存档对应的案件已失效')
      const record = await caseResponse.json() as CaseSummary
      // 缺少 briefing 的会话无法进入审讯，按失败处理。
      if (!record.briefing) throw new Error('存档缺少案件简报')
      setSession(restored)
      setCaseId(restored.caseId)
      setBriefing(record.briefing)
      setParseStage('ready')
      setParseError('')
      setInterrogation(true)
      setOpenPanel(null)
      localStorage.setItem(SESSION_STORAGE_KEY, restored.sessionId)
      return true
    } catch (error) {
      setParseError(error instanceof Error ? error.message : '读取存档失败。')
      return false
    }
  }

  // 刷新恢复：连接状态来自后端进程内的配置快照，会话与 briefing 从后端重新读取。
  useEffect(() => {
    let active = true

    void (async () => {
      try {
        const response = await fetch('/api/config/model/status', { cache: 'no-store' })
        if (!response.ok || !active) return
        const status = await response.json() as { configured?: boolean }
        setApiConnected(Boolean(status.configured))
      } catch { /* 后端未启动时首页仍可正常打开 */ }
    })()

    const storedSessionId = localStorage.getItem(SESSION_STORAGE_KEY)
    if (!storedSessionId) return () => { active = false }

    void (async () => {
      const restored = await restoreSession(storedSessionId)
      // 失效的上一局不再留在本地，避免每次刷新都重试一次注定失败的请求。
      if (!restored) {
        localStorage.removeItem(SESSION_STORAGE_KEY)
        if (active) setParseError('')
      }
    })()

    return () => { active = false }
  }, [])

  // 解析由后端任务执行；轮询只读取状态，不会重传书籍级原文。
  useEffect(() => {
    if (parseStage !== 'parsing' || !caseId) return
    let active = true
    const refresh = async () => {
      try {
        const response = await fetch(`/api/cases/${caseId}/parse-status`, { cache: 'no-store' })
        if (!response.ok) throw new Error((await readErrorMessage(response)) || '无法获取案件解析状态。')
        const status = await response.json() as { status: ParseStage; message: string; progress?: ParseProgressState; briefing?: CaseBriefing }
        if (!active) return
        setParseProgress(status.progress ?? null)
        if (status.status === 'ready' && status.briefing) {
          setBriefing(status.briefing); setParseStage('ready'); setParseProgress(null)
        } else if (status.status === 'failed') {
          setParseError(status.message || '案件解析失败，请稍后重试。'); setParseStage('failed'); setParseProgress(null)
        }
      } catch (error) {
        if (active) { setParseError(error instanceof Error ? error.message : '无法获取案件解析状态。'); setParseStage('failed'); setParseProgress(null) }
      }
    }
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 1_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [caseId, parseStage])

  async function submitCase(input: CaseInput | null) {
    setCaseInput(input); setBriefing(null); setInterrogation(false); setParseError('')
    setParseStage(input ? 'pending' : 'idle')
    if (!input) return
    try {
      const created = await fetch('/api/cases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceText: input.text, sourceType: CASE_SOURCE_TYPE[input.sourceType] }) })
      if (!created.ok) throw new Error((await readErrorMessage(created)) || '案件提交失败。')
      const record = await created.json() as CaseSummary
      setCaseId(record.caseId)
      if (record.briefing) { setBriefing(record.briefing); setParseStage('ready'); return }
      setParseStage('parsing')
      const parsed = await fetch(`/api/cases/${record.caseId}/parse`, { method: 'POST' })
      if (!parsed.ok) throw new Error((await readErrorMessage(parsed)) || '案件解析失败。')
    } catch (error) {
      setParseError(error instanceof Error ? error.message : '案件解析失败，请稍后重试。')
      setParseStage('failed')
    }
  }

  async function startSession(difficulty: Difficulty) {
    if (!briefing || !caseId) return
    setParseError('')
    // 解析结果没有人物时没有可审讯对象，先在这里拦住，避免进入一间无法操作的审讯室。
    if (briefing.characters.length === 0) {
      setParseError('本次案件解析没有识别出任何人物，无法开始审讯。请返回首页重新解析案件，或换一段人物信息更完整的案件文本。')
      return
    }
    let created: SessionState
    try {
      const response = await fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ caseId, difficulty }) })
      if (!response.ok) throw new Error('创建审讯会话失败，请重新解析案件。')
      created = await response.json() as SessionState
    } catch (error) {
      // 网络失败也要给出可见提示，否则点击「开始断案」会毫无反应。
      setParseError(error instanceof Error ? error.message : '创建审讯会话失败，请重新解析案件。')
      return
    }
    localStorage.setItem(SESSION_STORAGE_KEY, created.sessionId)
    setSession(created)
    setInterrogation(true)
  }

  function leaveCase() {
    localStorage.removeItem(SESSION_STORAGE_KEY)
    setInterrogation(false)
  }

  async function cancelParse() {
    if (!caseId) return
    try {
      const response = await fetch(`/api/cases/${caseId}/parse`, { method: 'DELETE' })
      if (!response.ok) throw new Error((await readErrorMessage(response)) || '无法取消案件解析。')
      setParseError('已取消本次解析，原案件文本仍保留；可再次点击“准备案件文本”重新解析。')
    } catch (error) {
      setParseError(error instanceof Error ? error.message : '无法取消案件解析。')
    }
  }

  function resubmitCase() {
    setBriefing(null)
    setCaseInput(null)
    setCaseId(null)
    setParseStage('idle')
    setParseError('')
    setOpenPanel('case')
  }

  if (briefing && !interrogation) return <Briefing briefing={briefing} onStart={(difficulty) => void startSession(difficulty)} onResubmit={resubmitCase} error={parseError} />
  if (interrogation && session && briefing) return <Interrogation session={session} briefing={briefing} onBack={leaveCase} onModelConnected={() => setApiConnected(true)} />

  const caseLabel = caseInput ? (parseStage === 'ready' ? '案件已解析' : '案件已载入') : '尚未配置'
  const apiLabel = apiConnected ? '模型已连接' : '尚未配置'
  const missing = [
    !caseInput ? '案件来源' : '',
    !apiConnected ? 'API 配置' : '',
  ].filter(Boolean)

  return (
    <main className="startup-page">
      <section className="intro" aria-labelledby="page-title">
        <div className="intro-rhythm" aria-hidden="true"><span /><span /><span /></div>
        <h1 id="page-title">虚构推理</h1>
      </section>

      <section className="main-actions" aria-label="主要功能">
        <button className={`main-action ${openPanel === 'case' ? 'active' : ''}`} type="button" aria-expanded={openPanel === 'case'} onClick={() => setOpenPanel(openPanel === 'case' ? null : 'case')}><b className="action-index" aria-hidden="true">01</b><strong>案件来源</strong><span>粘贴文本或上传 TXT</span><small>{caseLabel}</small></button>
        <button className={`main-action ${openPanel === 'api' ? 'active' : ''}`} type="button" aria-expanded={openPanel === 'api'} onClick={() => setOpenPanel(openPanel === 'api' ? null : 'api')}><b className="action-index" aria-hidden="true">02</b><strong>API 配置</strong><span>模型接入与连接测试</span><small>{apiLabel}</small></button>
        <button className={`main-action ${openPanel === 'saves' ? 'active' : ''}`} type="button" aria-expanded={openPanel === 'saves'} onClick={() => setOpenPanel(openPanel === 'saves' ? null : 'saves')}><b className="action-index" aria-hidden="true">03</b><strong>存档</strong><span>继续上一次审讯，或删除旧存档</span><small>{session ? '当前审讯进行中' : '每次行动后自动保存'}</small></button>
      </section>

      <button className={`start-case-button ${readyToStart ? 'ready' : ''}`} type="button" disabled={!readyToStart} onClick={() => { setOpenPanel(null); void startSession('normal') }}>{readyToStart ? '开始断案！' : '请配置案件来源还有 API 配置'}</button>
      {!readyToStart && <p className="start-hint" role="status">{missing.length ? `还需要：${missing.join('、')}` : '案件正在解析，请稍候。'}</p>}

      {openPanel === 'case' && <div className="panel-window"><CaseEntry onReady={(input) => { void submitCase(input) }} /></div>}
      {/* 连接测试成功只更新状态：面板保持展开，用户还要在里面挑选模型，避免页面突然收起。 */}
      {openPanel === 'api' && <div className="panel-window"><ModelConfig onConnected={() => setApiConnected(true)} onCollapse={() => setOpenPanel(null)} /></div>}
      {openPanel === 'saves' && <div className="panel-window"><Saves onResume={(sessionId) => { void restoreSession(sessionId) }} /></div>}

      {parseError && <p className="entry-error" role="alert">{parseError}</p>}
      {parseStage === 'parsing' && <ParseProgress progress={parseProgress} onCancel={() => void cancelParse()} />}
    </main>
  )
}

export default App
