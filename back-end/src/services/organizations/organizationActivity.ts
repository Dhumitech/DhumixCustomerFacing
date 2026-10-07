import type { Pool } from 'pg';
import { z } from 'zod';
import { withOrganizationReadTransaction } from '../database/transactions.js';
import { ApplicationError } from '../../utils/applicationError.js';
import type { TrustedTenantPrincipal } from '../tenantAccess/trustedTenantPrincipal.js';
import { RUN_PUBLIC_STATUS_SQL } from '../../helpers/runPublicStatus.js';

export const SAFE_ACTIVITY_ACTIONS=['services.create','run.create','run.retry','run.cancel','artifacts.download_authorize',
  'organization.created','organization.joined','organization.member_role_changed','organization.member_removed','organization.createInvite',
  'organization.revokeInvite','organization.resendInvite','marketplace.sample_download_authorize','marketplace.expert_enquiry.create'] as const;
const uuid=z.uuid(),time=z.iso.datetime({precision:null,offset:true}),count=z.string().regex(/^\d+$/);
const calls=z.object({intents:count,confirmed_calls:count,accepted_submissions:count,http_errors:count,not_sent:count,uncertain:count});
const usage=z.object({meter:z.string(),quantity:z.string().regex(/^\d+(?:\.\d+)?$/),unit:z.string()});
export const organizationActivitySchema=z.object({
  from:time,to:time,
  runs:z.array(z.object({id:uuid,started_by_user_id:uuid.nullable(),status:z.string(),created_at:time,updated_at:time,completed_at:time.nullable(),
    first_attempt_at:time.nullable(),last_attempt_at:time.nullable(),calls,usage:z.array(usage),
    timeline:z.array(z.object({sequence:count,event_type:z.string(),occurred_at:time})),timeline_truncated:z.boolean()})),
  actions:z.array(z.object({id:uuid,user_id:uuid.nullable(),action:z.string(),target_type:z.string(),target_id:uuid.nullable(),outcome:z.string(),occurred_at:time})),
  members:z.array(z.object({user_id:uuid.nullable(),calls,usage:z.array(usage)})),
  runs_truncated:z.boolean(),actions_truncated:z.boolean(),members_truncated:z.boolean(),
});
export type OrganizationActivity=z.infer<typeof organizationActivitySchema>;
export interface OrganizationActivityService { get(principal:TrustedTenantPrincipal,query:Record<string,unknown>):Promise<OrganizationActivity> }
interface ActivityQuery {from:string;to:string;member:string|null;action:string|null;limit:number}
function invalid():never {throw new ApplicationError({status:400,code:'VALIDATION_ERROR',title:'Invalid activity filters'});}
function parseQuery(value:Record<string,unknown>):ActivityQuery {
  if(Object.keys(value).some(key=>!['from','to','member','action','limit'].includes(key)))invalid();
  const to=value.to===undefined?new Date().toISOString():value.to;
  if(typeof to!=='string'||!Number.isFinite(Date.parse(to)))invalid();
  const from=value.from===undefined?new Date(Date.parse(to)-30*86400000).toISOString():value.from;
  const parsed=z.object({from:time,to:time,member:uuid.nullable(),action:z.enum(SAFE_ACTIVITY_ACTIONS).nullable(),limit:z.coerce.number().int().min(1).max(100)}).safeParse({from,to,member:value.member??null,action:value.action??null,limit:value.limit??50});
  if(!parsed.success || Date.parse(parsed.data.from)>=Date.parse(parsed.data.to) || Date.parse(parsed.data.to)-Date.parse(parsed.data.from)>31*86400000)invalid();
  return parsed.data;
}
const callTotals=`jsonb_build_object('intents',count(*)::text,'confirmed_calls',count(*) FILTER (WHERE c.state='responded')::text,
  'accepted_submissions',count(*) FILTER (WHERE c.state='responded' AND c.purpose='run_submit' AND c.http_status BETWEEN 200 AND 299)::text,
  'http_errors',count(*) FILTER (WHERE c.state='responded' AND c.http_status>=400)::text,'not_sent',count(*) FILTER (WHERE c.state='not_sent')::text,
  'uncertain',count(*) FILTER (WHERE c.state IN ('prepared','uncertain'))::text)`;
const emptyCalls=`'{"intents":"0","confirmed_calls":"0","accepted_submissions":"0","http_errors":"0","not_sent":"0","uncertain":"0"}'::jsonb`;

