import './App.css'
import CaseEntry from './components/CaseEntry'
import ModelConfig from './components/ModelConfig'
import { useEffect, useState } from 'react'
import type { CaseInput } from './types/case'
import Briefing from './components/Briefing'
import type { CaseBriefing, CaseSourceType, CaseSummary } from './types/api'
import Interrogation from './components/Interrogation'
import type { SessionState } from './types/session'

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
  preset: 'preset',
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
  const [openPanel, setOpenPanel] = useState<'case' | 'api' | null>(null)
  const [apiConnected, setApiConnected] = useState(false)
  const readyToStart = Boolean(caseInput && briefing && apiConnected)

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
      try {
        const sessionResponse = await fetch(`/api/sessions/${storedSessionId}`, { cache: 'no-store' })
        if (!sessionResponse.ok) throw new Error('会话已失效')
        const restored = await sessionResponse.json() as SessionState
        const caseResponse = await fetch(`/api/cases/${restored.caseId}`, { cache: 'no-store' })
        if (!caseResponse.ok) throw new Error('案件已失效')
        const record = await caseResponse.json() as CaseSummary
        // 缺少 briefing 说明这条记录已经不可用，交给 catch 清理掉，避免每次刷新都重试。
        if (!record.briefing) throw new Error('案件缺少解析结果')
        if (!active) return
        setSession(restored)
        setCaseId(restored.caseId)
        setBriefing(record.briefing)
        setParseStage('ready')
        setInterrogation(true)
      } catch {
        localStorage.removeItem(SESSION_STORAGE_KEY)
      }
    })()

    return () => { active = false }
  }, [])

  async function submitCase(input: CaseInput | null) {
    setCaseInput(input); setBriefing(null); setInterrogation(false); setParseError('')
    setParseStage(input ? 'pending' : 'idle')
    if (!input) return
    try {
      const created = await fetch('/api/cases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceText: input.text, sourceType: CASE_SOURCE_TYPE[input.sourceType] }) })
      if (!created.ok) throw new Error((await readErrorMessage(created)) || '案件提交失败。')
      const record = await created.json() as CaseSummary
      setCaseId(record.caseId)
      // 预置案件自带 Briefing，直接使用，不必为本地测试案件消耗一次模型调用。
      if (record.briefing) { setBriefing(record.briefing); setParseStage('ready'); return }
      setParseStage('parsing')
      const parsed = await fetch(`/api/cases/${record.caseId}/parse`, { method: 'POST' })
      if (!parsed.ok) throw new Error((await readErrorMessage(parsed)) || '案件解析失败。')
      const result = await parsed.json() as CaseSummary
      if (!result.briefing) throw new Error('解析结果缺少 briefing，请稍后重试。')
      setBriefing(result.briefing)
      setParseStage('ready')
    } catch (error) {
      setParseError(error instanceof Error ? error.message : '案件解析失败，请稍后重试。')
      setParseStage('failed')
    }
  }

  async function startSession() {
    if (!briefing || !caseId) return
    setParseError('')
    // 解析结果没有人物时没有可审讯对象，先在这里拦住，避免进入一间无法操作的审讯室。
    if (briefing.characters.length === 0) {
      setParseError('本次案件解析没有识别出任何人物，无法开始审讯。请返回首页重新解析案件，或换一段人物信息更完整的案件文本。')
      return
    }
    let created: SessionState
    try {
      const response = await fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ caseId }) })
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

  if (briefing && !interrogation) return <Briefing briefing={briefing} onStart={() => void startSession()} error={parseError} />
  if (interrogation && session && briefing) return <Interrogation session={session} briefing={briefing} onBack={leaveCase} onModelConnected={() => setApiConnected(true)} />

  const caseLabel = caseInput ? (parseStage === 'ready' ? '案件已解析' : '案件已载入') : '尚未配置'
  const apiLabel = apiConnected ? '模型已连接' : '尚未配置'
  const missing = [
    !caseInput ? '案件来源' : '',
    !apiConnected ? 'API 配置' : '',
  ].filter(Boolean)

  return (
    <main className="startup-page">
      <header className="page-header">
        <span className="project-mark" aria-hidden="true">案</span>
        <span>案件文本驱动 · 移动端推理网页</span>
      </header>

      <section className="intro" aria-labelledby="page-title">
        <p className="step-label">第三步 / 审讯推理</p>
        <h1 id="page-title">案件审讯 Demo</h1>
        <p className="intro-copy">从案件文本出发，在人物的证词与线索之间，逐步查明真相。</p>
      </section>

      <section className="main-actions" aria-label="主要功能">
        <button className={`main-action ${openPanel === 'case' ? 'active' : ''}`} type="button" aria-expanded={openPanel === 'case'} onClick={() => setOpenPanel(openPanel === 'case' ? null : 'case')}><strong>案件来源</strong><span>预置案件、粘贴文本或上传 TXT</span><small>{caseLabel}</small></button>
        <button className={`main-action ${openPanel === 'api' ? 'active' : ''}`} type="button" aria-expanded={openPanel === 'api'} onClick={() => setOpenPanel(openPanel === 'api' ? null : 'api')}><strong>API 配置</strong><span>模型接入、连接测试与运行状态</span><small>{apiLabel}</small></button>
      </section>

      <button className={`start-case-button ${readyToStart ? 'ready' : ''}`} type="button" disabled={!readyToStart} onClick={() => { setOpenPanel(null); void startSession() }}>{readyToStart ? '开始断案！' : '请配置案件来源还有 API 配置'}</button>
      {!readyToStart && <p className="start-hint" role="status">{missing.length ? `还需要：${missing.join('、')}` : '案件正在解析，请稍候。'}</p>}

      {openPanel === 'case' && <div className="panel-window"><CaseEntry onReady={(input) => { void submitCase(input) }} /></div>}
      {/* 连接测试成功只更新状态：面板保持展开，用户还要在里面挑选模型，避免页面突然收起。 */}
      {openPanel === 'api' && <div className="panel-window"><ModelConfig onConnected={() => setApiConnected(true)} onCollapse={() => setOpenPanel(null)} /></div>}

      <section className="pipeline-status" aria-label="准备进度">
        <h2>准备进度</h2>
        <ul>
          <li className={caseInput ? 'done' : ''}><span>案件文本</span><b>{caseInput ? `${Array.from(caseInput.text).length.toLocaleString()} 字符 · 已载入` : '等待输入'}</b></li>
          <li className={parseStage === 'ready' ? 'done' : parseStage === 'failed' ? 'failed' : ''}><span>模型解析</span><b>{parseStage === 'ready' ? '已完成' : parseStage === 'failed' ? '失败' : parseStage === 'idle' ? '等待输入' : '进行中…'}</b></li>
          <li className={apiConnected ? 'done' : ''}><span>模型连接</span><b>{apiConnected ? '已连接，可在审讯中调用' : '等待配置'}</b></li>
        </ul>
      </section>

      {parseError && <p className="entry-error" role="alert">{parseError}</p>}

      <section className="scope-card" aria-labelledby="scope-title">
        <h2 id="scope-title">当前进度</h2>
        {briefing
          ? <p>案件《{briefing.title}》已解析，点击「开始断案！」进入 briefing 与审讯环节。</p>
          : <p>载入案件并连接模型后即可开始审讯。审讯中的提问与出示证据都会消耗行动点。</p>}
        <p>案件、会话与模型配置目前都保存在后端内存中，重启后端会清空。</p>
      </section>

      <footer className="page-footer">项目启动页 · 等待本步骤确认</footer>
    </main>
  )
}

export default App
