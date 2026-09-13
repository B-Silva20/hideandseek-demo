import type { CaseBriefing } from '../types/api'
import type { SessionState } from '../types/session'
import './CaseDashboard.css'

export default function CaseDashboard({ briefing, session }: { briefing: CaseBriefing; session: SessionState }) {
  const confidence = Math.max(0, Math.min(100, session.caseConfidence ?? 0))
  const unlocked = session.evidence.filter((item) => item.unlocked).length
  const presented = session.evidence.filter((item) => item.presentedTo.length > 0).length
  const recent = [...session.events].reverse().slice(0, 4)

  return <aside className="case-dashboard" aria-label="案件调查面板">
    <div className="dashboard-title"><span>调查档案</span><strong>CASE FILE</strong></div>

    <div className="confidence-block">
      <div><span>案件置信度</span><strong>{confidence}%</strong></div>
      <div className="confidence-track"><span style={{ width: `${confidence}%` }} /></div>
      <small>{confidence >= 70 ? '关键事实逐渐闭合' : confidence >= 35 ? '证词中存在可疑缺口' : '需要继续搜集证据'}</small>
    </div>

    <div className="dashboard-stats">
      <div><b>{session.actionPoints}</b><span>行动点</span></div>
      <div><b>{session.contradictions.length}</b><span>矛盾点</span></div>
      <div><b>{presented}/{unlocked}</b><span>已出示证据</span></div>
    </div>

    <section className="dashboard-section">
      <h3>嫌疑人状态</h3>
      <ul className="mood-list">
        {briefing.characters.map((person) => <li key={person.name} className={session.currentSubject === person.name ? 'current' : ''}>
          <strong>{person.name}</strong>
          <span className="mood-row"><i>信任</i><span className="meter trust"><span style={{ width: `${session.trust[person.name] ?? 0}%` }} /></span></span>
          <span className="mood-row"><i>敌意</i><span className="meter hostility"><span style={{ width: `${session.hostility[person.name] ?? 0}%` }} /></span></span>
        </li>)}
      </ul>
    </section>

    <section className="dashboard-section">
      <h3>已发现矛盾</h3>
      {session.contradictions.length ? <ul>{session.contradictions.map((item) => <li key={item.contradictionId}>{item.topic}</li>)}</ul> : <p>尚未发现明显矛盾</p>}
    </section>

    <section className="dashboard-section">
      <h3>最新动态</h3>
      {recent.length
        ? <ul className="event-log">{recent.map((event) => <li key={event.eventId} className={event.type}><b>{event.title}</b><span>{event.detail}</span></li>)}</ul>
        : <p>审讯尚未开始</p>}
    </section>

    <section className="dashboard-section"><h3>案件目标</h3><p>{briefing.objective}</p></section>
  </aside>
}
