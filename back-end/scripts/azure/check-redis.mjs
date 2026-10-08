import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {parseEnv} from 'node:util';
import {createClient} from 'redis';import {redisConnectionKind} from '../../src/config/redisEnvironment.ts';

let client;
try{
 const args=process.argv.slice(2);if(args.length>1||args.some(a=>!a.startsWith('--env=')))throw new Error('Unsupported profile argument');
 const backend=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
 const source=parseEnv(fs.readFileSync(path.resolve(backend,args[0]?.slice(6)||'.env.azure'),'utf8'));
 if(redisConnectionKind(source.REDIS_URL,source.NODE_ENV)!=='azure')throw new Error('Secured Azure Redis required');
 client=createClient({url:source.REDIS_URL,disableOfflineQueue:true,socket:{tls:true,minVersion:'TLSv1.2',rejectUnauthorized:true,connectTimeout:10000,reconnectStrategy:false}});
 client.on('error',()=>{});await client.connect();if(await client.ping()!=='PONG')throw new Error('Ping failed');
 const host=new URL(source.REDIS_URL).hostname;
 console.log(JSON.stringify({status:'passed',host,checks:['TLS certificate verified','Redis authentication passed','PING returned PONG'],redisWrites:0,databaseConnections:0,providerCalls:0,emailCalls:0},null,2));
}catch{console.error('Azure Redis authentication/TLS check failed. No lease or application data was written.');process.exitCode=1;}
finally{if(client?.isOpen){if(client.isReady)await client.quit();else client.destroy();}}
