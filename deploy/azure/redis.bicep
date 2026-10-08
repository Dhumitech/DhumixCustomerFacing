targetScope = 'resourceGroup'

param location string = resourceGroup().location
param redisName string = 'redis-dhumi-ci-01'

resource redis 'Microsoft.Cache/redisEnterprise@2025-07-01' = {
  name: redisName
  location: location
  sku: {
    name: 'Balanced_B0'
  }
  tags: {
    project: 'dhumi'
    environment: 'demo'
    purpose: 'run-capacity-leases'
  }
  properties: {
    minimumTlsVersion: '1.2'
    highAvailability: 'Enabled'
    publicNetworkAccess: 'Enabled'
  }
}

// Capacity leases are ephemeral, single-key token-checked operations. Match
// the current standalone client and never evict an unexpired concurrency lease.
resource leases 'Microsoft.Cache/redisEnterprise/databases@2025-07-01' = {
  parent: redis
  name: 'default'
  properties: {
    clientProtocol: 'Encrypted'
    port: 10000
    clusteringPolicy: 'NoCluster'
    evictionPolicy: 'NoEviction'
    accessKeysAuthentication: 'Enabled'
    modules: []
    persistence: {
      aofEnabled: false
      rdbEnabled: false
    }
  }
}

output redisId string = redis.id
output hostName string = redis.properties.hostName
output databaseId string = leases.id
output port int = leases.properties.port
