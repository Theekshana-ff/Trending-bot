// File: api/news.js (H-03: Strict Live News Only — No Fake/Static Fallback Headlines)
const { fetchWithTimeout } = require('../lib/modules/marketData');
const { makeResponse } = require('../lib/modules/securityAndState');

module.exports = async (req, res) => {
  try {
    const r = await fetchWithTimeout('https://min-api.cryptocompare.com/data/v2/news/?lang=EN', {}, 3000);
    if (!r.ok) {
      return res.status(200).json(makeResponse(false, { items: [], error: `News provider HTTP ${r.status}` }, { sourceStatus: 'UNAVAILABLE', errorCode: 'NEWS_UNAVAILABLE' }));
    }
    const j = await r.json();
    const list = Array.isArray(j?.Data) ? j.Data.slice(0, 12).map(n => ({
      title: n.title,
      source: n.source_info?.name || n.source || 'Unknown',
      url: n.url,
      publishedAt: n.published_on ? new Date(n.published_on * 1000).toISOString() : null
    })) : [];

    if (!list.length) {
      return res.status(200).json(makeResponse(false, { items: [] }, { sourceStatus: 'UNAVAILABLE', errorCode: 'NEWS_EMPTY' }));
    }
    return res.status(200).json(makeResponse(true, { items: list }, { sourceStatus: 'LIVE_NEWS_VERIFIED' }));
  } catch (e) {
    return res.status(200).json(makeResponse(false, { items: [], error: e.message }, { sourceStatus: 'UNAVAILABLE', errorCode: 'NEWS_FETCH_FAILED' }));
  }
};
