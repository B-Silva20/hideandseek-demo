import ConnectionStatus from './components/ConnectionStatus'
import './App.css'

function App() {
  return (
    <main className="startup-page">
      <header className="page-header">
        <span className="project-mark" aria-hidden="true">案</span>
        <span>案件文本驱动 · 移动端推理网页</span>
      </header>

      <section className="intro" aria-labelledby="page-title">
        <p className="step-label">第一步 / 项目初始化</p>
        <h1 id="page-title">案件审讯 Demo</h1>
        <p className="intro-copy">从案件文本出发，在人物的证词与线索之间，逐步查明真相。</p>
      </section>

      <ConnectionStatus />

      <section className="scope-card" aria-labelledby="scope-title">
        <h2 id="scope-title">当前进度</h2>
        <p>本步骤用于确认项目能够启动，以及前后端能够正常连接。</p>
        <p>案件导入、模型解析与审讯游戏功能留待后续步骤，当前尚未开放。</p>
      </section>

      <footer className="page-footer">项目启动页 · 等待本步骤确认</footer>
    </main>
  )
}

export default App
