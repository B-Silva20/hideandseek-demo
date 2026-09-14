import { useEffect, useState } from 'react'
import type { SaveSlot } from '../types/api'
import './Saves.css'

/*
 * 存档面板：一局审讯就是一份存档。
 * 服务端在每次行动结算后自动写盘，这里只做「看有哪些存档 / 继续 / 删除」。
 */

/** 结局分类的中文短标签，说法与审讯室结局页保持一致。 */
const ENDING_LABEL: Record<string, string> = {
  confidence: '已告破',
  arrest_hit: '逮捕获准',
  arrest_miss: '逮捕被驳回',
  arrest_undecided: '不予逮捕',
  timeout: '行动点耗尽',
  breakdown: '审讯破裂',
}

function formatTime(value: string): string {
  const time = new Date(value)
  if (Number.isNaN(time.getTime())) return '时间未知'
  return time.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export default function Saves({ onResume }: { onResume: (sessionId: string) => void }) {
  const [saves, setSaves] = useState<SaveSlot[] | null>(null)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState('')

  // 面板每次展开都会重新挂载，因此只需要在挂载时取一次列表。
  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const response = await fetch('/api/saves', { cache: 'no-store' })
        // 响应体不是 JSON 时按失败处理，不把 SyntaxError 抛给用户。
        const body = await response.json().catch(() => ({})) as { saves?: SaveSlot[]; error?: string }
        if (!active) return
        if (!response.ok) throw new Error(body.error || '读取存档失败。')
        setSaves(body.saves ?? [])
        setError('')
      } catch (cause) {
        if (!active) return
        setSaves([])
        setError(cause instanceof Error ? cause.message : '读取存档失败。')
      }
    })()
    return () => { active = false }
  }, [])

  async function remove(slot: SaveSlot) {
    if (!window.confirm(`删除存档「${slot.caseTitle}」？该局的进度会一起删除，无法恢复。`)) return
    setBusyId(slot.sessionId)
    try {
      const response = await fetch(`/api/saves/${slot.sessionId}`, { method: 'DELETE' })
      if (!response.ok && response.status !== 404) {
        const body = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error || '删除存档失败。')
      }
      setSaves((current) => (current ?? []).filter((item) => item.sessionId !== slot.sessionId))
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除存档失败。')
    } finally {
      setBusyId('')
    }
  }

  return <section className="saves" aria-labelledby="saves-title">
    <h2 id="saves-title">存档</h2>
    {saves === null && <p className="saves-empty">正在读取存档…</p>}
    {saves !== null && saves.length === 0 && <p className="saves-empty">还没有存档。载入案件并开始审讯后会自动生成。</p>}

    {saves !== null && saves.length > 0 && <ul className="saves-list">
      {saves.map((slot) => <li key={slot.sessionId} className={`save-slot ${slot.gameState === 'ended' ? 'ended' : ''}`}>
        <div className="save-head">
          <strong>{slot.caseTitle}</strong>
          <span className={`save-state ${slot.gameState === 'ended' ? 'ended' : 'active'}`}>
            {slot.gameState === 'ended' ? ENDING_LABEL[slot.endingKind ?? ''] ?? '已结束' : '进行中'}
          </span>
        </div>
        <div className="save-stats">
          <span>第 {slot.turn} 轮</span>
          <span>{slot.actionPoints === null ? '练手 · 不限行动点' : `行动点 ${slot.actionPoints} / ${slot.actionPointsTotal}`}</span>
          <span>置信度 {slot.caseConfidence}%</span>
          <span>矛盾 {slot.contradictions} 处</span>
          <span>嫌疑人 {slot.suspects} 人</span>
        </div>
        <div className="save-actions">
          <button className="refresh-button" type="button" onClick={() => onResume(slot.sessionId)}>
            {slot.gameState === 'ended' ? '查看结局' : '继续审讯'}
          </button>
          <button className="test-button" type="button" disabled={busyId === slot.sessionId} onClick={() => void remove(slot)}>
            {busyId === slot.sessionId ? '正在删除…' : '删除'}
          </button>
          <span className="save-time">上次审讯 {formatTime(slot.updatedAt)}</span>
        </div>
      </li>)}
    </ul>}

    {error && <p role="alert" className="entry-error">{error}</p>}
  </section>
}
