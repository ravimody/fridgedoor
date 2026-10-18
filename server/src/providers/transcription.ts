import type Database from 'better-sqlite3';
import type { LlmHub } from '../llm/hub.js';
const extensions: Record<string, string> = { 'audio/webm': 'webm', 'audio/mp4': 'mp4', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/mpeg': 'mp3' };
export const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
/** The configured transcription model, when the provider offers speech-to-text. */
function transcriber(hub: LlmHub) {
  let resolved;
  try { resolved = hub.resolve('transcribe'); } catch { return undefined; }
  return resolved?.provider.capabilities.transcription && resolved.provider.transcribe ? resolved : undefined;
}
export function canTranscribe(hub: LlmHub) { return Boolean(transcriber(hub)); }
export async function transcribe(file: File, hub: LlmHub, signal: AbortSignal = AbortSignal.timeout(45_000)) {
  const extension = extensions[file.type.split(';')[0]!];
  if (!extension || !file.size || file.size > MAX_AUDIO_BYTES) throw new Error('INVALID_AUDIO');
  const target = transcriber(hub);
  if (!target) throw new Error('TRANSCRIPTION_UNAVAILABLE');
  // Provider errors can echo the request; expose only a stable code.
  try { return await target.provider.transcribe!(file, target.model, signal); } catch { throw new Error('TRANSCRIPTION_FAILED'); }
}

/** Voice requests per member per hour. Attempts are stored, so restarting the server doesn't reset the count. */
export const TRANSCRIPTIONS_PER_HOUR = 30;
export class TranscriptionLimiter {
  constructor(private readonly db: Database.Database, private readonly clock: () => Date = () => new Date()) {}
  /** Records an attempt and returns true, or returns false once the member has used this hour's allowance. */
  allow(memberId: string) {
    return this.db.transaction(() => {
      const now = this.clock();
      const used = this.db.prepare('SELECT count(*) AS count FROM transcription_attempts WHERE member_id = ? AND attempted_at > ?').get(memberId, new Date(now.getTime() - 3600_000).toISOString()) as { count: number };
      if (used.count >= TRANSCRIPTIONS_PER_HOUR) return false;
      this.db.prepare('INSERT INTO transcription_attempts (member_id, attempted_at) VALUES (?, ?)').run(memberId, now.toISOString());
      return true;
    })();
  }
}
