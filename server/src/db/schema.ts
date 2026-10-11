export const tables = ['households', 'members', 'browser_sessions'] as const;
export type TableName = (typeof tables)[number];
