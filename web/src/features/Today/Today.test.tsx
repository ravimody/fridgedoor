import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Today } from './Today.js';

vi.mock('../../api/client.js', () => ({ apiFetch: vi.fn((path: string) => path === '/agenda' ? Promise.resolve({ data: { items: [{ id: 'a1', title: 'School pickup', time: { kind: 'all_day', startDate: '2026-01-01', endDateExclusive: '2026-01-02' }, status: 'confirmed', visibility: 'shared', origin: 'household calendar' }] } }) : Promise.resolve({ data: { plans: [] } })) }));
describe('today screen', () => { it('shows safe agenda origin and review count', async () => { render(<Today />); expect(await screen.findByRole('heading', { name: /your household day/i })).toBeVisible(); expect(screen.getByText('School pickup')).toBeVisible(); expect(screen.getByText(/household calendar/i)).toBeVisible(); }); });
