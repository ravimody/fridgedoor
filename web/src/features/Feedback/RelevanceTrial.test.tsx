import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { apiFetch } from '../../api/client.js';
import { RelevanceTrial } from './RelevanceTrial.js';
vi.mock('../../api/client.js', () => ({ apiFetch: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const learning={data:{enabled:false,revision:0,preferences:[],generatedAt:null}};
const item = { id: 'trial-1', facts: { title: 'Synthetic package arrival', category: 'other', participants: [], preparationTasks: [], unresolvedFields: [] }, observedAt: '2026-09-19T12:00:00Z', value: null, reason: '', revision: 1 };
it('saves a one-tap vote without requiring a reason and supports changing it', async () => {
  vi.mocked(apiFetch).mockResolvedValueOnce({ data: { items: [item], expiresAt: '2026-10-19T12:00:00Z' } }).mockResolvedValueOnce({data:null}).mockResolvedValueOnce(learning).mockResolvedValueOnce({ data: { items: [{ ...item,value:'not_useful',revision:2 }], expiresAt: '2026-10-19T12:00:00Z' } }).mockResolvedValueOnce(learning);
  render(<MemoryRouter><RelevanceTrial /></MemoryRouter>);
  await screen.findByText('Synthetic package arrival');
  fireEvent.click(screen.getByRole('button',{name:'Not useful'}));
  await screen.findByText('Thanks, your ratings are saved.');
  expect(apiFetch).toHaveBeenCalledWith('/relevance-trial/trial-1',expect.objectContaining({body:JSON.stringify({value:'not_useful',reason:'',expectedRevision:1})}));
  fireEvent.click(screen.getByRole('button',{name:'Change answer'}));
  expect(screen.getByRole('button',{name:'Useful'})).toBeVisible();
});
it('retains optional explanation and card after a failed save', async () => {
  vi.mocked(apiFetch).mockResolvedValueOnce({data:{items:[item],expiresAt:null}}).mockResolvedValueOnce({data:null}).mockResolvedValueOnce(learning).mockRejectedValueOnce(new Error('offline'));
  render(<MemoryRouter><RelevanceTrial /></MemoryRouter>);
  await screen.findByText('Synthetic package arrival');
  fireEvent.click(screen.getByText('Add a reason (optional)'));
  fireEvent.change(screen.getByLabelText('What should we learn?'),{target:{value:'Routine updates are noise'}});
  fireEvent.click(screen.getByRole('button',{name:'Not useful'}));
  await waitFor(()=>expect(screen.getByRole('status')).toHaveTextContent('Could not save'));
  expect(screen.getByLabelText('What should we learn?')).toHaveValue('Routine updates are noise');
  expect(screen.getByText('0 of 1 answered')).toBeVisible();
});

it('offers self-service sampling and a preference preview without changing ratings', async () => {
  const preference={overview:'A tentative preference',preferences:[{direction:'avoid',pattern:'Routine arrival updates have not been useful.',evidenceIds:['trial-1']}]};
  vi.mocked(apiFetch).mockImplementation(async(path,init)=>{
    if(path==='/relevance-trial/learning')return learning;
    if(path==='/relevance-trial/summary')return {data:init?.method==='POST'?{result:preference,generatedAt:'2026-09-19T12:00:00Z'}:null};
    if(path==='/relevance-trial/next')return {data:{items:[{...item,value:'not_useful'},{...item,id:'trial-2',facts:{...item.facts,title:'Another random suggestion'}}],expiresAt:null}};
    return {data:{items:[{...item,value:'not_useful'}],expiresAt:null}};
  });
  render(<MemoryRouter><RelevanceTrial /></MemoryRouter>);
  await screen.findByText('1 of 1 answered');
  fireEvent.click(screen.getByRole('button',{name:'Summarize my feedback'}));
  await screen.findByText('A tentative preference');
  fireEvent.click(screen.getByRole('button',{name:'Try 5 random suggestions'}));
  await screen.findByText('Another random suggestion');
  expect(screen.getByRole('button',{name:'Try 5 random suggestions'})).toBeDisabled();
  expect(screen.getByText('1 of 2 answered')).toBeVisible();
});
