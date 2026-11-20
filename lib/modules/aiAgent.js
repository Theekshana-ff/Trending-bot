// Module 22: v7.2 Grok-Style Crypto AI Agent (Auto-Discover Active Groq Models + Optional xAI Grok)
const { fetchWithTimeout } = require('./marketData');

let cachedGroqModels = [];
let cachedAt = 0;

function getAiProviderConfig() {
  const groqKey = (process.env.GROQ_API_KEY || '').trim();
  const xaiKey = (process.env.XAI_API_KEY || '').trim();
  if (groqKey) {
    return {
      enabled: true,
      provider: 'GROQ_FREE',
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: groqKey,
      customModel: (process.env.GROQ_MODEL || '').trim()
    };
  }
  if (xaiKey) {
    return {
      enabled: true,
      provider: 'XAI_GROK',
      baseUrl: 'https://api.x.ai/v1',
      apiKey: xaiKey,
      customModel: (process.env.XAI_MODEL || 'grok-2-latest').trim()
    };
  }
  return { enabled: false, provider: 'NONE', baseUrl: '', apiKey: '', customModel: '' };
}

async function resolveActiveModels(cfg) {
  if (cfg.provider !== 'GROQ_FREE') {
    return [cfg.customModel || 'grok-2-latest'];
  }
  if (cachedGroqModels.length && Date.now() - cachedAt < 10 * 60 * 1000) {
    return cfg.customModel ? [cfg.customModel, ...cachedGroqModels.filter(m => m !== cfg.customModel)] : cachedGroqModels;
  }
  try {
    const r = await fetchWithTimeout(`${cfg.baseUrl}/models`, {
      headers: { 'Authorization': `Bearer ${cfg.apiKey}` }
    }, 4000);
    if (r.ok) {
      const j = await r.json();
      const skip = /whisper|tts|guard|safeguard|embed|prompt-guard|orpheus|playai/i;
      const ids = (j?.data || [])
        .map(m => m.id)
        .filter(id => id && !skip.test(id));
      // Prefer Llama / Qwen / DeepSeek / Mixtral / Gemma chat models first
      ids.sort((a, b) => {
        const rank = s => (/llama.*70b|llama-4|qwen/i.test(s) ? 0 : /llama/i.test(s) ? 1 : 2);
        return rank(a) - rank(b);
      });
      if (ids.length) {
        cachedGroqModels = ids.slice(0, 6);
        cachedAt = Date.now();
      }
    }
  } catch (e) {}

  const list = cachedGroqModels.length ? cachedGroqModels : ['llama-3.1-8b-instant'];
  return cfg.customModel ? [cfg.customModel, ...list.filter(m => m !== cfg.customModel)] : list;
}

async function fetchFearAndGreed() {
  try {
    const r = await fetchWithTimeout('https://api.alternative.me/fng/?limit=1', {
      headers: { 'User-Agent': 'BybitQuantBot/7.2' }
    }, 3000);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const item = j?.data?.[0];
    if (!item) throw new Error('Empty FNG');
    return { ok: true, value: Number(item.value || 50), classification: item.value_classification || 'Neutral' };
  } catch (e) {
    return { ok: false, value: 50, classification: 'Neutral', error: e.message };
  }
}

async function fetchLiveCryptoHeadlines(limit = 6) {
  try {
    const r = await fetchWithTimeout('https://min-api.cryptocompare.com/data/v2/news/?lang=EN', {
      headers: { 'User-Agent': 'BybitQuantBot/7.2' }
    }, 3000);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const list = (j?.Data || []).slice(0, limit).map(n => ({
      title: String(n.title || '').slice(0, 140),
      source: n.source || 'News',
      categories: n.categories || ''
    }));
    return { ok: true, headlines: list };
  } catch (e) {
    return { ok: false, headlines: [], error: e.message };
  }
}

