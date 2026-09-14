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
/** 支持书籍级 TXT；大正文只在解析和案件档案中保存，不进入每轮审讯上下文。 */
export const CASE_TEXT_MAX_LENGTH = 1_000_000

/** 案件 ID 只用于内存查找，限制长度避免异常长参数进入日志或 Map。 */
const CASE_ID_MAX_LENGTH = 64
const TITLE_MAX_LENGTH = 60
const FALLBACK_TITLE = '未命名案件'

export type CaseSourceType = 'paste' | 'file'
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
  /** 角色可知的局部事实，只在服务端审讯上下文中使用。 */
  facts?: CaseFact[]
}

export interface CaseFact {
  factId: string
  text: string
  holders: string[]
  revealAfter: 'initial' | 'evidence' | 'confrontation'
  evidenceTitle?: string
}

export interface CaseRecord extends CaseSummary {
  sourceText: string
  parsed?: ParsedCase
  parseError?: string
}

export type CreateCaseResult =
  | { ok: true; record: CaseRecord }
  | { ok: false; code: CaseErrorCode; error: string }

const SOURCE_TYPES: readonly CaseSourceType[] = ['paste', 'file']

/** 案件真相只供服务端使用，绝不随 CaseSummary 返回前端。 */
export function getCaseTruth(record: CaseRecord): string {
  const parsed = record.parsed?.truth?.trim()
  if (parsed) return parsed
  return '未知'
}

/** 凶手姓名只供服务端的结局判定使用；无法确定时返回空串。 */
export function getCaseCulprit(record: CaseRecord): string {
  const culprit = record.parsed?.culprit?.trim()
  if (culprit) return culprit
  return ''
}

/**
 * 当前步骤只使用进程内存，后端重启（含 tsx watch 热重载）会清空所有案件。
 * DATABASE_URL 持久化属于后续步骤，接口形状不会因此改变。
 */
const cases = new Map<string, CaseRecord>()

type ChangeListener = () => void
/** 变更订阅：持久化层用它触发节流自动存档，仓库本身不知道存档文件的存在。 */
const changeListeners = new Set<ChangeListener>()

export function onCasesChange(listener: ChangeListener): () => void {
  changeListeners.add(listener)
  return () => { changeListeners.delete(listener) }
}

/** 只在安全边界通知（案件创建完成、状态更新完成），不写半途中的中间状态。 */
function notifyCasesChange() {
  for (const listener of [...changeListeners]) listener()
}

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

