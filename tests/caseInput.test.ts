import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodeCaseBytes, prepareCaseInput, readCaseFile, MAX_FILE_BYTES } from '../src/engine/caseInput.ts'

const story = '调查员来到现场，发现证人描述的时间与门口录像不符。'.repeat(6)
test('all sources produce normalized text with the correct sourceType', () => {
  for (const sourceType of ['preset', 'text', 'txt'] as const) {
    assert.deepEqual(prepareCaseInput(`\uFEFF \r\n${story}\r\n `, sourceType), { text: story, sourceType })
  }
})
test('reject empty, short, symbolic, binary, corrupt and oversized content', () => {
  for (const text of [' \n\t', '案件', '！'.repeat(100), story + '\0', story + '\uFFFD', '案'.repeat(200001)]) {
    assert.throws(() => prepareCaseInput(text, 'text'))
  }
  assert.equal(prepareCaseInput('案'.repeat(100), 'text').text.length, 100)
  assert.equal(prepareCaseInput('案'.repeat(200000), 'text').text.length, 200000)
})
test('UTF-8, BOM, GBK and four-byte GB18030 decode correctly', () => {
  assert.equal(decodeCaseBytes(new TextEncoder().encode('\uFEFF案件调查').buffer).text, '案件调查')
  const gbk = Uint8Array.from([0xb0, 0xb8, 0xbc, 0xfe]).buffer
  assert.deepEqual(decodeCaseBytes(gbk), { text: '案件', encoding: 'gb18030' })
  assert.equal(decodeCaseBytes(Uint8Array.from([0x90, 0x30, 0x81, 0x30]).buffer).text, '\u{10000}')
  assert.throws(() => decodeCaseBytes(gbk, 'utf-8'))
  assert.throws(() => decodeCaseBytes(Uint8Array.from([0xff, 0xff]).buffer))
  assert.throws(() => decodeCaseBytes(new ArrayBuffer(0)))
  assert.throws(() => decodeCaseBytes(new ArrayBuffer(MAX_FILE_BYTES + 1)))
})
test('TXT reads, extension checks, empty files and file IO failures', async () => {
  const result = await readCaseFile(new File([story], '案件.TXT'))
  assert.deepEqual(result.input, { text: story, sourceType: 'txt' })
  await assert.rejects(readCaseFile(new File([story], 'case.pdf')), /\.txt/)
  await assert.rejects(readCaseFile(new File([], 'empty.txt')), /为空/)
  await assert.rejects(readCaseFile(new File([new Uint8Array(MAX_FILE_BYTES + 1)], 'large.txt')), /5 MB/)
  const unreadable = new File([story], 'unreadable.txt')
  unreadable.arrayBuffer = async () => { throw new Error('IO failure') }
  await assert.rejects(readCaseFile(unreadable), /文件读取失败/)
})
