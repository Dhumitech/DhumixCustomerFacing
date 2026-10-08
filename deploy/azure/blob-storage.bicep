targetScope = 'resourceGroup'

@description('Existing resource-group region. Keep result storage near the application and database.')
param location string = resourceGroup().location

@minLength(3)
@maxLength(24)
param storageAccountName string = 'stdhumici01'

param resultsContainerName string = 'dhumi-results'

@allowed(['demo', 'production'])
param environment string = 'demo'

@minValue(7)
@maxValue(365)
@description('Recovery window after deletion; does not expire active Run results.')
param deletionRecoveryDays int = 7

resource storage 'Microsoft.Storage/storageAccounts@2025-06-01' = {
  name: storageAccountName
  location: location
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  tags: {
    project: 'dhumi'
    environment: environment
    purpose: 'run-results'
  }
  properties: {
    accessTier: 'Hot'
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    allowCrossTenantReplication: false
    isHnsEnabled: false
    // Authenticated HTTPS endpoint. Private networking is a later hosting decision.
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      bypass: 'None'
      defaultAction: 'Allow'
    }
    encryption: {
      keySource: 'Microsoft.Storage'
      services: {
        blob: {
          enabled: true
          keyType: 'Account'
        }
      }
    }
  }
}

resource blobs 'Microsoft.Storage/storageAccounts/blobServices@2025-06-01' = {
  parent: storage
  name: 'default'
  properties: {
    isVersioningEnabled: true
    deleteRetentionPolicy: {
      enabled: true
      days: deletionRecoveryDays
    }
    containerDeleteRetentionPolicy: {
      enabled: true
      days: deletionRecoveryDays
    }
    cors: {
      corsRules: []
    }
  }
}

resource results 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-06-01' = {
  parent: blobs
  name: resultsContainerName
  properties: {
    publicAccess: 'None'
    metadata: {
      dhumi_layout_version: '1'
      dhumi_purpose: 'run_results'
    }
  }
}

output storageAccountId string = storage.id
output storageAccountName string = storage.name
output blobServiceEndpoint string = storage.properties.primaryEndpoints.blob
output resultsContainerId string = results.id
output resultsContainerName string = results.name
