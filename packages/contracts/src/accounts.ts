import { z } from 'zod';

// Built-in accounts: first-run setup, sign-in, invites, household management and owner settings.
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 200;

export const authStatusSchema = z.object({ data: z.object({ setupRequired: z.boolean(), accessMode: z.boolean(), publicUrl: z.string() }) });
export const inviteInfoSchema = z.object({ data: z.object({ householdName: z.string(), invitedBy: z.string() }) });
export type AuthStatus = z.infer<typeof authStatusSchema>['data'];
export type InviteInfo = z.infer<typeof inviteInfoSchema>['data'];

export type ProfileInput = { displayName: string; email: string; password: string; timezone: string };
export type SetupInput = ProfileInput & { token: string; householdName: string };
export type LoginInput = { email: string; password: string };

export type HouseholdRole = 'owner' | 'member';
export type HouseholdMember = { id: string; displayName: string; active: boolean; role: HouseholdRole; email?: string };
export type HouseholdInvite = { id: string; createdAt: string; expiresAt: string };
export type HouseholdDetails = { name: string; canManage: boolean; members: HouseholdMember[]; invites: HouseholdInvite[] };
export type CreatedInvite = { id: string; url: string; expiresAt: string };
export type PhonePairing = { link: string; qrSvg: string; expiresAt: string };

export type AiModels = { main?: string; email?: string; review?: string; transcribe?: string };
export type AiProviderPreset = { id: string; label: string; kind: string; baseUrl: string | null; needsApiKey: boolean; keyUrl: string | null; suggested: { main?: string; email?: string }; note: string | null };
export type AiCurrentSettings = { provider: string; baseUrl: string | null; structuredOutput: string | null; models: AiModels; hasApiKey: boolean };
export type AiAdminSettings = { managedByEnvironment: boolean; presets: AiProviderPreset[]; current: AiCurrentSettings | null };
/** Body for PUT /admin/ai and POST /admin/ai/test. A missing apiKey keeps the saved key for the same provider. */
export type AiSettingsInput = { provider: string; apiKey?: string; keepApiKey?: boolean; baseUrl?: string; structuredOutput?: string; models: AiModels };
export type AiTestResult = { ok: boolean; models: string[]; model?: string; error?: string };

export type ServerSettings = { publicUrl: string; publicUrlFromEnvironment: boolean; google: { configured: boolean; fromEnvironment: boolean; redirectUri: string } };
export type ServerSettingsInput = { publicUrl?: string; google?: { clientId: string; clientSecret: string } | null };
