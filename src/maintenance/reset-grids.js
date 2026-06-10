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
  let loaded = false;
  for (let i = 0; i < 8; i++) {
    try {
      await exchange.loadMarkets();
      loaded = true;
      break;
    } catch (e) {
      console.log(`loadMarkets попытка ${i+1}/8: ${e.message}`);
      await sleep(10000);
    }
  }
  if (!loaded) throw new Error('Не удалось загрузить рынки');
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const config = JSON.parse(fs.readFileSync(join(ROOT, 'grid-config.json'), 'utf8'));

  const symbolSet = new Set([
    ...Object.keys(state.grids),
    ...config.pairs.map(p => p.symbol),
    'BTC/USDT', 'BSV/USDT',
  ]);
  const symbols = [...symbolSet];
  console.log(`Проверяю ${symbols.length} пар: ${symbols.join(', ')}`);

  for (const symbol of symbols) {
    try {
      const orders = await exchange.fetchOpenOrders(symbol);
      console.log(`[${symbol}] ${orders.length} открытых ордеров — отменяю...`);
      for (const o of orders) {
        try {
          await exchange.cancelOrder(o.id, symbol);
          await sleep(100);
        } catch (e) {
          console.log(`  Ошибка отмены ${o.id}: ${e.message}`);
        }
      }
    } catch (e) {
      console.log(`[${symbol}] Ошибка: ${e.message}`);
    }
    await sleep(300);
  }

  state.grids = {};
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log('\nstate.grids очищены. Trades и totalProfit сохранены.');
  console.log(`totalProfit: $${state.totalProfit}`);
})();
