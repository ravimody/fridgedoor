import { useEffect, type ReactNode, type RefObject } from 'react';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@fridgedoor/contracts';

const messages: Record<string, string> = {
  SIGN_IN_FAILED: 'That email and password don’t match an account here. Check them and try again.',
  TOO_MANY_ATTEMPTS: 'Too many tries in a short time. Wait 15 minutes, then try again.',
  EMAIL_IN_USE: 'That email already has an account here. Sign in instead, or use a different email.',
  SETUP_ALREADY_DONE: 'This household is already set up. Sign in instead.',
  ALREADY_MEMBER: 'You’re already in this household. Open Fridgedoor to see it.',
  MEMBER_REMOVED: 'You were removed from this household. Ask whoever runs it to restore you in Settings → Household.',
  UNAUTHENTICATED: 'Sign in on your household’s sign-in page first, then open the invite link again.',
  INVITE_INVALID: 'This invite link has expired or was already used. Ask for a new one.',
  PASSWORD_INCORRECT: 'Your current password isn’t right. Try again.',
  VALIDATION: 'Some details weren’t accepted. Check each field and try again.',
  AUTH_REQUIRED: 'Your sign-in expired. Reload the page to sign in again.',
  NETWORK: 'Couldn’t reach Fridgedoor. Check your connection and try again.',
};

/** Plain-language text for an error thrown by the API client. */
export function errorMessage(error: unknown, overrides: Record<string, string> = {}): string {
  const code = error instanceof TypeError ? 'NETWORK' : error instanceof Error ? error.message : '';
  return overrides[code] ?? messages[code] ?? 'Something went wrong. Try again.';
}

export function FormError({ message }: { message: string }) {
  return message ? <p role="alert" className="form-error">{message}</p> : null;
}

/**
 * Moves focus to the first field (or button) inside `ref` whenever `key` changes, e.g. on each wizard step,
 * or to `fallback` (usually the heading) while there is nothing to fill in yet.
 */
export function useFocusFirst(ref: RefObject<HTMLElement | null>, key: unknown, fallback?: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const field = ref.current?.querySelector<HTMLElement>('input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])');
    (field ?? fallback?.current)?.focus();
  }, [ref, key, fallback]);
}

export const deviceTimezone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };
function timezones(current: string): string[] {
  const supported = (Intl as { supportedValuesOf?: (key: 'timeZone') => string[] }).supportedValuesOf?.('timeZone') ?? [];
  return supported.includes(current) ? supported : [current, ...supported];
}

export function TimezoneSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const options = timezones(value);
  return <label>Time zone<select value={value} onChange={(event) => onChange(event.target.value)}>{options.map((zone) => <option key={zone} value={zone}>{zone.replaceAll('_', ' ')}</option>)}</select></label>;
}

export function passwordProblem(password: string, confirm: string): string | undefined {
  if (password.length < PASSWORD_MIN_LENGTH) return `Choose a password with at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (password.length > PASSWORD_MAX_LENGTH) return `Choose a password with at most ${PASSWORD_MAX_LENGTH} characters.`;
  if (password !== confirm) return 'The two passwords don’t match.';
  return undefined;
}

export type Profile = { displayName: string; email: string; password: string; confirm: string; timezone: string };
export const emptyProfile = (): Profile => ({ displayName: '', email: '', password: '', confirm: '', timezone: deviceTimezone() });

export function profileProblem(profile: Profile): string | undefined {
  if (!profile.displayName.trim()) return 'Add your name.';
  if (!/^\S+@\S+\.\S+$/.test(profile.email.trim())) return 'Add an email address, like name@example.com.';
  return passwordProblem(profile.password, profile.confirm);
}
export const profileBody = (profile: Profile) => ({ displayName: profile.displayName.trim(), email: profile.email.trim(), password: profile.password, timezone: profile.timezone });

/** Name, email, password and time zone: the same fields when creating a household or joining one. */
export function ProfileFields({ value, onChange }: { value: Profile; onChange: (value: Profile) => void }) {
  const set = (field: keyof Profile) => (event: { target: { value: string } }) => onChange({ ...value, [field]: event.target.value });
  return <>
    <label>Your name<input name="name" autoComplete="name" value={value.displayName} onChange={set('displayName')} maxLength={80} required /></label>
    <label>Email<input name="email" type="email" autoComplete="email" inputMode="email" value={value.email} onChange={set('email')} maxLength={254} required /></label>
    <label>Password<input name="new-password" type="password" autoComplete="new-password" value={value.password} onChange={set('password')} minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} aria-describedby="password-hint" required /></label>
    <p id="password-hint" className="field-hint">At least {PASSWORD_MIN_LENGTH} characters. A short sentence is easy to remember.</p>
    <label>Confirm password<input name="confirm-password" type="password" autoComplete="new-password" value={value.confirm} onChange={set('confirm')} maxLength={PASSWORD_MAX_LENGTH} required /></label>
    <TimezoneSelect value={value.timezone} onChange={(timezone) => onChange({ ...value, timezone })} />
  </>;
}

/** Wraps sign-in screens: a narrow card under the product name. */
export function AuthPage({ eyebrow = 'Fridgedoor', title, children }: { eyebrow?: string; title: string; children: ReactNode }) {
  return <main className="page auth-page"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1>{children}</main>;
}
