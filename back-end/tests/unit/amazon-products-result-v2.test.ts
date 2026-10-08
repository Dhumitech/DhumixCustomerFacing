import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { normalizeAmazonProductsResultV2 } from '../../src/services/brightdata/amazon/amazonProductsResultV2.js';
import { AmazonResultNormalizationError, normalizeAmazonProviderResult } from '../../src/services/brightdata/amazon/amazonResultNormalizer.js';

const product = { asin: 'B00CK01P2A', title: 'Air filter variant', url: 'https://www.amazon.com/dp/B00CK01P2A', domain: 'amazon.com', currency: 'USD',
  final_price: 43.98, initial_price: 43.98, rating: 4.7, reviews_count: 45620, availability: 'In Stock', brand: 'Filterbuy',
  image_url: 'https://m.media-amazon.com/images/I/example.jpg', timestamp: '2026-10-08T07:51:30Z' };
const envelope = (rows: unknown) => ({ bytes: Readable.from([JSON.stringify(rows)]), contentType: 'application/json', contentEncoding: null, maxBytes: 200000 });

describe('Amazon product output v2: optional provider variant fields', () => {
  it('keeps all 136 products when nine variants omit pricing/availability', async () => {
    const rows = Array.from({ length: 136 }, (_, i) => {
      const row: Record<string, unknown> = { ...product, asin: `B${String(i).padStart(9, '0')}`, input: { private: 'not in normalized data' }, provider_nested_data: { private: true } };
      if (i < 9) { delete row.final_price; delete row.initial_price; delete row.availability; }
      return row;
    });
    const result = await normalizeAmazonProductsResultV2(envelope(rows));
    expect(result.recordCount).toBe(136);
    expect(result.schemaVersion).toBe('amazon.products.collect-by-url.output.v2');
    const normalized = JSON.parse(result.bytes.toString('utf8'));
    expect(normalized[0]).toMatchObject({ final_price: null, initial_price: null, availability: null });
    expect(normalized[9]).toMatchObject({ final_price: 43.98, initial_price: 43.98, availability: 'In Stock' });
    expect(normalized[0]).not.toHaveProperty('input');
    expect(normalized[0]).not.toHaveProperty('provider_nested_data');
  });
  it('preserves explicit unknown values without inventing a price or stock status', async () => {
    const result = await normalizeAmazonProductsResultV2(envelope([{ ...product, final_price: null, initial_price: null, availability: null }]));
    expect(JSON.parse(result.bytes.toString('utf8'))[0]).toMatchObject({ final_price: null, initial_price: null, availability: null });
  });
  it('does not change the pinned previous normalizer contract', async () => {
    const row: Record<string, unknown> = { ...product }; delete row.final_price;
    await expect(normalizeAmazonProviderResult({ ...envelope([row]), operationCode: 'amazon.products.collect_by_url' })).rejects.toBeInstanceOf(AmazonResultNormalizationError);
  });
  it.each([{ ...product, final_price: 'unknown' }, { ...product, asin: null }, { ...product, url: 'not a url' }, { ...product, error: 'private provider error' }])('rejects malformed/provider error records rather than hiding them', async row => {
    await expect(normalizeAmazonProductsResultV2(envelope([row]))).rejects.toBeInstanceOf(AmazonResultNormalizationError);
  });
  it('rejects oversized input', async () => {
    await expect(normalizeAmazonProductsResultV2({ ...envelope([product]), maxBytes: 10 })).rejects.toBeInstanceOf(AmazonResultNormalizationError);
  });
});
