import type { CaseBriefing } from '../types/api'
import './Briefing.css'

export default function Briefing({ briefing, onStart }: { briefing: CaseBriefing; onStart: () => void }) {
  return <main className="briefing" aria-labelledby="briefing-title">
    <p className="section-kicker">案件 Briefing</p><h1 id="briefing-title">{briefing.title}</h1>
    <section><h2>你的身份</h2><p>{briefing.playerRole}</p></section>
    <section><h2>前情提要</h2><p>{briefing.summary}</p></section>
    <section><h2>调查目标</h2><p>{briefing.objective}</p></section>
    <section><h2>人物</h2><ul>{briefing.characters.map((person) => <li key={person.name}><strong>{person.name}</strong><span>{person.publicIdentity}</span></li>)}</ul></section>
    <section><h2>人物关系</h2><ul>{briefing.relationships.map((item) => <li key={item}>{item}</li>)}</ul></section>
    <section><h2>已知线索</h2><ul>{briefing.knownClues.map((item) => <li key={item}>{item}</li>)}</ul></section>
    <section><h2>初始可见证据</h2><ul>{briefing.visibleEvidence.map((item) => <li key={item}>{item}</li>)}</ul></section>
    <section><h2>需要查明的问题</h2><ul>{briefing.questions.map((item) => <li key={item}>{item}</li>)}</ul></section>
    <button className="refresh-button" type="button" onClick={onStart}>进入审讯</button>
  </main>
}
