import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSitemap, fetchSitemapUrls } from '../src/lib/sitemap.js';
import { belongsToProperty, pickInspectionSample } from '../src/lib/sampler.js';

const INDEX = `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<sitemap><loc>https://x.com/a.xml</loc></sitemap><sitemap><loc>https://x.com/b.xml</loc></sitemap></sitemapindex>`;
const A = `<urlset><url><loc>https://x.com/1</loc></url><url><loc> https://x.com/2?a=1&amp;b=2 </loc></url></urlset>`;
const B = `<urlset><url><loc>https://x.com/1</loc></url><url><loc>https://x.com/3</loc></url></urlset>`;

test('parseSitemap detects index vs urlset and decodes entities', () => {
  assert.equal(parseSitemap(INDEX).isIndex, true);
  assert.deepEqual(parseSitemap(A).urls, ['https://x.com/1', 'https://x.com/2?a=1&b=2']);
});

test('fetchSitemapUrls recurses and de-duplicates', async () => {
  const pages = { 'https://x.com/i.xml': INDEX, 'https://x.com/a.xml': A, 'https://x.com/b.xml': B };
  const fetchImpl = async (u) => ({ ok: !!pages[u], text: async () => pages[u] ?? '' });
  const urls = await fetchSitemapUrls('https://x.com/i.xml', { fetchImpl });
  assert.deepEqual(urls.sort(), ['https://x.com/1', 'https://x.com/2?a=1&b=2', 'https://x.com/3']);
});

test('belongsToProperty handles domain and URL-prefix properties', () => {
  assert.equal(belongsToProperty('https://www.x.com/p', 'sc-domain:x.com'), true);
  assert.equal(belongsToProperty('https://y.com/p', 'sc-domain:x.com'), false);
  assert.equal(belongsToProperty('https://x.com/p', 'https://x.com/'), true);
  assert.equal(belongsToProperty('http://x.com/p', 'https://x.com/'), false);
  assert.equal(belongsToProperty('not a url', 'sc-domain:x.com'), false);
});

test('pickInspectionSample prioritises vanished, dedupes, caps at budget', () => {
  assert.deepEqual(pickInspectionSample(['a', 'b'], ['b', 'c', 'd'], 3), ['a', 'b', 'c']);
  assert.deepEqual(pickInspectionSample([], [], 5), []);
});
