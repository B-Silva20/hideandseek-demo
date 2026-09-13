import { randomUUID } from 'node:crypto'
import { findCase } from './caseStore.js'

export interface EvidenceState { id:string; name:string; description:string; trustDelta:number; hostilityDelta:number; unlockTopics:string[]; lieSuspects:string[] }
export interface Testimony { suspectId:string; topicId:string; claim:string; normalizedValue:string }
export interface ContradictionRecord { contradictionId:string; topicId:string; suspectA:string; suspectB:string; testimonyA:Testimony; testimonyB:Testimony; description:string; confronted:boolean }
export interface ConfrontationRecord { contradictionId:string; reaction:string; createdAt:string }
export type Ending = 'perfect_case' | 'wrong_arrest' | 'killer_escapes'
export interface SessionState { sessionId:string; caseId:string; currentSubject:string|null; history: Array<{role:'user'|'npc'; content:string}>; trust:Record<string,number>; hostility:Record<string,number>; unlockedEvidence:string[]; presentedEvidence:string[]; evidenceCatalog:Record<string, EvidenceState>; testimonies:Testimony[]; contradictionRecords:ContradictionRecord[]; confrontations:ConfrontationRecord[]; unlockedTopics:string[]; contradictions:string[]; actionPoints:number; actionLog:string[]; gameState:'active'|'ended'; ending:Ending|null; killerSuspectId?:string; keyEvidenceIds?:string[]; suspectIds?:string[]; endingReason?:string }
const sessions = new Map<string, SessionState>()
export const TRUST_TERMINATION_THRESHOLD = 20

function inferKiller(record: ReturnType<typeof findCase>, names: string[]): string | undefined {
  const truth = record?.parsed?.truth || ''
  if (record?.sourceType === 'preset') return names.length > 1 ? 'person-2' : names[0] ? 'person-1' : undefined
  const candidate = names.find((name) => truth.includes(name) && /(凶手|杀人|作案|真相|killer|murderer)/i.test(truth))
  if (candidate) return `person-${names.indexOf(candidate) + 1}`
  const idMatch = truth.match(/person[-_ ]?(\d+)/i)
  return idMatch ? `person-${idMatch[1]}` : undefined
}

export function resolveSuspectId(session: SessionState, suspectId: string): string | undefined {
  if (session.trust[suspectId] !== undefined) return suspectId
  const index = /^person-(\d+)$/.exec(suspectId)?.[1]
  if (index) {
    const name = Object.keys(session.trust)[Number(index) - 1]
    if (name) return name
  }
  return undefined
}

/** Evaluate and persist the final outcome. Calling this repeatedly is idempotent. */
export function evaluateEnding(session: SessionState, suspectId?: string, reason?: string): Ending | null {
  if (session.gameState === 'ended' && session.ending) return session.ending
  const normalizedName = suspectId && resolveSuspectId(session, suspectId)
  const normalized = normalizedName ? `person-${Object.keys(session.trust).indexOf(normalizedName) + 1}` : undefined
  const keyEvidence = (session.keyEvidenceIds ?? []).some((id) => session.presentedEvidence.includes(id))
  const contradictions = session.contradictions.length
  const killerKnown = Boolean(session.killerSuspectId)
  if (normalized && killerKnown && normalized === session.killerSuspectId && keyEvidence && contradictions >= 2) {
    session.ending = 'perfect_case'; session.endingReason = '正确指认凶手，出示关键证据并发现至少两个矛盾。'
  } else if (normalized && killerKnown && normalized !== session.killerSuspectId) {
    session.ending = 'wrong_arrest'; session.endingReason = '指认了错误的嫌疑人。'
  } else if (session.actionPoints <= 0 || reason === 'trust_low' || reason === 'insufficient_evidence' || (normalized && !killerKnown)) {
    session.ending = 'killer_escapes'; session.endingReason = reason === 'trust_low' ? '信任值过低，审讯被终止。' : reason === 'insufficient_evidence' ? '在证据不足时结束调查。' : '行动点耗尽，仍未能正确指认。'
  } else return null
  session.gameState = 'ended'
  return session.ending
}

export function createSession(caseId: unknown) {
  const record = findCase(caseId); if (!record) return null
  const characters = record.briefing?.characters ?? (record.parsed?.characters ?? []).map((value) => {
    const [name, ...rest] = value.split(/[：:]/u)
    return { name: name.trim(), publicIdentity: rest.join('：').trim() || '相关人物' }
  })
  const names = characters.map((person) => person.name)
  const trust: Record<string,number> = {}; const hostility: Record<string,number> = {}
  for (const person of characters) { trust[person.name] = 50; hostility[person.name] = 0 }
  const visibleEvidence = record.briefing?.visibleEvidence ?? record.parsed?.evidence?.slice(0, 5) ?? []
  const evidenceCatalog: Record<string, EvidenceState> = Object.fromEntries(visibleEvidence.map((name, index) => {
    const id = `evidence-${index + 1}`
    const lieSuspects = index === 0 && characters[0] ? [characters[0].name] : []
    return [id, { id, name, description: `与“${name}”有关的案件材料`, trustDelta: index === 0 ? 8 : 3, hostilityDelta: index === 0 ? 6 : 1, unlockTopics: [`topic-${index + 1}`], lieSuspects }]
  }))
  const session: SessionState = { sessionId:`session_${randomUUID()}`, caseId:record.caseId, currentSubject:null, history:[], trust, hostility, unlockedEvidence:Object.keys(evidenceCatalog), presentedEvidence:[], evidenceCatalog, testimonies:[], contradictionRecords:[], confrontations:[], unlockedTopics:[], contradictions:[], actionPoints:20, actionLog:[], killerSuspectId: inferKiller(record, names), keyEvidenceIds: Object.keys(evidenceCatalog).slice(0, 1), suspectIds: names.map((_, i) => `person-${i + 1}`), gameState:'active', ending:null }
  sessions.set(session.sessionId, session); return session
}
export function getSession(id: unknown) { return typeof id === 'string' ? sessions.get(id) : undefined }
export function updateSession(session: SessionState) { sessions.set(session.sessionId, session); return session }
