import ConnectionStatus from './components/ConnectionStatus'
import './App.css'
import CaseEntry from './components/CaseEntry'
import ModelConfig from './components/ModelConfig'
import { useState } from 'react'
import type { CaseInput } from './types/case'

function App() {
  const [caseInput, setCaseInput] = useState<CaseInput | null>(null)
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

      <CaseEntry onReady={setCaseInput} />
      {caseInput && <section className="parse-ready" role="status" aria-label="解析输入已就绪">
        <h2>案件文本已就绪</h2>
        <p>来源：<code>{caseInput.sourceType}</code> · {Array.from(caseInput.text).length.toLocaleString()} 字符</p>
        <p>已统一为案件文本，等待后续解析功能接入。当前尚未开始解析。</p>
      </section>}
      <ModelConfig />
      <ConnectionStatus />

      <section className="scope-card" aria-labelledby="scope-title">
        <h2 id="scope-title">当前进度</h2>
        <p>本步骤支持预置案件、粘贴文本与 TXT 上传，统一准备案件解析输入。</p>
        <p>模型解析与审讯游戏功能留待后续步骤，当前尚未开放。</p>
      </section>

      <footer className="page-footer">项目启动页 · 等待本步骤确认</footer>
    </main>
  )
}

export default App
