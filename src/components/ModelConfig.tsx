import { useEffect, useState } from 'react'
import ConnectionStatus from './ConnectionStatus'
import './ModelConfig.css'

type Provider = 'openai' | 'deepseek' | 'doubao' | 'custom'
const presets: Record<Provider, { label: string; baseUrl: string; model: string }> = {
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  doubao: { label: '豆包 / 火山方舟', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: '' },
  custom: { label: '自定义 OpenAI 兼容', baseUrl: '', model: '' },
}
const PROVIDERS = Object.keys(presets) as Provider[]

/**
 * 只记住服务商、Base URL、模型名这三个非敏感字段。
 * API Key 不进浏览器存储，它始终只保存在后端进程内存里，由后端在请求未带密钥时沿用。
 */
const STORAGE_KEY = 'interrogation.modelConfig'
interface StoredConfig { provider: Provider; baseUrl: string; model: string }

function isProvider(value: unknown): value is Provider {
  return typeof value === 'string' && PROVIDERS.includes(value as Provider)
}

function readStored(): StoredConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredConfig>
    if (!isProvider(parsed.provider)) return null
    return {
      provider: parsed.provider,
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : '',
      model: typeof parsed.model === 'string' ? parsed.model : '',
    }
  } catch { return null }
}

function writeStored(value: StoredConfig) {
  // 隐私模式或配额不足时写入会失败，忽略即可，不影响当前会话。
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)) } catch { /* ignore */ }
}

/** 反向识别地址属于哪个服务商，用于恢复上次选中的卡片；匹配不到就归为自定义。 */
function matchProvider(baseUrl: string): Provider {
  const normalized = baseUrl.trim().replace(/\/+$/, '').toLowerCase()
  const matched = PROVIDERS.find((key) => presets[key].baseUrl && presets[key].baseUrl.toLowerCase() === normalized)
  return matched ?? 'custom'
}