function titleFromText(sourceText: string): string | null {
  const ignored = /^(?:案件背景|故事背景|正文|人物(?:介绍)?|线索|简介|前言|序章|第一章|背景资料)[：:]?$/u
  const lines = sourceText
    .split('\n')
    .slice(0, 80)
    .map((line) => line.replace(/^\uFEFF/u, '').trim())
    .filter(Boolean)
  const usableTitle = (line: string): string | null => {
    if (ignored.test(line) || /[。！？；]$/u.test(line)) return null
    const length = Array.from(line).length
    return length >= 2 && length <= TITLE_MAX_LENGTH ? line : null
  }

  const titleCandidate = (line: string): string => {
    const labelled = line.match(/^(?:案件名称|案件名|案名|标题|题目)[：:]\s*(.+)$/u)
    if (labelled) return labelled[1].trim()
    if (line.startsWith('#')) return line.replace(/^#+\s*/u, '').trim()
    const quoted = line.match(/[《「『]([^》」』]{2,80})[》」』]/u)
    return quoted ? quoted[1].trim() : line
  }

  const firstLineTitle = usableTitle(titleCandidate(lines[0] ?? ''))
  if (firstLineTitle) return firstLineTitle

  for (const [index, line] of lines.entries()) {
    const candidate = titleCandidate(line)
    if (candidate !== line) return usableTitle(candidate)
    if (/^(?:作者|author)\s*[：:]/iu.test(lines[index + 1] ?? '')) {
      const bookTitle = usableTitle(line)
      if (bookTitle) return bookTitle
    }
  }

  return null
}

function deriveTitle(rawTitle: unknown, sourceType: CaseSourceType, fileName: string | undefined, sourceText: string): string {
  if (typeof rawTitle === 'string' && rawTitle.trim() && rawTitle.trim() !== FALLBACK_TITLE) {
    return truncate(rawTitle.trim(), TITLE_MAX_LENGTH)
  }
  const extracted = titleFromText(sourceText)
  if (extracted) return truncate(extracted, TITLE_MAX_LENGTH)
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
 *
 * 校验顺序固定为「文本 -> 长度 -> 来源类型」，保证空请求体总是得到最可执行的提示。
 */
export function createCase(payload: unknown): CreateCaseResult {
  const body = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  const sourceType = readSourceType(body.sourceType)

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

  if (!sourceType) {
    return {
      ok: false,
      code: 'INVALID_SOURCE_TYPE',
      error: '案件来源无效，应为 paste 或 file。',
    }
  }

  const fileName = readFileName(body.fileName)
  const record: CaseRecord = {
    caseId: `case_${randomUUID()}`,
    title: deriveTitle(body.title, sourceType, fileName, sourceText),
    status: 'parsing',
    sourceType,
    ...(fileName ? { fileName } : {}),
    textStats,
    createdAt: new Date().toISOString(),
    message: '案件文本已接收，正在解析。',
    sourceText,
  }

  cases.set(record.caseId, record)
  notifyCasesChange()
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
  notifyCasesChange()
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
  if (record.briefing) {
    summary.briefing = { ...record.briefing, title: record.title }
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

/*
 * 以下三个函数只服务于存档恢复（server/services/persistence.ts）。
 * 存档是玩家机器上的本地文件，可能被截断、被手工改动或跨版本读取，
 * 因此这里逐字段校验并补齐默认值：单条记录不合法只丢弃这一条，不让整份存档作废。
 */

export function snapshotCases(): CaseRecord[] {
  return [...cases.values()].map((record) => structuredClone(record))
}

function asText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function readStringList(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    .slice(0, maxItems)
    .map((item) => item.trim())
}

function readTextStats(value: unknown, sourceText: string): CaseTextStats {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  const charCount = raw?.charCount
  const lineCount = raw?.lineCount
  if (typeof charCount === 'number' && Number.isInteger(charCount) && charCount > 0
    && typeof lineCount === 'number' && Number.isInteger(lineCount) && lineCount > 0) {
    return { charCount, lineCount }
  }
  // 统计信息对不上就以原文重算，避免界面显示与内容不符。
  return countText(sourceText)
}

function readStoredBriefing(value: unknown): CaseBriefing | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const characters = Array.isArray(raw.characters)
    ? raw.characters.flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
      const person = entry as Record<string, unknown>
      const name = typeof person.name === 'string' ? person.name.trim() : ''
      if (!name) return []
      return [{ name, publicIdentity: asText(person.publicIdentity, '相关人物') }]
    }).slice(0, 40)
    : []
  // 没有人物就没有可审讯的对象，这条记录保留下来也没有意义。
  if (characters.length === 0) return null
  return {
    playerRole: asText(raw.playerRole, '调查人员'),
    title: asText(raw.title, FALLBACK_TITLE),
    summary: asText(raw.summary, ''),
    objective: asText(raw.objective, ''),
    characters,
    relationships: readStringList(raw.relationships, 40),
    knownClues: readStringList(raw.knownClues, 40),
    visibleEvidence: readStringList(raw.visibleEvidence, 40),
    questions: readStringList(raw.questions, 40),
  }
}

function readStoredParsed(value: unknown): ParsedCase | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const facts = Array.isArray(raw.facts) ? raw.facts.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const fact = entry as Record<string, unknown>
    const factId = typeof fact.factId === 'string' ? fact.factId.trim() : ''
    const text = typeof fact.text === 'string' ? fact.text.trim() : ''
    const holders = readStringList(fact.holders, 20)
    const revealAfter = fact.revealAfter
    if (!factId || !text || holders.length === 0 || (revealAfter !== 'initial' && revealAfter !== 'evidence' && revealAfter !== 'confrontation')) return []
    const gate: CaseFact['revealAfter'] = revealAfter
    const evidenceTitle = typeof fact.evidenceTitle === 'string' ? fact.evidenceTitle.trim() : ''
    return [{ factId, text, holders, revealAfter: gate, ...(gate === 'evidence' && evidenceTitle ? { evidenceTitle } : {}) }]
  }).slice(0, 80) : []
  return {
    playerRole: asText(raw.playerRole, '调查人员'),
    characters: readStringList(raw.characters, 40),
    relationships: readStringList(raw.relationships, 40),
    evidence: readStringList(raw.evidence, 40),
    timeline: readStringList(raw.timeline, 40),
    truth: asText(raw.truth, ''),
    culprit: asText(raw.culprit, ''),
    ...(facts.length ? { facts } : {}),
  }
}

function readStoredCase(value: unknown): CaseRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const caseId = typeof raw.caseId === 'string' ? raw.caseId.trim() : ''
  if (!caseId || caseId.length > CASE_ID_MAX_LENGTH) return null
  const sourceText = typeof raw.sourceText === 'string' ? raw.sourceText : ''
  if (!sourceText || sourceText.length > CASE_TEXT_MAX_LENGTH) return null
  const sourceType = readSourceType(raw.sourceType)
  if (!sourceType) return null

  const fileName = readFileName(raw.fileName)
  const storedStatus = raw.status === 'ready' || raw.status === 'failed' || raw.status === 'parsing' ? raw.status : 'parsing'
  // 存档里的 parsing 是上次进程被中断时留下的状态，重新解析需要模型，
  // 所以显式降级为 failed 并写明原因，避免界面永远停在「解析中」。
  const interrupted = storedStatus === 'parsing'
  const record: CaseRecord = {
    caseId,
    title: deriveTitle(raw.title, sourceType, fileName, sourceText),
    status: interrupted ? 'failed' : storedStatus,
    sourceType,
    ...(fileName ? { fileName } : {}),
    textStats: readTextStats(raw.textStats, sourceText),
    createdAt: typeof raw.createdAt === 'string' && !Number.isNaN(Date.parse(raw.createdAt)) ? raw.createdAt : new Date().toISOString(),
    message: interrupted
      ? '上次退出时该案件尚未解析完成，请重新提交案件文本。'
      : asText(raw.message, '已从存档恢复。'),
    sourceText,
  }
  const briefing = readStoredBriefing(raw.briefing)
  if (briefing) record.briefing = briefing
  const parsed = readStoredParsed(raw.parsed)
  if (parsed) record.parsed = parsed
  if (typeof raw.parseError === 'string' && raw.parseError) record.parseError = raw.parseError
  // 既没有 Briefing 也没有解析结果的案件无法进入审讯，丢弃。
  if (!record.briefing && !record.parsed) return null
  return record
}

/** 从存档恢复案件；返回成功恢复的条数，结构不完整的条目会被丢弃。 */
export function hydrateCases(payload: unknown): number {
  if (!Array.isArray(payload)) return 0
  let restored = 0
  for (const entry of payload) {
    const record = readStoredCase(entry)
    if (!record) continue
    cases.set(record.caseId, record)
    restored += 1
  }
  return restored
}
