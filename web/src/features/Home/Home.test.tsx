import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { Settings } from 'luxon';
import { Home, PlannerArchive } from './Home.js';
import { post, usePlanner } from './PlannerContext.js';
vi.mock('./PlannerContext.js', () => ({ usePlanner: vi.fn(), post: vi.fn() }));
const originalNow = Settings.now;
afterEach(() => { cleanup(); Settings.now = originalNow; vi.resetAllMocks(); });
it('shows a kept event with only a start in the week, without calling it a calendar event', () => {
  Settings.now = () => Date.parse('2026-09-13T22:00:00Z');
  vi.mocked(usePlanner).mockReturnValue({ timezone: 'America/New_York', runs: [], plans: [{ id: 'partial', savedInPlanner: true, visibility: 'private', status: 'needs_details', facts: { title: 'Synthetic gathering', time: { kind: 'unresolved', startHint: '2026-09-14T19:00:00-04:00', missing: ['end'] }, unresolvedFields: ['time'] } }], agenda: [], todos: [], reminders: [], connection: {}, loaded: true } as unknown as ReturnType<typeof usePlanner>);
  render(<MemoryRouter><Home /></MemoryRouter>);
  fireEvent.click(within(screen.getByRole('group', { name: 'Choose a day' })).getByRole('button', { name: 'Monday, September 14' }));
  const schedule = screen.getByRole('heading', { name: 'Monday’s plans' }).closest('section')!;
  expect(within(schedule).getByText('Synthetic gathering')).toBeVisible();
  expect(within(schedule).getByText(/Mon, Sep 14 · 7:00 PM · End time needed/)).toBeVisible();
  expect(within(schedule).getByText('Saved · Only you')).toBeVisible();
  expect(screen.queryByText('Kept without a date')).not.toBeInTheDocument();
});

it('shows a sourced daily overview and answers its durable question inline', () => {
  const act = vi.fn(async (action: () => Promise<unknown>) => { await action(); return true; });
  vi.mocked(post).mockResolvedValue({});
  vi.mocked(usePlanner).mockReturnValue({ timezone: 'America/New_York', runs: [], plans: [], agenda: [], todos: [], reminders: [], connection: {}, loaded: true, dailySettings: { enabled: true, revision: 1 }, dailyOverview: { state: 'ready', result: { summary: 'A school form needs attention.', items: [], questions: [], omittedRefs: [] }, items: [{ refs: ['candidate-1'], category: 'deadline', headline: 'ignored model label', detail: 'Bring the completed form.', priority: 'important', title: 'School form', normalizedTime: null, sourceRefs: ['source-1'], href: '/plans/plan-1' }], generatedAt: '2026-09-14T11:00:00Z', coverage: [], revision: 1 }, dismissMorningItem: vi.fn(), clarifications: [{ id: 'clar-1', question: 'Who will return the form?', reason: 'No owner is recorded.', sourceRefs: ['source-1'], state: 'open', answer: null, revision: 1, createdAt: '2026-09-14T11:00:00Z', expiresAt: '2026-10-14T11:00:00Z' }], act } as unknown as ReturnType<typeof usePlanner>);
  render(<MemoryRouter><Home /></MemoryRouter>);
  expect(screen.getByRole('heading', { name: 'Needs your attention' })).toBeVisible();
  expect(screen.getByRole('link', { name: 'School form' })).toHaveAttribute('href', '/plans/plan-1');
  expect(screen.getByText('Morning brief details')).toBeVisible();
  fireEvent.click(screen.getByLabelText('Options for School form'));
  fireEvent.click(within(screen.getByLabelText('Options for School form').closest('details')!).getByRole('button',{name:'Dismiss'}));
  expect(vi.mocked(usePlanner).mock.results[0]!.value.dismissMorningItem).toHaveBeenCalledWith(['candidate-1'],1);
  fireEvent.change(screen.getByLabelText('Answer'), { target: { value: 'I will return it.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save answer' }));
  expect(post).toHaveBeenCalledWith('/clarifications/clar-1/answer', { text: 'I will return it.', expectedRevision: 1 });
});

it('keeps the calendar visible without substituting a generic review when generation fails', () => {
  Settings.now=()=>Date.parse('2026-09-19T11:00:00Z');
  vi.mocked(usePlanner).mockReturnValue({timezone:'America/New_York',runs:[],plans:[],agenda:[{id:'calendar-1',title:'Actual appointment',time:{kind:'timed',start:'2026-09-19T12:00:00-04:00',end:'2026-09-19T13:00:00-04:00',timezone:'America/New_York'},origin:'your private calendar',status:'confirmed'}],todos:[],reminders:[],connection:{},loaded:true,dailySettings:{enabled:true,revision:1},dailyOverview:{state:'unavailable',result:{summary:'Your morning review is not available yet. Your calendar is still available below.',items:[],questions:[],omittedRefs:[]},items:[],coverage:[],revision:1},clarifications:[]} as unknown as ReturnType<typeof usePlanner>);
  render(<MemoryRouter><Home /></MemoryRouter>);
  expect(screen.getByText(/Your morning review is not available yet/)).toBeVisible();
  expect(screen.getByText('Actual appointment')).toBeVisible();
  expect(screen.queryByText(/safe fallback/)).not.toBeInTheDocument();
});

