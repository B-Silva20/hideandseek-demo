import { randomUUID } from 'node:crypto'
import { findCase } from './caseStore.js'

export interface EvidenceState { id:string; name:string; description:string; trustDelta:number; hostilityDelta:number; unlockTopics:string[]; lieSuspects:string[] }
export interface SessionState { sessionId:string; caseId:string; currentSubject:string|null; history: Array<{role:'user'|'npc'; content:string}>; trust:Record<string,number>; hostility:Record<string,number>; unlockedEvidence:string[]; presentedEvidence:string[]; evidenceCatalog:Record<string, EvidenceState>; unlockedTopics:string[]; contradictions:string[]; actionPoints:number; actionLog:string[]; gameState:'active'|'ended'; ending:null|string }
const sessions = new Map<string, SessionState>()
export function createSession(caseId: unknown) {
  const record = findCase(caseId); if (!record) return null
  const characters = record.briefing?.characters ?? []
  const trust: Record<string,number> = {}; const hostility: Record<string,number> = {}
  for (const person of characters) { trust[person.name] = 50; hostility[person.name] = 0 }
  const visibleEvidence = record.briefing?.visibleEvidence ?? []
  const evidenceCatalog: Record<string, EvidenceState> = Object.fromEntries(visibleEvidence.map((name, index) => {
    const id = `evidence-${index + 1}`
    const lieSuspects = index === 0 && characters[0] ? [characters[0].name] : []
    return [id, { id, name, description: `与“${name}”有关的案件材料`, trustDelta: index === 0 ? 8 : 3, hostilityDelta: index === 0 ? 6 : 1, unlockTopics: [`topic-${index + 1}`], lieSuspects }]
  }))
  const session: SessionState = { sessionId:`session_${randomUUID()}`, caseId:record.caseId, currentSubject:null, history:[], trust, hostility, unlockedEvidence:Object.keys(evidenceCatalog), presentedEvidence:[], evidenceCatalog, unlockedTopics:[], contradictions:[], actionPoints:20, actionLog:[], gameState:'active', ending:null }
  sessions.set(session.sessionId, session); return session
}
export function getSession(id: unknown) { return typeof id === 'string' ? sessions.get(id) : undefined }

export function updateSession(session: SessionState) { sessions.set(session.sessionId, session); return session }
