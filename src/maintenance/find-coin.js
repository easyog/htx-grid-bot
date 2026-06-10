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

const q = (process.argv[2] || 'CH').toUpperCase();

(async () => {
  await ex.loadMarkets();
  const hits = Object.keys(ex.markets)
    .filter(s => s.endsWith('/USDT'))
    .filter(s => s.split('/')[0].startsWith(q));
  console.log('USDT pairs starting with "' + q + '":');
  hits.forEach(s => console.log('  ' + s));
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
