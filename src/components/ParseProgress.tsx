import './ParseProgress.css'

export interface ParseProgressState {
  completedChunks: number
  totalChunks: number
  phase: 'extracting' | 'merging'
  message: string
}

export default function ParseProgress({ progress, onCancel }: { progress: ParseProgressState | null; onCancel: () => void }) {
  const completed = progress?.completedChunks ?? 0
  const total = Math.max(progress?.totalChunks ?? 1, 1)
  const ratio = progress?.phase === 'merging' ? 96 : Math.min(90, Math.round((completed / total) * 90))
  const label = progress?.phase === 'merging' ? '归并案件结构' : `档案拆解 ${completed} / ${total}`
  return <div className="parse-overlay" role="dialog" aria-modal="true" aria-labelledby="parse-progress-title">
    <div className="parse-slash parse-slash-one" aria-hidden="true" />
    <div className="parse-slash parse-slash-two" aria-hidden="true" />
    <section className="parse-progress-card">
      <p className="parse-kicker">CASE ANALYSIS / LIVE</p>
      <h2 id="parse-progress-title">正在拆解档案</h2>
      <p className="parse-status" role="status" aria-live="polite">{progress?.message ?? '正在连接案件解析器。'}</p>
      <div className="parse-meter" aria-label={`${label}，${ratio}%`}>
        <span style={{ width: `${ratio}%` }} />
      </div>
      <div className="parse-meta"><strong>{label}</strong><b>{ratio}%</b></div>
      <p className="parse-note">大文本会先分段整理，再合并人物、证物与时间线；已完成的段落不会重复发送到后续审讯。</p>
      <button className="parse-cancel" type="button" onClick={onCancel}>取消本次解析</button>
    </section>
  </div>
}
