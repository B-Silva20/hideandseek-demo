import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertCaseReady, caseReadinessIssues, parseCaseText, splitCaseText } from '../server/services/caseParser.js'

const playable = {
  playerRole: '调查员',
  characters: ['甲：目击者', '乙：相关人物'],
  relationships: ['甲与乙相识'],
  evidence: ['门口录像', '现场记录'],
  timeline: ['22:00 甲进入大楼', '22:15 乙离开现场'],
  truth: '甲隐瞒了关键行踪。',
  culprit: '甲',
}

test('case readiness accepts a case with people, evidence, timeline and a traceable culprit', () => {
  assert.deepEqual(caseReadinessIssues(playable), [])
  assert.deepEqual(assertCaseReady(playable), playable)
})

test('case readiness rejects cases that would enter interrogation without a solvable structure', () => {
  const issues = caseReadinessIssues({
    ...playable,
    characters: ['甲：目击者'],
    evidence: ['门口录像'],
    timeline: ['22:00 甲进入大楼'],
    truth: '未知',
    culprit: '不存在的人',
  })
  assert.deepEqual(issues, [
    '至少需要两名可审讯人物',
    '至少需要两条可核对证据',
    '至少需要两个明确的时间线节点',
    '材料未能提取出可核对的案件真相',
    '凶手姓名必须对应人物列表中的一人',
  ])
  assert.throws(() => assertCaseReady({ ...playable, characters: ['甲：目击者'] }), /至少需要两名可审讯人物/)
})

test('case parser keeps only well-formed, character-scoped facts with valid evidence gates', async () => {
  const response = new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
    ...playable,
    facts: [
      { factId: 'alibi', text: '甲称自己当晚在门口值班。', holders: ['甲'], revealAfter: 'initial' },
      { factId: 'camera', text: '甲看到录像后改口说曾进入大楼。', holders: ['甲'], revealAfter: 'evidence', evidenceTitle: '门口录像' },
      { factId: 'bad-holder', text: '不会被采用。', holders: ['不存在'], revealAfter: 'initial' },
      { factId: 'bad-evidence', text: '不会被采用。', holders: ['乙'], revealAfter: 'evidence', evidenceTitle: '不存在的证据' },
    ],
  }) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  const parsed = await parseCaseText('测试案件原文', {
    LLM_BASE_URL: 'https://example.com/v1', LLM_API_KEY: 'test-key', LLM_MODEL: 'test-model',
  }, async () => response)

  assert.deepEqual(parsed.facts, [
    { factId: 'alibi', text: '甲称自己当晚在门口值班。', holders: ['甲'], revealAfter: 'initial' },
    { factId: 'camera', text: '甲看到录像后改口说曾进入大楼。', holders: ['甲'], revealAfter: 'evidence', evidenceTitle: '门口录像' },
  ])
})

test('large cases split at a readable boundary and report completed chunks before merging', async () => {
  const source = `${'甲乙在案发前讨论行踪。\n'.repeat(8_000)}\n${'丙发现现场记录。\n'.repeat(2_000)}`
  const shortChunks = splitCaseText(source.slice(0, 500), 160)
  const chunks = splitCaseText(source)
  assert.ok(shortChunks.length > 1)
  assert.ok(shortChunks.every((chunk) => chunk.length <= 180))
  const progress: string[] = []
  let calls = 0
  const parsed = await parseCaseText(source, {
    LLM_BASE_URL: 'https://example.com/v1', LLM_API_KEY: 'test-key', LLM_MODEL: 'test-model',
  }, async () => {
    calls += 1
    const content = calls <= chunks.length
      ? JSON.stringify({ characters: ['甲'], relationships: [], evidence: [], timeline: [], events: [], unresolved: [] })
      : JSON.stringify(playable)
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }), { status: 200 })
  }, { onProgress: (entry) => progress.push(`${entry.phase}:${entry.completedChunks}/${entry.totalChunks}`) })
  assert.equal(calls, chunks.length + 1)
  assert.equal(parsed.culprit, '甲')
  assert.ok(progress.includes(`extracting:${chunks.length}/${chunks.length}`))
  assert.equal(progress.at(-1), `merging:${chunks.length}/${chunks.length}`)
})
