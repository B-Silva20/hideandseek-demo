import { useState } from 'react'
import type { CaseBriefing } from '../types/api'
import type { SessionState } from '../types/session'
import './Interrogation.css'

export default function Interrogation({ session, briefing, onBack }: { session: SessionState; briefing: CaseBriefing; onBack: () => void }) {
  const [state, setState] = useState(session); const [suspect, setSuspect] = useState(briefing.characters[0]?.name ?? ''); const [text, setText] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false)
  async function ask() { if (!text.trim()) return; setBusy(true); setError(''); try { const r=await fetch(`/api/sessions/${state.sessionId}/messages`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({suspectId:suspect,text})}); const b=await r.json(); if(!r.ok) throw new Error(b.error||'审讯失败。'); setState(b.session); setText('') } catch(e){setError(e instanceof Error?e.message:'审讯失败，请重试。')} finally{setBusy(false)} }
  return <main className="interrogation"><header><button type="button" onClick={onBack}>返回 briefing</button><strong>审讯进行中</strong><span>行动点 {state.actionPoints}/20</span></header><label>当前嫌疑人<select value={suspect} onChange={e=>setSuspect(e.target.value)}>{briefing.characters.map(c=><option key={c.name} value={c.name}>{c.name}</option>)}</select></label><section className="dialogue" aria-live="polite">{state.history.length===0&&<p className="muted">选择嫌疑人并输入你的问题。</p>}{state.history.map((m,i)=><p key={i} className={m.role}>{m.content}</p>)}</section>{error&&<p className="entry-error" role="alert">{error}</p>}<textarea value={text} maxLength={500} placeholder="例如：案发当晚你在哪里？" onChange={e=>setText(e.target.value)} /><button className="refresh-button" disabled={busy||state.actionPoints<=0} onClick={()=>void ask()}>{busy?'询问中…':state.actionPoints<=0?'行动点已用尽':'发送问题'}</button></main>
}
