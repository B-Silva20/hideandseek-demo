import { useState } from 'react'
import type { CaseBriefing } from '../types/api'
import type { Difficulty } from '../types/session'
import './Briefing.css'

const DIFFICULTIES: Array<{ value: Difficulty; label: string; detail: string }> = [
  { value: 'hard', label: '困难', detail: '20 步' },
  { value: 'normal', label: '普通', detail: '40 步' },
  { value: 'easy', label: '简单', detail: '80 步' },
  { value: 'practice', label: '练手', detail: '不限步数' },
]

export default function Briefing({ briefing, onStart, onResubmit, error }: { briefing: CaseBriefing; onStart: (difficulty: Difficulty) => void; onResubmit: () => void; error?: string }) {
  const [difficulty, setDifficulty] = useState<Difficulty>('normal')
  const selected = DIFFICULTIES.find((item) => item.value === difficulty) ?? DIFFICULTIES[1]

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
    <section className="difficulty-card" aria-labelledby="difficulty-title">
      <h2 id="difficulty-title">断案难度</h2>
      <div className="difficulty-options" role="group" aria-label="选择断案难度">
        {DIFFICULTIES.map((item) => <button key={item.value} className={difficulty === item.value ? 'difficulty-option active' : 'difficulty-option'} type="button" aria-pressed={difficulty === item.value} onClick={() => setDifficulty(item.value)}><strong>{item.label}</strong><span>{item.detail}</span></button>)}
      </div>
      <p>当前选择：{selected.label}，{selected.detail}。</p>
    </section>
    {error && <p className="entry-error" role="alert">{error}</p>}
    <div className="briefing-actions">
      <button className="test-button" type="button" onClick={onResubmit}>重新提交案件</button>
      <button className="refresh-button" type="button" onClick={() => onStart(difficulty)}>开始断案！</button>
    </div>
  </main>
}
