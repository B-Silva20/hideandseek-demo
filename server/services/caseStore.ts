import { randomUUID } from 'node:crypto'

/*
 * 案件输入契约（服务端副本）。
 *
 * 后端 tsconfig 的 rootDir 限定为 server/，无法引用 src/types/api.ts，
 * 因此字段名和长度限制必须与那份文件保持完全一致，修改时两端同步。
 *
 *   POST /api/cases           请求 CaseCreateRequest   -> 201 CaseSummary | 400 CaseErrorResponse
 *   GET  /api/cases/:caseId                          -> 200 CaseSummary | 404 CaseErrorResponse
 */

export const CASE_TEXT_MIN_LENGTH = 200
export const CASE_TEXT_MAX_LENGTH = 200_000

/** 案件 ID 只用于内存查找，限制长度避免异常长参数进入日志或 Map。 */
const CASE_ID_MAX_LENGTH = 64
const TITLE_MAX_LENGTH = 60
const FALLBACK_TITLE = '未命名案件'

export type CaseSourceType = 'preset' | 'paste' | 'file'
export type CaseStatus = 'parsing' | 'ready' | 'failed'

export interface CaseTextStats {
  charCount: number
  lineCount: number
}

export interface CaseSummary {
  caseId: string
  title: string
  status: CaseStatus
  sourceType: CaseSourceType
  fileName?: string
  textStats: CaseTextStats
  createdAt: string
  message: string
  briefing?: CaseBriefing
}
export interface CaseBriefing {
  playerRole: string
  title: string
  summary: string
  objective: string
  characters: Array<{ name: string; publicIdentity: string }>
  relationships: string[]
  knownClues: string[]
  visibleEvidence: string[]
  questions: string[]
}

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

/** 案件原文只留在服务端内存中，用于后续模型解析，不随响应返回前端。 */
export interface ParsedCase {
  playerRole: string
  characters: string[]
  relationships: string[]
  evidence: string[]
  timeline: string[]
  truth: string
  /** 凶手姓名，无法确定时为空串。只在服务端用于结局判定。 */
  culprit: string
}

export interface CaseRecord extends CaseSummary {
  sourceText: string
  parsed?: ParsedCase
  parseError?: string
}

export type CreateCaseResult =
  | { ok: true; record: CaseRecord }
  | { ok: false; code: CaseErrorCode; error: string }

const SOURCE_TYPES: readonly CaseSourceType[] = ['preset', 'paste', 'file']

/*
 * 预置案件自带 Briefing，不需要调用模型就能进入审讯。
 * 演示时即使没有配置 API Key（或模型超时），也能完整走完「案件 → Briefing → 审讯」。
 * 与 server/routes/preset.ts 提供的本地案件文本对应。
 */
const PRESET_BRIEFING: CaseBriefing = {
  playerRole: '调查人员',
  title: '占星术杀人魔法（本地预置案件）',
  summary: '四十年前的占星术连续杀人案留下多名受害者与一份神秘手记，案件在多年后重新出现线索。',
  objective: '通过审讯相关人物、核对时间线与证据，找出案件真相。',
  characters: [
    { name: '梅泽平吉', publicIdentity: '画家，案件核心人物' },
    { name: '胜子', publicIdentity: '梅泽平吉的妻子' },
    { name: '友子', publicIdentity: '梅泽家的女儿' },
    { name: '亚纪子', publicIdentity: '梅泽家的女儿' },
    { name: '夕纪子', publicIdentity: '梅泽家的女儿' },
    { name: '登纪子', publicIdentity: '梅泽家的女儿' },
    { name: '冷子', publicIdentity: '梅泽家的侄女' },
    { name: '野风子', publicIdentity: '梅泽家的侄女' },
  ],
  relationships: ['梅泽平吉与胜子是夫妻', '六名少女与梅泽家存在亲属关系', '案件与占星术手记和画室有关'],
  knownClues: ['占星术手记', '六名少女的星座对应关系', '画室与主屋的空间线索'],
  visibleEvidence: ['占星术手记', '受害者名单', '画室记录'],
  questions: ['谁拥有作案动机与机会？', '六名少女的时间线是否存在矛盾？', '手记内容与现场证据能否相互印证？'],
}

