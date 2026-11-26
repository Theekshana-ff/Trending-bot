// lib/bybitClient.js — Zero-dependency Bybit v5 REST API Client (Mainnet & Testnet)
import crypto from 'node:crypto';

export class BybitClient {
  constructor({ apiKey, apiSecret, testnet = false, recvWindow = 5000 } = {}) {
    this.apiKey = apiKey || '';
    this.apiSecret = apiSecret || '';
    this.recvWindow = String(recvWindow);
    this.testnet = Boolean(testnet);
    this.baseUrl = this.testnet
      ? 'https://api-testnet.bybit.com'
      : 'https://api.bybit.com';
  }

  _sign(timestamp, payload) {
    const raw = `${timestamp}${this.apiKey}${this.recvWindow}${payload}`;
    return crypto.createHmac('sha256', this.apiSecret).update(raw).digest('hex');
  }

  async request(method, path, params = {}, signed = false) {
    const upper = method.toUpperCase();
    let url = `${this.baseUrl}${path}`;
    let body = undefined;
    let signPayload = '';

    if (upper === 'GET') {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== '') qs.append(k, String(v));
      }
      const queryStr = qs.toString();
      if (queryStr) url += `?${queryStr}`;
      signPayload = queryStr;
    } else {
      body = JSON.stringify(params);
      signPayload = body;
    }

    const headers = { 'Content-Type': 'application/json' };
    if (signed) {
      if (!this.apiKey || !this.apiSecret) {
        throw new Error('Missing BYBIT_API_KEY or BYBIT_API_SECRET');
      }
      const timestamp = String(Date.now());
      headers['X-BAPI-API-KEY'] = this.apiKey;
      headers['X-BAPI-TIMESTAMP'] = timestamp;
      headers['X-BAPI-RECV-WINDOW'] = this.recvWindow;
      headers['X-BAPI-SIGN'] = this._sign(timestamp, signPayload);
    }

    const res = await fetch(url, { method: upper, headers, body });
    const data = await res.json();
    if (!res.ok || (data && data.retCode !== 0 && data.retCode !== undefined)) {
      const msg = data?.retMsg || `HTTP ${res.status}`;
      const err = new Error(`Bybit API error (${data?.retCode ?? res.status}): ${msg}`);
      err.retCode = data?.retCode;
      throw err;
    }
    return data;
  }

  getKlines(symbol, interval = '5', limit = 100) {
    return this.request('GET', '/v5/market/kline', {
      category: 'linear',
      symbol,
      interval: String(interval),
      limit,
    });
  }

  getOrderbook(symbol, limit = 5) {
    return this.request('GET', '/v5/market/orderbook', {
      category: 'linear',
      symbol,
      limit,
    });
  }

  getInstrumentInfo(symbol) {
    return this.request('GET', '/v5/market/instruments-info', {
      category: 'linear',
      symbol,
    });
  }

  getWalletBalance() {
    return this.request('GET', '/v5/account/wallet-balance', {
      accountType: 'UNIFIED',
      coin: 'USDT',
    }, true);
  }

  getPositions(symbol) {
    return this.request('GET', '/v5/position/list', {
      category: 'linear',
      settleCoin: symbol ? undefined : 'USDT',
      symbol,
    }, true);
  }

  getClosedPnL(limit = 20) {
    return this.request('GET', '/v5/position/closed-pnl', {
      category: 'linear',
      limit,
    }, true);
  }

  async setLeverage(symbol, leverage) {
    const lev = String(leverage);
    try {
      return await this.request('POST', '/v5/position/set-leverage', {
        category: 'linear',
        symbol,
        buyLeverage: lev,
        sellLeverage: lev,
      }, true);
    } catch (err) {
      if (err.retCode === 110043) return { retCode: 0, retMsg: 'Leverage unchanged' };
      throw err;
    }
  }

  submitOrder({
    symbol,
    side,
    orderType = 'Market',
    qty,
    price,
    takeProfit,
    stopLoss,
    reduceOnly = false,
    timeInForce = 'GTC',
  }) {
    const payload = {
      category: 'linear',
      symbol,
      side,
      orderType,
      qty: String(qty),
      reduceOnly,
    };
    if (orderType === 'Limit' && price) {
      payload.price = String(price);
      payload.timeInForce = timeInForce;
    }
    if (takeProfit) {
      payload.takeProfit = String(takeProfit);
      payload.tpTriggerBy = 'MarkPrice';
    }
    if (stopLoss) {
      payload.stopLoss = String(stopLoss);
      payload.slTriggerBy = 'MarkPrice';
    }
    return this.request('POST', '/v5/order/create', payload, true);
  }

  setTradingStop({ symbol, stopLoss, takeProfit }) {
    const payload = {
      category: 'linear',
      symbol,
      positionIdx: 0,
    };
    if (stopLoss) {
      payload.stopLoss = String(stopLoss);
      payload.slTriggerBy = 'MarkPrice';
    }
    if (takeProfit) {
      payload.takeProfit = String(takeProfit);
      payload.tpTriggerBy = 'MarkPrice';
    }
    return this.request('POST', '/v5/position/trading-stop', payload, true);
  }

  cancelAllOrders(symbol) {
    return this.request('POST', '/v5/order/cancel-all', {
      category: 'linear',
      symbol,
    }, true);
  }
}
