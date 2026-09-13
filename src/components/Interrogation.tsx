import { useState } from 'react'
import type { CaseBriefing } from '../types/api'
import type { SessionState } from '../types/session'
import './Interrogation.css'

const ENDING_COPY: Record<string, string> = {
  perfect_case: '完美结案：你锁定了真正凶手，并用关键证据和矛盾完成了指认。',
  wrong_arrest: '错误逮捕：你指认了错误的嫌疑人。',
  killer_escapes: '凶手逃脱：调查在证据不足、信任崩溃或行动点耗尽时结束。',
}

export default function Interrogation({ session, briefing, onBack }: { session: SessionState; briefing: CaseBriefing; onBack: () => void }) {
  const [state, setState] = useState(session)
  const [suspect, setSuspect] = useState(briefing.characters[0]?.name ?? '')
  const [accusation, setAccusation] = useState(briefing.characters[0]?.name ?? '')
  const [text, setText] = useState('')
  const [topicId, setTopicId] = useState('')
  const [normalizedValue, setNormalizedValue] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function ask() {
    if (!text.trim() || state.gameState === 'ended') return
    setBusy(true); setError('')
    try {
      const r = await fetch(`/api/sessions/${state.sessionId}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ suspectId: suspect, text, topicId: topicId.trim() || undefined, normalizedValue: normalizedValue.trim() || undefined }) })
      const b = await r.json(); if (!r.ok) throw new Error(b.error || '审讯失败')
      setState(b.session); setText(''); setNormalizedValue('')
    } catch (e) { setError(e instanceof Error ? e.message : '审讯失败，请重试') } finally { setBusy(false) }
  }

  async function confront(id: string) {
    setBusy(true); setError('')
    try {
      const r = await fetch(`/api/sessions/${state.sessionId}/contradictions/${id}/confront`, { method: 'POST' }); const b = await r.json()
      if (!r.ok) throw new Error(b.error || '对质失败'); setState(b.session)
    } catch (e) { setError(e instanceof Error ? e.message : '对质失败，请重试') } finally { setBusy(false) }
  }

  async function accuse() {
    if (state.gameState === 'ended') return
    setBusy(true); setError('')
    try {
      const r = await fetch(`/api/sessions/${state.sessionId}/accuse`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ suspectId: accusation }) }); const b = await r.json()
      if (!r.ok) throw new Error(b.error || '指认失败'); setState(b.session)
    } catch (e) { setError(e instanceof Error ? e.message : '指认失败，请重试') } finally { setBusy(false) }
  }

  const ended = state.gameState === 'ended'
  return <main className="interrogation">
    <header><button type="button" onClick={onBack}>返回 briefing</button><strong>审讯进行中</strong><span>行动点 {state.actionPoints}/20</span></header>
    {ended && <section className="ending-card" role="status"><h2>{ENDING_COPY[state.ending ?? 'killer_escapes']}</h2><p>{state.endingReason}</p></section>}
    <label>当前嫌疑人<select value={suspect} disabled={ended} onChange={e => setSuspect(e.target.value)}>{briefing.characters.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}</select></label>
    <section className="dialogue" aria-live="polite">{state.history.length === 0 && <p className="muted">选择嫌疑人并输入你的问题。</p>}{state.history.map((m, i) => <p key={i} className={m.role}>{m.content}</p>)}</section>
    <section className="contradictions-panel"><h2>证词矛盾</h2>{state.contradictionRecords?.length ? state.contradictionRecords.map(item => <article key={item.contradictionId}><strong>{item.topicId}</strong><p>{item.description}</p><blockquote>{item.suspectA}：{item.testimonyA.claim}</blockquote><blockquote>{item.suspectB}：{item.testimonyB.claim}</blockquote><button type="button" disabled={busy || ended || item.confronted || state.actionPoints <= 0} onClick={() => void confront(item.contradictionId)}>{item.confronted ? '已对质' : '进行对质（消耗1行动点）'}</button></article>) : <p className="muted">同一话题出现相反证词后，矛盾会显示在这里。</p>}</section>
    {error && <p className="entry-error" role="alert">{error}</p>}
    <label>话题 ID（用于结构化证词）<input disabled={ended} value={topicId} maxLength={120} placeholder="例如 crime_time" onChange={e => setTopicId(e.target.value)} /></label>
    <label>标准化值（例如 22:00）<input disabled={ended} value={normalizedValue} maxLength={200} placeholder="例如 22:00" onChange={e => setNormalizedValue(e.target.value)} /></label>
    <textarea disabled={ended} value={text} maxLength={500} placeholder="例如：案发当晚你在哪里？" onChange={e => setText(e.target.value)} />
    <button className="refresh-button" disabled={busy || ended || state.actionPoints <= 0} onClick={() => void ask()}>{busy ? '处理中…' : state.actionPoints <= 0 ? '行动点已用尽' : '发送问题'}</button>
    <section className="accusation-panel"><h2>结案指认</h2><label>指认嫌疑人<select value={accusation} disabled={busy || ended} onChange={e => setAccusation(e.target.value)}>{briefing.characters.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}</select></label><button className="refresh-button" disabled={busy || ended} onClick={() => void accuse()}>{ended ? '案件已结案' : '提交指认 / 结束调查'}</button></section>
  </main>
}
