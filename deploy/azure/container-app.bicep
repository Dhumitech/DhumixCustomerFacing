targetScope = 'resourceGroup'

param location string = resourceGroup().location
param environmentId string
param registryIdentityId string
param registryServer string = 'acrdhumici01.azurecr.io'
param appName string
@allowed(['api', 'frontend', 'outbox', 'jobs'])
param role string
param imageReference string
@secure()
param runtimeSettings object = {}
param apiUpstream string = ''
@minValue(0)
@maxValue(1)
param minimumReplicas int = 1

var isFrontend = role == 'frontend'
var hasIngress = isFrontend || role == 'api'
var containerPort = isFrontend ? 8080 : 3000
var probe = {
  httpGet: { path: '/v1/status', port: containerPort, scheme: 'HTTP' }
  periodSeconds: 15
  timeoutSeconds: 5
  failureThreshold: 3
}

resource app 'Microsoft.App/containerApps@2025-07-01' = {
  name: appName
  location: location
  tags: { project: 'dhumi', environment: 'demo', role: role }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${registryIdentityId}': {} }
  }
  properties: {
    environmentId: environmentId
    workloadProfileName: 'Consumption'
    configuration: union({
      activeRevisionsMode: 'Single'
      maxInactiveRevisions: 2
      identitySettings: [{ identity: registryIdentityId, lifecycle: 'None' }]
      registries: [{ server: registryServer, identity: registryIdentityId }]
      secrets: isFrontend ? [] : [{ name: 'runtime-settings', value: string(runtimeSettings) }]
    }, hasIngress ? {
      ingress: {
        external: isFrontend
        targetPort: containerPort
        transport: 'http'
        allowInsecure: false
      }
    } : {})
    template: {
      terminationGracePeriodSeconds: 60
      containers: [union({
        name: role
        image: imageReference
        resources: {
          cpu: json(role == 'jobs' ? '1.0' : (role == 'api' ? '0.5' : '0.25'))
          memory: role == 'jobs' ? '2Gi' : (role == 'api' ? '1Gi' : '0.5Gi')
        }
        volumeMounts: isFrontend ? [] : [{ volumeName: 'runtime', mountPath: '/run/secrets' }]
        env: isFrontend ? [
          { name: 'DHUMI_API_UPSTREAM', value: apiUpstream }
          { name: 'XDG_DATA_HOME', value: '/tmp/caddy-data' }
          { name: 'XDG_CONFIG_HOME', value: '/tmp/caddy-config' }
        ] : []
        probes: hasIngress ? [
          union(probe, { type: 'Readiness', initialDelaySeconds: 10 })
          union(probe, { type: 'Liveness', initialDelaySeconds: 30 })
          union(probe, { type: 'Startup', periodSeconds: 10, failureThreshold: 10 })
        ] : []
      }, isFrontend ? {} : {
        command: ['node']
        args: ['dist/deployment/runtimeEntrypoint.js', role]
      })]
      volumes: isFrontend ? [] : [{
        name: 'runtime'
        storageType: 'Secret'
        secrets: [{ secretRef: 'runtime-settings', path: 'runtime.json' }]
      }]
      scale: { minReplicas: minimumReplicas, maxReplicas: 1 }
    }
  }
}

output appId string = app.id
output appName string = app.name
output fqdn string = hasIngress ? app.properties.configuration.ingress.fqdn : ''
