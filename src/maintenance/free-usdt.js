import 'dotenv/config';
import './fetch-patch.js';
import ccxt from 'ccxt';
import https from 'https';
import fs from 'fs';

const ex = new ccxt.htx({
  apiKey: process.env.HTX_API_KEY,
  secret: process.env.HTX_API_SECRET,
  timeout: 30000,
  options: { defaultType: 'spot' },
  agent: new https.Agent({ rejectUnauthorized: false }),
});

// cancel the farthest single buy (most negative pct diff) on each pair
const TARGETS = ['SOL/USDT', 'AVAX/USDT'];

(async () => {
  const state = JSON.parse(fs.readFileSync('./grid-state.json', 'utf8'));
  for (const sym of TARGETS) {
    const tkr = await ex.fetchTicker(sym);
    const orders = await ex.fetchOpenOrders(sym);
    const buys = orders.filter(o => o.side === 'buy').sort((a, b) => a.price - b.price);
    if (!buys.length) { console.log(`[${sym}] no buys`); continue; }
    const far = buys[0]; // lowest price = farthest buy
    const diff = ((far.price - tkr.last) / tkr.last * 100).toFixed(2);
    console.log(`[${sym}] cancelling farthest buy @ ${far.price} (${diff}%) cost=$${(far.price*far.amount).toFixed(2)} id=${far.id}`);
    try {
      await ex.cancelOrder(far.id, sym);
      console.log(`  ✓ cancelled`);
      // remove from state
      const g = state.grids?.[sym];
      if (g?.orders) {
        for (const [k, o] of Object.entries(g.orders)) {
          if (o.id === far.id) { delete g.orders[k]; break; }
        }
      }
    } catch (e) { console.log(`  ✗ ${e.message}`); }
  }
  fs.writeFileSync('./grid-state.json', JSON.stringify(state, null, 2));
  console.log('\nstate updated');

  // show new balance
  const bal = await ex.fetchBalance();
  const u = bal.USDT || {};
  console.log(`USDT free: ${(u.free||0).toFixed(2)}  used: ${(u.used||0).toFixed(2)}`);
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
