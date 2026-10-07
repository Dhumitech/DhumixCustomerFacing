import { createScraperProcessing, ScraperContractError } from '../scrapers/scraperProcessing.js';
import type { TemplateExecutionDefinition, TemplateEngine } from '../catalogue/templateExecutionDefinition.js';
const processing=createScraperProcessing();

export function validateSharedScraperAdmission(input: {
  readonly engine: TemplateEngine;
  readonly definition: TemplateExecutionDefinition;
  readonly value: Readonly<Record<string,unknown>>;
}) {
  if(input.engine!=='scraper.v1')return {valid:true,issues:[]};
  const policy=input.definition.output_policy;
  if(typeof policy.scraper_contract_sha256!=='string' || !/^[a-f0-9]{64}$/.test(policy.scraper_contract_sha256))throw new ScraperContractError();
  return processing.prepare({operationCode:input.definition.operation_code,inputSchema:input.definition.request_schema,
    outputSchema:input.definition.result_schema,processing:policy.scraper_processing},policy.scraper_contract_sha256).validateInput(input.value);
}