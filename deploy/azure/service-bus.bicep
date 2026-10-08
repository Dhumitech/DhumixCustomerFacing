targetScope = 'resourceGroup'

param location string = resourceGroup().location
param namespaceName string = 'sb-dhumi-ci-01'
param queueName string = 'dhumi-run-commands'

resource bus 'Microsoft.ServiceBus/namespaces@2024-01-01' = {
  name: namespaceName
  location: location
  sku: {
    name: 'Standard'
    tier: 'Standard'
  }
  tags: {
    project: 'dhumi'
    environment: 'demo'
    purpose: 'run-commands'
  }
  properties: {
    minimumTlsVersion: '1.2'
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}

// Match the tested queue contract. PostgreSQL provides Run ordering/fencing;
// receivers do not use Service Bus sessions. Runtime never provisions entities.
resource commands 'Microsoft.ServiceBus/namespaces/queues@2024-01-01' = {
  parent: bus
  name: queueName
  properties: {
    requiresDuplicateDetection: true
    duplicateDetectionHistoryTimeWindow: 'PT5M'
    defaultMessageTimeToLive: 'PT1H'
    deadLetteringOnMessageExpiration: true
    lockDuration: 'PT1M'
    maxDeliveryCount: 5
    maxSizeInMegabytes: 1024
    requiresSession: false
    enablePartitioning: false
    enableExpress: false
    enableBatchedOperations: true
  }
}

output namespaceId string = bus.id
output fullyQualifiedNamespace string = '${namespaceName}.servicebus.windows.net'
output commandQueueId string = commands.id
output commandQueueName string = commands.name
