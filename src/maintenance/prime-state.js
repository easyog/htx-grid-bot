import 'dotenv/config';
import './fetch-patch.js';
import ccxt from 'ccxt';
import https from 'https';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const STATE_FILE = join(ROOT, 'grid-state.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));

const exchange = new ccxt.htx({
  apiKey: process.env.HTX_API_KEY,
  secret: process.env.HTX_API_SECRET,
  timeout: 30000,
  options: { defaultType: 'spot', createMarketBuyOrderRequiresPrice: false },
  agent: new https.Agent({ rejectUnauthorized: false }),
});

(async () => {
  for (let i = 0; i < 8; i++) {
    try { await exchange.loadMarkets(); break; }
    catch (e) { console.log(`loadMarkets ${i+1}/8: ${e.message}`); await sleep(10000); }
  }

  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const config = JSON.parse(fs.readFileSync(join(ROOT, 'grid-config.json'), 'utf8'));
  const bal = await exchange.fetchBalance();

  const coinsOnBalance = Object.entries(bal)
    .filter(([k, v]) => k !== 'USDT' && k !== 'info' && k !== 'free' && k !== 'used' && k !== 'total' && typeof v === 'object')
    .filter(([k, v]) => (v.free || 0) + (v.used || 0) > 0)
    .map(([k]) => k);

  console.log(`Монеты на балансе: ${coinsOnBalance.join(', ')}`);
  console.log(`USDT: free=${bal.USDT?.free?.toFixed(2) || 0}, used=${bal.USDT?.used?.toFixed(2) || 0}`);

  state.grids = {};
  let totalBase = 0;

  // Только пары из конфига (не все монеты на балансе — прочие остаются как hold)
  const tradingSymbols = config.pairs.map(p => p.symbol);
  for (const symbol of tradingSymbols) {
    const coin = symbol.split('/')[0];
    try {
      const ticker = await exchange.fetchTicker(symbol);
      const amount = (bal[coin]?.free || 0) + (bal[coin]?.used || 0);
      const value = amount * ticker.last;
      state.grids[symbol] = {
        orders: {},
        currentPrice: ticker.last,
        budget: 0,
        step: config.pairs.find(p => p.symbol === symbol)?.stepPercent || 1.5,
        createdAt: Date.now(),
      };
      totalBase += value;
      console.log(`[${symbol}] ${amount.toFixed(6)} × $${ticker.last} = $${value.toFixed(2)}`);
      await sleep(300);
    } catch (e) {
      console.log(`[${symbol}] Ошибка тикера: ${e.message}`);
    }
  }

  // Stale монеты вне торговых пар — показываем но не учитываем
  const tradingCoins = new Set(tradingSymbols.map(s => s.split('/')[0]));
  const staleValue = coinsOnBalance
    .filter(c => !tradingCoins.has(c))
    .reduce((sum, c) => sum + ((bal[c]?.free || 0) + (bal[c]?.used || 0)) * 0, 0);
  console.log(`\nHold вне торговли: ${coinsOnBalance.filter(c => !tradingCoins.has(c)).join(', ')}`);

  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  const usdtTotal = (bal.USDT?.free || 0) + (bal.USDT?.used || 0);
  console.log(`\nСтоимость монет: $${totalBase.toFixed(2)}`);
  console.log(`USDT: $${usdtTotal.toFixed(2)}`);
  console.log(`Total: $${(totalBase + usdtTotal).toFixed(2)}`);
  console.log(`state.grids заполнен ценами ${Object.keys(state.grids).length} пар`);
})();
