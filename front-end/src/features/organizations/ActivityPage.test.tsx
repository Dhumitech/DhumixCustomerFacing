import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {render,screen} from '@testing-library/react';
import {describe,it,expect,vi,afterEach} from 'vitest';
import {ActivityPage} from './ActivityPage';
import {organizationActivity} from '../../api/organizationActivity';
import {organizationsApi} from '../../api/organizations';
vi.mock('../../api/organizationActivity',()=>({organizationActivity:vi.fn()}));
vi.mock('../../api/organizations',()=>({organizationsApi:{members:vi.fn()}}));
afterEach(()=>{vi.clearAllMocks();window.history.replaceState(null,'','/');});
const show=()=>render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><ActivityPage /></QueryClientProvider>);
describe('Safe organization activity page',()=>{
 it('shows the next update without requesting activity',()=>{window.history.replaceState(null,'','/workspace/activity');show();expect(screen.getByText(/coming in the next update/)).toBeInTheDocument();expect(organizationActivity).not.toHaveBeenCalled();});
 it('displays observed counts and unknown history without inventing users or billing',async()=>{
  window.history.replaceState(null,'','/o/11111111-1111-4111-8111-111111111111/workspace/activity');
  vi.mocked(organizationsApi.members).mockResolvedValue({members:[]});
  vi.mocked(organizationActivity).mockResolvedValue({from:'2026-10-01T00:00:00Z',to:'2026-10-07T00:00:00Z',runs:[],actions:[],members:[{user_id:null,calls:{intents:'3',confirmed_calls:'1',accepted_submissions:'1',http_errors:'0',uncertain:'2',not_sent:'0'},usage:[]}],runs_truncated:true,actions_truncated:false,members_truncated:false});
  show();expect(screen.getByText(/coming in the next update/)).toBeInTheDocument();expect(organizationActivity).not.toHaveBeenCalled();expect(organizationsApi.members).not.toHaveBeenCalled();
 });
});
