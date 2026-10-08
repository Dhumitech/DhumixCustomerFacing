targetScope = 'resourceGroup'

@description('Keep application infrastructure in the existing resource-group region.')
param location string = resourceGroup().location

param environmentName string = 'cae-dhumi-ci-01'
param workspaceName string = 'law-dhumi-ci-01'
param virtualNetworkName string = 'vnet-dhumi-ci-01'
param infrastructureSubnetName string = 'snet-containerapps'
param infrastructureResourceGroupName string = 'rg-dhumi-aca-managed-ci-01'

@description('Dedicated new application network, checked against existing subscription ranges.')
param virtualNetworkCidr string = '10.60.0.0/16'
param infrastructureSubnetCidr string = '10.60.0.0/23'

@minValue(30)
@maxValue(730)
param logRetentionDays int = 30

var resourceTags = {
  project: 'dhumi'
  environment: 'demo'
  purpose: 'application-hosting'
}

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: workspaceName
  location: location
  tags: resourceTags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: logRetentionDays
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource virtualNetwork 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: virtualNetworkName
  location: location
  tags: resourceTags
  properties: {
    addressSpace: {
      addressPrefixes: [virtualNetworkCidr]
    }
    subnets: [
      {
        name: infrastructureSubnetName
        properties: {
          addressPrefix: infrastructureSubnetCidr
          delegations: [
            {
              name: 'container-apps'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
        }
      }
    ]
  }
}

resource environment 'Microsoft.App/managedEnvironments@2025-07-01' = {
  name: environmentName
  location: location
  tags: resourceTags
  properties: {
    infrastructureResourceGroup: infrastructureResourceGroupName
    publicNetworkAccess: 'Enabled'
    zoneRedundant: true
    vnetConfiguration: {
      infrastructureSubnetId: resourceId('Microsoft.Network/virtualNetworks/subnets', virtualNetwork.name, infrastructureSubnetName)
      internal: false
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: workspace.properties.customerId
        // ARM resolves this service credential; never output or save it locally.
        sharedKey: workspace.listKeys().primarySharedKey
      }
    }
  }
}

output environmentId string = environment.id
output environmentName string = environment.name
output defaultDomain string = environment.properties.defaultDomain
output workspaceId string = workspace.id
output workspaceCustomerId string = workspace.properties.customerId
output virtualNetworkId string = virtualNetwork.id
output infrastructureSubnetId string = resourceId('Microsoft.Network/virtualNetworks/subnets', virtualNetwork.name, infrastructureSubnetName)
output infrastructureResourceGroup string = infrastructureResourceGroupName