/** 预置案件的真相，只留在服务端供结局结算与模型提示词使用。 */
const PRESET_TRUTH = '手记的作者身份与六名少女的实际死亡顺序是关键：真凶利用手记制造了「按星座顺序作案」的假象，实际死亡时间与手记记录的顺序并不一致。'

/**
 * 预置案件没有模型解析结果，凶手身份取决于你实际使用的那份预置案件文本，
 * 因此不写死在代码里，而是从 PRESET_CULPRIT 环境变量读取。
 * 只有在 PRESET_BRIEFING.characters 中存在同名人物时才会被采纳，
 * 避免因为拼写错误让每一次逮捕都静默判错。留空则预置案件的逮捕一律返回「无法判定」。
 */
function readPresetCulprit(): string {
  const value = process.env.PRESET_CULPRIT?.trim() ?? ''
  if (!value) return ''
  return PRESET_BRIEFING.characters.some((person) => person.name === value) ? value : ''
}

/** 案件真相只供服务端使用，绝不随 CaseSummary 返回前端。 */
export function getCaseTruth(record: CaseRecord): string {
  const parsed = record.parsed?.truth?.trim()
  if (parsed) return parsed
  return record.sourceType === 'preset' ? PRESET_TRUTH : '未知'
}

/** 凶手姓名只供服务端的结局判定使用；无法确定时返回空串。 */
export function getCaseCulprit(record: CaseRecord): string {
  const culprit = record.parsed?.culprit?.trim()
  if (culprit) return culprit
  return record.sourceType === 'preset' ? readPresetCulprit() : ''
}

/**
 * 当前步骤只使用进程内存，后端重启（含 tsx watch 热重载）会清空所有案件。
 * DATABASE_URL 持久化属于后续步骤，接口形状不会因此改变。
 */
const cases = new Map<string, CaseRecord>()

/** 未找到案件时的统一错误，提醒用户后端重启会清空未持久化的案件。 */
export const CASE_NOT_FOUND_ERROR: CaseErrorResponse = {
  code: 'CASE_NOT_FOUND',
  error: '未找到该案件。后端重启会清空尚未持久化的案件，请重新提交案件文本。',
}

/** 统一换行符并去掉首尾空白后返回；非字符串返回 null。 */
function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value.replace(/\r\n?/g, '\n').trim()
}

/** 按 Unicode 码点计数，避免代理对被算成两个字符。 */
export function countText(text: string): CaseTextStats {
  const charCount = Array.from(text).length
  return { charCount, lineCount: charCount === 0 ? 0 : text.split('\n').length }
}

function truncate(value: string, maxLength: number): string {
  const characters = Array.from(value)
  return characters.length <= maxLength ? value : `${characters.slice(0, maxLength).join('')}…`
}

function deriveTitle(rawTitle: unknown, sourceType: CaseSourceType, fileName: string | undefined): string {
  if (typeof rawTitle === 'string' && rawTitle.trim()) {
    return truncate(rawTitle.trim(), TITLE_MAX_LENGTH)
  }
  if (sourceType === 'file' && fileName) {
    const withoutExtension = fileName.replace(/\.txt$/i, '').trim()
    if (withoutExtension) return truncate(withoutExtension, TITLE_MAX_LENGTH)
  }
  return FALLBACK_TITLE
}

function readFileName(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  return truncate(value.trim(), TITLE_MAX_LENGTH)
}

function readSourceType(value: unknown): CaseSourceType | null {
  if (typeof value !== 'string') return null
  return SOURCE_TYPES.find((type) => type === value) ?? null
}

