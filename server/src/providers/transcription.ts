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