async function callLlmJson({ systemPrompt, userPrompt, maxTokens = 260, temperature = 0.2 }) {
  const cfg = getAiProviderConfig();
  if (!cfg.enabled) {
    return { ok: false, provider: 'NONE', reason: 'AI_KEY_NOT_CONFIGURED' };
  }

  const models = await resolveActiveModels(cfg);
  let lastReason = 'AI_REQUEST_FAILED';

  for (const model of models) {
    try {
      const r = await fetchWithTimeout(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${cfg.apiKey}`
        },
        body: JSON.stringify({
          model,
          temperature,
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ]
        })
      }, 6500);

      if (!r.ok) {
        const txt = await r.text();
        lastReason = `AI HTTP ${r.status} (${model}): ${txt.slice(0, 120)}`;
        if (r.status === 404 || r.status === 400) continue;
        return { ok: false, provider: cfg.provider, reason: lastReason };
      }

      const j = await r.json();
      const content = j?.choices?.[0]?.message?.content || '';
      return { ok: true, provider: cfg.provider, model, content: content.trim() };
    } catch (e) {
      lastReason = e.message;
    }
  }
  return { ok: false, provider: cfg.provider, reason: lastReason };
}

async function runAiSecondOpinion({ pick, fearGreed, headlines = [], recentClosed = [] }) {
  const cfg = getAiProviderConfig();
  if (!cfg.enabled) {
    return { used: false, approve: true, provider: 'NONE', summary: 'AI key not set (using pure v6 math).' };
  }

  const newsText = headlines.length
    ? headlines.map((h, i) => `${i + 1}. ${h.title} (${h.source})`).join('\n')
    : 'No live headlines fetched.';
  const memText = recentClosed.length
    ? recentClosed.slice(0, 5).map(t => `${t.symbol} ${t.side}: PnL $${Number(t.closedPnl || 0).toFixed(2)}`).join('; ')
    : 'No recent closed trades.';

  const systemPrompt =
    'You are a strict Crypto Futures Risk & News Filter AI. ' +
    'Evaluate the proposed Bybit futures setup using the technicals, Fear & Greed, live news, and recent trade memory. ' +
    'Only VETO if there is severe breaking FUD/hack/crash news or an obvious extreme trap. ' +
    'Respond ONLY in valid JSON: {"approve": true|false, "confidence": 0-100, "reason": "short 1-sentence reason"}.';

  const userPrompt =
    `Setup: ${pick.bybitSymbol} ${pick.direction} (${pick.chartTf}, ${pick.orderType})\n` +
    `Score: ${pick.signalQualityScore}/100 | MTF: ${pick.mtfConfluenceScore}% | ADX: ${pick.adx} | RSI: ${pick.rsi} | BTC: ${pick.btcTrend}\n` +
    `Pattern: ${pick.pattern} | WhaleVol: ${pick.whaleAlert || 'NONE'} | OI: ${pick.oiChangePct}%\n` +
    `Fear & Greed: ${fearGreed?.value ?? 50} (${fearGreed?.classification || 'Neutral'})\n` +
    `Recent Closed PnL Memory: ${memText}\n` +
    `Live Crypto News:\n${newsText}`;

  const res = await callLlmJson({ systemPrompt, userPrompt, maxTokens: 160, temperature: 0.1 });
  if (!res.ok) {
    return { used: false, approve: true, provider: cfg.provider, summary: `AI bypassed (${res.reason})` };
  }

  try {
    const cleaned = res.content.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      used: true,
      provider: cfg.provider,
      approve: parsed.approve !== false,
      confidence: Number(parsed.confidence || 70),
      summary: String(parsed.reason || 'AI review completed').slice(0, 220)
    };
  } catch (e) {
    return { used: true, provider: cfg.provider, approve: true, confidence: 70, summary: res.content.slice(0, 180) };
  }
}

async function runGrokStyleChat({ question, contextSummary = '' }) {
  const cfg = getAiProviderConfig();
  if (!cfg.enabled) {
    return {
      ok: false,
      provider: 'NONE',
      reply: 'Groq AI active කරන්න Vercel Environment Variables වලට නොමිලේ ගත්ත GROQ_API_KEY එක දාන්න (console.groq.com).'
    };
  }

  const systemPrompt =
    'You are a sharp, concise Grok-style Crypto Futures AI Trading Assistant for a Bybit V5 live bot. ' +
    'Reply in the same language as the user (Sinhala / Singlish / English). ' +
    'Use the live Bybit market & account context provided. Be practical, concise (3-5 bullet points max), and never promise guaranteed profits.';

  const userPrompt = `Live Bot Context:\n${contextSummary}\n\nUser Question: ${String(question || '').slice(0, 500)}`;

  const res = await callLlmJson({ systemPrompt, userPrompt, maxTokens: 420, temperature: 0.35 });
  if (!res.ok) {
    return { ok: false, provider: cfg.provider, reply: `AI Error (${cfg.provider}): ${res.reason}` };
  }
  return { ok: true, provider: cfg.provider, model: res.model, reply: res.content };
}

module.exports = {
  getAiProviderConfig,
  fetchFearAndGreed,
  fetchLiveCryptoHeadlines,
  runAiSecondOpinion,
  runGrokStyleChat
};