/**
 * 校验并保存一份案件文本。
 * 校验顺序固定为「文本 -> 长度 -> 来源类型」，保证空请求体总是得到最可执行的提示。
 */
export function createCase(payload: unknown): CreateCaseResult {
  const body = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>

  const sourceText = normalizeText(body.sourceText)
  if (!sourceText) {
    return { ok: false, code: 'TEXT_REQUIRED', error: '请粘贴案件文本，或上传 .txt 文件。' }
  }

  const textStats = countText(sourceText)
  if (textStats.charCount < CASE_TEXT_MIN_LENGTH) {
    return {
      ok: false,
      code: 'TEXT_TOO_SHORT',
      error: `案件文本过短，至少需要 ${CASE_TEXT_MIN_LENGTH} 个字符，当前 ${textStats.charCount} 个。`,
    }
  }
  if (textStats.charCount > CASE_TEXT_MAX_LENGTH) {
    return {
      ok: false,
      code: 'TEXT_TOO_LONG',
      error: `案件文本过长，最多支持 ${CASE_TEXT_MAX_LENGTH} 个字符，当前 ${textStats.charCount} 个。请删减后重新提交。`,
    }
  }

  const sourceType = readSourceType(body.sourceType)
  if (!sourceType) {
    return {
      ok: false,
      code: 'INVALID_SOURCE_TYPE',
      error: '案件来源无效，应为 preset、paste 或 file。',
    }
  }

  const fileName = readFileName(body.fileName)
  const record: CaseRecord = {
    caseId: `case_${randomUUID()}`,
    title: deriveTitle(body.title, sourceType, fileName),
    status: 'parsing',
    sourceType,
    ...(fileName ? { fileName } : {}),
    textStats,
    createdAt: new Date().toISOString(),
    message: '案件文本已接收，正在解析。',
    sourceText,
  }

  if (sourceType === 'preset') {
    record.briefing = PRESET_BRIEFING
    record.status = 'ready'
    record.message = '预置案件已准备完成，可直接开始审讯。'
  }

  cases.set(record.caseId, record)
  return { ok: true, record }
}

export function findCase(caseId: unknown): CaseRecord | undefined {
  if (typeof caseId !== 'string' || !caseId || caseId.length > CASE_ID_MAX_LENGTH) return undefined
  return cases.get(caseId)
}

export function updateCase(caseId: string, patch: Pick<CaseRecord, 'status' | 'message'> & Partial<Pick<CaseRecord, 'parsed' | 'parseError'>>) {
  const record = cases.get(caseId)
  if (!record) return undefined
  Object.assign(record, patch)
  return record
}

/** 逐字段挑选契约字段，避免 sourceText 被后续改动意外带到响应里。 */
export function toCaseSummary(record: CaseRecord): CaseSummary {
  const summary: CaseSummary = {
    caseId: record.caseId,
    title: record.title,
    status: record.status,
    sourceType: record.sourceType,
    textStats: record.textStats,
    createdAt: record.createdAt,
    message: record.message,
  }
  if (record.fileName) summary.fileName = record.fileName
  // 预置案件直接返回自带 Briefing，无需经过模型解析。
  if (record.briefing) {
    summary.briefing = record.briefing
  } else if (record.parsed) {
    const p = record.parsed
    summary.briefing = {
      playerRole: p.playerRole,
      title: record.title,
      summary: p.timeline.slice(0, 2).join(' '),
      objective: '查明案件真相，并核对人物证词与现有证据。',
      characters: p.characters.map((value) => { const [name, ...rest] = value.split(/[：:]/u); return { name: name.trim(), publicIdentity: (rest.join('：').trim() || '相关人物') } }),
      relationships: p.relationships,
      knownClues: p.evidence,
      visibleEvidence: p.evidence.slice(0, 5),
      questions: ['谁有作案动机与机会？', '哪些证词存在矛盾？', '现有证据能否支持唯一结论？'],
    }
  }
  return summary
}
