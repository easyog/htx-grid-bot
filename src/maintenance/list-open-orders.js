import 'dotenv/config';
import './fetch-patch.js';
import ccxt from 'ccxt';
import https from 'https';

const ex = new ccxt.htx({
  apiKey: process.env.HTX_API_KEY,
  secret: process.env.HTX_API_SECRET,
  timeout: 30000,
  options: { defaultType: 'spot' },
  agent: new https.Agent({ rejectUnauthorized: false }),
});

(async () => {
  const symbols = process.argv.slice(2);
  if (!symbols.length) { console.log('usage: list-open-orders.js SYM1 SYM2 ...'); process.exit(1); }

  for (const sym of symbols) {
    const tkr = await ex.fetchTicker(sym);
    const orders = await ex.fetchOpenOrders(sym);
    console.log(`\n[${sym}] price=${tkr.last}  orders=${orders.length}`);
    const sorted = orders.slice().sort((a, b) => a.price - b.price);
    for (const o of sorted) {
      const diff = ((o.price - tkr.last) / tkr.last * 100);
      const usdt = o.side === 'buy' ? o.amount * o.price : 0;
      console.log(`  ${o.side.padEnd(4)} @ ${o.price}  amt=${o.amount}  ${o.side==='buy'?`cost=$${usdt.toFixed(2)}  `:''}${diff>0?'+':''}${diff.toFixed(2)}%  id=${o.id}`);
    }
  }
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
