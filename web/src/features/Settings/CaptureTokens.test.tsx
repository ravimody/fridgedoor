import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { apiFetch } from '../../api/client.js';
import { CaptureTokens } from './CaptureTokens.js';
vi.mock('../../api/client.js', () => ({ apiFetch: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetAllMocks(); });

it('copies the one-time token explicitly, explains the API, and removes it after revocation', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  vi.mocked(apiFetch).mockImplementation(async (_path, init) => ({ data: init?.method === 'POST' ? { id: 'fixture', label: 'Automation', token: 'synthetic-capture-token' } : { credentials: [] } }));
  render(<CaptureTokens />);
  fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
  const copy = await screen.findByRole('button', { name: 'Copy token' });
  expect(screen.queryByRole('link', { name: /download/i })).not.toBeInTheDocument();
  expect(writeText).not.toHaveBeenCalled();
  fireEvent.click(copy);
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('synthetic-capture-token'));
  fireEvent.click(screen.getByText('How to send items'));
  expect(screen.getByLabelText('Capture address')).toHaveValue(`${window.location.origin}/capture/v1/items`);
  expect(screen.getByText(/Items appear on Home for review/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Revoke token' }));
  await screen.findByText(/Token revoked/);
  expect(screen.queryByDisplayValue('synthetic-capture-token')).not.toBeInTheDocument();
});

it('keeps the token available for manual copy when clipboard permission fails', async () => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
  vi.mocked(apiFetch).mockImplementation(async (_path, init) => ({ data: init?.method === 'POST' ? { id: 'fixture', label: 'Automation', token: 'synthetic-capture-token' } : { credentials: [] } }));
  render(<CaptureTokens />);
  fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Copy token' }));
  await screen.findByText(/Copy was blocked/);
  expect(screen.getByLabelText('One-time token')).toHaveFocus();
  expect(screen.getByLabelText('One-time token')).toHaveValue('synthetic-capture-token');
});
