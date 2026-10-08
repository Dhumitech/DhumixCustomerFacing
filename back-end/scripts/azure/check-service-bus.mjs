import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {parseEnv} from 'node:util';
import {projectDeploymentEnvironment} from '../../src/deployment/environment.ts';
import {loadOutboxDispatcherConfig,loadJobManagerConfig} from '../../src/config/pattern4Environment.ts';
import {createConfiguredServiceBusClient} from '../../src/services/jobs/serviceBusExecutionQueue.ts';

const backend=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');let senderClient,receiverClient,sender,receiver;
try{
 const args=process.argv.slice(2);if(args.length>1||args.some(a=>!a.startsWith('--env=')))throw new Error('Unsupported profile argument');
 const source=parseEnv(fs.readFileSync(path.resolve(backend,args[0]?.slice(6)||'.env.azure'),'utf8'));
 const sending=loadOutboxDispatcherConfig(projectDeploymentEnvironment('outbox',source)).serviceBus;
 const receiving=loadJobManagerConfig(projectDeploymentEnvironment('jobs',source)).serviceBus;
 if(sending.driver!=='azure'||receiving.driver!=='azure'||sending.fullyQualifiedNamespace!==receiving.fullyQualifiedNamespace||sending.queueName!==receiving.queueName)throw new Error('One Azure queue required');
 senderClient=createConfiguredServiceBusClient(sending);receiverClient=createConfiguredServiceBusClient(receiving);
 sender=senderClient.createSender(sending.queueName);receiver=receiverClient.createReceiver(receiving.queueName,{receiveMode:'peekLock'});
 // Creating a batch opens/authenticates the sender link without sending. Peek
 // authenticates Listen without locking, consuming or exposing any message.
 await sender.createMessageBatch();await receiver.peekMessages(1);
 console.log(JSON.stringify({status:'passed',namespace:sending.fullyQualifiedNamespace,queue:sending.queueName,checks:['Entra sender link authenticated','Entra receiver peek authenticated'],messagesSent:0,messagesConsumed:0,databaseConnections:0,providerCalls:0,emailCalls:0},null,2));
}catch{console.error('Service Bus authentication/link check failed. No messages were submitted by this checker.');process.exitCode=1;}
finally{await Promise.allSettled([sender?.close(),receiver?.close()]);await Promise.allSettled([senderClient?.close(),receiverClient?.close()]);}
