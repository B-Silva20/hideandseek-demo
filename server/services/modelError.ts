/**
 * 模型相关的统一错误类型。
 *
 * code 供前端与日志判断原因，message 是可直接展示给用户的中文文案；
 * 两者都不包含 API Key、请求地址或原始异常，避免凭据和内部细节泄漏。
 */
export class ModelError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 502) {
    super(message)
  }
}
