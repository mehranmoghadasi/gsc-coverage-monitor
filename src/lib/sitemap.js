/**
 * sitemap.js — enumerate URLs from XML sitemaps / sitemap indexes with no XML dependency.
 * Used to seed the URL Inspection sample; GSC itself doesn't list a property's URLs.
 */

const LOC_RE = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;

/** @returns {{isIndex:boolean, urls:string[]}} */
export function parseSitemap(xml) {
  const urls = [];
  for (const m of xml.matchAll(LOC_RE)) urls.push(decodeXml(m[1]));
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  return { isIndex, urls };
}

function decodeXml(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/**
 * Fetch a sitemap (recursing into indexes) and return page URLs.
 * @param {string} url
 * @param {{fetchImpl?: typeof fetch, maxSitemaps?: number, maxUrls?: number}} opts
 */
export async function fetchSitemapUrls(url, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxSitemaps = opts.maxSitemaps ?? 50;
  const maxUrls = opts.maxUrls ?? 50000;
  const queue = [url];
  const seen = new Set();
  const pages = new Set();
  while (queue.length && seen.size < maxSitemaps && pages.size < maxUrls) {
    const next = queue.shift();
    if (seen.has(next)) continue;
    seen.add(next);
    let xml;
    try {
      const res = await fetchImpl(next, { headers: { 'user-agent': 'gsc-coverage-monitor/2.0 (+https://github.com/mehranmoghadasi/gsc-coverage-monitor)' } });
      if (!res.ok) continue;
      xml = await res.text();
    } catch {
      continue;
    }
    const { isIndex, urls } = parseSitemap(xml);
    if (isIndex) queue.push(...urls);
    else for (const u of urls) pages.add(u);
  }
  return [...pages];
}