it('keeps calendar commitments visible, deduplicates their review rows, and puts dated todos on the selected day',()=>{
  Settings.now=()=>Date.parse('2026-09-19T11:00:00Z');
  const time={kind:'timed',start:'2026-09-19T12:00:00-04:00',end:'2026-09-19T13:00:00-04:00',timezone:'America/New_York'};
  vi.mocked(usePlanner).mockReturnValue({timezone:'America/New_York',runs:[{id:'old-reply',state:'succeeded',result:{reply:'2+2=4',items:[],knowledge:[]}}],plans:[],agenda:[{id:'cal-1',title:'Actual appointment',time,origin:'Private calendar',status:'confirmed'}],todos:[{id:'tomorrow',title:'Return permission form',dueTime:'2026-09-20T12:00:00-04:00',completedAt:null},{id:'undated',title:'Sort the attic',completedAt:null}],reminders:[],connection:{},loaded:true,dailySettings:{enabled:true,revision:1},dailyOverview:{state:'ready',result:{summary:'A useful morning summary.'},items:[{refs:['candidate-1'],targets:[{kind:'calendar',id:'cal-1'}],category:'today',title:'Actual appointment',normalizedTime:time,detail:'Scheduled today',priority:'routine',sourceRefs:[],href:null}],coverage:[],revision:1},clarifications:[]} as unknown as ReturnType<typeof usePlanner>);
  render(<MemoryRouter><Home/></MemoryRouter>);
  expect(screen.getAllByText('Actual appointment')).toHaveLength(1);
  expect(screen.queryByText('2+2=4')).not.toBeInTheDocument();expect(screen.queryByText('Sort the attic')).not.toBeInTheDocument();expect(screen.queryByText('Return permission form')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Sunday, September 20'}));
  expect(screen.getByText('Return permission form')).toBeVisible();expect(screen.queryByText('Actual appointment')).not.toBeInTheDocument();expect(screen.queryByText('A useful morning summary.')).not.toBeInTheDocument();
});

it('keeps important future commitments on the horizon and explains review limits separately from actions',()=>{
  Settings.now=()=>Date.parse('2026-09-19T11:00:00Z');
  const review=(category:string,title:string)=>({refs:[title],category,title,detail:'Source-backed detail.',priority:'important',normalizedTime:null,sourceRefs:[],href:null});
  vi.mocked(usePlanner).mockReturnValue({timezone:'America/New_York',runs:[],plans:[],agenda:[],todos:[],reminders:[],loaded:true,dailySettings:{enabled:true,revision:1},dailyOverview:{state:'ready',result:{summary:'Upcoming plans.'},items:[review('prepare','School closed Monday'),review('change','Appointment moved'),review('decision','Choose pickup person'),review('deadline','Return form today')],coverage:[{channel:'email',status:'truncated',omittedCount:12}],revision:1},clarifications:[]} as unknown as ReturnType<typeof usePlanner>);
  render(<MemoryRouter><Home/></MemoryRouter>);
  const attention=screen.getByRole('heading',{name:'Needs your attention'}).closest('section')!;
  expect(within(attention).queryByText('School closed Monday')).not.toBeInTheDocument();
  expect(within(attention).queryByText('Appointment moved')).not.toBeInTheDocument();
  expect(within(attention).getByText('Choose pickup person')).toBeVisible();
  expect(within(attention).getByText('Return form today')).toBeVisible();
  const horizon=screen.getByRole('heading',{name:'On the horizon'}).closest('section')!;
  expect(within(horizon).getByText('School closed Monday')).toBeVisible();
  expect(within(horizon).getByText('Appointment moved')).toBeVisible();
  fireEvent.click(screen.getByText('Email: review limit reached'));
  expect(screen.getByText('12 email items were outside the morning brief’s size limit.')).toBeVisible();
});

it.each([
  [{ connected: true, status: 'active', provider: 'google' }, 'Choose a calendar', '/settings/calendar'],
  [{ connected: false, status: 'disconnected' }, 'Connect email', '/settings/email'],
  [{ connected: true, status: 'active', provider: 'imap' }, null, null],
])('offers a calendar action that fits the email connection: %o', (connection, label, href) => {
  Settings.now = () => Date.parse('2026-09-13T12:00:00Z');
  const item = { kind: 'event', title: 'Synthetic fair', quantity: null, start: '2026-09-14T10:00:00-04:00', end: '2026-09-14T12:00:00-04:00', location: null, notes: null };
  const run = { id: 'run-1', text: 'fair', state: 'succeeded', result: { reply: 'Found a fair.', items: [item], knowledge: [], assumptions: [], followups: [], sources: [] }, reviews: [] };
  vi.mocked(usePlanner).mockReturnValue({ timezone: 'America/New_York', runs: [run], plans: [], agenda: [], todos: [], reminders: [], clarifications: [], connection, destination: null, loaded: true } as unknown as ReturnType<typeof usePlanner>);
  render(<MemoryRouter><PlannerArchive /></MemoryRouter>);
  fireEvent.click(screen.getByText(/All pending suggestions/));
  fireEvent.click(screen.getByText(/Synthetic fair/, { selector: 'summary' }));
  expect(screen.getByRole('button', { name: 'Save' })).toBeVisible();
  expect(screen.queryByRole('link', { name: 'Connect Google' })).not.toBeInTheDocument();
  if (label) expect(screen.getByRole('link', { name: label })).toHaveAttribute('href', href);
  else expect(screen.queryByRole('link', { name: /Choose a calendar|Connect email/ })).not.toBeInTheDocument();
  expect(screen.queryByText(/^Run run-1/)).not.toBeInTheDocument();
});
