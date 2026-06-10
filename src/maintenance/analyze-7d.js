import 'dotenv/config';
import './fetch-patch.js';
import ccxt from 'ccxt';
import https from 'https';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const ex = new ccxt.htx({
  apiKey: process.env.HTX_API_KEY,
  secret: process.env.HTX_API_SECRET,
  timeout: 30000,
  options: { defaultType: 'spot' },
  agent: new https.Agent({ rejectUnauthorized: false }),
});

function pct(a, b) { return ((a - b) / b) * 100; }

async function analyze(sym) {
  const tkr = await ex.fetchTicker(sym);
  const ohlcv = await ex.fetchOHLCV(sym, '1h', undefined, 7 * 24);
  if (!ohlcv.length) return null;

  const closes = ohlcv.map(c => c[4]);
  const highs = ohlcv.map(c => c[2]);
  const lows = ohlcv.map(c => c[3]);
  const vols = ohlcv.map(c => c[5] * c[4]); // USDT volume

  const first = closes[0];
  const last = closes[closes.length - 1];
  const hi = Math.max(...highs);
  const lo = Math.min(...lows);
  const totalRange = pct(hi, lo);
  const trend = pct(last, first);

  // hourly returns
  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push(pct(closes[i], closes[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length;
  const std = Math.sqrt(variance);

  // daily ranges
  const dailyRanges = [];
  for (let d = 0; d < 7; d++) {
    const slice = ohlcv.slice(d * 24, (d + 1) * 24);
    if (!slice.length) continue;
    const dHi = Math.max(...slice.map(c => c[2]));
    const dLo = Math.min(...slice.map(c => c[3]));
    dailyRanges.push(pct(dHi, dLo));
  }
  const avgDailyRange = dailyRanges.reduce((a, b) => a + b, 0) / dailyRanges.length;

  // number of 1%+ moves (grid potential)
  const oneMovePct = rets.filter(r => Math.abs(r) >= 1).length;
  const twoMovePct = rets.filter(r => Math.abs(r) >= 2).length;

  // volume
  const totalVol = vols.reduce((a, b) => a + b, 0);
  const avgHourVol = totalVol / vols.length;
  const avgDayVol = totalVol / 7;

  return {
    sym,
    price: tkr.last,
    first,
    last,
    hi,
    lo,
    trend: trend.toFixed(2),
    totalRange: totalRange.toFixed(2),
    avgDailyRange: avgDailyRange.toFixed(2),
    dailyRanges: dailyRanges.map(v => v.toFixed(2)),
    hourlyStd: std.toFixed(3),
    movesGte1pct: oneMovePct,
    movesGte2pct: twoMovePct,
    avgDayVolUSDT: avgDayVol.toFixed(0),
    avgHourVolUSDT: avgHourVol.toFixed(0),
  };
}

(async () => {
  // skip loadMarkets — spot-only analysis, futures endpoint is down

  const pairs = ['CFG/USDT', 'BOBBSC/USDT', 'M/USDT', 'SOL/USDT', 'AVAX/USDT'];
  const results = [];
  for (const s of pairs) {
    try {
      const r = await analyze(s);
      if (r) results.push(r);
    } catch (e) { console.log(`err ${s}: ${e.message}`); }
    await sleep(500);
  }

  console.log('\n=== 7D ANALYSIS ===');
  for (const r of results) {
    console.log(`\n[${r.sym}]  price=${r.price}`);
    console.log(`  trend 7d:       ${r.trend}%   (${r.first} -> ${r.last})`);
    console.log(`  hi/lo:          ${r.hi} / ${r.lo}   total range: ${r.totalRange}%`);
    console.log(`  avg daily rng:  ${r.avgDailyRange}%  per-day: [${r.dailyRanges.join(', ')}]`);
    console.log(`  hourly std:     ${r.hourlyStd}%  (1h volatility)`);
    console.log(`  1h moves >=1%:  ${r.movesGte1pct} / 168     >=2%: ${r.movesGte2pct}`);
    console.log(`  avg day vol:    $${Number(r.avgDayVolUSDT).toLocaleString()}   hour: $${Number(r.avgHourVolUSDT).toLocaleString()}`);
  }

  console.log('\n=== JSON ===');
  console.log(JSON.stringify(results, null, 2));
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
