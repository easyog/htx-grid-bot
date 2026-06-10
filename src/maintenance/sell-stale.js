// Продажа hold-монет: всё что НЕ в config.pairs и НЕ в списке защищённых (BTC/BSV)
// Динамически читает grid-config.json + grid-state.json, продаёт всё лишнее
import 'dotenv/config';
import './fetch-patch.js';
import ccxt from 'ccxt';
import https from 'https';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CONFIG_FILE = join(ROOT, 'grid-config.json');
const STATE_FILE = join(ROOT, 'grid-state.json');

// Монеты которые НЕ продавать даже если не в торговле (личный hold)
const PROTECTED = new Set(['BTC', 'BSV', 'USDT', 'USDC', 'USDD', 'HUSD', 'DAI']);

const sleep = ms => new Promise(r => setTimeout(r, ms));

const exchange = new ccxt.htx({
  apiKey: process.env.HTX_API_KEY,
  secret: process.env.HTX_API_SECRET,
  timeout: 30000,
  options: { defaultType: 'spot', createMarketBuyOrderRequiresPrice: false },
  agent: new https.Agent({ rejectUnauthorized: false }),
});

(async () => {
  // Загрузка с ретраями
  for (let i = 0; i < 10; i++) {
    try { await exchange.loadMarkets(); break; }
    catch (e) {
      console.log(`loadMarkets ${i + 1}/10: ${e.message}`);
      await sleep(Math.min(5000 * Math.pow(1.4, i), 60000));
    }
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

  // Торговые монеты (из config И из state.grids — на случай десинхрона)
  const tradingCoins = new Set();
  for (const p of config.pairs || []) tradingCoins.add(p.symbol.split('/')[0]);
  for (const sym of Object.keys(state.grids || {})) tradingCoins.add(sym.split('/')[0]);

  console.log(`Торговые монеты (оставляем): ${[...tradingCoins].join(', ') || 'нет'}`);
  console.log(`Защищённые: ${[...PROTECTED].join(', ')}`);

  const bal = await exchange.fetchBalance();
  const candidates = [];

  for (const [coin, v] of Object.entries(bal)) {
    if (typeof v !== 'object') continue;
    if (coin === 'info' || coin === 'free' || coin === 'used' || coin === 'total') continue;
    if (tradingCoins.has(coin)) continue;
    if (PROTECTED.has(coin)) continue;

    const free = v.free || 0;
    const used = v.used || 0;
    if (free + used <= 0) continue;
    candidates.push({ coin, free, used });
  }

  if (candidates.length === 0) {
    console.log('Нет монет для продажи — всё чисто');
    return;
  }

  console.log(`\nНайдено ${candidates.length} монет для ликвидации:`);
  for (const c of candidates) console.log(`  ${c.coin}: free=${c.free}, used=${c.used}`);
  console.log();

  let sold = 0, skipped = 0, totalReceived = 0;

  for (const { coin, free, used } of candidates) {
    const symbol = `${coin}/USDT`;

    // Отменяем открытые ордера по этой паре (используются в `used`)
    if (used > 0) {
      try {
        const openOrders = await exchange.fetchOpenOrders(symbol);
        for (const o of openOrders) {
          try { await exchange.cancelOrder(o.id, symbol); await sleep(200); }
          catch (e) { console.log(`  Cancel ${o.id} failed: ${e.message}`); }
        }
        if (openOrders.length > 0) {
          console.log(`[${symbol}] Отменено ${openOrders.length} открытых ордеров`);
          await sleep(1500); // ждём возврата used→free
        }
      } catch {}
    }

    // Свежий баланс после cancel
    let amount = free + used;
    try {
      const fresh = await exchange.fetchBalance();
      amount = fresh[coin]?.free || 0;
    } catch {}

    if (amount <= 0) { skipped++; continue; }

    let market;
    try { market = exchange.market(symbol); }
    catch {
      console.log(`[${symbol}] Нет пары на HTX — пропуск (${amount} ${coin} остаётся)`);
      skipped++;
      continue;
    }

    let ticker;
    try { ticker = await exchange.fetchTicker(symbol); }
    catch (e) {
      console.log(`[${symbol}] fetchTicker failed: ${e.message}`);
      skipped++;
      continue;
    }

    const price = ticker.last;
    const value = amount * price;
    const minAmount = market.limits.amount?.min || 0;
    const minCost = market.limits.cost?.min || 0;

    if (amount < minAmount || value < minCost) {
      console.log(`[${symbol}] ${amount.toFixed(6)} × $${price} = $${value.toFixed(2)} < min($${minCost}) — DUST, пропуск`);
      skipped++;
      continue;
    }

    const precAmount = market.precision.amount;
    const decimals = precAmount && precAmount < 1 ? Math.ceil(-Math.log10(precAmount)) : (precAmount || 8);
    const sellAmount = +(amount * 0.998).toFixed(decimals); // -0.2% запас на precision

    if (sellAmount < minAmount || sellAmount * price < minCost) {
      console.log(`[${symbol}] После precision ${sellAmount} < min — пропуск`);
      skipped++;
      continue;
    }

    console.log(`[${symbol}] Продаю ${sellAmount} ${coin} по рынку (~$${value.toFixed(2)})...`);
    try {
      const order = await exchange.createMarketSellOrder(symbol, sellAmount);
      const filled = order.filled || sellAmount;
      const avg = order.average || price;
      const received = filled * avg;
      sold++;
      totalReceived += received;
      console.log(`  ✓ ${filled} × $${avg} = $${received.toFixed(2)}`);
    } catch (e) {
      console.log(`  ✗ Ошибка: ${e.message}`);
      skipped++;
    }
    await sleep(500);
  }

  console.log(`\n=== ИТОГ ===`);
  console.log(`Продано: ${sold} | Пропущено: ${skipped}`);
  console.log(`Получено USDT: ~$${totalReceived.toFixed(2)}`);

  await sleep(2000);
  try {
    const newBal = await exchange.fetchBalance();
    console.log(`USDT после: free=${(newBal.USDT?.free || 0).toFixed(2)}, used=${(newBal.USDT?.used || 0).toFixed(2)}`);
  } catch {}

  process.exit(0);
})().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
