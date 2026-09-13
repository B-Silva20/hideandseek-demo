import { useRef, useState } from 'react'
import { decodeCaseBytes, prepareCaseInput, readCaseFile } from '../engine/caseInput'
import type { TextEncoding } from '../engine/caseInput'
import type { CaseInput, SourceType } from '../types/case'
import { CASE_TEXT_MIN_LENGTH } from '../types/api'
import './CaseEntry.css'

const labels: Record<SourceType, string> = { preset: '使用预置案件', text: '粘贴案件文本', txt: '上传 TXT 文件' }
export default function CaseEntry({ onReady }: { onReady: (input: CaseInput | null) => void }) {
  const [mode, setMode] = useState<SourceType>('preset')
  const [text, setText] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [encoding, setEncoding] = useState<TextEncoding>('auto')
  const [preview, setPreview] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const revision = useRef(0)
  function reset() {
    revision.current += 1
    setBusy(false); setError(''); setNotice(''); setPreview(''); onReady(null)
  }
  async function submit() {
    reset()
    const current = revision.current
    setBusy(true)
    try {
      let input: CaseInput
      let decodedEncoding = ''
      if (mode === 'text') input = prepareCaseInput(text, 'text')
      else if (mode === 'txt') {
        if (!file) throw new Error('请先选择 TXT 文件。')
        const result = await readCaseFile(file, encoding)
        input = result.input; decodedEncoding = result.encoding
      } else {
        let response: Response
        try { response = await fetch('/api/cases/preset', { signal: AbortSignal.timeout(15_000), cache: 'no-store' }) }
        catch { throw new Error('预置案件读取失败或超时，请确认后端已启动，或使用其他输入方式。') }
        if (!response.ok) throw new Error('预置案件不可用，请确认后端及本地案件文件已就绪，或使用其他输入方式。')
        const decoded = decodeCaseBytes(await response.arrayBuffer())
        input = prepareCaseInput(decoded.text, 'preset'); decodedEncoding = decoded.encoding
      }
      if (current !== revision.current) return
      setPreview(input.text.slice(0, 600))
      setNotice(decodedEncoding ? `已按 ${decodedEncoding.toUpperCase()} 读取。若预览乱码，请在上传入口手动选择编码。` : '文本已清理并通过校验。')
      onReady(input)
    } catch (cause) {
      if (current === revision.current) setError(cause instanceof Error ? cause.message : '读取失败，请重新输入。')
    } finally { if (current === revision.current) setBusy(false) }
  }
  return <section className="case-entry" aria-labelledby="case-entry-title">
    <h2 id="case-entry-title">选择案件来源</h2>
    <div className="entry-options" role="group" aria-label="案件输入方式">
      {(Object.keys(labels) as SourceType[]).map((source) => <button key={source} type="button" aria-pressed={mode === source} onClick={() => { reset(); setMode(source) }}>{labels[source]}</button>)}
    </div>
    <p className="entry-help">至少 {CASE_TEXT_MIN_LENGTH} 个字符，最多 20 万字符；TXT 文件最大 5 MB。</p>
    {mode === 'preset' && <div className="preset-copy"><h3>占星术杀人魔法</h3><p>读取已配置的本地预置案件，作为本次调查的案件文本。</p></div>}
    {mode === 'text' && <>
      <label htmlFor="case-text">案件文本</label>
      <textarea id="case-text" value={text} placeholder="粘贴案件背景、人物、线索与事件经过……" onChange={(event) => { reset(); setText(event.target.value) }} />
      <p className={`entry-help char-count ${Array.from(text).length >= CASE_TEXT_MIN_LENGTH ? 'ready' : ''}`}>
        当前 {Array.from(text).length.toLocaleString()} 个字符 / 至少 {CASE_TEXT_MIN_LENGTH} 个
      </p>
    </>}
    {mode === 'txt' && <>
      <label htmlFor="case-file">选择 TXT 文件</label>
      <input id="case-file" type="file" accept=".txt,text/plain" onChange={(event) => { reset(); setFile(event.target.files?.[0] ?? null); event.target.value = '' }} />
      {file && <p className="file-name">已选择：{file.name}（{(file.size / 1024).toFixed(1)} KB）</p>}
      <label htmlFor="case-encoding">文本编码</label>
      <select id="case-encoding" value={encoding} onChange={(event) => { reset(); setEncoding(event.target.value as TextEncoding) }}>
        <option value="auto">自动识别（UTF-8 / GB18030）</option><option value="utf-8">UTF-8</option><option value="gb18030">GB18030 / GBK</option>
      </select>
    </>}
    {error && <p role="alert" className="entry-error">{error}</p>}
    <button className="refresh-button" type="button" disabled={busy} onClick={() => void submit()}>{busy ? '正在读取案件…' : mode === 'preset' ? '进入预置案件' : '准备案件文本'}</button>
    <p className="entry-help">{mode === 'preset' ? '预置案件自带测试 Briefing，点击后可直接进入审讯，不需要调用模型。' : '提交后会调用模型生成 Briefing；失败可在下方重新提交。'}</p>
    {notice && <div className="text-preview"><p>{notice}</p><details><summary>查看文本开头，检查编码</summary><pre>{preview}</pre></details></div>}
  </section>
}
