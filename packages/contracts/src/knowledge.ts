import { z } from 'zod';

export const knowledgeProposalSchema = z.object({
  id: z.string().min(1).max(100), operation: z.enum(['add', 'update', 'archive', 'merge']),
  targetKeys: z.array(z.string().min(1).max(80)).min(1).max(3),
  baseRevisions: z.array(z.number().int().nonnegative()).max(3),
  proposedValue: z.string().max(500).nullable(), provenanceRefs: z.array(z.string().max(100)).max(12),
  reason: z.string().min(1).max(300), status: z.enum(['pending', 'accepted', 'dismissed', 'applied', 'expired']),
  createdAt: z.string().datetime(), expiresAt: z.string().datetime(),
}).strict();
export type KnowledgeProposal = z.infer<typeof knowledgeProposalSchema>;

export const knowledgeMaintenanceOutputSchema = z.object({
  proposals: z.array(z.object({
    operation: z.enum(['add', 'update', 'archive', 'merge']), targetKeys: z.array(z.string().min(1).max(80)).min(1).max(3),
    baseRevisions: z.array(z.number().int().nonnegative()).max(3), proposedValue: z.string().max(500).nullable(),
    provenanceRefs: z.array(z.string().max(100)).max(12), reason: z.string().min(1).max(300),
  }).strict()).max(5),
}).strict();
export type KnowledgeMaintenanceOutput = z.infer<typeof knowledgeMaintenanceOutputSchema>;