export default function ModelConfig({ onConnected, onCollapse }: { onConnected?: () => void; onCollapse?: () => void }) {
  const [stored] = useState(readStored)
  const initialProvider = stored?.provider ?? 'openai'
  const [provider, setProvider] = useState<Provider>(initialProvider)
  const [baseUrl, setBaseUrl] = useState(() => stored?.baseUrl || presets[initialProvider].baseUrl)
  const [model, setModel] = useState(() => stored?.model || presets[initialProvider].model)
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [apiKey, setApiKey] = useState('')
  const [savedKey, setSavedKey] = useState(false)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [connection, setConnection] = useState<'success' | 'error' | null>(null)

  // 记住非敏感字段，下次点开面板即可直接续用。
  useEffect(() => { writeStored({ provider, baseUrl, model }) }, [provider, baseUrl, model])

  // 后端进程内的配置是当前真正生效的一份，优先于浏览器里记住的草稿。
  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const response = await fetch('/api/config/model/status', { cache: 'no-store' })
        if (!response.ok) return
        const status = await response.json().catch(() => ({})) as { configured?: boolean; hasApiKey?: boolean; baseUrl?: string; model?: string }
        if (!active) return
        if (status.hasApiKey || status.configured) setSavedKey(true)
        if (status.baseUrl) { setBaseUrl(status.baseUrl); setProvider(matchProvider(status.baseUrl)) }
        if (status.model) setModel(status.model)
      } catch { /* 后端未启动时沿用本地记住的草稿 */ }
    })()
    return () => { active = false }
  }, [])

  function choose(next: Provider) {
    setProvider(next); setBaseUrl(presets[next].baseUrl); setModel(presets[next].model); setNotice('')
  }

  /** 手动改地址后同步高亮对应的服务商卡片，避免出现「地址是 A、选中是 B」。 */
  function updateBaseUrl(value: string) {
    setBaseUrl(value); setProvider(matchProvider(value))
  }

  /** 只更新连接状态，不关闭面板：成功后用户还要在这里挑选服务端返回的模型。 */
  async function testConnection() {
    const submittedKey = apiKey
    setTesting(true); setConnection(null); setNotice('')
    try {
      const response = await fetch('/api/config/model/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', body: JSON.stringify({ apiKey: submittedKey, baseUrl, model }) })
      const body = await response.json().catch(() => ({})) as { connected?: boolean; message?: string; error?: string; saved?: boolean; model?: string }
      if (!response.ok || !body.connected) throw new Error(body.error || '模型连接失败。')
      setConnection('success'); setNotice(body.message || '模型 API 连接成功。')
      if (body.saved) { setSavedKey(true); setApiKey('') }
      onConnected?.()
      // 未手填模型时服务端会回传它选中的模型，与模型列表合并后供下拉框直接选择。
      const detected = typeof body.model === 'string' ? body.model : ''
      const modelsResponse = await fetch('/api/config/model/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: submittedKey, baseUrl }), cache: 'no-store' })
      // 取列表失败只影响下拉选项，不能把已经成功的连接测试重新标成失败。
      const fetched = modelsResponse.ok
        ? ((await modelsResponse.json().catch(() => ({}))) as { models?: string[] }).models ?? []
        : []
      setAvailableModels(detected && !fetched.includes(detected) ? [detected, ...fetched] : fetched)
      if (detected) setModel((current) => current || detected)
    } catch (error) { setConnection('error'); setNotice(error instanceof Error ? error.message : '模型连接失败。') }
    finally { setTesting(false) }
  }
  async function save() {
    setBusy(true); setNotice(''); setConnection(null)
    try {
      const response = await fetch('/api/config/model', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseUrl, model, apiKey }) })
      const body = await response.json().catch(() => ({})) as { error?: string; message?: string }
      if (!response.ok) throw new Error(body.error || '配置保存失败。')
      setApiKey(''); setSavedKey(true); setNotice(body.message || '模型配置已保存，密钥不会返回或显示。')
    } catch (error) { setNotice(error instanceof Error ? error.message : '配置保存失败。') }
    finally { setBusy(false) }
  }

  const keyMissing = !apiKey && !savedKey
  const actionsDisabled = busy || testing || !baseUrl || keyMissing

  return <section className="model-config" aria-labelledby="model-config-title">
    <div className="card-heading"><div><p className="section-kicker">连接模型</p><h2 id="model-config-title">API 可视化配置</h2></div><div className="config-heading-actions"><span className="config-lock">仅后端保存</span>{onCollapse && <button className="collapse-button" type="button" onClick={onCollapse}>收起</button>}</div></div>
    <p className="config-copy">选择服务商并填写 API Key。密钥只发送到本地后端，不会写入网页、响应或 Git。</p>
    <div className="provider-grid" role="group" aria-label="模型服务商">
      {PROVIDERS.map((item) => <button key={item} type="button" className={provider === item ? 'provider active' : 'provider'} onClick={() => choose(item)}>{presets[item].label}</button>)}
    </div>
    <label htmlFor="model-base-url">Base URL</label><input id="model-base-url" value={baseUrl} onChange={(event) => updateBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" />
    <label htmlFor="model-api-key">API Key</label><input id="model-api-key" type="password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setConnection(null) }} placeholder={savedKey ? '后端已保存密钥，留空即沿用' : '粘贴密钥，仅本次提交使用'} autoComplete="off" />
    {savedKey && <p className="config-notice">API Key 已保存在后端进程中，刷新或重新打开面板都不需要重填；浏览器不会保存密钥。</p>}
    <label htmlFor="model-name">模型名称（可选）</label>
    <select id="model-name" value={availableModels.includes(model) ? model : model ? '__custom__' : ''} onChange={(event) => setModel(event.target.value === '__custom__' ? '' : event.target.value)}>
      <option value="">连接成功后选择模型（可暂不填写）</option>{availableModels.map((item) => <option key={item} value={item}>{item}</option>)}<option value="__custom__">自定义输入…</option>
    </select>
    {(model && !availableModels.includes(model) || availableModels.length === 0) && <input aria-label="自定义模型名称" value={model} onChange={(event) => setModel(event.target.value)} placeholder="可选，例如 gpt-4o-mini 或 Endpoint ID" />}
    {(notice || connection) && <p className={`connection-result ${connection ?? 'info'}`} role={connection === 'error' ? 'alert' : 'status'}>{notice || (connection === 'success' ? '连接成功' : '连接失败')}</p>}
    <div className="config-actions"><button className="refresh-button" type="button" disabled={actionsDisabled} onClick={() => void save()}>{busy ? '正在保存…' : '保存配置'}</button><button className="test-button" type="button" disabled={actionsDisabled} onClick={() => void testConnection()}>{testing ? '正在测试…' : '测试连接'}</button></div>
    <ConnectionStatus />
  </section>
}