export function createOrganizationActivityService(pool:Pool):OrganizationActivityService {
  return {async get(principal,query){
    if(principal.kind!=='browser')throw new ApplicationError({status:403,code:'ACCESS_DENIED',title:'Browser session required'});
    const filters=parseQuery(query),values=[principal.tenantId,filters.from,filters.to,filters.member,filters.limit+1];
    try {return await withOrganizationReadTransaction(pool,{tenantId:principal.tenantId,userId:principal.userId},async db=>{
      // Independent aggregates prevent call x usage multiplication. Internal traffic is excluded.
      const result=await db.query<{item:unknown}>(`WITH selected AS (
        SELECT run.id,run.created_by_user_id,run.internal_status,run.created_at,run.updated_at,run.completed_at FROM app.runs run JOIN app.organizations o ON o.id=run.organization_id WHERE run.organization_id=$1 AND NOT o.is_internal
          AND run.created_at>=$2::timestamptz AND run.created_at<$3::timestamptz AND ($4::uuid IS NULL OR run.created_by_user_id=$4)
        ORDER BY run.created_at DESC,run.id DESC LIMIT $5
      ), calls AS (SELECT run_id,${callTotals} totals FROM app.provider_calls c WHERE organization_id=$1 GROUP BY run_id),
      quantities AS (SELECT run_id,meter_code,unit,sum(quantity)::text quantity FROM app.usage_events WHERE organization_id=$1 AND outcome='succeeded' AND source='artifact' GROUP BY run_id,meter_code,unit),
      usage AS (SELECT run_id,jsonb_agg(jsonb_build_object('meter',meter_code,'quantity',quantity,'unit',unit) ORDER BY meter_code,unit) totals FROM quantities GROUP BY run_id),
      attempts AS (SELECT run_id,min(started_at) first_at,max(finished_at) last_at FROM app.run_attempts WHERE organization_id=$1 GROUP BY run_id)
      SELECT jsonb_build_object('id',run.id,'started_by_user_id',run.created_by_user_id,'status',${RUN_PUBLIC_STATUS_SQL},
        'created_at',run.created_at,'updated_at',run.updated_at,'completed_at',run.completed_at,'first_attempt_at',a.first_at,'last_attempt_at',a.last_at,
        'calls',coalesce(c.totals,${emptyCalls}),'usage',coalesce(u.totals,'[]'::jsonb),
        'timeline',coalesce(events.items,'[]'::jsonb),'timeline_truncated',coalesce(events.truncated,false)) item
      FROM selected run LEFT JOIN calls c ON c.run_id=run.id LEFT JOIN usage u ON u.run_id=run.id LEFT JOIN attempts a ON a.run_id=run.id
      LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('sequence',e.sequence::text,'event_type',e.event_type,'occurred_at',e.occurred_at) ORDER BY e.sequence) FILTER(WHERE e.position<=20) items,
        count(*)>20 truncated FROM (SELECT sequence,event_type,occurred_at,row_number() OVER(ORDER BY sequence DESC) position FROM app.run_events
          WHERE organization_id=$1 AND run_id=run.id ORDER BY sequence DESC LIMIT 21)e) events ON true
      ORDER BY run.created_at DESC,run.id DESC`,values);
      const actions=await db.query<{item:unknown}>(`SELECT jsonb_build_object('id',a.id,'user_id',a.actor_user_id,'action',a.action,
        'target_type',a.target_type,'target_id',a.target_id,'outcome',a.outcome,'occurred_at',a.occurred_at) item
        FROM app.audit_events a JOIN app.organizations o ON o.id=a.organization_id WHERE a.organization_id=$1 AND NOT o.is_internal
          AND a.occurred_at>=$2::timestamptz AND a.occurred_at<$3::timestamptz AND ($4::uuid IS NULL OR a.actor_user_id=$4)
          AND a.action=ANY($6::text[]) AND ($7::text IS NULL OR a.action=$7) ORDER BY a.occurred_at DESC,a.id DESC LIMIT $5`,[...values,SAFE_ACTIVITY_ACTIONS,filters.action]);
      const members=await db.query<{item:unknown}>(`WITH calls AS (
        SELECT initiated_by_user_id user_id,${callTotals} totals FROM app.provider_calls c JOIN app.organizations o ON o.id=c.organization_id
          WHERE c.organization_id=$1 AND NOT o.is_internal AND prepared_at>=$2::timestamptz AND prepared_at<$3::timestamptz GROUP BY initiated_by_user_id
      ), quantities AS (
        SELECT r.created_by_user_id user_id,u.meter_code,u.unit,sum(u.quantity)::text quantity FROM app.usage_events u
        JOIN app.runs r ON r.organization_id=u.organization_id AND r.id=u.run_id JOIN app.organizations o ON o.id=u.organization_id
        WHERE u.organization_id=$1 AND NOT o.is_internal AND u.observed_at>=$2::timestamptz AND u.observed_at<$3::timestamptz AND u.source='artifact' AND u.outcome='succeeded'
        GROUP BY r.created_by_user_id,u.meter_code,u.unit
      ), usage AS (SELECT user_id,jsonb_agg(jsonb_build_object('meter',meter_code,'quantity',quantity,'unit',unit) ORDER BY meter_code,unit) totals FROM quantities GROUP BY user_id),
      people AS (SELECT user_id FROM calls UNION SELECT user_id FROM usage)
      SELECT jsonb_build_object('user_id',p.user_id,'calls',coalesce(c.totals,${emptyCalls}),'usage',coalesce(u.totals,'[]'::jsonb)) item
        FROM people p LEFT JOIN calls c ON c.user_id IS NOT DISTINCT FROM p.user_id LEFT JOIN usage u ON u.user_id IS NOT DISTINCT FROM p.user_id
        WHERE ($4::uuid IS NULL OR p.user_id=$4) ORDER BY p.user_id NULLS LAST LIMIT $5`,values);
      const limit=filters.limit;
      return organizationActivitySchema.parse({from:filters.from,to:filters.to,runs:result.rows.slice(0,limit).map(r=>r.item),actions:actions.rows.slice(0,limit).map(r=>r.item),
        members:members.rows.slice(0,limit).map(r=>r.item),runs_truncated:result.rows.length>limit,actions_truncated:actions.rows.length>limit,members_truncated:members.rows.length>limit});
    });}catch(error){if(error instanceof ApplicationError)throw error;throw new ApplicationError({status:500,code:'INTERNAL_ERROR',title:'Activity unavailable',cause:error});}
  }};
}
