import './App.css'
import CaseEntry from './components/CaseEntry'
import { useState } from 'react'
import type { CaseInput } from './types/case'
import Briefing from './components/Briefing'
import type { CaseBriefing, CaseSummary } from './types/api'
import Interrogation from './components/Interrogation'
import type { SessionState } from './types/session'

function App() {
  const [briefing, setBriefing] = useState<CaseBriefing | null>(null)
  const [interrogation, setInterrogation] = useState(false)
  const [parseError, setParseError] = useState('')
  const [session, setSession] = useState<SessionState|null>(null)
  const [caseId, setCaseId] = useState<string | null>(null)
  useState(() => { const id=localStorage.getItem('sessionId'); if(id) void fetch(`/api/sessions/${id}`).then(r=>r.ok?r.json():null).then(s=>{if(s){setSession(s);setInterrogation(true)}}) })
  async function submitCase(input: CaseInput | null) {
    setBriefing(null); setInterrogation(false); setParseError('')
    if (!input) return
    try {
      const created = await fetch('/api/cases', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ sourceText: input.text, sourceType: input.sourceType === 'text' ? 'paste' : input.sourceType }) })
      if (!created.ok) throw new Error((await created.json() as {error?:string}).error || '案件提交失败。')
      const record = await created.json() as CaseSummary
      if (input.sourceType === 'preset' && record.briefing) {
        setCaseId(record.caseId)
        setBriefing(record.briefing)
        return
      }
      const parsed = await fetch(`/api/cases/${record.caseId}/parse`, { method: 'POST' })
      if (!parsed.ok) throw new Error((await parsed.json() as {error?:string}).error || '案件解析失败。')
      const result = await parsed.json() as CaseSummary
      setCaseId(result.caseId)
      if (!result.briefing) throw new Error('解析结果缺少 briefing，请稍后重试。')
      setBriefing(result.briefing)
    } catch (error) { setParseError(error instanceof Error ? error.message : '案件解析失败，请稍后重试。') }
  }
  async function startSession() { if (!briefing || !caseId) return; const response=await fetch('/api/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({caseId})}); if(response.ok){const s=await response.json(); localStorage.setItem('sessionId',s.sessionId); setSession(s); setInterrogation(true)} else setParseError('创建审讯会话失败，请重新解析案件。') }
  if (briefing && !interrogation) return <Briefing briefing={briefing} onStart={() => void startSession()} />
  if (interrogation && session && briefing) return <Interrogation session={session} briefing={briefing} onBack={() => setInterrogation(false)} />
  return (
    <main className="startup-page">
      <header className="page-header">
        <span className="project-mark" aria-hidden="true">案</span>
        <span>案件文本驱动 · 移动端推理网页</span>
      </header>

      <section className="intro" aria-labelledby="page-title">
        <p className="step-label">第二步 / 案件输入</p>
        <h1 id="page-title">案件审讯 Demo</h1>
        <p className="intro-copy">从案件文本出发，在人物的证词与线索之间，逐步查明真相。</p>
      </section>

      <CaseEntry onReady={(input) => { void submitCase(input) }} />
      {parseError && <p className="entry-error" role="alert">{parseError}</p>}
      <footer className="page-footer">案件文本由后端安全解析 · API 密钥不会出现在网页中</footer>
    </main>
  )
}

export default App
