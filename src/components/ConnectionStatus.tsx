import { useEffect, useState } from 'react'
import type { HealthResponse } from '../types/api'

type ConnectionState =
  | { kind: 'loading' }
  | { kind: 'success'; data: HealthResponse }
  | { kind: 'error'; timedOut: boolean }

function isHealthResponse(value: unknown): value is HealthResponse {
  if (!value || typeof value !== 'object') return false

  const data = value as Partial<HealthResponse>
  const configuration = data.configuration

  return (
    data.status === 'ok' &&
    data.service === 'interrogation-api' &&
    typeof data.message === 'string' &&
    !!configuration &&
    typeof configuration.ready === 'boolean' &&
    Array.isArray(configuration.missing) &&
    configuration.missing.every((item) => typeof item === 'string') &&
    Array.isArray(configuration.invalid) &&
    configuration.invalid.every((item) => typeof item === 'string')
  )
}

function ConnectionStatus() {
  const [state, setState] = useState<ConnectionState>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    let timedOut = false
    const timeout = window.setTimeout(() => {
      timedOut = true
      controller.abort()
    }, 10_000)

    async function checkConnection() {
      try {
        const response = await fetch('/api/health', {
          signal: controller.signal,
          cache: 'no-store',
        })

        if (!response.ok) throw new Error('Health check failed')

        const data: unknown = await response.json()
        if (!isHealthResponse(data)) throw new Error('Unexpected health response')

        if (active) setState({ kind: 'success', data })
      } catch {
        if (active) setState({ kind: 'error', timedOut })
      } finally {
        window.clearTimeout(timeout)
      }
    }

    void checkConnection()

    return () => {
      active = false
      window.clearTimeout(timeout)
      controller.abort()
    }
  }, [attempt])

  const loading = state.kind === 'loading'
  const connected = state.kind === 'success'
  const ready = connected && state.data.configuration.ready
  const badgeClass = loading ? '' : connected ? (ready ? 'success' : 'warning') : 'error'
  const badgeText = loading ? '检查中' : connected ? (ready ? '检查通过' : '待配置') : '连接失败'

  function refresh() {
    setState({ kind: 'loading' })
    setAttempt((current) => current + 1)
  }

  return (
    <section className="connection-card" aria-labelledby="connection-title">
      <div className="card-heading">
        <h2 id="connection-title">运行状态</h2>
        <span className={`status-badge ${badgeClass}`}>{badgeText}</span>
      </div>

      <div aria-live="polite" aria-atomic="true" aria-busy={loading}>
        <dl className="status-list">
          <div className="status-row">
            <dt>后端服务</dt>
            <dd>{loading ? '正在连接…' : connected ? '已连接' : '未连接'}</dd>
          </div>
          <div className="status-row">
            <dt>服务端配置</dt>
            <dd>{loading ? '等待检查' : connected ? (ready ? '检查通过' : '需要完善') : '暂无法检查'}</dd>
          </div>
        </dl>

        <div className="connection-detail">
          {loading && <p>正在检查后端连接与配置，请稍候。</p>}
          {connected && ready && (
            <p>后端服务已启动，配置检查通过。此检查尚未验证真实模型 API 调用。</p>
          )}
          {connected && !ready && (
            <>
              <p>
                配置缺少 {state.data.configuration.missing.length} 项，
                格式无效 {state.data.configuration.invalid.length} 项。
              </p>
              <p>请根据后端启动提示完善配置并重启后端，再刷新状态。</p>
            </>
          )}
          {state.kind === 'error' && (
            <>
              <p>{state.timedOut ? '连接检查超时。' : '无法连接后端，或后端返回了无效响应。'}</p>
              <p>请在项目目录的新终端中单独启动后端：<code>npm run dev:server</code>，然后重试。</p>
            </>
          )}
        </div>
      </div>

      <button className="refresh-button" type="button" disabled={loading} onClick={refresh}>
        {loading ? '正在检查…' : state.kind === 'error' ? '重新检查连接' : '刷新状态'}
      </button>
    </section>
  )
}

export default ConnectionStatus
