import 'dotenv/config';
import './fetch-patch.js';
import ccxt from 'ccxt';
import https from 'https';

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

  const bal = await exchange.fetchBalance();
  const usdtFree = bal.USDT?.free || 0;
  const usdtUsed = bal.USDT?.used || 0;

  console.log('═══ БАЛАНС HTX SPOT ═══\n');
  console.log(`USDT free:  $${usdtFree.toFixed(2)}`);
  console.log(`USDT used:  $${usdtUsed.toFixed(2)} (в ордерах)`);
  console.log(`USDT total: $${(usdtFree + usdtUsed).toFixed(2)}\n`);

  console.log('Монеты:');
  console.log(`${'Coin'.padEnd(6)} ${'Free'.padEnd(14)} ${'Used'.padEnd(14)} ${'Total'.padEnd(14)} ${'Price'.padEnd(12)} Value`);

  const coins = Object.entries(bal)
    .filter(([k, v]) => k !== 'USDT' && k !== 'info' && k !== 'free' && k !== 'used' && k !== 'total' && typeof v === 'object')
    .filter(([k, v]) => (v.free || 0) + (v.used || 0) > 0);

  let totalCoinValue = 0;
  const TRADING = ['SOL', 'AVAX', 'DOGE', 'ETH', 'TON', 'ADA'];
  const tradingValue = {};
  const holdValue = {};

  for (const [coin, v] of coins) {
    const free = v.free || 0;
    const used = v.used || 0;
    const total = free + used;
    const symbol = `${coin}/USDT`;
    let price = 0;
    let value = 0;
    try {
      const ticker = await exchange.fetchTicker(symbol);
      price = ticker.last;
      value = total * price;
      totalCoinValue += value;
      if (TRADING.includes(coin)) tradingValue[coin] = value;
      else holdValue[coin] = value;
    } catch (e) {
      console.log(`  [${symbol}] ошибка тикера: ${e.message}`);
    }
    console.log(`${coin.padEnd(6)} ${free.toFixed(6).padEnd(14)} ${used.toFixed(6).padEnd(14)} ${total.toFixed(6).padEnd(14)} $${price.toString().padEnd(10)} $${value.toFixed(2)}`);
    await sleep(200);
  }

  console.log(`\n─── РАЗБИВКА ───`);
  let tradingSum = 0;
  for (const [c, v] of Object.entries(tradingValue)) {
    console.log(`  [ТОРГУЕТСЯ] ${c}: $${v.toFixed(2)}`);
    tradingSum += v;
  }
  let holdSum = 0;
  for (const [c, v] of Object.entries(holdValue)) {
    console.log(`  [HOLD]      ${c}: $${v.toFixed(2)}`);
    holdSum += v;
  }

  console.log(`\n─── ИТОГО ───`);
  console.log(`USDT (free + used):        $${(usdtFree + usdtUsed).toFixed(2)}`);
  console.log(`Торговые монеты (6 пар):   $${tradingSum.toFixed(2)}`);
  console.log(`Hold монеты:               $${holdSum.toFixed(2)}`);
  console.log(`ОБЩИЙ БАЛАНС БИРЖИ:        $${(usdtFree + usdtUsed + totalCoinValue).toFixed(2)}`);
  console.log(`Рабочий капитал грида:     $${(usdtFree + usdtUsed + tradingSum).toFixed(2)}`);
})();
