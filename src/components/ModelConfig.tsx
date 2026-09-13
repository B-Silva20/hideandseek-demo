import { useState } from 'react'
import './ModelConfig.css'

type Provider = 'openai' | 'deepseek' | 'doubao' | 'custom'
const presets: Record<Provider, { label: string; baseUrl: string; model: string }> = {
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  doubao: { label: '豆包 / 火山方舟', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: '' },
  custom: { label: '自定义 OpenAI 兼容', baseUrl: '', model: '' },
}

export default function ModelConfig() {
  const [provider, setProvider] = useState<Provider>('openai')
  const [baseUrl, setBaseUrl] = useState(presets.openai.baseUrl)
  const [model, setModel] = useState('')
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [apiKey, setApiKey] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [connection, setConnection] = useState<'success' | 'error' | null>(null)

  function choose(next: Provider) {
    setProvider(next); setBaseUrl(presets[next].baseUrl); setModel(presets[next].model); setNotice('')
  }
  async function testConnection() {
    setTesting(true); setConnection(null); setNotice('')
    try {
      const response = await fetch('/api/config/model/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', body: JSON.stringify({ apiKey, baseUrl, model }) })
      const body = await response.json() as { connected?: boolean; message?: string; error?: string }
      if (!response.ok || !body.connected) throw new Error(body.error || '模型连接失败。')
      setConnection('success'); setNotice(body.message || '模型 API 连接成功。')
      const modelsResponse = await fetch('/api/config/model/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey, baseUrl }), cache: 'no-store' })
      if (modelsResponse.ok) { const modelsBody = await modelsResponse.json() as { models?: string[] }; setAvailableModels(modelsBody.models ?? []) }
    } catch (error) { setConnection('error'); setNotice(error instanceof Error ? error.message : '模型连接失败。') }
    finally { setTesting(false) }
  }
  async function save() {
    setBusy(true); setNotice(''); setConnection(null)
    try {
      const response = await fetch('/api/config/model', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseUrl, model, apiKey }) })
      const body = await response.json() as { error?: string; message?: string }
      if (!response.ok) throw new Error(body.error || '配置保存失败。')
      setApiKey(''); setNotice(body.message || '模型配置已保存，密钥不会返回或显示。')
    } catch (error) { setNotice(error instanceof Error ? error.message : '配置保存失败。') }
    finally { setBusy(false) }
  }
  return <section className="model-config" aria-labelledby="model-config-title">
    <div className="card-heading"><div><p className="section-kicker">连接模型</p><h2 id="model-config-title">API 可视化配置</h2></div><span className="config-lock">仅后端保存</span></div>
    <p className="config-copy">选择服务商并填写 API Key。密钥只发送到本地后端，不会写入网页、响应或 Git。</p>
    <div className="provider-grid" role="group" aria-label="模型服务商">
      {(Object.keys(presets) as Provider[]).map((item) => <button key={item} type="button" className={provider === item ? 'provider active' : 'provider'} onClick={() => choose(item)}>{presets[item].label}</button>)}
    </div>
    <label htmlFor="model-base-url">Base URL</label><input id="model-base-url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" />
    <label htmlFor="model-api-key">API Key</label><input id="model-api-key" type="password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setConnection(null) }} placeholder="粘贴密钥，仅本次提交使用" autoComplete="off" />
    <label htmlFor="model-name">模型名称（可选）</label>
    <select id="model-name" value={availableModels.includes(model) ? model : model ? '__custom__' : ''} onChange={(event) => setModel(event.target.value === '__custom__' ? '' : event.target.value)}>
      <option value="">连接成功后选择模型（可暂不填写）</option>{availableModels.map((item) => <option key={item} value={item}>{item}</option>)}<option value="__custom__">自定义输入…</option>
    </select>
    {(model && !availableModels.includes(model) || availableModels.length === 0) && <input aria-label="自定义模型名称" value={model} onChange={(event) => setModel(event.target.value)} placeholder="可选，例如 gpt-4o-mini 或 Endpoint ID" />}
    <div className="config-actions"><button className="refresh-button" type="button" disabled={busy || testing || !apiKey || !baseUrl} onClick={() => void save()}>{busy ? '正在保存…' : '保存配置'}</button><button className="test-button" type="button" disabled={busy || testing || !apiKey || !baseUrl} onClick={() => void testConnection()}>{testing ? '正在测试…' : '测试连接'}</button></div>
    {connection && <p className={`connection-result ${connection}`} role="status">{connection === 'success' ? '连接成功' : '连接失败'}</p>}
    {notice && <p className="config-notice" role="status">{notice}</p>}
  </section>
}
