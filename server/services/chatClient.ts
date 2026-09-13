import { ModelError } from './modelError.js'

/*
 * OpenAI 兼容 chat/completions 的统一调用入口，案件解析与审讯共用同一套加固措施：
 *   - 只接受 http(s) 且不含用户名、密码、查询参数、片段的 Base URL；
 *   - 禁止重定向，避免密钥被带到其他主机；
 *   - 请求超时、响应体积上限、非流式；
 *   - 只返回 content 解析后的 JSON，错误一律转成脱敏的 ModelError。
 */

export interface ChatJsonRequest {
  baseUrl: string
  apiKey: string
  model: string
  system: string
  user: string
  /** 默认 60 秒。 */
  timeoutMs?: number
  /** 响应字节上限，默认 1 MiB。 */
  maxBytes?: number
}

function resolveEndpoint(baseUrl: string, apiKey: string, model: string): URL {
  try {
    if (!apiKey || !model) throw new Error('incomplete configuration')
    const url = new URL(baseUrl)
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('unsupported protocol')
    if (url.username || url.password || url.search || url.hash) throw new Error('unexpected url parts')
    url.pathname = `${url.pathname.replace(/\/$/, '')}/chat/completions`
    return url
  } catch {
    throw new ModelError('LLM_NOT_CONFIGURED', '请在后端配置 LLM_API_KEY、LLM_BASE_URL 和 LLM_MODEL。', 503)
  }
}

export async function requestChatJson(request: ChatJsonRequest, transport: typeof fetch = fetch): Promise<unknown> {
  const url = resolveEndpoint(request.baseUrl, request.apiKey, request.model)
  const signal = AbortSignal.timeout(request.timeoutMs ?? 60_000)
  const maxBytes = request.maxBytes ?? 1_048_576

  try {
    const response = await transport(url, {
      method: 'POST', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${request.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: request.model, stream: false,
        messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.user }],
      }),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new ModelError(
        response.status === 429 ? 'LLM_RATE_LIMITED' : 'LLM_REQUEST_FAILED',
        '模型服务拒绝请求，请检查配置或稍后重试。',
      )
    }
    if (!response.body) throw new ModelError('INVALID_MODEL_OUTPUT', '模型返回为空。')

    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > maxBytes) {
          await reader.cancel()
          throw new ModelError('INVALID_MODEL_OUTPUT', '模型返回内容过大。')
        }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }

    let payload: unknown
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch { throw new ModelError('INVALID_MODEL_OUTPUT', '模型返回的数据无法解析。') }

    const result = payload as { choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown } }> }
    const choice = result?.choices?.[0]
    if (choice?.finish_reason !== 'stop' || typeof choice?.message?.content !== 'string') {
      throw new ModelError('INVALID_MODEL_OUTPUT', '模型未返回完整结果。')
    }
    try { return JSON.parse(choice.message.content) }
    catch { throw new ModelError('INVALID_MODEL_OUTPUT', '模型返回的 JSON 结构无法解析。') }
  } catch (error) {
    if (error instanceof ModelError) throw error
    if (signal.aborted) throw new ModelError('LLM_TIMEOUT', '模型调用超时，请稍后重试。', 504)
    throw new ModelError('LLM_REQUEST_FAILED', '模型调用失败或返回格式无效。')
  }
}
