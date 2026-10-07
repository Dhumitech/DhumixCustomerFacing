/** Historical mapping context, used only by the reviewed 0072 re-encryption path. */
export function providerMappingAad(mappingId:string):Buffer {
  return Buffer.from(`dhumi:provider-mapping:v1:${mappingId}`,'utf8');
}
export function providerDatasetAad(templateVersionId:string):Buffer {
  return Buffer.from(`dhumi:template-dataset:v1:${templateVersionId}`,'utf8');
}
export function providerSnapshotAad(input:{readonly tenantId:string;readonly runId:string;readonly attemptId:string}):Buffer {
  return Buffer.from(`dhumi:provider-snapshot:v1:${input.tenantId}:${input.runId}:${input.attemptId}`,'utf8');
}
