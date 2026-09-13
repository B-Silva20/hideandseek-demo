export interface HealthResponse {
  status: 'ok'
  service: 'interrogation-api'
  configuration: {
    ready: boolean
    missing: string[]
    invalid: string[]
  }
  message: string
}

/*
 * 案件输入接口契约（前端副本）。
 *
 * 后端 tsconfig 的 rootDir 限定为 server/，无法直接引用本文件，
 * 因此 server/services/caseStore.ts 保存了一份字段名和长度限制完全一致的副本。
 * 修改任何字段名或常量时必须两端同步修改。
 *
 *   POST /api/cases           请求 CaseCreateRequest   -> 201 CaseSummary | 400 CaseErrorResponse
 *   GET  /api/cases/:caseId                          -> 200 CaseSummary | 404 CaseErrorResponse
 *
 * 两个响应都带 Cache-Control: no-store，且都不会回传案件原文，
 * 只回传 CaseTextStats 供用户核对。
 */

/** 案件文本的提交方式。上传 .txt 不经过 multipart，由前端读取后按纯文本提交。 */
export type CaseSourceType = 'preset' | 'paste' | 'file'

/** 案件状态。parsing 表示文本已被接收，模型解析尚未完成。 */
export type CaseStatus = 'parsing' | 'ready' | 'failed'

/** 接收文本后的统计信息，用于让用户确认内容无误；不包含原文。 */
export interface CaseTextStats {
  charCount: number
  lineCount: number
}

/** POST /api/cases 的请求体。sourceText 为必填，其余字段可选。 */
export interface CaseCreateRequest {
  sourceText: string
  sourceType: CaseSourceType
  /** 展示用标题；不传时按 fileName 推导，再退化为「未命名案件」。 */
  title?: string
  /** 仅 sourceType 为 file 时使用，用于展示与推导标题。 */
  fileName?: string
}

/** POST /api/cases 与 GET /api/cases/:caseId 共用的响应体。 */
export interface CaseSummary {
  caseId: string
  title: string
  status: CaseStatus
  sourceType: CaseSourceType
  fileName?: string
  textStats: CaseTextStats
  /** ISO 8601 时间字符串。 */
  createdAt: string
  /** 面向用户的中文提示，可直接展示。 */
  message: string
}

/** 失败响应的错误码，前端据此选择提示文案，不要匹配 error 文案本身。 */
export type CaseErrorCode =
  | 'TEXT_REQUIRED'
  | 'TEXT_TOO_SHORT'
  | 'TEXT_TOO_LONG'
  | 'INVALID_SOURCE_TYPE'
  | 'CASE_NOT_FOUND'

export interface CaseErrorResponse {
  code: CaseErrorCode
  error: string
}

/**
 * 案件文本长度限制，按 Unicode 码点计数（与 Array.from(text).length 一致）。
 * 上传 .txt 前请在前端先做同样的长度检查，避免把超大请求发到后端。
 */
export const CASE_TEXT_MIN_LENGTH = 200
export const CASE_TEXT_MAX_LENGTH = 200_000
