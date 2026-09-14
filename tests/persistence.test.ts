import assert from 'node:assert/strict'
import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { createCase, findCase, hydrateCases, updateCase } from '../server/services/caseStore.js'
import { createSession, getCaseSecret, getSession, hydrateSessions, updateSession } from '../server/services/sessionStore.js'
import { SAVE_VERSION, captureSaveFile, caseArchivePath, migrateSave, readCaseArchive, readSaveFile, writeCaseArchive, writeSaveFile } from '../server/services/persistence.js'

/*
 * 存档测试围绕 save-systems 的三条硬要求：
 *   原子写（临时文件 + 改名）、损坏时回退备份、版本迁移与防御性校验。
 * 全部写进系统临时目录，不碰项目里的 .data/。
 */

async function tempSavePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'interrogation-save-'))
  return join(directory, 'save.json')
}

function saveFile(caseId: string, savedAt = '2026-01-01T00:00:00.000Z') {
  return { version: SAVE_VERSION, savedAt, cases: [{ caseId }], sessions: [], secrets: {} }
}

test('a save file round-trips and leaves no temp file behind', async () => {
  const path = await tempSavePath()
  const file = saveFile('case_1')
  await writeSaveFile(path, file)

  const loaded = await readSaveFile(path)
  assert.equal(loaded.source, 'primary')
  assert.equal(loaded.issue, null)
  assert.deepEqual(loaded.file, file)

  const entries = await readdir(dirname(path))
  assert.deepEqual(entries.filter((name) => name.endsWith('.tmp')), [])
})

test('case archives keep large case data outside the per-turn save file', async () => {
  const path = await tempSavePath()
  const archivePath = caseArchivePath(path)
  await writeCaseArchive(archivePath, { version: 1, cases: [{ caseId: 'case_1', sourceText: '案件原文'.repeat(1000) }] })
  assert.deepEqual(await readCaseArchive(archivePath), [{ caseId: 'case_1', sourceText: '案件原文'.repeat(1000) }])

  await writeSaveFile(path, { version: SAVE_VERSION, savedAt: '2026-01-01T00:00:00.000Z', cases: [], sessions: [{ sessionId: 'session_1' }], secrets: {} })
  const sessionFile = await readSaveFile(path)
  assert.ok(sessionFile.file)
  assert.deepEqual(sessionFile.file.cases, [])
})

test('a corrupted save falls back to the previous backup', async () => {
  const path = await tempSavePath()
  await writeSaveFile(path, saveFile('case_first'))
  await writeSaveFile(path, saveFile('case_second', '2026-02-02T00:00:00.000Z'))
  // 第二次写入前留的备份是第一次的内容，所以主文件损坏后应当回退到 case_first。
  await writeFile(path, '{ 这不是合法 JSON', 'utf8')

  const loaded = await readSaveFile(path)
  assert.equal(loaded.source, 'backup')
  assert.match(loaded.issue ?? '', /回退到上一份备份/)
  assert.ok(loaded.file)
  assert.equal((loaded.file.cases[0] as { caseId: string }).caseId, 'case_first')
})

test('an unversioned save is migrated up to the current version', () => {
  const migrated = migrateSave({ cases: [{ caseId: 'case_1' }] })
  assert.equal(migrated.version, SAVE_VERSION)
  assert.equal(migrated.cases.length, 1)
  assert.deepEqual(migrated.sessions, [])
  assert.deepEqual(migrated.secrets, {})
})

test('migration refuses a save from a newer build, and reading it disables autosave', async () => {
  assert.throws(() => migrateSave({ version: SAVE_VERSION + 1 }), /高于/)
  assert.throws(() => migrateSave('nope'), /对象/)
  assert.throws(() => migrateSave([1, 2, 3]), /对象/)

  const path = await tempSavePath()
  await writeFile(path, JSON.stringify({ version: SAVE_VERSION + 1, cases: [], sessions: [], secrets: {} }), 'utf8')
  const loaded = await readSaveFile(path)
  assert.equal(loaded.file, null)
  // newer 为真时调用方会停用自动存档，避免覆盖玩家用新版本写下的存档。
  assert.equal(loaded.newer, true)
  assert.match(loaded.issue ?? '', /更新的程序版本/)
})

test('captureSaveFile stamps the current version', () => {
  const captured = captureSaveFile()
  assert.equal(captured.version, SAVE_VERSION)
  assert.ok(Array.isArray(captured.cases))
  assert.ok(Array.isArray(captured.sessions))
  assert.ok(Object.prototype.toString.call(captured.secrets) === '[object Object]')
  assert.equal(Number.isNaN(Date.parse(captured.savedAt)), false)
})

test('cases, sessions, narrative variables and secrets survive snapshot then hydrate', () => {
  const created = createCase({ sourceType: 'paste', sourceText: '案件文本。'.repeat(50), title: '存档测试案件' })
  assert.equal(created.ok, true)
  if (!created.ok) return
  updateCase(created.record.caseId, {
    status: 'ready',
    message: '案件解析完成。',
    parsed: {
      playerRole: '调查人员',
      characters: ['甲：证人'],
      relationships: [],
      evidence: ['现场记录'],
      timeline: ['案发当晚。'],
      truth: '甲隐瞒了事实。',
      culprit: '甲',
    },
  })
  const session = createSession(created.record.caseId)
  assert.ok(session)
  session.variables['use:甲:routine'] = 2
  session.variables['asked:甲:1'] = 1
  updateSession(session)

  const snapshot = captureSaveFile()
  assert.ok(snapshot.cases.length >= 1)
  assert.ok(snapshot.sessions.length >= 1)
  assert.ok(Object.keys(snapshot.secrets).length >= 1)

  // 恢复是幂等的：同一个 caseId / sessionId 会被覆盖写回，而不是重复插入。
  assert.ok(hydrateCases(snapshot.cases) >= 1)
  const restored = hydrateSessions({ sessions: snapshot.sessions, secrets: snapshot.secrets })
  assert.ok(restored.sessions >= 1)

  assert.ok(findCase(created.record.caseId))
  const reloaded = getSession(session.sessionId)
  assert.ok(reloaded)
  assert.equal(reloaded.variables['use:甲:routine'], 2)
  assert.equal(reloaded.variables['asked:甲:1'], 1)
  assert.ok(getCaseSecret(session.sessionId))
})

test('structurally broken entries are dropped instead of voiding the whole save', () => {
  assert.equal(hydrateCases([{ caseId: 'case_missing_text', sourceType: 'paste' }, 'not-an-object', null, 42]), 0)
  // 空正文且没有 Briefing 的案件无法进入审讯，同样丢弃。
  assert.equal(hydrateCases([{ caseId: 'case_1', sourceType: 'paste', sourceText: '' }]), 0)
  // 会话引用了不存在的案件，或是没有人物情绪表时丢弃。
  assert.equal(hydrateSessions({ sessions: [{ sessionId: 'session_1', caseId: 'case_nope', trust: { 甲: 50 } }], secrets: {} }).sessions, 0)
  assert.equal(hydrateSessions({ sessions: [{ sessionId: 'session_2', caseId: 'case_nope', trust: {} }], secrets: {} }).sessions, 0)
  // 传入完全不是对象时也不能抛错。
  assert.equal(hydrateCases(undefined), 0)
  assert.deepEqual(hydrateSessions(null), { sessions: 0, secrets: 0 })
})
