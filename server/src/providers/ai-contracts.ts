import { z } from 'zod';
import { normalizedTimeSchema } from '@fridgedoor/contracts';

export const extractionResultSchema = z.object({
  decision: z.enum(['share_candidate', 'private', 'exclude']),
  category: z.enum(['school', 'travel', 'appointment', 'optional', 'work', 'medical', 'other']),
  confidence: z.number().min(0).max(1),
  uncertaintyReasons: z.array(z.string().max(200)).max(10),
  privacyFlags: z.array(z.enum(['explicit_private', 'medical', 'work', 'uncertain', 'incomplete'])).max(10),
  candidates: z.array(z.object({
    decision: z.enum(['share_candidate', 'private', 'exclude']), confidence: z.number().min(0).max(1), privacyFlags: z.array(z.string().max(100)).max(10),
    kind: z.enum(['event', 'deadline', 'todo', 'grocery']), relation: z.enum(['new', 'update', 'cancel']),
    safeFacts: z.object({ title: z.string().max(200), category: z.string().max(80), participants: z.array(z.string().max(80)).max(10), time: normalizedTimeSchema.optional(), location: z.string().max(500).optional(), notes: z.string().max(2000).optional(), preparationTasks: z.array(z.string().max(200)).max(20), unresolvedFields: z.array(z.string().max(80)).max(10) }).strict(),
    sourceEvidence: z.array(z.object({ field: z.string().max(80), kind: z.enum(['text', 'media']), textSpan: z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }).optional(), mediaPageRegion: z.object({ page: z.number().int().nonnegative(), x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().min(0).max(1), height: z.number().min(0).max(1) }).optional() }).strict()).max(20),
    attention: z.object({kind:z.enum(['coordination','decision','disruption']),reason:z.string().min(1).max(300),evidenceQuote:z.string().min(1).max(1000)}).strict().optional(),
    sourceTimeInterpretation: z.string().max(300).optional(), unresolvedFields: z.array(z.string().max(80)).max(10),
  }).strict()).max(20),
}).strict();
export type ExtractionResult = z.infer<typeof extractionResultSchema>;
export type ExtractionMedia = { kind: 'image' | 'pdf'; mimeType: 'image/png' | 'application/pdf'; dataBase64: string; pageCount?: number; width?: number; height?: number };
export type ExtractionKnowledge = { key: string; value: string; revision: number; provenance: 'legacy'|'user'|'source'|'maintenance'; confirmation: 'confirmed'|'unconfirmed'; validity: 'current'|'future'; validFrom: string | null; validUntil: string | null };
export type ExtractionPacket = { schemaVersion: string; sourceVersionId: string; sourceTime?: string; referenceTime?: string; nextMorningReview?: string; timezone: string; ownerLabel: string; allowedParticipants: string[]; allowedCategories: string[]; text: string; truncated: boolean; subject?: string; sender?: string; personalPreferences?: Array<{direction: 'prefer'|'avoid'|'uncertain'; pattern: string}>; knowledge?: ExtractionKnowledge[]; media?: ExtractionMedia[] };
export type AiUsage = { inputTokens?: number; outputTokens?: number; providerRequestId?: string; reasoningTokens?: number; stages?: Array<{model:string; inputTokens:number; outputTokens:number; reasoningTokens:number; providerRequestId:string}>; reviewReason?: string };
export type AiResponse = { result: ExtractionResult; usage: AiUsage; provider: string; model: string };
export type EmailGateCheckpoint = { reviewReason: string; usage: NonNullable<AiUsage['stages']>[number] };
export type EmailGateStore = { load(key: string): EmailGateCheckpoint | undefined; save(key: string, value: EmailGateCheckpoint): void };
export type AiProvider = { managesReservations?: boolean; extract(packet: ExtractionPacket, signal: AbortSignal, beforeAdditionalRequest?: (model: string) => void, checkpoints?: EmailGateStore): Promise<AiResponse>; respondToChat(packet: unknown, signal: AbortSignal): Promise<never> };
export const EXTRACTION_PROMPT_VERSION = 'extract-v7';
