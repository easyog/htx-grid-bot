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

// Ордера для отмены: {symbol, price} — самые дальние по каждой паре
const TARGETS = [
  { sym: 'ETH/USDT', price: 2201.89 },
  { sym: 'SOL/USDT', price: 81.6229 },
  { sym: 'SUI/USDT', price: 0.9012 },
  { sym: 'ADA/USDT', price: 0.239262 },
  { sym: 'AVAX/USDT', price: 8.9909 },
  { sym: 'SOL/USDT', price: 83.2124 },
  { sym: 'ADA/USDT', price: 0.241573 },
];

(async () => {
  for (let i = 0; i < 8; i++) {
    try { await exchange.loadMarkets(); break; }
    catch (e) { console.log(`loadMarkets ${i+1}/8: ${e.message}`); await sleep(10000); }
  }

  // 1) Cancel targeted far buys
  let freed = 0;
  for (const t of TARGETS) {
    try {
      const orders = await exchange.fetchOpenOrders(t.sym);
      const match = orders.find(o => o.side === 'buy' && Math.abs(o.price - t.price) / t.price < 0.001);
      if (!match) { console.log(`[${t.sym}] buy @ ${t.price} не найден`); continue; }
      await exchange.cancelOrder(match.id, t.sym);
      const lock = match.amount * match.price;
      freed += lock;
      console.log(`[${t.sym}] cancel buy @ ${match.price} → freed $${lock.toFixed(2)}`);
      // Очищаем из state
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      const g = state.grids[t.sym];
      if (g && g.orders) {
        for (const [p, o] of Object.entries(g.orders)) {
          if (o.id === match.id || (o.side === 'buy' && Math.abs(o.price - t.price) / t.price < 0.001)) {
            delete g.orders[p];
          }
        }
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
      }
      await sleep(200);
    } catch (e) {
      console.log(`[${t.sym}] ERR: ${e.message}`);
    }
  }
  console.log(`\nTotal freed: $${freed.toFixed(2)}`);

  // 2) Check real free USDT
  const bal = await exchange.fetchBalance();
  const usdtFree = bal.USDT?.free || 0;
  console.log(`USDT free now: $${usdtFree.toFixed(2)}`);

  // 3) Place M buy @ 3.47
  const symbol = 'M/USDT';
  const market = exchange.markets[symbol];
  const ticker = await exchange.fetchTicker(symbol);
  const price = 3.470;
  const cost = Math.min(usdtFree * 0.95, 20.0);
  const amount = parseFloat((cost / price).toFixed(market.precision?.amount || 4));
  const finalPrice = parseFloat(price.toFixed(market.precision?.price || 6));
  console.log(`Placing M BUY: ${amount} M @ ${finalPrice} (cost $${(amount*finalPrice).toFixed(2)})`);

  try {
    const order = await exchange.createLimitBuyOrder(symbol, amount, finalPrice);
    console.log(`OK order ID: ${order.id}`);
    // Записать в state
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    state.grids[symbol].orders[finalPrice] = {
      id: order.id, side: 'buy', price: finalPrice, amount,
      status: 'open', placedAt: new Date().toISOString(), fromLadder: false
    };
    // Убираем из plannedLevels если было близко
    if (state.grids[symbol].plannedLevels) {
      state.grids[symbol].plannedLevels = state.grids[symbol].plannedLevels.filter(
        l => !(l.side === 'buy' && Math.abs(l.price - finalPrice) / finalPrice < 0.01)
      );
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    console.log('State обновлён. Бот увидит ордер при следующем tick.');
  } catch (e) {
    console.log(`Place M buy ERR: ${e.message}`);
  }

  process.exit(0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
