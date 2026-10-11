import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { apiFetch } from '../../api/client.js';
import { BackgroundAi } from './BackgroundAi.js';
vi.mock('../../api/client.js', () => ({ apiFetch: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it('requires explicit disclosure acceptance and saves the current revision', async () => {
  const status = { available: true, enabled: false, revision: 2, connectionActive: true, attemptsLastDay: 0, dailyLimit: 3000, hourlyLimit: 500, pending: 0, lastProcessedAt: null };
  vi.mocked(apiFetch).mockImplementation(async (_path, init) => {
    if (init?.method === 'POST') { expect(JSON.parse(init.body as string)).toEqual({ enabled: true, expectedRevision: 2 }); return { data: { ...status, enabled: true, revision: 3 } }; }
    return { data: status };
  });
  render(<BackgroundAi />);
  expect(await screen.findByRole('button', { name: 'Enable email suggestions' })).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Enable email suggestions' }));
  expect(await screen.findByText('Email suggestions enabled for your account.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Disable email suggestions' })).toBeEnabled();
});

it.each([false, true])('explains unusual volume and whether processing is paused: %s', async pausedForVolume => {
  vi.mocked(apiFetch).mockResolvedValue({data:{enabled:true, available:true, connectionActive:true, attemptsLastHour:300, attemptsLastDay:1000, volumeWarning:true, pausedForVolume, dailyLimit:3000, hourlyLimit:500, pending:40, failuresLastDay:0}});
  render(<BackgroundAi />);
  expect(await screen.findByText(/Unusually high email processing/)).toHaveTextContent(pausedForVolume ? 'temporarily paused' : 'Analysis continues');
  expect(screen.getByText(/volume safeguards, not spending caps/)).toBeVisible();
});
