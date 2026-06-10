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
  const bal = await ex.fetchBalance();
  const u = bal.USDT || {};
  console.log(`USDT free: ${(u.free||0).toFixed(2)}  used: ${(u.used||0).toFixed(2)}  total: ${((u.free||0)+(u.used||0)).toFixed(2)}`);

  // list key coins balances too
  for (const c of ['SOL','AVAX','ADA','CFG','BOBBSC','M']) {
    const v = bal[c] || {};
    const f = v.free||0, us = v.used||0;
    if (f+us > 0) console.log(`${c}: free=${f}  used=${us}  total=${(f+us)}`);
  }
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
