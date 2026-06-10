// Сканер всех пар на HTX — ищет лучшие для грид-торговли
// v3 (2026-04-22): окно 3 дня вместо 5 — меньше шума, ярче свежие тренды
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CONFIG_FILE = join(ROOT, 'grid-config.json');
const STATE_FILE = join(ROOT, 'grid-state.json');

// Кэш 1h свечей — TTL 90 мин. Кэш 5m — TTL 15 мин (бары роллятся каждые 5 мин)
const _ohlcvCache = {};
const _ohlcv5mCache = {};
const OHLCV_TTL_MS = 90 * 60 * 1000;
const OHLCV_5M_TTL_MS = 15 * 60 * 1000;

function loadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

export async function scanPairs(exchange, log) {
  log('=== СКАНЕР ПАР (v2) ===');

  const config = loadJson(CONFIG_FILE) || {};
  const state = loadJson(STATE_FILE) || {};
  const sc = config.scanner || {};

  const MIN_VOLUME = sc.minVolume24h || 200000;
  const MAX_SPREAD = 0.3;
  const MAX_DROP_24H = -10; // B: отсекаем падающие ножи

  // Feedback (E): сегодняшний pnl по парам из state.trades
  const todayPnl = {};
  const today = new Date().toISOString().slice(0, 10);
  for (const t of state.trades || []) {
    if (typeof t.profit === 'number' && t.time?.startsWith(today)) {
      todayPnl[t.symbol] = (todayPnl[t.symbol] || 0) + t.profit;
    }
  }
  const activeSymbols = new Set(Object.keys(state.grids || {}));

  // Бюджет на пару — для viability check (C)
  const totalBudget = config.totalBudget || 600;
  const maxPairs = sc.maxPairs || 10;
  const perPairBudget = totalBudget / maxPairs;

  // FIX: ретрай fetchTickers — 1 таймаут не должен ломать весь скан
  let tickers = null;
  for (let i = 0; i < 5; i++) {
    try {
      tickers = await exchange.fetchTickers();
      break;
    } catch (e) {
      log(`fetchTickers попытка ${i+1}/5: ${e.message}`);
      await new Promise(r => setTimeout(r, 3000 * (i + 1)));
    }
  }
  if (!tickers) throw new Error('fetchTickers failed после 5 попыток');

  const usdtPairs = Object.entries(tickers)
    .filter(([sym]) => sym.endsWith('/USDT') && !sym.includes(':'))
    .filter(([, t]) => t.quoteVolume && t.last);

  log(`Всего USDT пар: ${usdtPairs.length}`);

  // Pre-фильтр: vol, spread, falling knife (B), grid viability (C)
  // Активные пары всегда проходят — нужны метрики для auto-rotation и /scanner
  const preFiltered = usdtPairs.filter(([sym, t]) => {
    if (activeSymbols.has(sym)) return true;
    if (t.quoteVolume < MIN_VOLUME) return false;
    if (!t.ask || !t.bid) return false;
    const spreadPct = (t.ask - t.bid) / t.bid * 100;
    if (spreadPct > MAX_SPREAD) return false;
    if (typeof t.percentage === 'number' && t.percentage <= MAX_DROP_24H) return false;
    const market = exchange.markets?.[sym];
    if (market) {
      const minCost = market.limits?.cost?.min || 0;
      if (minCost > 0 && minCost * 10 > perPairBudget * 0.9) return false;
    }
    return true;
  });
  log(`После pre-фильтра (vol≥$${MIN_VOLUME/1000}K, spread≤${MAX_SPREAD}%, 24h>${MAX_DROP_24H}%, viable): ${preFiltered.length} пар`);

  const candidates = [];
  let cacheHits = 0, cacheMisses = 0;
  let cacheHits5m = 0, cacheMisses5m = 0;

  for (const [symbol, ticker] of preFiltered) {
    const vol24h = ticker.quoteVolume || 0;

    try {
      // 1h × 72 бара = 3 суток. Покрывает дневную волат + 48ч чоппинес
      let candles;
      const cached = _ohlcvCache[symbol];
      if (cached && Date.now() - cached.time < OHLCV_TTL_MS) {
        candles = cached.candles;
        cacheHits++;
      } else {
        candles = await exchange.fetchOHLCV(symbol, '1h', undefined, 72);
        if (candles && candles.length >= 48) _ohlcvCache[symbol] = { candles, time: Date.now() };
        cacheMisses++;
      }
      if (!candles || candles.length < 48) continue;

      // 5m × 72 баров = 6 часов. Даёт "микро-чоппинес" и detection "пилит прямо сейчас?"
      let candles5m = null;
      const cached5m = _ohlcv5mCache[symbol];
      if (cached5m && Date.now() - cached5m.time < OHLCV_5M_TTL_MS) {
        candles5m = cached5m.candles;
        cacheHits5m++;
      } else {
        try {
          candles5m = await exchange.fetchOHLCV(symbol, '5m', undefined, 72);
          if (candles5m && candles5m.length >= 36) _ohlcv5mCache[symbol] = { candles: candles5m, time: Date.now() };
        } catch { candles5m = null; }
        cacheMisses5m++;
      }

      const closes = candles.map(c => c[4]);
      const highs = candles.map(c => c[2]);
      const lows = candles.map(c => c[3]);

      // === Последние 48ч ===
      const recent = candles.slice(-48);
      const recHighs = recent.map(c => c[2]);
      const recLows = recent.map(c => c[3]);
      const recCloses = recent.map(c => c[4]);
      const max48 = Math.max(...recHighs);
      const min48 = Math.min(...recLows);

      // === A: Movement48 — суммарное % движение close-to-close за 48ч ===
      // Прямая мера ожидаемых фиксов: round_trips ≈ movement / (step × 2)
      let movement48 = 0;
      for (let i = 1; i < recCloses.length; i++) {
        movement48 += Math.abs(recCloses[i] - recCloses[i - 1]) / recCloses[i - 1] * 100;
      }

      // Choppiness = movement / |net trend| (пила vs тренд)
      const trend48Pct = (recCloses[recCloses.length - 1] - recCloses[0]) / recCloses[0] * 100;
      const absTrend48 = Math.abs(trend48Pct);
      const choppiness = movement48 / Math.max(absTrend48, 0.5);

      // === 5m микро-чоппинес за 6ч ===
      let movement6h = 0, chop6h = 0, trend6h = 0;
      if (candles5m && candles5m.length >= 36) {
        const c5 = candles5m.map(c => c[4]);
        for (let i = 1; i < c5.length; i++) {
          movement6h += Math.abs(c5[i] - c5[i - 1]) / c5[i - 1] * 100;
        }
        trend6h = (c5[c5.length - 1] - c5[0]) / c5[0] * 100;
        chop6h = movement6h / Math.max(Math.abs(trend6h), 0.3);
      }

      // === D: Recency-weighted daily volatility (3 дня) ===
      const dailyRanges = [];
      for (let d = 0; d < 3; d++) {
        const dayBars = candles.slice(d * 24, (d + 1) * 24);
        if (dayBars.length < 12) continue;
        const dh = Math.max(...dayBars.map(c => c[2]));
        const dl = Math.min(...dayBars.map(c => c[3]));
        dailyRanges.push((dh - dl) / dl * 100);
      }
      const weights = [0.8, 1.2, 1.7]; // oldest→newest, упор на сегодня
      let wSum = 0, wTot = 0;
      for (let i = 0; i < dailyRanges.length; i++) {
        const w = weights[i] || 1;
        wSum += dailyRanges[i] * w;
        wTot += w;
      }
      const weightedDR = wTot > 0 ? wSum / wTot : 0;

      // 3-дневный тренд
      const trend3dPct = (closes[closes.length - 1] - closes[0]) / closes[0] * 100;
      const absTrend3d = Math.abs(trend3dPct);

      // 3-дневный диапазон (для back-compat поля range7d)
      const max3d = Math.max(...highs);
      const min3d = Math.min(...lows);
      const range3dPct = (max3d - min3d) / min3d * 100;

      const spread = ticker.ask && ticker.bid
        ? (ticker.ask - ticker.bid) / ticker.bid * 100
        : 999;

      // Position в 48ч диапазоне — штраф если цена у экстремума
      const pricePos = (max48 - min48) > 0 ? (ticker.last - min48) / (max48 - min48) : 0.5;
      const extremePenalty = (pricePos > 0.92 || pricePos < 0.08) ? 10 : 0;

      // === YIELD MODEL (v4, 2026-04-22) ===
      // Прямая модель доходности: RT × step = % в день на грид-капитал.
      // effectiveStep ≈ wDR/3 (мин 0.8%) — прокси к dynStep бота.
      const effectiveStepPct = Math.max(0.8, weightedDR / 3);
      const dailyRT = movement48 / 2 / (effectiveStepPct * 2);
      const yieldPct = dailyRT * effectiveStepPct;
      const yieldScore = Math.min(yieldPct * 2, 30);   // cap 30 при yield≥15%/д

      // Trend dominance: |trend| / movement. <0.4 = чопит, >0.4 = бежит.
      // M показал что high movement + high trend ОК, если movement >> trend (M: 23/105 = 0.22).
      const trendDominance = absTrend3d / Math.max(movement48, 1);
      const trendPenalty = trendDominance > 0.4 ? Math.min(15, (trendDominance - 0.4) * 50) : 0;

      // Базовые компоненты — ослаблены, yieldScore доминирует
      const movementScore = Math.min(movement48 / 5, 20);
      const choppinessScore = Math.min(Math.max(choppiness - 2, 0) * 2, 15);
      const volatScore = Math.min(weightedDR * 2, 10);
      const trendScore = Math.max(8 - absTrend3d * 0.5, 0);
      const spreadScore = Math.max(10 - spread * 33, 0);
      const volumeScore = Math.min(Math.log10(vol24h) * 1.5, 10);
      const recentBonus = Math.min(movement6h / 2, 5);

      // Extreme position: штраф только если 6ч мертво. Активный пробой ATH ≠ зло.
      const extremeNow = (pricePos > 0.92 || pricePos < 0.08) && movement6h < 5;
      const extremePenaltyV4 = extremeNow ? 10 : 0;

      // Спящая пара
      const sleepPenalty = (movement6h < 3 && chop6h < 2) ? 8 : 0;

      let gridScore = yieldScore + movementScore + choppinessScore + volatScore +
                      trendScore + spreadScore + volumeScore + recentBonus -
                      extremePenaltyV4 - trendPenalty - sleepPenalty;

      // PnL feedback
      const pnl = todayPnl[symbol] || 0;
      if (pnl > 0.3) gridScore += 8;
      else if (pnl < -0.3) gridScore -= 15;

      // === Verdict — короткий человеко-читаемый ярлык
      let verdict;
      if (pnl > 1) verdict = `💰 Зарабатывает +$${pnl.toFixed(2)}/день`;
      else if (yieldPct >= 15 && trendDominance < 0.3) verdict = '💎 Чопит идеально';
      else if (yieldPct >= 10 && movement6h >= 8 && trendDominance < 0.4) verdict = '🚀 Пилит ракету';
      else if (trendDominance >= 0.5) verdict = '⚠️ Тренд давит грид';
      else if (movement6h < 3 && chop6h < 2) verdict = '💤 Спит';
      else if (yieldPct >= 8) verdict = '✅ Рабочая лошадка';
      else if (yieldPct < 3) verdict = '❌ Низкая доходность';
      else verdict = '📊 Стандарт';

      const breakdown = `yield ${yieldPct.toFixed(1)}%/д · RT ${dailyRT.toFixed(1)} · step ${effectiveStepPct.toFixed(1)}% · chop ${choppiness.toFixed(1)} · trendDom ${trendDominance.toFixed(2)}`;

      candidates.push({
        symbol,
        price: ticker.last,
        vol24h,
        range7d: +range3dPct.toFixed(1),
        avgDailyRange: +weightedDR.toFixed(2),
        movement48: +movement48.toFixed(1),
        choppiness: +choppiness.toFixed(1),
        movement6h: +movement6h.toFixed(2),
        chop6h: +chop6h.toFixed(1),
        trend: +trend3dPct.toFixed(2),
        pct24h: typeof ticker.percentage === 'number' ? +ticker.percentage.toFixed(2) : null,
        spread: +spread.toFixed(4),
        pricePos: +pricePos.toFixed(2),
        todayPnl: +pnl.toFixed(2),
        active: activeSymbols.has(symbol),
        // === v4 fields ===
        effectiveStep: +effectiveStepPct.toFixed(2),
        dailyRT: +dailyRT.toFixed(2),
        yieldPct: +yieldPct.toFixed(2),
        trendDominance: +trendDominance.toFixed(2),
        verdict,
        breakdown,
        // ==================
        gridScore: +gridScore.toFixed(1),
        suggestedRange: {
          lower: +(ticker.last * 0.92).toFixed(6),
          upper: +(ticker.last * 1.08).toFixed(6),
        },
      });

      if (!cached || Date.now() - cached.time >= OHLCV_TTL_MS) {
        await new Promise(r => setTimeout(r, 100));
      }
    } catch {
      continue;
    }
  }

  log(`OHLCV cache 1h: ${cacheHits}/${cacheMisses} | 5m: ${cacheHits5m}/${cacheMisses5m}`);

  candidates.sort((a, b) => b.gridScore - a.gridScore);
  const top20 = candidates.slice(0, 20);
  // Всегда включаем активные пары (даже если не в топ-20) — нужно для /scanner
  const topSyms = new Set(top20.map(c => c.symbol));
  const extraActive = candidates.filter(c => activeSymbols.has(c.symbol) && !topSyms.has(c.symbol));
  const top = [...top20, ...extraActive];

  log(`\nТОП-15 пар для грид-бота (v4 yield-model):`);
  log('─'.repeat(140));
  log(
    'Пара'.padEnd(13) +
    'Score'.padEnd(7) +
    'Yield/д'.padEnd(9) +
    'RT/д'.padEnd(6) +
    'Step%'.padEnd(7) +
    'Move48'.padEnd(8) +
    'Chop'.padEnd(6) +
    'TrDom'.padEnd(7) +
    'PnL$'.padEnd(7) +
    'Вердикт'
  );
  log('─'.repeat(140));
  for (const c of top20.slice(0, 15)) {
    const mark = c.active ? '*' : ' ';
    log(
      (mark + c.symbol).padEnd(13) +
      String(c.gridScore).padStart(5).padEnd(7) +
      (c.yieldPct.toFixed(1) + '%').padStart(7).padEnd(9) +
      c.dailyRT.toFixed(1).padStart(4).padEnd(6) +
      (c.effectiveStep.toFixed(1) + '%').padStart(5).padEnd(7) +
      String(c.movement48).padStart(5).padEnd(8) +
      String(c.choppiness).padStart(4).padEnd(6) +
      c.trendDominance.toFixed(2).padStart(5).padEnd(7) +
      ((c.todayPnl >= 0 ? '+' : '') + c.todayPnl.toFixed(2)).padStart(6).padEnd(7) +
      c.verdict
    );
  }
  log('─'.repeat(140));
  log('* = активная. Yield = RT × step (доходность/день на грид-капитал). TrDom = |trend|/movement (>0.4 = тренд давит).');

  return top;
}
