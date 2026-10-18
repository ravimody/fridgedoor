import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { apiFetch } from '../../api/client.js';
import { MorningDigest } from './MorningDigest.js';
vi.mock('../../api/client.js', () => ({ apiFetch: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it('saves the chosen time and opt-in with the server revision and explains missing phone enrollment', async () => {
  const status = { enabled: false, localTime: '07:00', timezone: 'America/New_York', revision: 2, available: true, devices: 0, lastDelivery: null };
  vi.mocked(apiFetch).mockResolvedValueOnce({ data: status }).mockResolvedValueOnce({ data: { ...status, enabled: true, localTime: '08:15', revision: 3 } });
  render(<MorningDigest />);
  fireEvent.click(await screen.findByLabelText('Send me a morning notification'));
  fireEvent.change(screen.getByLabelText('Morning time'), { target: { value: '08:15' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save morning settings' }));
  await waitFor(() => expect(screen.getByText('Morning notification saved for your account.')).toBeVisible());
  expect(JSON.parse(vi.mocked(apiFetch).mock.calls[1]![1]!.body as string)).toEqual({ enabled: true, localTime: '08:15', expectedRevision: 2 });
  expect(screen.getByText(/Enable notifications on this phone below/)).toBeVisible();
});
