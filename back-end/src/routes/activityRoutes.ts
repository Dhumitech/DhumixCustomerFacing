import type { FastifyInstance } from 'fastify';
import type { RuntimeConfig } from '../config/environment.js';
import { requireTenantPrincipal } from '../middleware/tenantPrincipal.js';
import { SAFE_ACTIVITY_ACTIONS,organizationActivitySchema } from '../services/organizations/organizationActivity.js';
import { toJSONSchema } from 'zod';
export async function registerActivityRoutes(app:FastifyInstance,config:RuntimeConfig):Promise<void> {
  app.get('/v1/organization/activity',{preHandler:[requireTenantPrincipal()],config:{rateLimit:{max:config.signupRateLimit.max,timeWindow:config.signupRateLimit.windowMs}},
    schema:{querystring:{type:'object',additionalProperties:false,properties:{from:{type:'string',format:'date-time'},to:{type:'string',format:'date-time'},
      member:{type:'string',format:'uuid'},action:{type:'string',enum:SAFE_ACTIVITY_ACTIONS},limit:{type:'string',pattern:'^(?:[1-9]|[1-9][0-9]|100)$'}}},response:{200:toJSONSchema(organizationActivitySchema)}},
    handler:async(request,reply)=>{const principal=request.trustedTenantPrincipal;if(!principal)throw new Error('Missing organization principal');
      await reply.send(await app.organizationActivityService.get(principal,request.query as Record<string,unknown>));}});
}
