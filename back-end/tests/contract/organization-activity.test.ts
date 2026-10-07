import {randomUUID} from 'node:crypto';
import {describe,it,expect,afterEach,vi} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {buildApp} from '../../src/app.js';
import {loadRuntimeConfig} from '../../src/config/environment.js';
import {authenticationRequired} from '../../src/services/identity/sessionErrors.js';
import {ApplicationError} from '../../src/utils/applicationError.js';
import {stubGetCatalogTemplateService,stubListCatalogTemplatesService} from '../support/catalogueStub.js';
import {stubGetServiceService,stubCreateServiceService,stubListServicesService} from '../support/serviceStub.js';
const tenantId=randomUUID(),userId=randomUUID(),sessionId=randomUUID();
let app:FastifyInstance|undefined;
afterEach(async()=>{await app?.close();app=undefined;});
const projection={from:'2026-10-01T00:00:00Z',to:'2026-10-07T00:00:00Z',runs:[],actions:[],members:[],runs_truncated:false,actions_truncated:false,members_truncated:false};
async function build(denied=false){
 const get=vi.fn(async()=>projection);
 app=await buildApp(loadRuntimeConfig({NODE_ENV:'test',LOG_LEVEL:'silent',FRONTEND_ORIGIN:'http://localhost:5173',DATABASE_HOST:'localhost',DATABASE_NAME:'dhumi_test',
 DATABASE_IDENTITY_USER:'dhumi_test_identity_login',DATABASE_IDENTITY_PASSWORD:'identity-password-at-least-20-characters',DATABASE_CUSTOMER_API_USER:'dhumi_test_customer_api_login',DATABASE_CUSTOMER_API_PASSWORD:'customer-password-at-least-20-characters',DATABASE_ADMISSION_USER:'dhumi_test_admission_login',DATABASE_ADMISSION_PASSWORD:'admission-password-at-least-20-characters',ACCESS_TOKEN_SECRET:'test-access-token-secret-at-least-32-chars',ACCESS_TOKEN_ISSUER:'https://dhumi.test',ACCESS_TOKEN_AUDIENCE:'dhumi-browser'}),{
 signupService:{async submit(){throw Error('unexpected');}},signInService:{async authenticate(){throw Error('unexpected');}},refreshService:{async refresh(){throw Error('unexpected');}},logoutService:{async logout(){throw Error('unexpected');}},
 browserAuthenticationService:{async authenticate(authorization){if(authorization!=='Bearer fixture')throw authenticationRequired();return{userId,sessionId};}},
 tenantAuthorizationService:{async authorizeBrowserTenant(){if(denied)throw new ApplicationError({status:404,code:'RESOURCE_NOT_FOUND',title:'Not found'});return{tenantId,userId,sessionId};}},
 workspaceService:{async getWorkspace(){throw Error('unexpected');}},listCatalogTemplatesService:stubListCatalogTemplatesService,getCatalogTemplateService:stubGetCatalogTemplateService,
 listServicesService:stubListServicesService,getServiceService:stubGetServiceService,createServiceService:stubCreateServiceService,organizationActivityService:{get},
 });return{app,get};
}
describe('GET organization activity contract',()=>{
 it('accepts normal serialized integer limits and passes trusted organization/member filters',async()=>{
  const {app,get}=await build();const response=await app.inject({method:'GET',url:'/v1/organization/activity?limit=100&member='+userId,headers:{authorization:'Bearer fixture','x-dhumi-organization':tenantId}});
  expect(response.statusCode,response.body).toBe(200);expect(response.json()).toEqual(projection);
  expect(get).toHaveBeenCalledWith(expect.objectContaining({kind:'browser',tenantId,userId}),expect.objectContaining({limit:'100',member:userId}));
 });
 it('requires a browser session before querying activity',async()=>{
  const {app,get}=await build();expect((await app.inject({method:'GET',url:'/v1/organization/activity'})).statusCode).toBe(401);expect(get).not.toHaveBeenCalled();
 });
 it('refuses missing organization access before querying activity',async()=>{
  const {app,get}=await build(true);expect((await app.inject({method:'GET',url:'/v1/organization/activity',headers:{authorization:'Bearer fixture'}})).statusCode).toBe(404);expect(get).not.toHaveBeenCalled();
 });
 it.each(['limit=101','limit=0','limit=1.5','cost=true','action=security.secret','member=invalid'])('refuses unsafe or invalid filter %s',async query=>{
  const {app,get}=await build();expect((await app.inject({method:'GET',url:'/v1/organization/activity?'+query,headers:{authorization:'Bearer fixture'}})).statusCode).toBe(400);expect(get).not.toHaveBeenCalled();
 });
});
