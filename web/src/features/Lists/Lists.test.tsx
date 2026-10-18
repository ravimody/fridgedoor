import {MemoryRouter} from 'react-router-dom';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Lists } from './Lists.js';
import { apiFetch } from '../../api/client.js';
vi.mock('../Home/PlannerContext.js', () => ({ usePlanner: () => ({ timezone: 'America/New_York' }) }));
vi.mock('../../api/client.js', () => ({ apiFetch: vi.fn() }));
beforeEach(()=>vi.mocked(apiFetch).mockResolvedValue({data:{items:[]}}));
afterEach(()=>{cleanup();vi.resetAllMocks();});
const base={id:'item',title:'Milk',completedAt:null as string|null,revision:1,createdAt:'2026-09-20T12:00:00Z'};
describe('lists screen', () => {
  it('hides a checked grocery immediately and restores it on a failed save',async()=>{
    let rejectSave:(error:Error)=>void=()=>{};
    vi.mocked(apiFetch).mockImplementation(async(_path,options)=>options?.method==='PATCH'?new Promise((_resolve,reject)=>{rejectSave=reject;}):{data:{items:[{...base,kind:'grocery'}]}});
    render(<MemoryRouter><Lists initialKind="grocery"/></MemoryRouter>);
    const active=screen.getByRole('region',{name:'Active items'});
    fireEvent.click(await within(active).findByRole('checkbox'));
    expect(within(active).queryByText('Milk')).not.toBeInTheDocument();
    rejectSave(Error('STALE_REVISION'));
    await within(active).findByText('Milk');expect(await screen.findByRole('status')).toHaveTextContent('restored');
  });
});
