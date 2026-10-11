import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {Settings} from 'luxon';
import {TaskActions} from './TaskActions.js';
import {apiFetch} from '../../api/client.js';
vi.mock('../../api/client.js',()=>({apiFetch:vi.fn()}));
const originalNow=Settings.now;
afterEach(()=>{cleanup();vi.resetAllMocks();Settings.now=originalNow;});
const item={id:'task',title:'Call workshop host',revision:4,completedAt:null};
it('offers quick dates and sends a date-only snooze in the owner timezone',async()=>{
 Settings.now=()=>Date.parse('2026-03-08T04:30:00Z');vi.mocked(apiFetch).mockResolvedValue({});const saved=vi.fn();
 render(<TaskActions item={item} timezone="America/New_York" onSaved={saved}/>);
 fireEvent.click(screen.getByText('Remind me later'));fireEvent.click(screen.getByRole('button',{name:'Tomorrow'}));
 await waitFor(()=>expect(saved).toHaveBeenCalledOnce());
 expect(apiFetch).toHaveBeenCalledWith('/list-items/task/snooze',expect.objectContaining({method:'POST',body:JSON.stringify({expectedRevision:4,date:'2026-03-08'})}));
 expect(screen.getByRole('button',{name:'In 3 days',hidden:true})).toBeInTheDocument();expect(screen.getByRole('button',{name:'In 7 days',hidden:true})).toBeInTheDocument();
});
it('keeps the item available and explains a failed save',async()=>{
 vi.mocked(apiFetch).mockRejectedValue(Error('STALE_REVISION'));const saved=vi.fn();render(<TaskActions item={item} onSaved={saved}/>);
 fireEvent.click(screen.getByRole('button',{name:'Done'}));await screen.findByRole('status');expect(saved).not.toHaveBeenCalled();expect(screen.getByRole('button',{name:'Done'})).toBeEnabled();
});
it('supports an arbitrary future date without changing completion',async()=>{
 Settings.now=()=>Date.parse('2026-09-20T15:00:00Z');vi.mocked(apiFetch).mockResolvedValue({});render(<TaskActions item={item} timezone="America/New_York" onSaved={()=>{}}/>);
 fireEvent.click(screen.getByText('Remind me later'));fireEvent.change(screen.getByLabelText('Choose a date'),{target:{value:'2026-10-12'}});fireEvent.click(screen.getByRole('button',{name:'Save date'}));
 await waitFor(()=>expect(apiFetch).toHaveBeenCalledWith('/list-items/task/snooze',expect.objectContaining({body:JSON.stringify({expectedRevision:4,date:'2026-10-12'})})));
});
