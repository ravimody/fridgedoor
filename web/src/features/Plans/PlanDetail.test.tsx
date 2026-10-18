import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { PlanDetail } from './PlanDetail.js';

const { apiFetch } = vi.hoisted(() => {
  const fixture = { id: 'p1', revision: 1, visibility: 'private' as const, status: 'needs_details' as const, facts: { title: 'School pickup', category: 'school', participants: ['Alex'], time: { kind: 'unresolved' as const, missing: ['date' as const] }, preparationTasks: [], unresolvedFields: ['date'] }, changeKind: 'new' as const, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', sourceSummary: { kind: 'email', count: 1, available: true }, possibleDuplicate: false };
  const request = vi.fn((path: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') return Promise.resolve({ data: { ...fixture, revision: 2, facts: { ...fixture.facts, title: 'Updated pickup' } } });
    if (path === '/plans/p1') return Promise.resolve({ data: fixture });
    if (path === '/plans/p1/history') return Promise.resolve({ data: { entries: [{ id: 'h1', type: 'facts_edited', actorLabel: 'Alex', safePayload: { title: 'School pickup' }, createdAt: '2026-01-01T00:00:00.000Z' }] } });
    return Promise.resolve({ data: { sourceVersionId: 's1', availability: 'available', kind: 'gmail', sender: 'school@example.test', labels: ['Inbox'], text: 'Pickup is Friday.' } });
  });
  return { apiFetch: request };
});
vi.mock('../../api/client.js', () => ({ apiFetch }));

afterEach(cleanup);

describe('plan detail review', () => {
  it('loads owner evidence and saves a correction through the revisioned API', async () => {
    render(<MemoryRouter initialEntries={['/plans/p1']}><Routes><Route path="/plans/:id" element={<PlanDetail />} /></Routes></MemoryRouter>);
    expect(await screen.findByRole('heading', { name: 'School pickup' })).toBeVisible();
    expect(screen.getByText('Pickup is Friday.')).toBeVisible();
    expect(screen.getByText('Details edited')).toBeVisible();
    expect(screen.getByLabelText('Time zone')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Updated pickup' } });
    fireEvent.click(screen.getByRole('button', { name: /save corrections/i }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/plans/p1', expect.objectContaining({ method: 'PATCH' })));
    expect(await screen.findByText('Your corrections are saved for review.')).toBeVisible();
  });
  it('keeps commas and new lines while typing lists and saves them split', async () => {
    render(<MemoryRouter initialEntries={['/plans/p1']}><Routes><Route path="/plans/:id" element={<PlanDetail />} /></Routes></MemoryRouter>);
    await screen.findByRole('heading', { name: 'School pickup' });
    const participants = screen.getByLabelText('Participants');
    await userEvent.type(participants, ', Sam, ');
    expect(participants).toHaveValue('Alex, Sam, ');
    const tasks = screen.getByLabelText('Preparation to-dos');
    await userEvent.type(tasks, 'Pack snacks{Enter}Bring form');
    expect(tasks).toHaveValue('Pack snacks\nBring form');
    fireEvent.click(screen.getByRole('button', { name: /save corrections/i }));
    await screen.findByText('Your corrections are saved for review.');
    const request = apiFetch.mock.calls.filter((call) => call[1]?.method === 'PATCH').at(-1)!;
    expect(JSON.parse(request[1]!.body as string).facts).toMatchObject({ participants: ['Alex', 'Sam'], preparationTasks: ['Pack snacks', 'Bring form'] });
  });
  it('lets an incomplete calendar draft acquire a reviewed time', async () => {
    render(<MemoryRouter initialEntries={['/plans/p1']}><Routes><Route path="/plans/:id" element={<PlanDetail />} /></Routes></MemoryRouter>);
    await screen.findByRole('heading', { name: 'School pickup' });
    fireEvent.change(screen.getByLabelText('Start'), { target: { value: '2026-09-14T18:00' } });
    fireEvent.change(screen.getByLabelText('End'), { target: { value: '2026-09-14T19:00' } });
    fireEvent.change(screen.getByLabelText('Time zone'), { target: { value: 'America/New_York' } });
    fireEvent.click(screen.getByRole('button', { name: /save corrections/i }));
    await screen.findByText('Your corrections are saved for review.');
    const request = apiFetch.mock.calls.filter((call) => call[1]?.method === 'PATCH').at(-1);
    expect(JSON.parse(request![1]!.body as string).facts).toMatchObject({ time: { kind: 'timed', start: '2026-09-14T18:00:00.000-04:00', end: '2026-09-14T19:00:00.000-04:00' }, unresolvedFields: [] });
  });

});

it('saves and queues an existing-event update, and requires confirmation before removal', async () => {
  const facts = { title: 'School pickup', category: 'school', participants: [], time: { kind: 'timed', start: '2026-09-14T18:00:00-04:00', end: '2026-09-14T19:00:00-04:00', timezone: 'America/New_York' }, preparationTasks: [], unresolvedFields: [] };
  const plan = { id: 'p1', revision: 2, visibility: 'shared', status: 'accepted', facts, changeKind: 'new', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', sourceSummary: { kind: 'capture', count: 1, available: true }, possibleDuplicate: false, calendarAction: { actionId: 'create', state: 'succeeded', kind: 'create' } };
  apiFetch.mockImplementation(async (path, init) => {
    if (init?.method === 'PATCH') { plan.revision++; plan.facts = JSON.parse(init.body as string).facts; return { data: plan } as never; }
    if (path.endsWith('/apply')) return { data: { actionId: 'update', state: 'pending' } } as never;
    if (path.endsWith('/history')) return { data: { entries: [] } } as never;
    if (path.endsWith('/evidence')) return { data: { sourceVersionId: 's', availability: 'expired', kind: 'capture', labels: [] } } as never;
    return { data: plan } as never;
  });
  apiFetch.mockClear();
  render(<MemoryRouter initialEntries={['/plans/p1']}><Routes><Route path="/plans/:id" element={<PlanDetail />} /></Routes></MemoryRouter>);
  await screen.findByRole('heading', { name: 'School pickup' });
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Later pickup' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save and update calendar' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/plans/p1/apply', expect.objectContaining({ body: JSON.stringify({ expectedRevision: 3, kind: 'update' }) })));
  fireEvent.click(await screen.findByRole('button', { name: 'Remove from calendar' }));
  expect(apiFetch.mock.calls.filter(([, init]) => init?.body?.toString().includes('"kind":"cancel"'))).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm removal' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/plans/p1/apply', expect.objectContaining({ body: JSON.stringify({ expectedRevision: 3, kind: 'cancel' }) })));
});

it('edits a deadline without requiring an end or silently creating a calendar event', async () => {
  const plan = { id: 'p1', revision: 1, visibility: 'private', status: 'proposed', facts: { title: 'Permission slip', category: 'school', participants: [], preparationTasks: [], unresolvedFields: [], time: { kind: 'deadline', at: '2026-09-18T17:00:00-04:00', timezone: 'America/New_York' } }, changeKind: 'new', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', sourceSummary: { kind: 'email', count: 1, available: true }, possibleDuplicate: false };
  apiFetch.mockImplementation(async (path, init) => {
    if (init?.method === 'PATCH') { plan.revision++; plan.facts = JSON.parse(init.body as string).facts; return { data: plan } as never; }
    if (path.endsWith('/history')) return { data: { entries: [] } } as never;
    if (path.endsWith('/evidence')) return { data: { sourceVersionId: 's', availability: 'expired', kind: 'gmail', labels: [] } } as never;
    return { data: plan } as never;
  });
  apiFetch.mockClear();
  render(<MemoryRouter initialEntries={['/plans/p1']}><Routes><Route path="/plans/:id" element={<PlanDetail />} /></Routes></MemoryRouter>);
  await screen.findByRole('heading', { name: 'Permission slip' });
  expect(screen.getByRole('button', { name: 'Add to calendar' })).toBeDisabled();
  expect(screen.getByLabelText('Due')).toHaveValue('2026-09-18T17:00');
  fireEvent.change(screen.getByLabelText('Due'), { target: { value: '2026-09-18T18:00' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save corrections' }));
  await screen.findByText('Your corrections are saved for review.');
  expect(plan.facts.time).toEqual({ kind: 'deadline', at: '2026-09-18T18:00:00.000-04:00', timezone: 'America/New_York' });
  expect(apiFetch.mock.calls.some(([path]) => path.endsWith('/apply') || path.endsWith('/decision'))).toBe(false);
});

it('retries the original failed action and refreshes its persisted status', async () => {
  const plan = { id:'p1',revision:2,visibility:'shared',status:'accepted',facts:{title:'School pickup',category:'school',participants:[],preparationTasks:[],unresolvedFields:[],time:{kind:'timed',start:'2026-09-14T18:00:00-04:00',end:'2026-09-14T19:00:00-04:00',timezone:'America/New_York'}},changeKind:'new',createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z',sourceSummary:{kind:'capture',count:1,available:false},possibleDuplicate:false,calendarAction:{actionId:'original',state:'failed',kind:'create'}};
  apiFetch.mockImplementation(async (path,init) => {
    if (path==='/actions/original/retry' && init?.method==='POST') { plan.calendarAction.state='pending';plan.revision++;return {data:{actionId:'original',planId:'p1',state:'pending'}} as never; }
    if(path.endsWith('/history'))return {data:{entries:[]}} as never;
    if(path.endsWith('/evidence'))return {data:{sourceVersionId:'s',availability:'expired',kind:'capture',labels:[]}} as never;
    return {data:structuredClone(plan)} as never;
  });apiFetch.mockClear();
  render(<MemoryRouter initialEntries={['/plans/p1']}><Routes><Route path="/plans/:id" element={<PlanDetail/>}/></Routes></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button',{name:'Retry original calendar change'}));
  await waitFor(()=>expect(apiFetch).toHaveBeenCalledWith('/actions/original/retry',expect.objectContaining({method:'POST',body:JSON.stringify({expectedRevision:2})})));
  await screen.findByText('Waiting for Google Calendar');
  expect(apiFetch.mock.calls.some(([path])=>path.endsWith('/apply'))).toBe(false);
});
