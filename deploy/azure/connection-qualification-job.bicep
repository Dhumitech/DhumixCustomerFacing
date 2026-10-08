targetScope = 'resourceGroup'

param location string = resourceGroup().location
param environmentId string
param registryIdentityId string
param backendImage string
@secure()
param apiSettings object
@secure()
param outboxSettings object
@secure()
param jobsSettings object
param checkerSource string
param jobName string = 'job-dhumi-qualification-ci-01'

var roles = ['api', 'outbox', 'jobs']
var settings = [apiSettings, outboxSettings, jobsSettings]
var roleSecrets = [for (role, index) in roles: { name: '${role}-settings', value: string(settings[index]) }]
var roleVolumes = [for role in roles: {
  name: '${role}-runtime'
  storageType: 'Secret'
  secrets: [{ secretRef: '${role}-settings', path: 'runtime.json' }]
}]

resource job 'Microsoft.App/jobs@2025-07-01' = {
  name: jobName
  location: location
  tags: { project: 'dhumi', purpose: 'temporary-readonly-connection-qualification' }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${registryIdentityId}': {} }
  }
  properties: {
    environmentId: environmentId
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 240
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      identitySettings: [{ identity: registryIdentityId, lifecycle: 'None' }]
      registries: [{ server: 'acrdhumici01.azurecr.io', identity: registryIdentityId }]
      secrets: concat(roleSecrets, [
        { name: 'connection-checker', value: checkerSource }
      ])
    }
    template: {
      containers: [for role in roles: {
        name: role
        image: backendImage
        command: ['node']
        args: ['scripts/azure/check-docker-rehearsal.mjs', role]
        resources: { cpu: json('0.25'), memory: '0.5Gi' }
        volumeMounts: [
          { volumeName: '${role}-runtime', mountPath: '/run/secrets' }
          { volumeName: 'checker', mountPath: '/app/scripts/azure' }
        ]
      }]
      volumes: concat(roleVolumes, [{
        name: 'checker'
        storageType: 'Secret'
        secrets: [{ secretRef: 'connection-checker', path: 'check-docker-rehearsal.mjs' }]
      }])
    }
  }
}

output jobId string = job.id
