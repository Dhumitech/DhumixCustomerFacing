import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { organizationActivity } from '../../api/organizationActivity';
import { selectedOrganization } from '../../api/organizationScope';
import { organizationsApi } from '../../api/organizations';
import type { GetActivityData } from '../../api/generated';
type ActivityAction = NonNullable<GetActivityData['query']>['action'];
export function ActivityPage() {
  const organization=selectedOrganization();
  const [member,setMember]=useState(''),[action,setAction]=useState<ActivityAction|''>('');
  const [from,setFrom]=useState(()=>new Date(Date.now()-29*86400000).toISOString().slice(0,10));
  const [to,setTo]=useState(()=>new Date().toISOString().slice(0,10));
  const members=useQuery({queryKey:['organization-members',organization],queryFn:organizationsApi.members,enabled:!!organization});
  const activity=useQuery({queryKey:['organization-activity',organization,member,action,from,to],
    queryFn:()=>organizationActivity({from:new Date(from+'T00:00:00Z').toISOString(),to:new Date(Date.parse(to+'T00:00:00Z')+86400000).toISOString(),
      ...(member?{member}:{}),...(action?{action}:{}),limit:100}),enabled:!!organization&&!!from&&!!to});
  const names=new Map(members.data?.members.map(item=>[item.user_id,item.email]));
  const name=(id:string|null)=>id===null?'Unknown historical user':names.get(id)??id;
  if(!organization)return <section><h2>Organization activity</h2><p>Choose or join an organization to see its activity.</p></section>;
  return <section className="organization-members"><h2>Organization activity</h2>
    <div><label>From <input type="date" value={from} onChange={e=>setFrom(e.target.value)} /></label>{' '}
      <label>Through <input type="date" value={to} onChange={e=>setTo(e.target.value)} /></label>{' '}
      <label>Member <select value={member} onChange={e=>setMember(e.target.value)}><option value="">Everyone</option>
        {members.data?.members.map(person=><option key={person.user_id} value={person.user_id}>{person.email}</option>)}</select></label>{' '}
      <label>Action <select value={action} onChange={e=>setAction(e.target.value as ActivityAction|'')}><option value="">All safe actions</option>
        {['services.create','run.create','run.retry','run.cancel','organization.joined','organization.member_removed','marketplace.expert_enquiry.create'].map(value=><option key={value}>{value}</option>)}</select></label></div>
    {activity.isPending&&<p role="status">Loading activity…</p>}
    {activity.error&&<p role="alert">Activity could not be loaded. Check the date range and try again.</p>}
    {activity.data&&<>
      {(activity.data.runs_truncated||activity.data.actions_truncated||activity.data.members_truncated)&&<p role="status">More activity exists. Narrow the dates or choose a member to see a smaller range.</p>}
      <h3>Member totals</h3><p>Confirmed calls have a recorded response. Uncertain requests are shown separately. Usage describes collected records.</p>
      <ul>{activity.data.members.map((person,index)=><li key={person.user_id??'unknown-'+index}>{name(person.user_id)}: {person.calls.confirmed_calls} confirmed calls,
        {' '}{person.calls.uncertain} uncertain, {person.calls.not_sent} not sent.
        {person.usage.map(item=><span key={item.meter+item.unit}> {item.quantity} {item.unit} ({item.meter}).</span>)}</li>)}</ul>
      <h3>Runs</h3><ul>{activity.data.runs.map(run=><li key={run.id}>Started by {name(run.started_by_user_id)} on {new Date(run.created_at).toLocaleString()} — {run.status}.
        {' '}{run.calls.confirmed_calls} confirmed calls; {run.calls.uncertain} uncertain.
        {run.usage.map(item=><span key={item.meter+item.unit}> {item.quantity} {item.unit}.</span>)}
        {run.first_attempt_at&&<span> First attempt: {new Date(run.first_attempt_at).toLocaleString()}.</span>}
        {run.completed_at&&<span> Completed: {new Date(run.completed_at).toLocaleString()}.</span>}
        <ol>{run.timeline.map(event=><li key={event.sequence}>{event.event_type}: {new Date(event.occurred_at).toLocaleString()}</li>)}</ol>
        {run.timeline_truncated&&<span>Showing the latest 20 events. The Run event history contains earlier events.</span>}</li>)}</ul>
      <h3>Actions</h3><ul>{activity.data.actions.map(item=><li key={item.id}>{new Date(item.occurred_at).toLocaleString()} — {name(item.user_id)}: {item.action} ({item.outcome})</li>)}</ul>
      {!activity.data.runs.length&&!activity.data.actions.length&&<p>No activity in this range.</p>}
    </>}
  </section>;
}
