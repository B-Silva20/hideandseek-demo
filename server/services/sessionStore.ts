import { randomUUID } from 'node:crypto'
import { findCase } from './caseStore.js'

export interface SessionState { sessionId:string; caseId:string; currentSubject:string|null; history: Array<{role:'user'|'npc'; content:string}>; trust:Record<string,number>; hostility:Record<string,number>; unlockedEvidence:string[]; presentedEvidence:string[]; contradictions:string[]; actionPoints:number; actionLog:string[]; gameState:'active'|'ended'; ending:null|string }
const sessions = new Map<string, SessionState>()
export function createSession(caseId: unknown) {
  const record = findCase(caseId); if (!record) return null
  const characters = record.briefing?.characters ?? []
  const trust: Record<string,number> = {}; const hostility: Record<string,number> = {}
  for (const person of characters) { trust[person.name] = 50; hostility[person.name] = 0 }
  const session: SessionState = { sessionId:`session_${randomUUID()}`, caseId:record.caseId, currentSubject:null, history:[], trust, hostility, unlockedEvidence:record.briefing?.visibleEvidence ?? [], presentedEvidence:[], contradictions:[], actionPoints:20, actionLog:[], gameState:'active', ending:null }
  sessions.set(session.sessionId, session); return session
}
export function getSession(id: unknown) { return typeof id === 'string' ? sessions.get(id) : undefined }

export function updateSession(session: SessionState) { sessions.set(session.sessionId, session); return session }
