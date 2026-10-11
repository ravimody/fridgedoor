import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Capture } from './Capture.js';
vi.mock('../../api/client.js', () => ({ apiFetch: vi.fn(async (path: string) => ({ data: path.endsWith('/settings') ? { enabled: true, consent: true } : [] })) }));
describe('capture screen', () => { it('offers photo/PDF and message input after consent', async () => { render(<Capture />); expect(await screen.findByLabelText('Photo or PDF')).toBeVisible(); expect(screen.getByLabelText('Message or recipe link')).toBeVisible(); }); });
