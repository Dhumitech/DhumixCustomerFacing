import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {loadOperatorConfig} from '../config/operatorEnvironment.js';
import {createOperatorPool} from '../services/database/pools.js';
import {verifyOperatorPool} from '../services/database/roleVerification.js';
import {withOperatorTransaction} from '../services/database/transactions.js';
import {createTemplateBindingRepository} from '../services/brightdata/templateBindingRepository.js';
import {createLocalProviderReferenceProtector} from '../services/brightdata/providerReferenceProtector.js';
export function parseTemplateCommand(args:readonly string[]){
 const action=args[0];if(action!=='set-dataset'&&action!=='publish')throw Error('Use set-dataset or publish.');
 const options:Record<string,string|true>={};
 for(let i=1;i<args.length;i++){const key=args[i];if(!key?.startsWith('--')||Object.hasOwn(options,key))throw Error('Invalid template options.');
  if(key==='--confirm'){options[key]=true;continue;}const value=args[++i];if(!value||value.startsWith('--'))throw Error('Missing template option value.');options[key]=value;}
 const allowed=['--version','--by','--expected-database','--confirm',action==='publish'?'--evidence':'--dataset-file'];
 if(Object.keys(options).some(k=>!allowed.includes(k))||options['--confirm']!==true||options['--expected-database']!=='dhumi_test'||typeof options['--by']!=='string'||
  !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(options['--by'])||typeof options['--version']!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(options['--version'])||
  typeof options[action==='publish'?'--evidence':'--dataset-file']!=='string')throw Error('Explicit version, existing user email, dhumi_test target and confirmation are required.');
 return{action,version:options['--version'],by:options['--by'].trim().toLowerCase(),evidence:options['--evidence'] as string|undefined,datasetFile:options['--dataset-file'] as string|undefined};
}
/** Uses the existing operator login and owner-provided protection key. */
export async function runTemplateCommand(args:readonly string[]=process.argv.slice(2)){
 const options=parseTemplateCommand(args),config=loadOperatorConfig();
 if(config.database.database!=='dhumi_test'||config.database.port!==5432||!['localhost','127.0.0.1'].includes(config.database.host))throw Error('Only local main dhumi_test is supported by this command.');
 const pool=createOperatorPool(config.database,()=>undefined,'dhumi-template');
 try{
  await verifyOperatorPool(pool,config.database.credential.user);
  const actor=await withOperatorTransaction(pool,async db=>{
   const ready=await db.query<{ready:boolean}>("SELECT to_regclass('app.service_versions') IS NULL AND to_regclass('app.organizations') IS NOT NULL AND EXISTS(SELECT 1 FROM app.schema_migrations WHERE version='0075_naming') AS ready");
   if(ready.rows[0]?.ready!==true)throw Error('Reviewed 0075 must be applied first.');
   const user=await db.query<{id:string}>('SELECT id FROM app.users WHERE email_normalized=$1 AND state=\'active\'',[options.by]);
   if(user.rows.length!==1)throw Error('A real active operator user is required.');return user.rows[0]!.id;
  });
  const protector=createLocalProviderReferenceProtector('test',process.env.PROVIDER_REFERENCE_LOCAL_KEY??'');
  const repository=createTemplateBindingRepository(pool,protector);
  if(options.action==='set-dataset'){
   const bytes=readFileSync(resolve(options.datasetFile!));if(bytes.length>256)throw Error('Invalid private binding file.');
   await repository.setDataset({templateVersionId:options.version,operatorUserId:actor,datasetId:bytes.toString('utf8').trim()});
  }else await repository.publish({templateVersionId:options.version,operatorUserId:actor,evidenceReference:options.evidence!});
  return{action:options.action,templateVersionId:options.version,operatorUserId:actor};
 }finally{await pool.end();}
}
const invoked=process.argv[1];
if(invoked&&pathToFileURL(resolve(invoked)).href===import.meta.url)runTemplateCommand().then(result=>process.stdout.write(JSON.stringify(result)+'\n')).catch(()=>{process.stderr.write('Template command refused or failed. Review target, 0075, active operator user, private binding key and accepted evidence.\n');process.exitCode=1;});
