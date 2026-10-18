import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { apiFetch } from '../../api/client.js';
import { EmailPrivacy } from './EmailPrivacy.js';
vi.mock('../../api/client.js', () => ({ apiFetch: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const policy = { excludedSenders: [], excludedLabels: ['Receipts'], genericAppointmentOptIn: false, revision: 3 };

it('keeps commas and spaces while typing and saves the split lists', async () => {
  vi.mocked(apiFetch).mockImplementation(async (_path, init) => ({ data: init?.method === 'PUT' ? { ...policy, ...JSON.parse(init.body as string), revision: 4 } : policy }));
  render(<EmailPrivacy />);
  const labels = screen.getByLabelText('Excluded labels');
  await waitFor(() => expect(labels).toHaveValue('Receipts'));
  const senders = screen.getByLabelText('Excluded senders');
  await userEvent.type(senders, 'a@example.com, c@example.org');
  expect(senders).toHaveValue('a@example.com, c@example.org');
  await userEvent.type(labels, ', Work ');
  await userEvent.click(screen.getByRole('button', { name: 'Save source preferences' }));
  expect(await screen.findByText('Source preferences saved.')).toBeVisible();
  const body = JSON.parse(vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'PUT')![1]!.body as string);
  expect(body).toMatchObject({ excludedSenders: ['a@example.com', 'c@example.org'], excludedLabels: ['Receipts', 'Work'], expectedRevision: 3 });
  expect(senders).toHaveValue('a@example.com, c@example.org');
});

it('explains a load failure plainly', async () => {
  vi.mocked(apiFetch).mockRejectedValue(new Error('API_500'));
  render(<EmailPrivacy />);
  expect(await screen.findByRole('status')).toHaveTextContent('Could not load your email privacy settings. Reload to try again.');
});
