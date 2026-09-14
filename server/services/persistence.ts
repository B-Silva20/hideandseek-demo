import { closeSync, copyFileSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs'
import { copyFile, mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hydrateCases, onCasesChange, snapshotCases } from './caseStore.js'
import { hydrateSessions, onSessionsChange, snapshotSessions } from './sessionStore.js'

/*
 * 存档持久化：把案件、会话与案件机密写成一份版本化的 JSON 存档。
 *
 * 这里只负责「文件格式 / 版本 / 落盘方式」，不知道任何游戏字段的含义：
 * 记录的校验与重建分别由 caseStore 与 sessionStore 负责，避免两处重复定义契约。
 *
 * 遵循 save-systems 的几条硬规则：
 *   1. 只序列化纯数据；恢复时重新构建运行时结构，不保存任何运行时引用。
 *   2. 存档自带 version，读取时按顺序迁移到当前版本。
 *   3. 原子写：先写临时文件并 fsync，再改名覆盖；覆盖前留一份 .bak。
 *      Windows 上改名覆盖不保证原子，备份才是真正能恢复的那一份。
 *   4. 防御性读取：文件损坏先回退 .bak，来自更新版本的文件一律不覆盖。
 *   5. 只在安全边界（一次行动结算完、案件创建完）节流自动存档，
 *      并在进程退出时同步落盘。
 */

export const SAVE_VERSION = 1
/** 一次行动会产生多次变更通知，合并成一次写盘；退出时仍会强制落盘。 */
const SAVE_DEBOUNCE_MS = 800

/** 存档文件的结构。cases / sessions / secrets 具体字段由各自的仓库校验。 */
export interface SaveFile {
  version: number
  savedAt: string
  cases: unknown[]
  sessions: unknown[]
  secrets: Record<string, unknown>
}

/** 不会随每一轮审讯变化的案件档案，原文仅在案件变更时写入这里。 */
export interface CaseArchive {
  version: 1
  cases: unknown[]
}

export interface PersistenceStatus {
  file: string
  /** false 表示存档来自更新的版本，本次不会覆盖它（自动存档已停用）。 */
  active: boolean
  restoredCases: number
  restoredSessions: number
  /** 读取过程中的提示，正常读取时为 null。 */
  issue: string | null
}

interface LoadedSave {
  file: SaveFile | null
  source: 'primary' | 'backup' | 'none'
  issue: string | null
  newer: boolean
}

/** 默认存到项目根目录的 .data/save.json（已被 .gitignore 排除），可用 SAVE_FILE 覆盖。 */
export function defaultSaveFile(): string {
  const override = process.env.SAVE_FILE?.trim()
  if (override) return override
  return join(fileURLToPath(new URL('../../.data/', import.meta.url)), 'save.json')
}

export function caseArchivePath(saveFile: string): string {
  return `${saveFile}.cases`
}

/** 当前内存状态的快照。写盘前才调用，保证写到磁盘的永远是最新状态。 */
export function captureSaveFile(): SaveFile {
  const { sessions, secrets } = snapshotSessions()
  return {
    version: SAVE_VERSION,
    savedAt: new Date().toISOString(),
    cases: snapshotCases(),
    sessions,
    secrets,
  }
}

/** 审讯行动专用快照：不重复携带大段案件原文。 */
function captureSessionSaveFile(): SaveFile {
  const { sessions, secrets } = snapshotSessions()
  return { version: SAVE_VERSION, savedAt: new Date().toISOString(), cases: [], sessions, secrets }
}

function captureCaseArchive(): CaseArchive {
  return { version: 1, cases: snapshotCases() }
}

export function serializeSaveFile(file: SaveFile): string {
  return JSON.stringify(file)
}

function readVersion(raw: Record<string, unknown>): number {
  return typeof raw.version === 'number' && Number.isInteger(raw.version) && raw.version >= 0 ? raw.version : 0
}

type Migration = (data: Record<string, unknown>) => Record<string, unknown>

/**
 * 版本 0：没有 version 字段的早期文件（含手工编辑过的文件）。
 * 补齐必要结构后升级到 v1，缺失的容器一律给空值而不是让整份存档作废。
 */
function migrateFromV0(data: Record<string, unknown>): Record<string, unknown> {
  return {
    ...data,
    version: 1,
    savedAt: typeof data.savedAt === 'string' ? data.savedAt : new Date(0).toISOString(),
    cases: Array.isArray(data.cases) ? data.cases : [],
    sessions: Array.isArray(data.sessions) ? data.sessions : [],
    secrets: data.secrets && typeof data.secrets === 'object' && !Array.isArray(data.secrets) ? data.secrets : {},
  }
}

const MIGRATIONS: Record<number, Migration> = { 0: migrateFromV0 }

/** 按顺序把任意版本的原始数据迁移到当前版本，并归一化到 SaveFile 形状。 */
export function migrateSave(raw: unknown): SaveFile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('存档根节点必须是对象。')
  let data: Record<string, unknown> = { ...(raw as Record<string, unknown>) }
  let version = readVersion(data)
  if (version > SAVE_VERSION) throw new Error(`存档版本 v${version} 高于当前程序支持的 v${SAVE_VERSION}。`)
  while (version < SAVE_VERSION) {
    const migration = MIGRATIONS[version]
    if (!migration) throw new Error(`缺少 v${version} -> v${version + 1} 的迁移。`)
    data = migration(data)
    version += 1
    data.version = version
  }
  const normalized = migrateFromV0(data)
  return {
    version: SAVE_VERSION,
    savedAt: typeof normalized.savedAt === 'string' ? normalized.savedAt : new Date().toISOString(),
    cases: Array.isArray(normalized.cases) ? normalized.cases : [],
    sessions: Array.isArray(normalized.sessions) ? normalized.sessions : [],
    secrets: normalized.secrets as Record<string, unknown>,
  }
}

