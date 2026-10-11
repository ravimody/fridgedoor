import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Chat } from './Chat.js';
import { apiFetch } from '../../api/client.js';
vi.mock('../../api/client.js', () => ({ apiFetch: vi.fn() }));
afterEach(cleanup);

describe('assistant', () => {
  it('shows consent before sending and distinguishes drafts from calendar writes', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path) => ({ data: path.endsWith('/settings') ? { enabled: true, consent: false } : [] }));
    render(<MemoryRouter><Chat /></MemoryRouter>);
    expect(await screen.findByRole('button', { name: 'Enable for my account' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  });
  it('saves a request and preserves its input when submission fails', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path, init) => {
      if (path.endsWith('/settings')) return { data: { enabled: true, consent: true } };
      if (init?.method === 'POST') throw new Error('NETWORK'); return { data: [] };
    });
    render(<MemoryRouter><Chat /></MemoryRouter>);
    fireEvent.change(await screen.findByLabelText('Message or recipe link'), { target: { value: 'School fair tomorrow' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('did not complete'));
    expect(screen.getByLabelText('Message or recipe link')).toHaveValue('School fair tomorrow');
  });
});
