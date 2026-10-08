import type { Readable } from 'node:stream';
import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { getAmazonPreciseOutputContract } from './amazonOutputContracts.js';
import { AmazonResultNormalizationError } from './amazonResultNormalizer.js';

const previous = getAmazonPreciseOutputContract('amazon.products.collect_by_url')!;
const oldItems = previous.outputSchema.items as { properties: Record<string, unknown>; required: string[] };
export const AMAZON_PRODUCTS_RESULT_V2 = Object.freeze({
  operationCode: 'amazon.products.collect_by_url', normalizerCode: previous.normalizerCode, normalizerVersion: 3,
  schemaVersion: 'amazon.products.collect-by-url.output.v2', projectedFields: previous.projectedFields,
  outputSchema: {
    ...previous.outputSchema, $id: 'urn:dhumi:schema:amazon.products.collect-by-url.output.v2',
    items: { ...oldItems, properties: { ...oldItems.properties, final_price: { type: ['number', 'null'] }, initial_price: { type: ['number', 'null'] }, availability: { type: ['string', 'null'] } } },
  },
});

const Ajv2020 = Ajv2020Module as unknown as new (options: object) => { compile(schema: object): (data: unknown) => boolean };
const addFormats = addFormatsModule as unknown as (compiler: object) => void;
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(AMAZON_PRODUCTS_RESULT_V2.outputSchema);
const optionalProviderFields = new Set(['final_price', 'initial_price', 'availability']);

export async function normalizeAmazonProductsResultV2(input: {
  readonly bytes: Readable; readonly contentType: string; readonly contentEncoding: string | null; readonly maxBytes: number;
}) {
  if (!['application/json', 'text/plain'].includes(input.contentType.toLowerCase()) || input.contentEncoding !== null || !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1) {
    input.bytes.destroy(); throw new AmazonResultNormalizationError();
  }
  const chunks: Buffer[] = []; let count = 0;
  try {
    for await (const chunk of input.bytes) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      count += bytes.length;
      if (count > input.maxBytes) { input.bytes.destroy(); throw new AmazonResultNormalizationError(); }
      chunks.push(bytes);
    }
    const records: unknown = JSON.parse(Buffer.concat(chunks, count).toString('utf8'));
    if (!Array.isArray(records) || records.some(r => !r || typeof r !== 'object' || Array.isArray(r) || Object.hasOwn(r, 'error') || Object.hasOwn(r, 'error_code'))) throw new AmazonResultNormalizationError();
    const projected = records.map(record => Object.fromEntries(AMAZON_PRODUCTS_RESULT_V2.projectedFields.map(field => [field,
      optionalProviderFields.has(field) && (!Object.hasOwn(record, field) || record[field] === null) ? null : record[field],
    ])));
    if (!validate(projected)) throw new AmazonResultNormalizationError();
    return Object.freeze({ bytes: Buffer.from(JSON.stringify(projected)), contentType: 'application/json' as const, contentEncoding: null,
      schemaVersion: AMAZON_PRODUCTS_RESULT_V2.schemaVersion, recordCount: projected.length });
  } catch (error) {
    if (error instanceof AmazonResultNormalizationError) throw error;
    throw new AmazonResultNormalizationError(error);
  }
}