/** 读单个文件：不存在、不是 JSON、来自更新版本、结构无法识别都会返回可读的原因。 */
async function loadCandidate(path: string): Promise<{ file: SaveFile | null; issue: string | null; newer: boolean }> {
  let contents: string
  try {
    contents = await readFile(path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return { file: null, issue: code === 'ENOENT' ? null : '存档文件无法读取', newer: false }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch {
    return { file: null, issue: '存档文件不是合法 JSON', newer: false }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { file: null, issue: '存档根节点不是对象', newer: false }
  }
  const raw = parsed as Record<string, unknown>
  if (readVersion(raw) > SAVE_VERSION) {
    return { file: null, issue: `存档来自更新的程序版本（v${readVersion(raw)}），本次不会覆盖它`, newer: true }
  }
  try {
    return { file: migrateSave(raw), issue: null, newer: false }
  } catch {
    return { file: null, issue: '存档结构无法识别', newer: false }
  }
}

/** 读取存档：主文件不可用时回退到上一次的备份。 */
export async function readSaveFile(path: string): Promise<LoadedSave> {
  const primary = await loadCandidate(path)
  if (primary.file) return { file: primary.file, source: 'primary', issue: null, newer: false }
  const backup = await loadCandidate(`${path}.bak`)
  if (backup.file) {
    return {
      file: backup.file,
      source: 'backup',
      issue: `${primary.issue ?? '主存档不可用'}，已回退到上一份备份存档。`,
      newer: false,
    }
  }
  return { file: null, source: 'none', issue: primary.issue ?? backup.issue, newer: primary.newer }
}

/** 原子写：临时文件 + fsync + 改名，覆盖前先备份旧文件。 */
export async function writeSaveFile(path: string, file: SaveFile): Promise<void> {
  await writeJsonFile(path, file)
}

async function writeJsonFile(path: string, file: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  try {
    await copyFile(path, `${path}.bak`)
  } catch { /* 首次写入时还没有旧文件 */ }
  const temp = `${path}.tmp`
  const handle = await open(temp, 'w')
  try {
    await handle.writeFile(JSON.stringify(file), 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temp, path)
}

/** 退出时的同步版本：进程正在关闭，来不及等待事件循环。 */
export function writeSaveFileSync(path: string, file: SaveFile): void {
  writeJsonFileSync(path, file)
}

function writeJsonFileSync(path: string, file: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  try {
    copyFileSync(path, `${path}.bak`)
  } catch { /* 首次写入时还没有旧文件 */ }
  const temp = `${path}.tmp`
  const descriptor = openSync(temp, 'w')
  try {
    writeSync(descriptor, JSON.stringify(file))
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  renameSync(temp, path)
}

/** 读取案件档案；损坏时回退备份，缺失时由旧版 save.json 的 cases 字段迁移。 */
export async function readCaseArchive(path: string): Promise<unknown[] | null> {
  for (const candidate of [path, `${path}.bak`]) {
    try {
      const raw = JSON.parse(await readFile(candidate, 'utf8')) as { version?: unknown; cases?: unknown }
      if (raw?.version === 1 && Array.isArray(raw.cases)) return raw.cases
    } catch { /* 尝试下一份候选 */ }
  }
  return null
}

export async function writeCaseArchive(path: string, archive: CaseArchive): Promise<void> {
  await writeJsonFile(path, archive)
}

let targetFile: string | null = null
let autosaveEnabled = false
let timer: NodeJS.Timeout | null = null
let caseTimer: NodeJS.Timeout | null = null
let queue: Promise<void> = Promise.resolve()
let caseQueue: Promise<void> = Promise.resolve()
let casesDirty = false
let unsubscribers: Array<() => void> = []

function scheduleSave() {
  if (!targetFile || !autosaveEnabled) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void flushPersistence()
  }, SAVE_DEBOUNCE_MS)
  timer.unref?.()
}

function scheduleCaseArchive() {
  if (!targetFile || !autosaveEnabled) return
  casesDirty = true
  if (caseTimer) clearTimeout(caseTimer)
  caseTimer = setTimeout(() => {
    caseTimer = null
    void flushCaseArchive()
  }, SAVE_DEBOUNCE_MS)
  caseTimer.unref?.()
}

function flushCaseArchive(): Promise<void> {
  if (!targetFile || !autosaveEnabled) return Promise.resolve()
  if (!casesDirty) return caseQueue
  const path = caseArchivePath(targetFile)
  casesDirty = false
  caseQueue = caseQueue.then(() => writeCaseArchive(path, captureCaseArchive())).catch((error) => {
    casesDirty = true
    throw error
  })
  return caseQueue
}

/**
 * 把当前状态写盘。写盘失败不抛出：存档失败不能中断正在进行的审讯，
 * 但会把错误留在 rejected promise 里由调用方决定是否记录。
 */
export function flushPersistence(): Promise<void> {
  if (!targetFile || !autosaveEnabled) return Promise.resolve()
  const path = targetFile
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  // 新案件先落到独立档案，再写引用它的会话进度，避免中断后出现悬空会话。
  queue = queue.then(async () => {
    await flushCaseArchive()
    await writeSaveFile(path, captureSessionSaveFile())
  })
  return queue
}

/** 进程退出路径专用：同步落盘，避免事件循环已关闭导致最后一段进度丢失。 */
export function flushPersistenceSync(): void {
  if (!targetFile || !autosaveEnabled) return
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (caseTimer) { clearTimeout(caseTimer); caseTimer = null }
  if (casesDirty) {
    casesDirty = false
    writeJsonFileSync(caseArchivePath(targetFile), captureCaseArchive())
  }
  writeSaveFileSync(targetFile, captureSessionSaveFile())
}

/** 启动时读取存档并恢复内存状态；之后每次仓库变更都会触发节流自动存档。 */
export async function startPersistence(options: { file?: string } = {}): Promise<PersistenceStatus> {
  targetFile = options.file ?? defaultSaveFile()
  const loaded = await readSaveFile(targetFile)
  const archivedCases = await readCaseArchive(caseArchivePath(targetFile))
  let restoredCases = 0
  let restoredSessions = 0
  if (archivedCases) restoredCases = hydrateCases(archivedCases)
  else if (loaded.file) restoredCases = hydrateCases(loaded.file.cases)
  if (loaded.file) {
    restoredSessions = hydrateSessions({ sessions: loaded.file.sessions, secrets: loaded.file.secrets }).sessions
  }
  autosaveEnabled = !loaded.newer
  // 先恢复再订阅，避免恢复过程本身触发一次多余的写盘。
  unsubscribers = [onCasesChange(scheduleCaseArchive), onSessionsChange(scheduleSave)]
  // 首次升级时把旧版 save.json 中的案件正文迁移到独立档案。
  if (autosaveEnabled && !archivedCases && loaded.file?.cases.length) {
    casesDirty = true
    void flushCaseArchive()
  }
  return {
    file: targetFile,
    active: autosaveEnabled,
    restoredCases,
    restoredSessions,
    issue: loaded.issue,
  }
}

/** 停止自动存档并解除订阅（测试与热重载使用）。 */
export function stopPersistence() {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (caseTimer) {
    clearTimeout(caseTimer)
    caseTimer = null
  }
  for (const unsubscribe of unsubscribers) unsubscribe()
  unsubscribers = []
  targetFile = null
  autosaveEnabled = false
  casesDirty = false
}
