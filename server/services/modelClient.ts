export type ModelConnectionResult = { ok: true; model: string } | { ok: false; status: number; message: string }

function getBaseUrl(environment: NodeJS.ProcessEnv) {
  const key = environment.LLM_API_KEY?.trim()
  const base = environment.LLM_BASE_URL?.trim()
  if (!key || !base) return null
  try {
    const url = new URL(base)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null
    return { key, url }
  } catch { return null }
}

export async function listModels(environment: NodeJS.ProcessEnv, transport: typeof fetch = fetch) {
  const config = getBaseUrl(environment)
  if (!config) return { ok: false as const, status: 400, message: 'API Key 或 Base URL 无效。' }
  const url = new URL(config.url)
  url.pathname = `${url.pathname.replace(/\/$/, '')}/models`
  try {
    const response = await transport(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${config.key}` } })
    const body = await response.json() as { data?: Array<{ id?: unknown }> }
    if (!response.ok) return { ok: false as const, status: response.status, message: response.status === 401 || response.status === 403 ? 'API Key 无效或无权访问。' : `模型服务返回 HTTP ${response.status}。` }
    return { ok: true as const, models: (body.data ?? []).map((item) => item.id).filter((id): id is string => typeof id === 'string' && id.length > 0) }
  } catch { return { ok: false as const, status: 502, message: '无法读取模型列表，请检查网络和 Base URL。' } }
}

export async function testModelConnection(environment: NodeJS.ProcessEnv = process.env, transport: typeof fetch = fetch): Promise<ModelConnectionResult> {
  const config = getBaseUrl(environment)
  if (!config) return { ok: false, status: 400, message: 'API Key 或 Base URL 无效。' }
  const model = environment.LLM_MODEL?.trim()
  if (!model) {
    const result = await listModels(environment, transport)
    return result.ok ? { ok: true, model: result.models[0] ?? '服务可访问（尚未选择模型）' } : result
  }
  const url = new URL(config.url)
  url.pathname = `${url.pathname.replace(/\/$/, '')}/chat/completions`
  try {
    const response = await transport(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: '请只回复：连接成功' }] }) })
    await response.body?.cancel()
    if (!response.ok) return { ok: false, status: response.status, message: response.status === 401 || response.status === 403 ? 'API Key 无效或无权访问该模型。' : `模型服务返回 HTTP ${response.status}。` }
    return { ok: true, model }
  } catch { return { ok: false, status: 502, message: '无法连接模型服务，请检查网络和 Base URL。' } }
}
