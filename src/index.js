import 'dotenv/config';
import './fetch-patch.js';
import ccxt from 'ccxt';
import https from 'https';
import fs from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { analyzeNews } from './news.js';
// scanner-worker запускается как child-процесс с авто-рестартом (см. startScannerWorker ниже)
import {
  initTelegram, sendTg, sendWithKeyboard, notifyTrade, notifyDailyReport,
  notifyAlert, notifyRebalance, onCommand, checkCommands, clearQueue,
  notifyStartup, notifyMorning, notifyEvening, notifyWeekly,
  notifyInactivity, notifyPriceSpike, notifyMilestone, V,
} from './telegram.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ===== Логгер =====
const OBSIDIAN_LOG_DIR = 'C:/Users/user/Documents/Obsidian Vault/htx-bot/spot-grid/logs';

function log(msg) {
  const ts = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(join(ROOT, 'grid.log'), line + '\n');
}

// Дописать строку в Obsidian дневной лог
function obsLog(section, text) {
  try {
    const todayStr = today();
    const filePath = `${OBSIDIAN_LOG_DIR}/${todayStr}.md`;
    let content = '';
    try { content = fs.readFileSync(filePath, 'utf8'); } catch {}

    const ts = new Date().toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', second: '2-digit' });

    if (!content) {
      content = `# Spot Grid Log ${todayStr}\n\n`;
    }

    // Добавляем секцию если нет
    if (!content.includes(`## ${section}`)) {
      content += `\n## ${section}\n`;
    }

    // Вставляем запись в конец секции
    const sectionIdx = content.indexOf(`## ${section}`);
    const nextSection = content.indexOf('\n## ', sectionIdx + 1);
    const insertAt = nextSection === -1 ? content.length : nextSection;
    content = content.slice(0, insertAt) + `- \`${ts}\` ${text}\n` + content.slice(insertAt);

    fs.writeFileSync(filePath, content);
  } catch {}
}

// ===== Scanner-worker: запуск + авто-рестарт =====
let scannerWorker = null;
let scannerRestartCount = 0;
let scannerLastRestart = 0;
function startScannerWorker() {
  const workerPath = join(ROOT, 'src', 'scanner-worker.js');
  const logPath = join(ROOT, 'scanner.log');
  const out = fs.openSync(logPath, 'a');
  scannerWorker = spawn(process.execPath, [workerPath], {
    stdio: ['ignore', out, out],
    detached: false,
  });
  log(`scanner-worker запущен PID=${scannerWorker.pid}`);
  scannerWorker.on('exit', (code, signal) => {
    const now = Date.now();
    if (now - scannerLastRestart < 60000) scannerRestartCount++; else scannerRestartCount = 1;
    scannerLastRestart = now;
    log(`scanner-worker упал code=${code} signal=${signal} — рестарт через 10с (попытка ${scannerRestartCount})`);
    if (scannerRestartCount >= 5) {
      log(`scanner-worker падает 5 раз подряд за минуту — пауза 5 мин`);
      setTimeout(() => { scannerRestartCount = 0; startScannerWorker(); }, 300000);
    } else {
      setTimeout(startScannerWorker, 10000);
    }
  });
}
process.on('exit', () => { try { scannerWorker?.kill(); } catch {} });
process.on('SIGINT', () => { try { scannerWorker?.kill(); } catch {}; process.exit(0); });
process.on('SIGTERM', () => { try { scannerWorker?.kill(); } catch {}; process.exit(0); });

// ===== Конфиг =====
function loadConfig() {
  return JSON.parse(fs.readFileSync(join(ROOT, 'grid-config.json'), 'utf8'));
}
let config = loadConfig();
const STATE_FILE = join(ROOT, 'grid-state.json');

if (config.scanner?.enabled) startScannerWorker();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ===== Состояние =====
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {
      grids: {},
      trades: [],
      totalProfit: 0,
      lockedProfit: 0,
      paused: false,
      startBudget: config.totalBudget,
      currentBudget: config.totalBudget,
      dayStats: { date: today(), profit: 0, trades: 0 },
      pairProfits: {},
    };
  }
}

function saveState(state) {
  // Trim: weekly report использует 7д ~3.5k записей. Срезаем при >6000 до 5000 — амортизация.
  if (state.trades?.length > 6000) state.trades = state.trades.slice(-5000);
  // Атомарная запись: tmp + rename, чтобы при kill -9 в середине не получить пустой/обрезанный JSON
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// Атомарная запись конфига — используется везде вместо прямого fs.writeFileSync
function saveConfig() {
  const cfgPath = join(ROOT, 'grid-config.json');
  const tmp = cfgPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  fs.renameSync(tmp, cfgPath);
}

function today() {
  return new Date().toISOString().split('T')[0];
}

// ===== Биржа =====
let exchange;

async function initExchange() {
  exchange = new ccxt.htx({
    apiKey: process.env.HTX_API_KEY,
    secret: process.env.HTX_API_SECRET,
    timeout: 30000,
    options: { defaultType: 'spot', createMarketBuyOrderRequiresPrice: false },
    agent: new https.Agent({ rejectUnauthorized: false }),
  });

  // FIX: exp backoff + 12 попыток. VPN иногда виснет на 1-2 мин — 5 попыток × 5с = 25с мало
  for (let i = 0; i < 12; i++) {
    try {
      await exchange.loadMarkets();
      log(`Рынки загружены: ${Object.keys(exchange.markets).length} пар`);
      return;
    } catch (e) {
      const wait = Math.min(5000 * Math.pow(1.4, i), 60000);
      log(`Загрузка рынков: попытка ${i + 1}/12 - ${e.message} (ждём ${Math.round(wait/1000)}с)`);
      await sleep(wait);
    }
  }
  throw new Error('Не удалось загрузить рынки (12 попыток, >5 мин)');
}

// ===== Утилиты =====
function getMarketInfo(symbol) {
  const market = exchange.market(symbol);
  return {
    amountPrecision: market.precision.amount,
    pricePrecision: market.precision.price,
    minAmount: market.limits.amount?.min || 0,
    minCost: market.limits.cost?.min || 0,
    minPrice: market.limits.price?.min || 0,
    maxPrice: market.limits.price?.max || Infinity,
  };
}

// ===== Дедупликация ошибок (не спамить одинаковые) =====
const _errorThrottle = {};
const ERROR_THROTTLE_MS = 300000; // 5 мин

function shouldLogError(key) {
  const now = Date.now();
  const last = _errorThrottle[key];
  if (last && now - last < ERROR_THROTTLE_MS) return false;
  _errorThrottle[key] = now;
  return true;
}

function fmt(value, precision) {
  if (typeof precision === 'number' && precision > 0 && precision < 1) {
    const decimals = Math.ceil(-Math.log10(precision));
    return +value.toFixed(decimals);
  }
  return +value.toFixed(precision || 8);
}

// ===== [4] БЮДЖЕТ — реальный баланс с биржи (кэш 60 сек) =====
let _budgetCache = null;
let _budgetCacheTime = 0;
const BUDGET_CACHE_MS = 60000;

// Кэш цен hold-монет (обновляется вместе с _budgetCache)
const _holdPriceCache = {};

async function getRealBudget(forceRefresh = false) {
  if (!forceRefresh && _budgetCache && Date.now() - _budgetCacheTime < BUDGET_CACHE_MS) {
    return _budgetCache;
  }

  const bal = await getBalances(forceRefresh);
  const usdtFree = bal.USDT?.free || 0;
  const usdtUsed = bal.USDT?.used || 0; // в открытых ордерах
  const totalUsdt = usdtFree + usdtUsed;

  const state = loadState();
  const tradingCoins = new Set(config.pairs.map(p => p.symbol.split('/')[0]));

  // Сканируем ВСЕ монеты на балансе, разделяя на trading/hold
  let tradingValue = 0;
  let holdValue = 0;
  const holdBreakdown = {};

  const coinEntries = Object.entries(bal).filter(([k, v]) =>
    k !== 'USDT' && k !== 'info' && k !== 'free' && k !== 'used' && k !== 'total'
    && typeof v === 'object' && ((v.free || 0) + (v.used || 0) > 0)
  );

  for (const [coin, v] of coinEntries) {
    const amount = (v.free || 0) + (v.used || 0);
    const symbol = `${coin}/USDT`;

    if (tradingCoins.has(coin)) {
      // Торговая монета — цена из state.grids (обновляется в checkGrid каждый цикл)
      const lastPrice = state.grids[symbol]?.currentPrice;
      if (lastPrice) tradingValue += amount * lastPrice;
    } else {
      // Hold монета — цена через ticker, кэшируется на время действия _budgetCache
      let price = _holdPriceCache[coin];
      if (!price || forceRefresh) {
        try {
          const ticker = await exchange.fetchTicker(symbol);
          price = ticker.last;
          _holdPriceCache[coin] = price;
        } catch {
          price = 0;
        }
      }
      const value = amount * price;
      if (value > 0) {
        holdValue += value;
        holdBreakdown[coin] = value;
      }
    }
  }

  const reservePercent = config.scanner?.reservePercent || 15;
  const totalValue = totalUsdt + tradingValue + holdValue;
  const lockedProfit = Math.max(0, state.lockedProfit || 0);
  const tradableRaw = totalUsdt + tradingValue;
  const tradableValue = Math.max(0, tradableRaw - lockedProfit);
  const reserve = tradableValue * reservePercent / 100;
  const workingBudget = tradableValue - reserve;

  _budgetCache = {
    totalValue, workingBudget, usdtFree, usdtUsed,
    baseValue: tradingValue, // совместимость со старым кодом
    tradingValue, holdValue, holdBreakdown, tradableValue, reserve,
    lockedProfit,
  };
  _budgetCacheTime = Date.now();
  return _budgetCache;
}

async function getPairBudget(state, pairConfig) {
  const { workingBudget } = await getRealBudget();
  const pairCount = config.pairs.length;

  if (!config.rebalance?.enabled) {
    const totalWeight = config.pairs.reduce((s, p) => s + (Number(p.budget) || 0), 0);
    if (totalWeight > 0) {
      const weight = (Number(pairConfig.budget) || 0) / totalWeight;
      return workingBudget * weight;
    }
    return workingBudget / pairCount;
  }

  // [6] РЕБАЛАНСИРОВКА — больше бюджета прибыльным парам
  const profits = {};
  let totalPairProfit = 0;
  for (const p of config.pairs) {
    profits[p.symbol] = state.pairProfits?.[p.symbol] || 0;
    totalPairProfit += profits[p.symbol];
  }

  if (totalPairProfit <= 0) {
    return workingBudget / pairCount;
  }

  // Базовый бюджет (60%) + бонус за профит (40%)
  const baseBudget = workingBudget * 0.6 / pairCount;
  const profitShare = profits[pairConfig.symbol] / totalPairProfit;
  const bonusBudget = workingBudget * 0.4 * profitShare;

  return baseBudget + bonusBudget;
}

// ===== [5] ДИНАМИЧЕСКИЙ ШАГ (кэш 10 мин) =====
const _stepCache = {};
const STEP_CACHE_MS = 10 * 60 * 1000;

async function getDynamicStep(symbol, baseStep) {
  if (!config.dynamicStep?.enabled) return baseStep;

  // Кэш — не дёргаем API чаще чем раз в 10 мин на пару
  // F3: Инвалидация кэша при spike > 2% от цены в момент снятия шага
  const cached = _stepCache[symbol];
  if (cached && Date.now() - cached.time < STEP_CACHE_MS) {
    if (cached.refPrice) {
      try {
        const st = loadState();
        const livePrice = st.grids?.[symbol]?.currentPrice;
        if (livePrice && Math.abs(livePrice - cached.refPrice) / cached.refPrice > 0.02) {
          log(`[${symbol}] DynStep cache инвалидирован: price spike ${((livePrice/cached.refPrice-1)*100).toFixed(2)}%`);
        } else {
          return cached.step;
        }
      } catch { return cached.step; }
    } else {
      return cached.step;
    }
  }

  try {
    const candles = await exchange.fetchOHLCV(symbol, '1h', undefined, 24);
    if (!candles || candles.length < 12) return baseStep;

    // Средний часовой диапазон за последние 24ч
    const ranges = candles.map(c => (c[2] - c[3]) / c[3] * 100);
    const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;

    // Последние 3 часа — свежая волатильность (вес x2)
    const recentRanges = ranges.slice(-3);
    const recentAvg = recentRanges.reduce((a, b) => a + b, 0) / recentRanges.length;
    const blendedRange = (avgRange + recentAvg * 2) / 3;

    // O3: trend penalty — при сильном 24ч тренде увеличиваем шаг чтобы не продать слишком рано
    // |trend| 0-2% → 1x, 5% → 1.2x, 10%+ → 1.5x
    const firstClose = candles[0][4];
    const lastClose = candles[candles.length - 1][4];
    const trendAbs = Math.abs((lastClose - firstClose) / firstClose * 100);
    const trendMultiplier = 1 + Math.min(0.5, trendAbs / 20); // до +50%

    const volRatio = blendedRange / 1.6;
    const pairOverride = config.pairs.find(p => p.symbol === symbol)?.dynamicStep || {};
    const minStep = pairOverride.minStep ?? config.dynamicStep.minStep ?? 0.8;
    const maxStep = pairOverride.maxStep ?? config.dynamicStep.maxStep ?? 2;

    const dynamicStep = Math.max(minStep, Math.min(maxStep, baseStep * volRatio * trendMultiplier));
    const result = +dynamicStep.toFixed(2);

    // F3: сохраняем reference price для обнаружения spike (lastClose уже вычислен для trend)
    _stepCache[symbol] = { step: result, time: Date.now(), refPrice: lastClose };

    if (Math.abs(result - baseStep) > 0.2) {
      log(`[${symbol}] Шаг: ${result}% (волат: ${blendedRange.toFixed(3)}%/ч, 24ч: ${avgRange.toFixed(3)}%, 3ч: ${recentAvg.toFixed(3)}%)`);
    }

    return result;
  } catch {
    return baseStep;
  }
}

// Получить текущий шаг для пары (из кэша или стейта, без API)
function getCurrentStep(symbol, fallback) {
  const cached = _stepCache[symbol];
  if (cached && Date.now() - cached.time < STEP_CACHE_MS) return cached.step;
  return fallback;
}

// ===== Safety: stop-loss + trend-gate =====
// Тренд берём из последнего снимка scanner-worker'а (обновляется каждые 30 мин)
function readScannerSnapshot() {
  try {
    const path = join(ROOT, 'scanner-result.json');
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch { return null; }
}

function getPairTrend(symbol) {
  const snap = readScannerSnapshot();
  if (!snap?.top) return { trendDown: false, pct24h: 0, trendDom: 0, age: Infinity };
  const p = snap.top.find(x => x.symbol === symbol);
  if (!p) return { trendDown: false, pct24h: 0, trendDom: 0, age: Infinity };
  const age = (Date.now() - new Date(snap.time).getTime()) / 60000;
  const pct24h = p.pct24h || 0;
  const trendDom = p.trendDominance || 0;
  const cfg = config.safety?.trendGate || {};
  const pctThreshold = cfg.pct24hThreshold ?? -5;
  const domThreshold = cfg.trendDomThreshold ?? 0.5;
  // Down: упало >5% за 24ч ИЛИ сильный медвежий тренд (dom>0.5 + минусовая динамика)
  const trendDown = (pct24h <= pctThreshold) || (trendDom >= domThreshold && pct24h < -1);
  return { trendDown, pct24h, trendDom, age };
}

// Проверка безопасности пары: unrealized vs budget + тренд
async function checkPairSafety(symbol, pairConfig, state) {
  const grid = state.grids[symbol];
  if (!grid) return { stopLoss: false, trendDown: false, unrealizedPct: 0, pct24h: 0, trendDom: 0 };

  const tr = getPairTrend(symbol);

  let unrealizedPct = 0;
  const orders = Object.values(grid.orders || {});
  const openSells = orders.filter(o => o.side === 'sell' && o.status === 'open');
  if (openSells.length > 0) {
    try {
      const ticker = await exchange.fetchTicker(symbol);
      const cur = ticker.last;
      const stepPct = (grid.step || pairConfig.stepPercent || 1.5) / 100;
      let curValue = 0, costBasis = 0;
      for (const o of openSells) {
        curValue += o.amount * cur;
        costBasis += o.amount * (o.price / (1 + stepPct));
      }
      const budget = grid.budget || pairConfig.budget || 50;
      unrealizedPct = ((curValue - costBasis) / budget) * 100;
    } catch {}
  }

  const stopLossThreshold = config.safety?.stopLossPercent ?? -15;
  return {
    stopLoss: unrealizedPct < stopLossThreshold,
    trendDown: tr.trendDown,
    unrealizedPct: +unrealizedPct.toFixed(2),
    pct24h: tr.pct24h,
    trendDom: tr.trendDom,
    scannerAgeMin: +tr.age.toFixed(1),
  };
}

// ===== Генерация уровней грида =====
function generateGridLevels(currentPrice, stepPercent, gridLines) {
  const levels = [];
  const halfLines = Math.floor(gridLines / 2);

  for (let i = 1; i <= halfLines; i++) {
    levels.push({ price: currentPrice * (1 - stepPercent / 100 * i), side: 'buy' });
  }
  for (let i = 1; i <= halfLines; i++) {
    levels.push({ price: currentPrice * (1 + stepPercent / 100 * i), side: 'sell' });
  }

  return levels.sort((a, b) => a.price - b.price);
}

// ===== Баланс (кэш 30 сек) =====
let _balanceCache = null;
let _balanceCacheTime = 0;
const BALANCE_CACHE_MS = 30000;

async function getBalances(forceRefresh = false) {
  if (!forceRefresh && _balanceCache && Date.now() - _balanceCacheTime < BALANCE_CACHE_MS) {
    return _balanceCache;
  }
  _balanceCache = await exchange.fetchBalance();
  _balanceCacheTime = Date.now();
  return _balanceCache;
}

function invalidateBalanceCache() {
  _balanceCache = null;
  _balanceCacheTime = 0;
}

// ===== Отменить ордера для пары =====
async function cancelPairOrders(symbol) {
  try {
    const orders = await exchange.fetchOpenOrders(symbol);
    for (const order of orders) {
      try {
        await exchange.cancelOrder(order.id, symbol);
        await sleep(100);
      } catch (e) {
        log(`Ошибка отмены ${order.id}: ${e.message}`);
        obsLog('Баги', `❌ Ошибка отмены ордера ${order.id} (${symbol}): ${e.message}`);
      }
    }
    return orders.length;
  } catch {
    return 0;
  }
}

// ===== Начальная покупка базовой монеты для sell-ордеров =====
// FIX: докупаем ВСЕГДА до amountNeeded (без threshold 0.9) чтобы хватало на все sell-уровни
async function initialBuy(symbol, amountNeeded, currentPrice) {
  const base = symbol.split('/')[0];
  const balance = await getBalances();
  const baseBalance = balance[base]?.free || 0;

  // Небольшой запас 2% к amountNeeded на случай slippage и precision-округлений
  const target = amountNeeded * 1.02;
  if (baseBalance >= target) {
    log(`[${symbol}] Достаточно ${base}: ${baseBalance.toFixed(6)} (нужно ${target.toFixed(6)})`);
    return;
  }

  const toBuy = target - baseBalance;
  const cost = toBuy * currentPrice * 1.01;
  const quote = balance.USDT?.free || 0;

  if (cost > quote) {
    // Покупаем сколько можем — лучше частично, чем вообще ничего
    const maxCost = quote * 0.98;
    if (maxCost < (exchange.market(symbol).limits?.cost?.min || 1)) {
      log(`[${symbol}] Нехватка USDT: нужно $${cost.toFixed(2)}, есть $${quote.toFixed(2)} — пропуск докупки`);
      return;
    }
    log(`[${symbol}] Частичная докупка: нужно $${cost.toFixed(2)}, трачу $${maxCost.toFixed(2)}`);
    try {
      const order = await exchange.createMarketBuyOrder(symbol, +maxCost.toFixed(2));
      log(`[${symbol}] Куплено ${base} @ ${order.average || currentPrice} (частично)`);
      invalidateBalanceCache();
      await sleep(1000);
    } catch (e) {
      log(`[${symbol}] Ошибка частичной докупки: ${e.message}`);
      obsLog('Баги', `❌ **${symbol}** ошибка частичной докупки: ${e.message}`);
    }
    return;
  }

  // HTX спот market buy: передаём cost (сколько USDT потратить)
  const costUsdt = +(toBuy * currentPrice * 1.01).toFixed(2); // +1% запас на проскальзывание/комиссию
  log(`[${symbol}] Покупаю ~${toBuy.toFixed(6)} ${base} по рынку (cost: $${costUsdt})...`);

  try {
    const order = await exchange.createMarketBuyOrder(symbol, costUsdt);
    log(`[${symbol}] Куплено ${base} @ ${order.average || currentPrice}`);
    invalidateBalanceCache();
    await sleep(1000);
  } catch (e) {
    log(`[${symbol}] Ошибка начальной покупки: ${e.message}`);
    obsLog('Баги', `❌ **${symbol}** ошибка начальной покупки: ${e.message}`);
  }
}

// ===== Установка грида для одной пары =====
async function setupGrid(pairConfig, state) {
  const { symbol, stepPercent } = pairConfig;
  let gridLines = pairConfig.gridLines;
  if (!state) state = loadState();

  // [4] Бюджет из реального баланса биржи
  const budget = await getPairBudget(state, pairConfig);
  // [5] Динамический шаг
  const step = await getDynamicStep(symbol, stepPercent);

  const market = getMarketInfo(symbol);
  const ticker = await exchange.fetchTicker(symbol);
  const currentPrice = ticker.last;
  const base = symbol.split('/')[0];

  // F2: Динамически уменьшаем gridLines если бюджет на уровень < minCost*1.15
  // Запас 1.15 на проскальзывание цены между placement-ами, чтобы ордера реально прошли
  const minCostSafe = (market.minCost || 1) * 1.15;
  const maxLinesByCost = Math.max(2, Math.floor(budget / minCostSafe));
  if (maxLinesByCost < gridLines) {
    log(`[${symbol}] gridLines ${gridLines} → ${maxLinesByCost} (budget $${budget.toFixed(2)} / minCost $${(market.minCost || 1).toFixed(2)})`);
    gridLines = maxLinesByCost;
  }

  log(`\n[${symbol}] Настройка грида`);
  log(`[${symbol}] Цена: ${currentPrice} | Бюджет: $${budget.toFixed(2)} | Линий: ${gridLines} | Шаг: ${step}%`);

  // Перед отменой — проверяем не исполнились ли старые ордера (чтобы не потерять профит)
  if (state.grids[symbol]?.orders) {
    const oldGrid = state.grids[symbol];
    const oldBudget = oldGrid.budget || budget;
    const oldStep = oldGrid.step || stepPercent;
    const oldAmountPerLevel = oldBudget / gridLines;
    const stepMult = oldStep / 100;
    try {
      const openOnExchange = await exchange.fetchOpenOrders(symbol);
      const openIds = new Set(openOnExchange.map(o => o.id));
      if (!state.processedIds) state.processedIds = [];

      for (const [priceKey, orderInfo] of Object.entries(oldGrid.orders)) {
        if (orderInfo.status !== 'open') continue;
        if (openIds.has(orderInfo.id)) continue;
        if (state.processedIds.includes(orderInfo.id)) continue;

        // Ордер пропал с биржи — возможно исполнен
        try {
          const detail = await exchange.fetchOrder(orderInfo.id, symbol);
          if (detail.status === 'closed' && orderInfo.side === 'sell') {
            const grossProfit = oldAmountPerLevel * stepMult;
            const commission = oldAmountPerLevel * 0.004;
            const profitUsd = +(grossProfit - commission).toFixed(4);
            state.totalProfit += profitUsd;
            state.lockedProfit = +(((state.lockedProfit || 0) + profitUsd)).toFixed(4);
            if (!state.pairProfits) state.pairProfits = {};
            state.pairProfits[symbol] = (state.pairProfits[symbol] || 0) + profitUsd;
            if (!state.dayStats || state.dayStats.date !== today()) state.dayStats = { date: today(), profit: 0, trades: 0 };
            state.dayStats.profit += profitUsd;
            state.dayStats.trades++;
            state.trades.push({ time: new Date().toISOString(), symbol, type: 'sell_filled', price: parseFloat(priceKey), amount: orderInfo.amount, profit: profitUsd });
            log(`[${symbol}] Пойман пропущенный SELL @ ${priceKey} | +$${profitUsd}`);
            obsLog('Сделки', `💰 **${symbol}** пропущенный SELL @ ${priceKey} | **+$${profitUsd}** | Сейф: $${state.lockedProfit.toFixed(4)} | Копилка-стат: $${state.totalProfit.toFixed(4)}`);
            await notifyTrade(symbol, 'sell', priceKey, profitUsd);
          }
          state.processedIds.push(orderInfo.id);
        } catch {}
      }
      saveState(state);
    } catch (e) {
      log(`[${symbol}] Ошибка проверки пропущенных: ${e.message}`);
    }
  }

  let levels = generateGridLevels(currentPrice, step, gridLines);
  let amountPerLevel = budget / gridLines;

  // Лесенка: ставим только N ближайших + страховочный buy. Остальные — в очередь plannedLevels (refillLadder доставит).
  if (config.ladder?.enabled) {
    const aB = pairConfig.ladder?.activeBuys ?? config.ladder.activeBuys ?? 2;
    const aS = pairConfig.ladder?.activeSells ?? config.ladder.activeSells ?? 2;

    const allBuys = levels.filter(l => l.side === 'buy')
      .sort((a, b) => Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice));
    const allSells = levels.filter(l => l.side === 'sell')
      .sort((a, b) => Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice));

    const activeBuysList = allBuys.slice(0, aB);
    const activeSellsList = allSells.slice(0, aS);
    const queued = [
      ...allBuys.slice(aB).map(l => ({ price: l.price, side: 'buy', status: 'queued' })),
      ...allSells.slice(aS).map(l => ({ price: l.price, side: 'sell', status: 'queued' })),
    ];

    const newLevels = [...activeBuysList, ...activeSellsList];

    // Страховочный buy на -X% от цены (ловит резкие свечи вниз)
    // Trend-gate: при медвежьем тренде по паре safety-buy НЕ ставим (не ловим падающий нож)
    if (config.ladder.safetyOrder?.enabled && !state.grids[symbol]?.trendDown) {
      const dist = config.ladder.safetyOrder.buyDistancePercent || 5;
      const safetyPrice = currentPrice * (1 - dist / 100);
      newLevels.push({ price: safetyPrice, side: 'buy', isSafety: true });
    }

    newLevels.sort((a, b) => a.price - b.price);
    levels = newLevels;

    // Сохраняем очередь и метаданные для refillLadder (создаём grid если нет)
    if (!state.grids[symbol]) state.grids[symbol] = { orders: {}, createdAt: Date.now() };
    state.grids[symbol].plannedLevels = queued;
    state.grids[symbol].ladderMeta = { amountPerLevel, step, totalLines: gridLines };
  }

  const sellLevels = levels.filter(l => l.side === 'sell');
  const totalBaseNeeded = sellLevels.reduce((sum, l) => sum + amountPerLevel / l.price, 0);

  // Pre-check: симулируем размещение с учётом средств, замороженных в старых ордерах
  const preBalance = await getBalances(true);
  let potentialUsdt = (preBalance.USDT?.free || 0) + (preBalance.USDT?.used || 0);
  let potentialBase = (preBalance[base]?.free || 0) + (preBalance[base]?.used || 0);

  // Симулируем initialBuy (покупка base при нехватке для sell-ордеров)
  if (potentialBase < totalBaseNeeded * 0.9) {
    const shortfall = totalBaseNeeded - potentialBase;
    const cost = shortfall * currentPrice * 1.01;
    if (potentialUsdt >= cost) {
      potentialUsdt -= cost;
      potentialBase = totalBaseNeeded;
    }
  }

  let plannedOrders = 0;
  let _remU = potentialUsdt, _remB = potentialBase;
  for (const level of levels) {
    const p = fmt(level.price, market.pricePrecision);
    const a = fmt(amountPerLevel / level.price, market.amountPrecision);
    if (a < market.minAmount || a * p < market.minCost) continue;
    if (p < market.minPrice || p > market.maxPrice) continue;
    if (level.side === 'buy') {
      const c = a * p;
      if (_remU >= c) { plannedOrders++; _remU -= c; }
    } else {
      if (_remB >= a) { plannedOrders++; _remB -= a; }
    }
  }

  const existingOpen = Object.values(state.grids[symbol]?.orders || {}).filter(o => o.status === 'open').length;

  // Buy-only fallback: пара пустая ИЛИ зависла с малым количеством ордеров >2ч
  // FIX: раньше активировался только если existingOpen===0. Теперь размораживает stale пары (STABLE/MAY/GUN/CAKE/HOME со 1 ордером сутки+)
  let buyOnlyMode = false;
  const _createdAt = state.grids[symbol]?.createdAt || 0;
  const _ageHours = _createdAt ? (Date.now() - _createdAt) / 3600000 : 999;
  const _stale = existingOpen > 0 && existingOpen <= 2 && _ageHours > 2;
  if (plannedOrders === 0 && (existingOpen === 0 || _stale)) {
    const usdtFree = preBalance.USDT?.free || 0;
    const maxForPair = Math.min(usdtFree * 0.5, budget * 0.6);
    const maxBuys = Math.floor(maxForPair / (market.minCost * 1.1));
    if (maxBuys >= 1 && maxForPair >= market.minCost) {
      const buyLvls = levels.filter(l => l.side === 'buy');
      const useBuys = Math.min(maxBuys, buyLvls.length, 3);
      const adaptedPerLevel = maxForPair / useBuys;
      levels = buyLvls.slice(-useBuys);
      amountPerLevel = adaptedPerLevel;
      buyOnlyMode = true;
      if (_stale) {
        log(`[${symbol}] 🔧 Разморозка зависшей пары (${existingOpen} ордеров ${_ageHours.toFixed(1)}ч): buy-only ${useBuys}×$${adaptedPerLevel.toFixed(2)}`);
        obsLog('Грид', `🔧 **${symbol}** разморозка: висит ${_ageHours.toFixed(1)}ч → buy-only ${useBuys}×$${adaptedPerLevel.toFixed(2)}`);
      } else {
        log(`[${symbol}] 📉 Buy-only: USDT $${usdtFree.toFixed(2)} (лимит $${maxForPair.toFixed(2)}), ${useBuys} buy по $${adaptedPerLevel.toFixed(2)}`);
        obsLog('Грид', `📉 **${symbol}** buy-only: ${useBuys} buy по $${adaptedPerLevel.toFixed(2)} (лимит $${maxForPair.toFixed(2)})`);
      }
    }
  }

  // Если новый грид невозможен И старые ордера есть — не трогаем старые
  if (plannedOrders === 0 && !buyOnlyMode) {
    // Обновляем step в state чтобы DynStep не триггерил пересоздание повторно каждые 10 мин
    if (state.grids[symbol]) {
      state.grids[symbol].step = step;
      saveState(state);
    }
    if (existingOpen > 0) {
      log(`[${symbol}] ⚠️ Нет средств для нового грида — сохраняю текущие ${existingOpen} ордеров`);
      obsLog('Грид', `⚠️ **${symbol}** нет средств на перестройку, оставлен текущий грид (${existingOpen} ордеров)`);
    } else {
      log(`[${symbol}] ⚠️ Нет средств для грида и нет открытых ордеров — пропускаю пару`);
      obsLog('Грид', `⚠️ **${symbol}** недостаточно USDT ($${((preBalance.USDT?.free || 0) + (preBalance.USDT?.used || 0)).toFixed(2)}) — пара без ордеров`);
    }
    return { buyCount: 0, sellCount: 0 };
  }

  const cancelled = await cancelPairOrders(symbol);
  if (cancelled > 0) log(`[${symbol}] Отменено ${cancelled} старых ордеров`);

  if (!buyOnlyMode) {
    await initialBuy(symbol, totalBaseNeeded, currentPrice);
  }

  const balances = await getBalances(true);
  let baseAvailable = balances[base]?.free || 0;
  let usdtAvailable = balances.USDT?.free || 0;

  if (!state.grids[symbol]) state.grids[symbol] = { orders: {}, createdAt: Date.now() };
  const grid = state.grids[symbol];
  grid.orders = {};
  grid.currentPrice = currentPrice;
  grid.budget = budget;
  grid.step = step;
  grid.lines = gridLines; // F2: фактическое число линий (может быть уменьшено по minCost)
  // F4: если trailing выключен — чистим старые trailing-entries чтобы не зависали
  if (!config.trailing?.enabled && Array.isArray(grid.trailing) && grid.trailing.length > 0) {
    log(`[${symbol}] Очищено ${grid.trailing.length} stale trailing-entries (trailing disabled)`);
    grid.trailing = [];
  }
  if (!grid.createdAt) grid.createdAt = Date.now();

  let buyCount = 0, sellCount = 0, skippedBalance = 0, skippedPrice = 0;

  for (const level of levels) {
    const price = fmt(level.price, market.pricePrecision);
    const amount = fmt(amountPerLevel / level.price, market.amountPrecision);

    if (amount < market.minAmount || amount * price < market.minCost) {
      continue;
    }

    // Валидация цены по лимитам биржи
    if (price < market.minPrice || price > market.maxPrice) {
      skippedPrice++;
      continue;
    }

    try {
      let order;
      if (level.side === 'buy') {
        const cost = amount * price;
        if (usdtAvailable < cost) {
          skippedBalance++;
          continue;
        }
        order = await exchange.createLimitBuyOrder(symbol, amount, price);
        usdtAvailable -= cost;
        buyCount++;
      } else {
        if (baseAvailable < amount) {
          skippedBalance++;
          continue;
        }
        order = await exchange.createLimitSellOrder(symbol, amount, price);
        baseAvailable -= amount;
        sellCount++;
      }

      grid.orders[price] = {
        id: order.id,
        side: level.side,
        price,
        amount,
        status: 'open',
        placedAt: new Date().toISOString(),
      };

      await sleep(150);
    } catch (e) {
      const errKey = `setup_${symbol}_${level.side}`;
      if (shouldLogError(errKey)) {
        log(`[${symbol}] Ошибка ${level.side} @ ${price}: ${e.message}`);
        obsLog('Баги', `❌ **${symbol}** ошибка размещения ${level.side} @ ${price}: ${e.message}`);
      }
    }
  }

  if (skippedBalance > 0) log(`[${symbol}] Пропущено ${skippedBalance} ордеров (нехватка баланса)`);
  if (skippedPrice > 0) log(`[${symbol}] Пропущено ${skippedPrice} ордеров (цена за лимитами биржи)`);

  log(`[${symbol}] Размещено: ${buyCount} buy + ${sellCount} sell`);
  invalidateBalanceCache();
  _budgetCache = null; _budgetCacheTime = 0;
  saveState(state);
  return { buyCount, sellCount };
}

// ===== Лесенка: доставить активные ордера из очереди plannedLevels =====
const _refillBusy = new Set();
async function refillLadder(pairConfig, market) {
  const { symbol } = pairConfig;
  if (!config.ladder?.enabled) return;
  if (_refillBusy.has(symbol)) return;
  _refillBusy.add(symbol);
  try {
    const state = loadState();
    const grid = state.grids[symbol];
    if (!grid || !grid.plannedLevels || grid.plannedLevels.length === 0) return;
    const meta = grid.ladderMeta;
    if (!meta || !meta.amountPerLevel) return;

    const pairCfg = config.pairs.find(p => p.symbol === symbol);
    const activeBuys = pairCfg?.ladder?.activeBuys ?? config.ladder.activeBuys ?? 2;
    const activeSells = pairCfg?.ladder?.activeSells ?? config.ladder.activeSells ?? 2;

    const openOrds = Object.values(grid.orders).filter(o => o.status === 'open');
    const openBuys = openOrds.filter(o => o.side === 'buy').length;
    const openSells = openOrds.filter(o => o.side === 'sell').length;

    if (openBuys >= activeBuys && openSells >= activeSells) return;

    const ticker = await exchange.fetchTicker(symbol);
    const currentPrice = ticker.last;

    const bal = await getBalances(true);
    const base = symbol.split('/')[0];
    let usdtFree = bal.USDT?.free || 0;
    let baseFree = bal[base]?.free || 0;

    const placeFromQueue = async (side, need) => {
      let placedHere = 0;
      const candidates = grid.plannedLevels
        .filter(l => l.side === side && l.status === 'queued')
        .sort((a, b) => Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice));
      for (let i = 0; i < Math.min(need, candidates.length); i++) {
        const lvl = candidates[i];
        const price = fmt(lvl.price, market.pricePrecision);
        const amount = fmt(meta.amountPerLevel / price, market.amountPrecision);
        const removeFromQueue = () => {
          grid.plannedLevels = grid.plannedLevels.filter(l => !(l.price === lvl.price && l.side === lvl.side));
        };
        if (amount < market.minAmount || amount * price < market.minCost) { removeFromQueue(); continue; }
        if (price < market.minPrice || price > market.maxPrice) { removeFromQueue(); continue; }
        if (grid.orders[price]) { removeFromQueue(); continue; }
        if (side === 'buy') {
          const cost = amount * price;
          if (usdtFree < cost) break;
          try {
            const order = await exchange.createLimitBuyOrder(symbol, amount, price);
            grid.orders[price] = { id: order.id, side: 'buy', price, amount, status: 'open', placedAt: new Date().toISOString(), fromLadder: true };
            usdtFree -= cost;
            placedHere++;
            removeFromQueue();
            await sleep(150);
          } catch (e) {
            if (shouldLogError(`refill_buy_${symbol}`)) log(`[${symbol}] Ladder buy err @ ${price}: ${e.message}`);
            break;
          }
        } else {
          if (baseFree < amount) break;
          try {
            const order = await exchange.createLimitSellOrder(symbol, amount, price);
            grid.orders[price] = { id: order.id, side: 'sell', price, amount, status: 'open', placedAt: new Date().toISOString(), fromLadder: true };
            baseFree -= amount;
            placedHere++;
            removeFromQueue();
            await sleep(150);
          } catch (e) {
            if (shouldLogError(`refill_sell_${symbol}`)) log(`[${symbol}] Ladder sell err @ ${price}: ${e.message}`);
            break;
          }
        }
      }
      return placedHere;
    };

    let placed = 0;
    // Trend-gate: при медвежьем тренде по паре buy-side ladder paused (sell остаются работать)
    if (openBuys < activeBuys && !grid.trendDown) placed += await placeFromQueue('buy', activeBuys - openBuys);
    if (openSells < activeSells) placed += await placeFromQueue('sell', activeSells - openSells);

    if (placed > 0) {
      log(`[${symbol}] Ladder +${placed} (очередь: ${grid.plannedLevels.length})`);
      saveState(state);
      invalidateBalanceCache();
    }
  } catch (e) {
    log(`[${symbol}] refillLadder error: ${e.message}`);
  } finally {
    _refillBusy.delete(symbol);
  }
}

// ===== Trailing stop: активация при +X%, продажа при откате на Y% =====
async function checkTrailingStops(symbol, currentPrice, market) {
  if (!config.trailing?.enabled) return;

  const state = loadState();
  const grid = state.grids[symbol];
  if (!grid || !grid.trailing || grid.trailing.length === 0) return;

  const activate = (config.trailing.activatePercent || 0.8) / 100;
  const pullback = (config.trailing.pullbackPercent || 0.15) / 100;
  const remaining = [];
  let changed = false;

  for (const entry of grid.trailing) {
    if (!entry.activated) {
      if (currentPrice >= entry.buyPrice * (1 + activate)) {
        entry.activated = true;
        entry.peak = currentPrice;
        log(`[${symbol}] TRAIL активирован: buy ${entry.buyPrice} peak ${currentPrice}`);
        changed = true;
      }
      remaining.push(entry);
    } else {
      if (currentPrice > entry.peak) {
        entry.peak = currentPrice;
        changed = true;
        remaining.push(entry);
      } else if (currentPrice <= entry.peak * (1 - pullback)) {
        // Триггер — market sell
        try {
          const base = symbol.split('/')[0];
          const freshBal = await getBalances(true);
          const baseFree = freshBal[base]?.free || 0;
          const sellAmount = Math.min(entry.amount, baseFree);
          const minAmt = market.limits?.amount?.min || 0;
          if (sellAmount < minAmt) {
            log(`[${symbol}] TRAIL: нехватка базы ${sellAmount} < ${minAmt}`);
            remaining.push(entry);
            continue;
          }
          const order = await exchange.createMarketSellOrder(symbol, sellAmount);
          const sellPrice = order.average || order.price || currentPrice;
          const gross = sellAmount * (sellPrice - entry.buyPrice);
          const commission = sellAmount * sellPrice * 0.004;
          const profitUsd = +(gross - commission).toFixed(4);
          state.totalProfit += profitUsd;
          state.lockedProfit = +(((state.lockedProfit || 0) + profitUsd)).toFixed(4);
          if (!state.pairProfits) state.pairProfits = {};
          state.pairProfits[symbol] = (state.pairProfits[symbol] || 0) + profitUsd;
          if (!state.dayStats || state.dayStats.date !== today()) state.dayStats = { date: today(), profit: 0, trades: 0 };
          state.dayStats.profit += profitUsd;
          state.dayStats.trades++;
          state.trades.push({
            time: new Date().toISOString(), symbol, type: 'sell_filled',
            price: sellPrice, amount: sellAmount, profit: profitUsd, trailing: true,
          });
          const pct = ((sellPrice - entry.buyPrice) / entry.buyPrice * 100).toFixed(2);
          log(`[${symbol}] TRAIL SELL @ ${sellPrice.toFixed(6)} (peak ${entry.peak.toFixed(6)}, buy ${entry.buyPrice}) | +${pct}% | +$${profitUsd} | Сейф: $${state.lockedProfit.toFixed(4)}`);
          obsLog('Сделки', `**${symbol}** TRAIL SELL @ ${sellPrice.toFixed(6)} (peak ${entry.peak.toFixed(6)}, buy ${entry.buyPrice}) | **+$${profitUsd}** (+${pct}%) | Сейф: $${state.lockedProfit.toFixed(4)}`);
          try { await notifyTrade(symbol, 'sell', sellPrice.toFixed(6), profitUsd); } catch {}
          changed = true;
          invalidateBalanceCache();
        } catch (e) {
          log(`[${symbol}] TRAIL sell error: ${e.message}`);
          remaining.push(entry);
        }
      } else {
        remaining.push(entry);
      }
    }
  }

  if (changed) {
    grid.trailing = remaining;
    grid.currentPrice = currentPrice;
    saveState(state);
  }
}

// ===== Проверка исполненных ордеров =====
async function checkGrid(pairConfig) {
  const { symbol, stepPercent } = pairConfig;
  const market = getMarketInfo(symbol);

  const state = loadState();
  const grid = state.grids[symbol];
  if (!grid) return { filled: 0 };

  // Бюджет: из стейта (никогда не дёргаем API в горячем цикле)
  const budget = grid.budget || config.totalBudget / config.pairs.length;
  // F2: используем фактическое число линий из стейта (setupGrid мог уменьшить по minCost)
  const effectiveLines = grid.lines || pairConfig.gridLines;
  const amountPerLevel = budget / effectiveLines;
  const step = grid.step || stepPercent;

  let openOrders;
  try {
    openOrders = await exchange.fetchOpenOrders(symbol);
  } catch (e) {
    log(`[${symbol}] Ошибка fetchOpenOrders: ${e.message}`);
    obsLog('Баги', `❌ **${symbol}** ошибка fetchOpenOrders: ${e.message}`);
    return { filled: 0 };
  }

  const openIds = new Set(openOrders.map(o => o.id));
  const ticker = await exchange.fetchTicker(symbol);
  const currentPrice = ticker.last;

  // Обновляем текущую цену в стейте для status-панели
  grid.currentPrice = currentPrice;

  // B8: пропускаем trailing-проверку если trailing выключен и entries нет (экономим 17k вызовов/сут)
  if (config.trailing?.enabled || (grid.trailing && grid.trailing.length > 0)) {
    try {
      await checkTrailingStops(symbol, currentPrice, market);
    } catch (e) {
      log(`[${symbol}] checkTrailingStops error: ${e.message}`);
    }
  }

  let filledCount = 0;
  // Живой шаг — берём из кэша (обновляется каждые 10 мин), не фиксированный из грида
  const liveStep = getCurrentStep(symbol, step);
  const stepMultiplier = liveStep / 100;

  // Защита от дублей — запоминаем обработанные ID
  if (!state.processedIds) state.processedIds = [];

  for (const [priceKey, orderInfo] of Object.entries(grid.orders)) {
    if (orderInfo.status !== 'open') continue;
    if (openIds.has(orderInfo.id)) continue;

    // Защита от дублей
    if (state.processedIds.includes(orderInfo.id)) {
      orderInfo.status = 'filled';
      continue;
    }

    // Верифицируем через API — реально исполнен или отменён?
    let realStatus = 'closed'; // по умолчанию считаем исполненным
    try {
      const orderDetail = await exchange.fetchOrder(orderInfo.id, symbol);
      realStatus = orderDetail.status; // 'closed' = исполнен, 'canceled' = отменён
    } catch {
      // Если ошибка — пропускаем, проверим в следующем цикле
      continue;
    }

    if (realStatus === 'canceled' || realStatus === 'cancelled' || realStatus === 'expired') {
      log(`[${symbol}] ${orderInfo.side.toUpperCase()} @ ${priceKey} — отменён, пропускаю`);
      orderInfo.status = 'cancelled';
      state.processedIds.push(orderInfo.id);
      saveState(state);
      continue;
    }

    if (realStatus !== 'closed') {
      continue; // не исполнен — пропускаем
    }

    // Реально исполнен — сразу сохраняем ID чтобы не обработать дважды
    state.processedIds.push(orderInfo.id);
    saveState(state);
    filledCount++;

    if (orderInfo.side === 'buy') {
      const sellPrice = fmt(parseFloat(priceKey) * (1 + stepMultiplier), market.pricePrecision);
      // F1: продаём ровно то что купили (минус 0.2% на комиссию buy-стороны), а НЕ budget/gridLines
      // Иначе при buy-only разница купленного и запланированного повисает в hold
      const sellAmount = fmt(orderInfo.amount * 0.998, market.amountPrecision);

      if (config.trailing?.enabled) {
        // Trailing mode: не ставим limit sell, а кладём в tracker
        if (!grid.trailing) grid.trailing = [];
        const buyPrice = parseFloat(priceKey);
        const freshBal = await getBalances(true);
        const baseFree = freshBal[symbol.split('/')[0]]?.free || 0;
        const trailAmount = Math.min(orderInfo.amount, baseFree);
        if (trailAmount >= (market.limits?.amount?.min || 0)) {
          grid.trailing.push({
            buyPrice,
            amount: trailAmount,
            activated: false,
            peak: 0,
            createdAt: Date.now(),
            linkedFrom: priceKey,
          });
          log(`[${symbol}] BUY @ ${priceKey} ИСПОЛНЕН -> TRAIL (amount ${trailAmount}, актив при +${config.trailing.activatePercent || 0.8}%)`);
          obsLog('Сделки', `**${symbol}** BUY @ ${priceKey} → TRAIL (активация при +${config.trailing.activatePercent || 0.8}%, откат ${config.trailing.pullbackPercent || 0.15}%)`);
        } else {
          log(`[${symbol}] BUY @ ${priceKey} ИСПОЛНЕН но base < min — пропуск трейлинга`);
        }
      } else {
        log(`[${symbol}] BUY @ ${priceKey} ИСПОЛНЕН -> sell @ ${sellPrice}`);
        obsLog('Сделки', `📥 **${symbol}** BUY @ ${priceKey} → sell @ ${sellPrice}`);

        // Проверка: цена в лимитах и есть базовая монета
        if (sellPrice < market.minPrice || sellPrice > market.maxPrice) {
          log(`[${symbol}] Пропуск sell @ ${sellPrice} — цена за лимитами биржи`);
        } else {
          const freshBal = await getBalances(true);
          const baseFree = freshBal[symbol.split('/')[0]]?.free || 0;
          if (baseFree < sellAmount) {
            log(`[${symbol}] Пропуск sell @ ${sellPrice} — нехватка ${symbol.split('/')[0]} (есть ${baseFree.toFixed(6)}, нужно ${sellAmount})`);
          } else {
            try {
              const order = await exchange.createLimitSellOrder(symbol, sellAmount, sellPrice);
              grid.orders[sellPrice] = {
                id: order.id, side: 'sell', price: sellPrice, amount: sellAmount,
                status: 'open', linkedFrom: priceKey, placedAt: new Date().toISOString(),
              };
            } catch (e) {
              const errKey = `check_sell_${symbol}`;
              if (shouldLogError(errKey)) {
                log(`[${symbol}] Ошибка sell @ ${sellPrice}: ${e.message}`);
                obsLog('Баги', `❌ **${symbol}** ошибка sell @ ${sellPrice}: ${e.message}`);
              }
            }
          }
        }
      }

      state.trades.push({
        time: new Date().toISOString(), symbol, type: 'buy_filled',
        price: parseFloat(priceKey), amount: orderInfo.amount,
      });

      // buy — не спамим в TG, только лог

    } else if (orderInfo.side === 'sell') {
      const buyPrice = fmt(parseFloat(priceKey) * (1 - stepMultiplier), market.pricePrecision);
      // B2: профит и встречный buy считаем по РЕАЛЬНО проданному объёму, не по бюджету/lines
      // Иначе при миграции trailing (amount * 0.997) или DynStep смене lines — завышаем profit и
      // новый buy может оказаться больше чем мы получили USDT → накопление hold.
      const soldUsdt = orderInfo.amount * parseFloat(priceKey); // реально получили (до комиссии)
      const buyAmount = fmt((soldUsdt * 0.998) / buyPrice, market.amountPrecision); // реинвестим после 0.2% sell-комиссии
      const grossProfit = soldUsdt * stepMultiplier;
      const commission = soldUsdt * 0.004;
      const profitUsd = +(grossProfit - commission).toFixed(4);

      state.totalProfit += profitUsd;
      state.lockedProfit = +(((state.lockedProfit || 0) + profitUsd)).toFixed(4);
      if (!state.pairProfits) state.pairProfits = {};
      state.pairProfits[symbol] = (state.pairProfits[symbol] || 0) + profitUsd;

      // Дневная статистика
      if (!state.dayStats || state.dayStats.date !== today()) {
        state.dayStats = { date: today(), profit: 0, trades: 0 };
      }
      state.dayStats.profit += profitUsd;
      state.dayStats.trades++;

      log(`[${symbol}] SELL @ ${priceKey} ИСПОЛНЕН -> buy @ ${buyPrice} | +$${profitUsd} | Сейф: $${state.lockedProfit.toFixed(4)}`);
      obsLog('Сделки', `💰 **${symbol}** SELL @ ${priceKey} → buy @ ${buyPrice} | **+$${profitUsd}** | Сейф: $${state.lockedProfit.toFixed(4)}`);

      // O4: стоп-защита от падающего ножа — не выкупаем вниз если пара -8%+ за 24ч
      const pct24h = ticker.percentage;
      const fallingKnife = typeof pct24h === 'number' && pct24h <= -8;
      // Orphan-grid: пара уже заменена, новые buy не ставим. Sell-профит просто капает в копилку.
      if (grid.orphaned) {
        log(`[${symbol}] 👻 ORPHAN sell @ ${priceKey} ИСПОЛНЕН → counter-buy пропущен (пара заменена)`);
        notifyTrade(symbol, 'orphan_sell', priceKey, profitUsd).catch(() => {});
      } else if (fallingKnife) {
        log(`[${symbol}] 🛡️ Пропуск counter-buy — пара падает ${pct24h.toFixed(1)}%/24ч (защита от падающего ножа)`);
        obsLog('Система', `🛡️ **${symbol}** counter-buy пропущен: 24ч ${pct24h.toFixed(1)}% (защита)`);
      } else if (buyPrice < market.minPrice || buyPrice > market.maxPrice) {
        log(`[${symbol}] Пропуск buy @ ${buyPrice} — цена за лимитами биржи`);
      } else {
        const freshBal = await getBalances(true);
        const usdtFree = freshBal.USDT?.free || 0;
        const buyCost = buyAmount * buyPrice;
        if (usdtFree < buyCost) {
          log(`[${symbol}] Пропуск buy @ ${buyPrice} — нехватка USDT (есть $${usdtFree.toFixed(2)}, нужно $${buyCost.toFixed(2)})`);
        } else {
          try {
            const order = await exchange.createLimitBuyOrder(symbol, buyAmount, buyPrice);
            grid.orders[buyPrice] = {
              id: order.id, side: 'buy', price: buyPrice, amount: buyAmount,
              status: 'open', linkedFrom: priceKey, placedAt: new Date().toISOString(),
            };
          } catch (e) {
            const errKey = `check_buy_${symbol}`;
            if (shouldLogError(errKey)) {
              log(`[${symbol}] Ошибка buy @ ${buyPrice}: ${e.message}`);
              obsLog('Баги', `❌ **${symbol}** ошибка buy @ ${buyPrice}: ${e.message}`);
            }
          }
        }
      }

      state.trades.push({
        time: new Date().toISOString(), symbol, type: 'sell_filled',
        price: parseFloat(priceKey), amount: orderInfo.amount, profit: profitUsd,
      });

      // TG-3: fire-and-forget — TG API не блокирует checkGrid
      notifyTrade(symbol, 'sell', priceKey, profitUsd).catch(() => {});
    }

    orderInfo.status = 'filled';
    await sleep(150);
  }

  // Обновляем бюджет и чистим processedIds (храним последние 1000 — хватает на сутки даже при активной торговле)
  const { workingBudget: updatedBudget } = await getRealBudget();
  state.currentBudget = updatedBudget;
  grid.currentPrice = currentPrice;
  // B10: обрезаем до 1000 (было 200 — слишком мало при 50+ сделках/день, можно словить ложный processed)
  if (state.processedIds.length > 1000) {
    state.processedIds = state.processedIds.slice(-500);
  }
  saveState(state);
  return { filled: filledCount, currentPrice };
}

// ===== [6] Проверка ребалансировки =====
async function checkRebalance() {
  if (!config.rebalance?.enabled) return;

  const state = loadState();
  if (!state.pairProfits) return;

  const profits = config.pairs.map(p => ({
    symbol: p.symbol,
    profit: state.pairProfits[p.symbol] || 0,
  }));

  profits.sort((a, b) => b.profit - a.profit);

  if (profits.length < 2) return;

  const best = profits[0];
  const worst = profits[profits.length - 1];

  // Ребалансируем если разница профита > порога
  const threshold = config.rebalance.thresholdPercent || 30;
  const totalProfit = profits.reduce((s, p) => s + p.profit, 0);
  if (totalProfit <= 0) return;

  const bestShare = (best.profit / totalProfit) * 100;
  const worstShare = (worst.profit / totalProfit) * 100;

  if (bestShare - worstShare > threshold) {
    const { workingBudget: currentBudget } = await getRealBudget();

    log(`\n[РЕБАЛАНСИРОВКА] ${best.symbol} (${bestShare.toFixed(0)}% профита) vs ${worst.symbol} (${worstShare.toFixed(0)}% профита)`);

    // Пересоздаём гриды с новыми бюджетами
    for (const pairConfig of config.pairs) {
      const newBudget = await getPairBudget(state, pairConfig);
      log(`[РЕБАЛАНСИРОВКА] ${pairConfig.symbol}: $${newBudget.toFixed(2)}`);
    }

    // Переустанавливаем гриды
    for (const pairConfig of config.pairs) {
      await setupGrid(pairConfig, state);
      await sleep(500);
    }

    await notifyRebalance(worst.symbol, best.symbol, currentBudget * 0.1);
  }
}

// ===== [8] АВТО-ПЕРЕКЛЮЧЕНИЕ ПАР =====
async function closeGrid(symbol, opts = {}) {
  const keepSells = opts.keepSells === true;
  log(`[${symbol}] Закрытие грида${keepSells ? ' (keepSells: оставляем sell висеть)' : ''}...`);

  let cancelledBuys = 0, freedUSDT = 0, sellsKept = 0, lockedBaseUSDT = 0;

  if (keepSells) {
    // Отменяем только buy-ордера, sell остаются висеть
    try {
      const orders = await exchange.fetchOpenOrders(symbol);
      for (const o of orders) {
        if (o.side === 'buy') {
          try {
            await exchange.cancelOrder(o.id, symbol);
            cancelledBuys++;
            freedUSDT += (o.price || 0) * (o.amount || 0);
            await sleep(100);
          } catch (e) { log(`[${symbol}] Ошибка отмены buy ${o.id}: ${e.message}`); }
        } else if (o.side === 'sell') {
          sellsKept++;
          lockedBaseUSDT += (o.price || 0) * (o.amount || 0);
        }
      }
    } catch (e) { log(`[${symbol}] Ошибка fetchOpenOrders: ${e.message}`); }

    // Помечаем grid как orphaned (sell остаются, новые ордера НЕ ставим)
    const state = loadState();
    if (state.grids[symbol]) {
      state.grids[symbol].orphaned = true;
      state.grids[symbol].orphanedAt = Date.now();
      // Очистим buy-записи из orders, sell оставим — они нужны для трекинга profit
      for (const [priceKey, info] of Object.entries(state.grids[symbol].orders || {})) {
        if (info.side === 'buy') delete state.grids[symbol].orders[priceKey];
      }
      saveState(state);
    }
    log(`[${symbol}] keepSells: отменено ${cancelledBuys} buy ($${freedUSDT.toFixed(2)}), оставлено ${sellsKept} sell (~$${lockedBaseUSDT.toFixed(2)})`);
    return { cancelledBuys, freedUSDT, sellsKept, lockedBaseUSDT };
  }

  // === Полная ликвидация (старая логика) ===
  await cancelPairOrders(symbol);

  // Продаём все монеты по рынку
  const base = symbol.split('/')[0];
  const balances = await getBalances();
  const baseBalance = balances[base]?.free || 0;
  const market = getMarketInfo(symbol);

  if (baseBalance > market.minAmount) {
    const amount = fmt(baseBalance, market.amountPrecision);
    try {
      const ticker = await exchange.fetchTicker(symbol);
      // F5: maker-продажа по bid (экономим 0.2% taker). Если не исполнится за 3 мин — market.
      const sellPrice = fmt((ticker.bid || ticker.last) * 0.999, market.pricePrecision);
      const usdValue = baseBalance * (ticker.last || 0);
      if (amount * sellPrice < market.minCost) {
        // Слишком мало — сразу market
        await exchange.createMarketSellOrder(symbol, amount);
        log(`[${symbol}] Market sell ${amount} ${base} (~$${usdValue.toFixed(2)}) — под minCost для limit`);
      } else {
        const limitOrder = await exchange.createLimitSellOrder(symbol, amount, sellPrice);
        log(`[${symbol}] Limit sell ${amount} ${base} @ ${sellPrice} (~$${usdValue.toFixed(2)}) — жду 3 мин`);
        const deadline = Date.now() + 3 * 60 * 1000;
        let filled = false;
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 15000));
          try {
            const st = await exchange.fetchOrder(limitOrder.id, symbol);
            if (st.status === 'closed') { filled = true; break; }
          } catch {}
        }
        if (!filled) {
          try { await exchange.cancelOrder(limitOrder.id, symbol); } catch {}
          const bal2 = await getBalances(true);
          const rem = bal2[base]?.free || 0;
          if (rem > market.minAmount) {
            const remAmt = fmt(rem, market.amountPrecision);
            await exchange.createMarketSellOrder(symbol, remAmt);
            log(`[${symbol}] Market fallback ${remAmt} ${base} после 3 мин`);
          }
        } else {
          log(`[${symbol}] Limit sell исполнен (сэкономили 0.2% taker)`);
        }
      }
    } catch (e) {
      log(`[${symbol}] Ошибка продажи ${base}: ${e.message}`);
      obsLog('Баги', `❌ **${symbol}** ошибка продажи ${base}: ${e.message}`);
    }
  }

  // Удаляем из state
  const state = loadState();
  delete state.grids[symbol];
  saveState(state);
  log(`[${symbol}] Грид закрыт`);
}

async function autoSwitchPairs() {
  if (!config.scanner?.autoSwitch) return;
  // B3: во время news-паузы ротация недопустима — иначе откроем пары перед тем как main cancel их
  const stCheck = loadState();
  if (stCheck.paused) { log('autoSwitchPairs пропущен — бот на паузе'); return; }

  const minBudgetPerPair = config.scanner.minBudgetPerPair || 10;
  const reservePercent = config.scanner.reservePercent || 15;
  const minGridScore = config.scanner.minGridScore || 85;
  const dropScore = config.scanner.dropScore || 70; // ниже этого — убираем пару
  const maxPairs = config.scanner.maxPairs || 10;
  const minHoursBeforeRemove = config.scanner.minHoursBeforeRemove || 2; // не убираем свежие пары

  log('\n=== АВТО-РОТАЦИЯ ПАР ===');

  // Читаем результат из scanner-worker
  let topPairs;
  try {
    const scanData = JSON.parse(fs.readFileSync(join(ROOT, 'scanner-result.json'), 'utf8'));
    topPairs = scanData.top;
    const age = Math.round((Date.now() - new Date(scanData.time).getTime()) / 60000);
    if (age > 30) {
      log(`Данные сканера устарели (${age} мин) — пропускаю ротацию`);
      return;
    }
    log(`Данные сканера: ${topPairs.length} пар (${age} мин назад)`);
  } catch {
    log('Нет данных сканера — scanner-worker не запущен?');
    return;
  }
  if (!topPairs || topPairs.length === 0) return;

  const state = loadState();
  const scanScores = {};
  for (const p of topPairs) scanScores[p.symbol] = p.gridScore;

  // === ШАГ 1: Оценка текущих пар — найти слабые для замены ===
  const currentPairs = config.pairs.map(p => {
    const grid = state.grids[p.symbol];
    const score = scanScores[p.symbol] || 0; // 0 если пара вылетела из топа сканера
    const profit = state.pairProfits?.[p.symbol] || 0;
    const openOrders = Object.values(grid?.orders || {}).filter(o => o.status === 'open').length;
    const createdAt = grid?.createdAt || 0;
    const ageHours = createdAt ? (Date.now() - createdAt) / 3600000 : 999;
    return { symbol: p.symbol, score, profit, openOrders, ageHours, config: p };
  });

  log(`Текущие пары (${currentPairs.length}):`);
  for (const p of currentPairs) {
    const flag = p.score < dropScore ? '🔴' : p.score < minGridScore ? '🟡' : '🟢';
    log(`  ${flag} ${p.symbol}: score ${p.score.toFixed(0)}, профит $${p.profit.toFixed(4)}, ордеров ${p.openOrders}`);
  }

  // Слабые: score ниже порога, возраст > min, пара не на паузе, и не прибыльная за 24ч
  // FIX: если score=0 (пара вылетела из топа сканера вообще) — убираем ВСЕГДА, даже при малом числе пар
  const weakPairs = currentPairs.filter(p => {
    if (p.score === 0 && p.ageHours > minHoursBeforeRemove && !state.grids[p.symbol]?.paused && p.profit <= 0.2) return true;
    return p.score < dropScore &&
      p.ageHours > minHoursBeforeRemove &&
      currentPairs.length > 4 &&
      !state.grids[p.symbol]?.paused &&
      p.profit <= 0.2;
  });

  // Кандидаты на добавление: высокий score, нет в текущих
  const currentSymbols = currentPairs.map(p => p.symbol);
  const candidates = topPairs.filter(p =>
    !currentSymbols.includes(p.symbol) &&
    p.vol24h >= (config.scanner.minVolume24h || 500000) &&
    p.avgDailyRange >= (config.scanner.minDailyRange || 3) &&
    p.gridScore >= minGridScore
  );

  // === ШАГ 2: Ротация — убираем слабые, заменяем сильными ===
  let rotated = 0;
  for (const weak of weakPairs) {
    if (candidates.length === 0) break;
    const replacement = candidates.shift();

    log(`\n🔄 РОТАЦИЯ: ${weak.symbol} (score ${weak.score.toFixed(0)}) → ${replacement.symbol} (score ${replacement.gridScore.toFixed(0)})`);
    obsLog('Ротация', `🔄 **${weak.symbol}** (score ${weak.score.toFixed(0)}) → **${replacement.symbol}** (score ${replacement.gridScore.toFixed(0)})`);

    // Закрываем слабую
    try {
      await closeGrid(weak.symbol);
      config.pairs = config.pairs.filter(p => p.symbol !== weak.symbol);
    } catch (e) {
      log(`Ошибка закрытия ${weak.symbol}: ${e.message}`);
      continue;
    }

    await sleep(1000);
    invalidateBalanceCache();

    // Открываем новую
    const balances = await getBalances(true);
    const freeUsdt = balances.USDT?.free || 0;
    // Бюджет для новой пары: 1/N от рабочего капитала, но не меньше minBudget и не больше 50% свободного USDT
    const workingCap = config.totalBudget || 600;
    const perPairTarget = workingCap / Math.max(1, maxPairs);
    const budgetForNew = Math.max(minBudgetPerPair, Math.min(freeUsdt * 0.5, perPairTarget));

    if (budgetForNew < minBudgetPerPair) {
      log(`Недостаточно USDT для ${replacement.symbol} ($${freeUsdt.toFixed(2)})`);
      continue;
    }

    const newPairConfig = {
      symbol: replacement.symbol,
      budget: +budgetForNew.toFixed(2),
      gridLines: Math.max(6, Math.min(10, Math.floor(budgetForNew / 5))),
      stepPercent: 1.5,
    };

    config.pairs.push(newPairConfig);
    saveConfig();

    const newState = loadState();
    newState.grids[replacement.symbol] = { orders: {}, createdAt: Date.now() };
    saveState(newState);
    await setupGrid(newPairConfig, newState);
    invalidateBalanceCache();

    await sendTg(
      `🔄 <b>РОТАЦИЯ</b>\n${V.thinLine}\n` +
      `❌ ${weak.symbol} (score ${weak.score.toFixed(0)})\n` +
      `✅ ${replacement.symbol} (score ${replacement.gridScore.toFixed(0)})\n` +
      `Волатильность: ${replacement.avgDailyRange}%/день\n` +
      `Бюджет: $${budgetForNew.toFixed(2)}`
    );

    rotated++;
    await sleep(500);
  }

  if (rotated > 0) {
    log(`Ротация завершена: ${rotated} замен`);
  }

  // === ШАГ 3: Добавление новых (если есть свободный USDT и места) ===
  if (config.pairs.length < maxPairs && candidates.length > 0) {
    const balances = await getBalances(true);
    const freeUsdt = balances.USDT?.free || 0;
    const totalUsdt = (balances.USDT?.free || 0) + (balances.USDT?.used || 0);
    const reserve = totalUsdt * reservePercent / 100;
    let availableForNew = freeUsdt - reserve;

    if (availableForNew >= minBudgetPerPair) {
      log(`\nСвободный USDT для новых пар: $${availableForNew.toFixed(2)}`);

      for (const bestNew of candidates) {
        if (config.pairs.length >= maxPairs) break;
        if (availableForNew < minBudgetPerPair) break;

        const newMarket = exchange.market(bestNew.symbol);
        const budgetForNew = Math.min(availableForNew * 0.3, 35);
        // FIX: используем фактический gridLines а не магический 10 (иначе зря отсеивали валидных кандидатов)
        const newGridLines = Math.max(6, Math.min(10, Math.floor(budgetForNew / 5)));
        const orderSize = budgetForNew / newGridLines;

        if (orderSize < (newMarket.limits.cost?.min || 1)) continue;
        if (budgetForNew < minBudgetPerPair) break;

        log(`\n➕ ДОБАВЛЯЮ: ${bestNew.symbol} (score: ${bestNew.gridScore.toFixed(0)}, бюджет: $${budgetForNew.toFixed(2)})`);
        obsLog('Диверсификация', `➕ **${bestNew.symbol}** добавлена (score: ${bestNew.gridScore.toFixed(0)}, волат: ${bestNew.avgDailyRange}%/день, бюджет: $${budgetForNew.toFixed(2)})`);

        const newPairConfig = {
          symbol: bestNew.symbol,
          budget: +budgetForNew.toFixed(2),
          gridLines: newGridLines,
          stepPercent: 1.5,
        };

        config.pairs.push(newPairConfig);
        saveConfig();

        const newState = loadState();
        newState.grids[bestNew.symbol] = { orders: {}, createdAt: Date.now() };
        saveState(newState);
        await setupGrid(newPairConfig, newState);
        invalidateBalanceCache();

        availableForNew -= budgetForNew;

        await sendTg(
          `➕ <b>Новая пара: ${bestNew.symbol}</b>\n` +
          `Score: ${bestNew.gridScore.toFixed(0)}\n` +
          `Волатильность: ${bestNew.avgDailyRange}%/день\n` +
          `Бюджет: $${budgetForNew.toFixed(2)}\n` +
          `Всего пар: ${config.pairs.length}`
        );

        await sleep(500);
      }
    }
  }

  log(`Итого пар: ${config.pairs.length}`);
}

// ===== Статус =====
async function printStatus() {
  const state = loadState();
  let realBudgetInfo;
  try {
    realBudgetInfo = await getRealBudget();
  } catch { realBudgetInfo = null; }

  const gridBudget = Object.values(state.grids).reduce((sum, g) => sum + (g.budget || 0), 0);
  const budget = realBudgetInfo ? realBudgetInfo.workingBudget : gridBudget;

  log('\n═══ СТАТУС ГРИД-БОТА ═══');
  if (realBudgetInfo) {
    const usdtTotal = realBudgetInfo.usdtFree + realBudgetInfo.usdtUsed;
    const hold = realBudgetInfo.holdValue || 0;
    const holdStr = hold > 1 ? `, hold: $${hold.toFixed(2)}` : '';
    const safeStr = realBudgetInfo.lockedProfit > 0 ? ` | 🔒 Сейф: $${realBudgetInfo.lockedProfit.toFixed(2)}` : '';
    log(`Баланс: $${realBudgetInfo.totalValue.toFixed(2)} (USDT: $${usdtTotal.toFixed(2)}, торг.монеты: $${realBudgetInfo.tradingValue.toFixed(2)}${holdStr}) | Резерв: $${realBudgetInfo.reserve.toFixed(2)} | Рабочий: $${budget.toFixed(2)}${safeStr}`);
  } else {
    log(`Бюджет (grid): $${gridBudget.toFixed(2)}`);
  }

  const pairStats = [];
  for (const [symbol, grid] of Object.entries(state.grids)) {
    const openOrders = Object.values(grid.orders).filter(o => o.status === 'open');
    const buys = openOrders.filter(o => o.side === 'buy');
    const sells = openOrders.filter(o => o.side === 'sell');
    const pairProfit = state.pairProfits?.[symbol] || 0;

    log(`[${symbol}] Цена: ${grid.currentPrice} | Budget: $${(grid.budget || 0).toFixed(2)} | Step: ${grid.step || '?'}% | Buy: ${buys.length} | Sell: ${sells.length} | Профит: $${pairProfit.toFixed(4)}`);

    pairStats.push({ symbol, trades: 0, profit: pairProfit });
  }

  const dayProfit = state.dayStats?.date === today() ? state.dayStats.profit : 0;
  const dayTrades = state.dayStats?.date === today() ? state.dayStats.trades : 0;

  log(`Сегодня: ${dayTrades} сделок, +$${dayProfit.toFixed(4)}`);
  log(`Копилка: $${state.totalProfit.toFixed(4)} | Всего сделок: ${state.trades.length}`);
  log('═'.repeat(40));

  return { dayProfit, totalProfit: state.totalProfit, budget, trades: dayTrades, pairs: pairStats };
}

// ===== Дневной отчёт =====
let lastReportDate = '';

async function dailyReport() {
  const todayStr = today();
  if (lastReportDate === todayStr) return;

  const now = new Date();
  const hour = (now.getUTCHours() + 3) % 24; // MSK
  if (hour < 23) return;

  lastReportDate = todayStr;

  const stats = await printStatus();
  await notifyDailyReport(stats);

  // Дописываем итоги дня в Obsidian (не затираем записи obsLog)
  try {
    const obsidianDir = 'C:/Users/user/Documents/Obsidian Vault/htx-bot/spot-grid/logs';
    const state = loadState();
    const dayTrades = state.trades.filter(t => t.time.startsWith(todayStr));
    const filePath = `${obsidianDir}/${todayStr}.md`;

    // Читаем существующий файл (obsLog мог уже написать туда)
    let existing = '';
    try { existing = fs.readFileSync(filePath, 'utf8'); } catch {}

    // Формируем блок итогов
    let report = '';
    report += `\n## Итого дня\n`;
    report += `- Бюджет: $${stats.budget.toFixed(2)}\n`;
    report += `- Сделок: ${stats.trades}\n`;
    report += `- Профит за день: $${stats.dayProfit.toFixed(4)}\n`;
    report += `- Общий профит: $${stats.totalProfit.toFixed(4)}\n\n`;

    report += `## Пары (итог)\n`;
    for (const [symbol, grid] of Object.entries(state.grids)) {
      const pp = state.pairProfits?.[symbol] || 0;
      report += `- ${symbol}: бюджет $${(grid.budget || 0).toFixed(2)}, шаг ${grid.step || '?'}%, профит $${pp.toFixed(4)}\n`;
    }

    report += `\n## Все сделки\n`;
    for (const t of dayTrades) {
      if (t.profit) {
        report += `- ${t.time.split('T')[1].slice(0,8)} ${t.symbol} ${t.type} @ ${t.price} → +$${t.profit}\n`;
      } else {
        report += `- ${t.time.split('T')[1].slice(0,8)} ${t.symbol} ${t.type} @ ${t.price}\n`;
      }
    }

    // Убираем старый блок итогов если был, дописываем новый
    if (existing.includes('## Итого дня')) {
      const idx = existing.indexOf('## Итого дня');
      existing = existing.slice(0, idx).trimEnd();
    }

    const content = existing ? existing + '\n' + report : `# Spot Grid Log ${todayStr}\n` + report;
    fs.writeFileSync(filePath, content);
    log(`Obsidian лог записан: ${todayStr}.md`);
  } catch (e) {
    log(`Ошибка записи Obsidian: ${e.message}`);
  }
}

// ===== Uptime =====
const BOT_START_TIME = Date.now();

function formatUptime() {
  const ms = Date.now() - BOT_START_TIME;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 0) return `${h}ч ${m}мин`;
  return `${m}мин`;
}

// ===== Хелперы для статистики =====
function getTradesForPeriod(state, startDate) {
  return state.trades.filter(t => t.time >= startDate);
}

function getPeriodStats(state, startDate) {
  const trades = getTradesForPeriod(state, startDate);
  // TG-8: profit может быть 0 (комиссия съела всё) — считать sell по type, не по truthy
  const sells = trades.filter(t => t.type === 'sell_filled' || typeof t.profit === 'number');
  const profit = sells.reduce((s, t) => s + (t.profit || 0), 0);

  const pairProfits = {};
  for (const t of sells) {
    pairProfits[t.symbol] = (pairProfits[t.symbol] || 0) + t.profit;
  }

  const pairs = Object.entries(pairProfits).map(([symbol, p]) => ({ symbol, profit: p }));
  pairs.sort((a, b) => b.profit - a.profit);

  return {
    trades: trades.length,
    sellTrades: sells.length,
    profit,
    bestPair: pairs[0] || null,
    worstPair: pairs[pairs.length - 1] || null,
    pairs,
  };
}

function getStreak(state) {
  let streak = 0;
  const d = new Date();
  for (let i = 0; i < 30; i++) {
    const dateStr = d.toISOString().split('T')[0];
    const dayTrades = state.trades.filter(t => t.time.startsWith(dateStr) && t.profit);
    const dayProfit = dayTrades.reduce((s, t) => s + t.profit, 0);
    if (dayProfit > 0) { streak++; } else if (dayTrades.length > 0) { break; } else if (i > 0) { break; }
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

function getRecords(state) {
  // Лучший день
  const dayProfits = {};
  for (const t of state.trades) {
    if (!t.profit) continue;
    const day = t.time.split('T')[0];
    dayProfits[day] = (dayProfits[day] || 0) + t.profit;
  }
  const days = Object.entries(dayProfits).map(([d, p]) => ({ date: d, profit: p }));
  days.sort((a, b) => b.profit - a.profit);

  // Лучшая сделка
  const bestTrade = state.trades.filter(t => t.profit).sort((a, b) => b.profit - a.profit)[0] || null;

  return {
    bestDay: days[0] || null,
    bestTrade,
    totalDays: days.length,
    profitableDays: days.filter(d => d.profit > 0).length,
    streak: getStreak(state),
  };
}

// ===== Обработчик команд TG =====
async function handleTgCommand(cmd, arg, value) {
  const st = loadState();
  const dayProfit = st.dayStats?.date === today() ? st.dayStats.profit : 0;
  const dayTrades = st.dayStats?.date === today() ? st.dayStats.trades : 0;

  // ===== ПИНГ =====
  if (cmd === 'ping') {
    const errors = 0; // TODO: track runtime errors count
    await sendTg(
      `${st.paused ? '🔴' : '🟢'} <b>${st.paused ? 'На паузе' : 'Работаю'}</b> | ⏱ ${formatUptime()}\n` +
      `${V.money} Сегодня: ${V.pnl(dayProfit)} (${dayTrades} сделок)`
    );
    return;
  }

  // ===== ДОЛЛАР =====
  if (cmd === 'dollar') {
    // TG-4: динамическая цель = 1% от бюджета (минимум $1)
    const dailyGoal = Math.max(1, (config.totalBudget || 600) * 0.01);
    const pct = Math.min(100, Math.max(0, (dayProfit / dailyGoal) * 100));
    await sendTg(
      `${V.pnlIcon(dayProfit)} Сегодня: <b>${V.pnl(dayProfit)}</b>\n` +
      `${V.target} $${dailyGoal.toFixed(2)}: ${V.bar(pct, 15)} ${pct.toFixed(0)}%`
    );
    return;
  }

  // ===== СТАТУС (существующий, улучшенный) =====
  if (cmd === 'status') {
    let budgetInfo;
    try { budgetInfo = await getRealBudget(); } catch {}

    let msg = `${V.chart} <b>СТАТУС</b>\n${V.line}\n\n`;
    msg += `${st.paused ? '🔴 НА ПАУЗЕ' : '🟢 Работает'} | ⏱ ${formatUptime()}\n\n`;

    if (budgetInfo) {
      msg += `💼 Баланс биржи: <b>$${budgetInfo.totalValue.toFixed(2)}</b>\n`;
      msg += `   USDT: $${(budgetInfo.usdtFree + budgetInfo.usdtUsed).toFixed(2)} | Торг: $${budgetInfo.tradingValue.toFixed(2)}`;
      if (budgetInfo.holdValue > 1) {
        const holdCoins = Object.entries(budgetInfo.holdBreakdown || {})
          .filter(([, v]) => v > 1).map(([c]) => c).join(', ');
        msg += ` | Hold: $${budgetInfo.holdValue.toFixed(2)}${holdCoins ? ` (${holdCoins})` : ''}`;
      }
      msg += `\n⚙️ Рабочий: <b>$${budgetInfo.workingBudget.toFixed(2)}</b>\n\n`;
    }

    // TG-6: считаем дневной профит по парам отдельно от накопленного
    const todayStr = today();
    const todayPairProfits = {};
    for (const t of st.trades) {
      if (!t.time.startsWith(todayStr) || typeof t.profit !== 'number') continue;
      todayPairProfits[t.symbol] = (todayPairProfits[t.symbol] || 0) + t.profit;
    }

    let totalOpenOrders = 0;
    for (const [symbol, grid] of Object.entries(st.grids)) {
      let buys = 0, sells = 0;
      try {
        const oo = await exchange.fetchOpenOrders(symbol);
        buys = oo.filter(o => o.side === 'buy').length;
        sells = oo.filter(o => o.side === 'sell').length;
        totalOpenOrders += oo.length;
      } catch {}
      const coin = symbol.split('/')[0];
      const todayPp = todayPairProfits[symbol] || 0;
      const allPp = st.pairProfits?.[symbol] || 0;
      msg += `${V.pnlIcon(allPp)} <b>${coin}</b> $${grid.currentPrice} | ${buys}B/${sells}S | день ${V.pnl(todayPp)} / всего ${V.pnl(allPp)}\n`;
    }

    msg += `\n${V.thinLine}\n`;
    msg += `${V.bolt} Сегодня: <b>${dayTrades}</b> сделок | <b>${V.pnl(dayProfit)}</b>\n`;
    msg += `${V.gem} Копилка: <b>$${st.totalProfit.toFixed(2)}</b>\n`;
    msg += `📋 Ордеров: ${totalOpenOrders}`;

    await sendWithKeyboard(msg);
    return;
  }

  // ===== ПРОФИТ =====
  if (cmd === 'profit') {
    const todayUtc = today();
    const yesterdayUtc = new Date(Date.now() - 86400000).toISOString().split('T')[0];

    let periodTitle, startDate, endDate, isToday = false;
    const a = arg || 'summary';
    if (a === 'today') {
      startDate = todayUtc; endDate = todayUtc; isToday = true;
      periodTitle = `Сегодня (${todayUtc})`;
    } else if (a === 'yesterday') {
      startDate = yesterdayUtc; endDate = yesterdayUtc;
      periodTitle = `Вчера (${yesterdayUtc})`;
    } else if (a === 'week') {
      startDate = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
      endDate = todayUtc;
      periodTitle = `Последние 7 дней`;
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(a)) {
      startDate = a; endDate = a;
      periodTitle = `День ${a}`;
    } else {
      startDate = null; endDate = null;
      periodTitle = null;
    }

    let msg;
    if (periodTitle) {
      const trades = st.trades.filter(t => {
        const d = t.time.split('T')[0];
        return d >= startDate && d <= endDate;
      });
      const sells = trades.filter(t => t.type === 'sell_filled' || typeof t.profit === 'number');
      const periodProfit = sells.reduce((s, t) => s + (t.profit || 0), 0);
      const pairProfits = {};
      for (const t of sells) {
        pairProfits[t.symbol] = (pairProfits[t.symbol] || 0) + (t.profit || 0);
      }

      msg = `${V.money} <b>ПРОФИТ — ${periodTitle}</b>\n${V.line}\n\n`;
      msg += `${V.bolt} Сделок: <b>${sells.length}</b>\n`;
      msg += `${V.money} Профит: <b>${V.pnl(periodProfit)}</b>\n`;
      if (a === 'week') msg += `📊 Ср. в день: ${V.pnl(periodProfit / 7)}\n`;
      msg += `${V.gem} Копилка-стат (всего): <b>$${st.totalProfit.toFixed(2)}</b>\n`;
      msg += `🔒 Сейф (заморожено): <b>$${(st.lockedProfit || 0).toFixed(2)}</b>\n`;

      if (Object.keys(pairProfits).length > 0) {
        msg += `\n<b>По парам:</b>\n`;
        const sorted = Object.entries(pairProfits).sort((a, b) => b[1] - a[1]);
        for (const [sym, pp] of sorted) {
          const coin = sym.split('/')[0];
          msg += `  ${V.pnlIcon(pp)} ${coin}: ${V.pnl(pp)}\n`;
        }
      }

      if (isToday) {
        const dailyGoal = Math.max(1, (config.totalBudget || 600) * 0.01);
        const pct = Math.min(100, Math.max(0, (periodProfit / dailyGoal) * 100));
        msg += `\n${V.target} Цель $${dailyGoal.toFixed(2)}: ${V.bar(pct, 15)} ${pct.toFixed(0)}%\n`;
      }
    } else {
      msg = `${V.money} <b>ПРОФИТ</b>\n${V.line}\n\n`;
      msg += `${V.bolt} Сегодня: <b>${V.pnl(dayProfit)}</b> (${dayTrades} сделок)\n`;
      msg += `${V.gem} Копилка-стат: <b>$${st.totalProfit.toFixed(2)}</b>\n`;
      msg += `🔒 Сейф (заморожено): <b>$${(st.lockedProfit || 0).toFixed(2)}</b>\n\n`;
      if (Object.keys(st.pairProfits || {}).length > 0) {
        msg += `<b>По парам (всего):</b>\n`;
        const sorted = Object.entries(st.pairProfits).sort((a, b) => b[1] - a[1]);
        for (const [sym, pp] of sorted) {
          const coin = sym.split('/')[0];
          const pct = st.totalProfit > 0 ? (pp / st.totalProfit * 100) : 0;
          msg += `  ${V.pnlIcon(pp)} ${coin.padEnd(5)} ${V.pnl(pp).padEnd(10)} ${V.bar(Math.abs(pct), 8)} ${pct.toFixed(0)}%\n`;
        }
      }
      const dailyGoal = Math.max(1, (config.totalBudget || 600) * 0.01);
      const pct = Math.min(100, Math.max(0, (dayProfit / dailyGoal) * 100));
      msg += `\n${V.target} Цель $${dailyGoal.toFixed(2)}: ${V.bar(pct, 15)} ${pct.toFixed(0)}%\n`;
    }

    msg += `\n<i>⏱ Дни считаются в UTC — день меняется в 03:00 МСК</i>`;

    const mkBtn = (offset) => {
      const d = new Date(Date.now() - offset * 86400000).toISOString().split('T')[0];
      return { text: d, callback_data: `профит:${d}` };
    };
    const inline = [
      [{ text: '📅 Сегодня', callback_data: 'профит:today' },
       { text: '📅 Вчера', callback_data: 'профит:yesterday' }],
      [mkBtn(2), mkBtn(3), mkBtn(4)],
      [mkBtn(5), mkBtn(6), mkBtn(7)],
      [{ text: '📊 Неделя (сумма)', callback_data: 'профит:week' }],
    ];

    await sendTg(msg, { keyboard: { inline_keyboard: inline } });
    return;
  }

  // ===== НЕДЕЛЯ =====
  if (cmd === 'week') {
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
    const stats = getPeriodStats(st, weekAgo);

    let msg = `📈 <b>НЕДЕЛЯ</b>\n${V.line}\n\n`;
    msg += `${V.bolt} Сделок: <b>${stats.sellTrades}</b>\n`;
    msg += `${V.money} Профит: <b>${V.pnl(stats.profit)}</b>\n`;
    msg += `📊 Ср. в день: ${V.pnl(stats.profit / 7)}\n\n`;

    if (stats.bestPair) msg += `${V.crown} Лучшая: <b>${stats.bestPair.symbol.split('/')[0]}</b> ${V.pnl(stats.bestPair.profit)}\n`;
    if (stats.worstPair && stats.pairs.length > 1) msg += `${V.down} Худшая: <b>${stats.worstPair.symbol.split('/')[0]}</b> ${V.pnl(stats.worstPair.profit)}\n`;

    if (stats.pairs.length > 0) {
      msg += `\n<b>Разбивка:</b>\n`;
      for (const p of stats.pairs) {
        msg += `  ${V.pnlIcon(p.profit)} ${p.symbol.split('/')[0]}: ${V.pnl(p.profit)}\n`;
      }
    }

    await sendWithKeyboard(msg);
    return;
  }

  // ===== МЕСЯЦ =====
  if (cmd === 'month') {
    const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
    const stats = getPeriodStats(st, monthAgo);

    let msg = `📅 <b>МЕСЯЦ</b>\n${V.line}\n\n`;
    msg += `${V.bolt} Сделок: <b>${stats.sellTrades}</b>\n`;
    msg += `${V.money} Профит: <b>${V.pnl(stats.profit)}</b>\n`;
    msg += `📊 Ср. в день: ${V.pnl(stats.profit / 30)}\n`;

    let budgetInfo;
    try { budgetInfo = await getRealBudget(); } catch {}
    if (budgetInfo && stats.profit > 0) {
      const roi = (stats.profit / budgetInfo.totalValue * 100);
      msg += `📈 ROI: <b>${roi.toFixed(1)}%</b>\n`;
    }

    if (stats.bestPair) msg += `\n${V.crown} Лучшая: <b>${stats.bestPair.symbol.split('/')[0]}</b> ${V.pnl(stats.bestPair.profit)}`;

    await sendWithKeyboard(msg);
    return;
  }

  // ===== РЕКОРД =====
  if (cmd === 'record') {
    const rec = getRecords(st);

    let msg = `${V.trophy} <b>РЕКОРДЫ</b>\n${V.line}\n\n`;

    if (rec.bestDay) {
      msg += `${V.crown} Лучший день: <b>${V.pnl(rec.bestDay.profit)}</b>\n`;
      msg += `   ${rec.bestDay.date}\n\n`;
    }
    if (rec.bestTrade) {
      msg += `${V.gem} Лучшая сделка: <b>${V.pnl(rec.bestTrade.profit)}</b>\n`;
      msg += `   ${rec.bestTrade.symbol} @ ${rec.bestTrade.price}\n\n`;
    }

    msg += `${V.fire} Streak: <b>${rec.streak} дн</b> в плюсе\n`;
    msg += `📊 Дней торговли: ${rec.totalDays}\n`;
    msg += `${V.up} В плюсе: ${rec.profitableDays}/${rec.totalDays}`;
    if (rec.totalDays > 0) {
      msg += ` (${(rec.profitableDays / rec.totalDays * 100).toFixed(0)}%)`;
    }

    await sendWithKeyboard(msg);
    return;
  }

  // ===== ОРДЕРА =====
  if (cmd === 'orders') {
    let msg = `📋 <b>ОРДЕРА</b>\n${V.line}\n\n`;
    let totalBuyUSDT = 0, totalSellUSDT = 0;

    for (const [symbol, grid] of Object.entries(st.grids)) {
      const coin = symbol.split('/')[0];
      const price = grid.currentPrice;
      let orders;
      try { orders = await exchange.fetchOpenOrders(symbol); } catch { orders = []; }

      const buys = orders.filter(o => o.side === 'buy').sort((a, b) => b.price - a.price);
      const sells = orders.filter(o => o.side === 'sell').sort((a, b) => a.price - b.price);

      const buyUSDT = buys.reduce((s, o) => s + (o.price || 0) * (o.amount || 0), 0);
      const sellUSDT = sells.reduce((s, o) => s + (o.price || 0) * (o.amount || 0), 0);
      totalBuyUSDT += buyUSDT;
      totalSellUSDT += sellUSDT;

      const orphanTag = grid.orphaned ? ' 👻 ORPHAN' : '';
      msg += `<b>${coin}</b>${orphanTag} $${price} | шаг ${grid.step || '?'}%\n`;

      if (sells.length > 0) {
        const nearest = sells[0];
        const dist = ((nearest.price - price) / price * 100).toFixed(1);
        msg += `  🔺 Sell: ${sells.length} шт | $${sellUSDT.toFixed(2)} | ближ. $${nearest.price} (+${dist}%)\n`;
      }
      if (buys.length > 0) {
        const nearest = buys[0];
        const dist = ((price - nearest.price) / price * 100).toFixed(1);
        msg += `  🔻 Buy:  ${buys.length} шт | $${buyUSDT.toFixed(2)} | ближ. $${nearest.price} (-${dist}%)\n`;
      }
      if (grid.orphaned) {
        msg += `  <i>пара заменена, sell ждут отскока — «отмени sell ${coin}» / «продай ${coin}»</i>\n`;
      }
      msg += '\n';
    }

    msg += `${V.thinLine}\n`;
    msg += `💰 Всего в ордерах:\n`;
    msg += `  🔻 Buy:  <b>$${totalBuyUSDT.toFixed(2)}</b>\n`;
    msg += `  🔺 Sell: <b>$${totalSellUSDT.toFixed(2)}</b>`;

    await sendWithKeyboard(msg);
    return;
  }

  // ===== БАЛАНС =====
  if (cmd === 'balance') {
    let budgetInfo;
    try { budgetInfo = await getRealBudget(true); } catch {}
    const bal = await getBalances(true);

    let msg = `💵 <b>БАЛАНС</b>\n${V.line}\n\n`;

    if (budgetInfo) {
      msg += `💼 Всего: <b>$${budgetInfo.totalValue.toFixed(2)}</b>\n`;
      msg += `   📊 В работе: $${budgetInfo.workingBudget.toFixed(2)}\n`;
      msg += `   🔒 Резерв: $${budgetInfo.reserve.toFixed(2)}\n\n`;
    }

    const usdtFree = bal.USDT?.free || 0;
    const usdtUsed = bal.USDT?.used || 0;
    msg += `<b>USDT</b>\n`;
    msg += `   Свободно: $${usdtFree.toFixed(2)}\n`;
    msg += `   В ордерах: $${usdtUsed.toFixed(2)}\n\n`;

    msg += `<b>Монеты:</b>\n`;
    for (const [symbol, grid] of Object.entries(st.grids)) {
      const base = symbol.split('/')[0];
      const free = bal[base]?.free || 0;
      const used = bal[base]?.used || 0;
      const total = free + used;
      if (total < 0.0001) continue;
      const usdVal = total * (grid.currentPrice || 0);
      const pct = budgetInfo ? (usdVal / budgetInfo.totalValue * 100) : 0;
      msg += `   ${base}: ${total.toFixed(4)} (~$${usdVal.toFixed(2)}) ${V.bar(pct, 6)} ${pct.toFixed(0)}%\n`;
    }

    await sendWithKeyboard(msg);
    return;
  }

  // ===== АКТИВЫ — все монеты на балансе (торговые + hold) =====
  if (cmd === 'assets') {
    let budgetInfo;
    try { budgetInfo = await getRealBudget(true); } catch {}
    const bal = await getBalances(true);
    const tradingSyms = new Set(config.pairs.map(p => p.symbol));
    const tradingCoins = new Set([...tradingSyms].map(s => s.split('/')[0]));

    const usdtFree = bal.USDT?.free || 0;
    const usdtUsed = bal.USDT?.used || 0;
    const usdtTotal = usdtFree + usdtUsed;

    // Собираем все монеты с ненулевым балансом + USD-оценка
    const items = []; // {coin, free, used, total, price, usd, kind}
    for (const [coin, v] of Object.entries(bal)) {
      if (coin === 'USDT' || coin === 'info' || coin === 'free' || coin === 'used' || coin === 'total') continue;
      if (typeof v !== 'object') continue;
      const free = v.free || 0;
      const used = v.used || 0;
      const total = free + used;
      if (total <= 0) continue;

      let price = 0;
      let kind;
      if (tradingCoins.has(coin)) {
        kind = 'trade';
        const gsym = [...tradingSyms].find(s => s.startsWith(coin + '/'));
        price = st.grids[gsym]?.currentPrice || 0;
        if (!price) {
          try { price = (await exchange.fetchTicker(gsym)).last || 0; } catch {}
        }
      } else {
        kind = 'hold';
        try { price = (await exchange.fetchTicker(`${coin}/USDT`)).last || 0; } catch {}
      }
      const usd = total * price;
      if (usd < 0.01) continue;
      items.push({ coin, free, used, total, price, usd, kind });
    }
    items.sort((a, b) => b.usd - a.usd);

    const totalCoinUsd = items.reduce((s, i) => s + i.usd, 0);
    const totalAll = usdtTotal + totalCoinUsd;

    let msg = `💎 <b>АКТИВЫ</b>\n${V.line}\n\n`;
    msg += `💼 Всего: <b>$${totalAll.toFixed(2)}</b>\n`;
    msg += `   USDT: $${usdtTotal.toFixed(2)} (своб $${usdtFree.toFixed(2)} / ордера $${usdtUsed.toFixed(2)})\n`;
    msg += `   Монеты: $${totalCoinUsd.toFixed(2)}\n\n`;

    const tradeItems = items.filter(i => i.kind === 'trade');
    const holdItems = items.filter(i => i.kind === 'hold');

    if (tradeItems.length > 0) {
      msg += `<b>📊 Торговые (${tradeItems.length}):</b>\n`;
      for (const it of tradeItems) {
        const pct = totalAll > 0 ? (it.usd / totalAll * 100) : 0;
        const amtStr = it.total >= 1 ? it.total.toFixed(4) : it.total.toPrecision(4);
        const priceStr = it.price >= 1 ? it.price.toFixed(4) : it.price.toPrecision(4);
        msg += `   <b>${it.coin}</b>: ${amtStr} @ $${priceStr} = <b>$${it.usd.toFixed(2)}</b> (${pct.toFixed(1)}%)\n`;
      }
      msg += `\n`;
    }

    if (holdItems.length > 0) {
      msg += `<b>👜 Hold (${holdItems.length}):</b>\n`;
      for (const it of holdItems) {
        const pct = totalAll > 0 ? (it.usd / totalAll * 100) : 0;
        const amtStr = it.total >= 1 ? it.total.toFixed(4) : it.total.toPrecision(4);
        const priceStr = it.price >= 1 ? it.price.toFixed(4) : it.price.toPrecision(4);
        msg += `   <b>${it.coin}</b>: ${amtStr} @ $${priceStr} = <b>$${it.usd.toFixed(2)}</b> (${pct.toFixed(1)}%)\n`;
      }
      msg += `\n<i>Hold не торгуется. Продать: </i><code>продай XXX</code>\n`;
    }

    if (items.length === 0) msg += `<i>Монет на балансе нет</i>\n`;

    await sendWithKeyboard(msg);
    return;
  }

  // ===== СКАНЕР =====
  if (cmd === 'scanner') {
    let scanData;
    try {
      scanData = JSON.parse(fs.readFileSync(join(ROOT, 'scanner-result.json'), 'utf8'));
    } catch {
      await sendTg(`${V.warn} Нет данных сканера`);
      return;
    }

    const age = Math.round((Date.now() - new Date(scanData.time).getTime()) / 60000);
    const currentSymbols = new Set(config.pairs.map(p => p.symbol));
    const all = scanData.top || [];

    // Top-5 среди всех (общий топ), rank нужен для каждой активной
    const ranked = [...all].sort((a, b) => b.gridScore - a.gridScore);
    const rankMap = new Map(ranked.map((c, i) => [c.symbol, i + 1]));

    const inactiveTop = ranked.filter(c => !currentSymbols.has(c.symbol)).slice(0, 5);
    const activeWithMetrics = [...currentSymbols].map(sym => {
      const m = all.find(c => c.symbol === sym);
      return m ? { ...m, rank: rankMap.get(sym) } : { symbol: sym, notFound: true };
    });
    // Сортируем активные: сперва те что не в данных сканера, потом по rank
    activeWithMetrics.sort((a, b) => {
      if (a.notFound && !b.notFound) return 1;
      if (!a.notFound && b.notFound) return -1;
      return (a.rank || 999) - (b.rank || 999);
    });

    let msg = `🔍 <b>СКАНЕР v4</b> <i>(${age} мин назад)</i>\n${V.line}\n`;
    msg += `<i>Yield = RT × step (доходность/день на $ капитала)</i>\n\n`;

    msg += `<b>🏆 ТОП-5 общий:</b>\n`;
    for (const p of ranked.slice(0, 5)) {
      const coin = p.symbol.split('/')[0];
      const active = currentSymbols.has(p.symbol) ? ' ✅' : '';
      const verdict = p.verdict || '';
      const yPct = p.yieldPct != null ? `${p.yieldPct.toFixed(1)}%/д` : '—';
      msg += `<code>${String(p.gridScore).padStart(5)}</code> <b>${coin}</b>${active} ${verdict}\n`;
      msg += `       yield ${yPct} · RT ${p.dailyRT?.toFixed(1) ?? '—'} · step ${p.effectiveStep?.toFixed(1) ?? '—'}%\n`;
    }

    msg += `\n<b>📊 ТВОИ ПАРЫ:</b>\n`;
    let weakCount = 0;
    for (const p of activeWithMetrics) {
      const coin = p.symbol.split('/')[0];
      if (p.notFound) {
        msg += `<code>  ?  </code> <b>${coin}</b> — вне фильтра сканера ${V.warn}\n`;
        weakCount++;
        continue;
      }
      const tag = p.rank <= 10 ? V.up : p.rank <= 20 ? V.flat : V.down;
      if (p.rank > 15) weakCount++;
      const pnl = p.todayPnl ? ` ${V.pnl(p.todayPnl)}` : '';
      const verdict = p.verdict ? ` ${p.verdict}` : '';
      const yPct = p.yieldPct != null ? `${p.yieldPct.toFixed(1)}%/д` : '—';
      msg += `${tag} #${String(p.rank).padStart(2)} <b>${coin}</b> score=${p.gridScore} · yield ${yPct}${pnl}${verdict}\n`;
    }

    if (weakCount > 0) {
      msg += `\n<b>🌟 КАНДИДАТЫ на замену:</b>\n`;
      for (const p of inactiveTop) {
        const coin = p.symbol.split('/')[0];
        const verdict = p.verdict || '';
        const yPct = p.yieldPct != null ? `${p.yieldPct.toFixed(1)}%/д` : '—';
        msg += `<code>${String(p.gridScore).padStart(5)}</code> <b>${coin}</b> · yield ${yPct} ${verdict}\n`;
      }
      msg += `\n<i>Замени через: заменить SYM на SYM2</i>`;
    } else {
      msg += `\n${V.up} Все пары в топ-15 — ротация не нужна`;
    }

    await sendWithKeyboard(msg);
    return;
  }

  // ===== РЫНОК =====
  if (cmd === 'market') {
    const { analyzeNews: _analyzeNews } = await import('./news.js');
    const news = await _analyzeNews((...a) => {}); // silent

    let msg = `🌍 <b>РЫНОК</b>\n${V.line}\n\n`;

    if (news.fearGreed) {
      const fg = news.fearGreed.value;
      const fgBar = V.bar(fg, 15);
      const fgIcon = fg < 25 ? '😱' : fg < 45 ? '😟' : fg < 55 ? '😐' : fg < 75 ? '😊' : '🤑';
      msg += `${fgIcon} Fear & Greed: <b>${fg}</b> (${news.fearGreed.label})\n`;
      msg += `   ${fgBar}\n\n`;
    }

    msg += `📰 Новости: Score <b>${news.score}</b>`;
    if (news.reasons.length > 0) msg += `\n   ${news.reasons.join('\n   ')}`;
    msg += `\n\n`;

    // BTC price
    try {
      const btcTicker = await exchange.fetchTicker('BTC/USDT');
      msg += `₿ BTC: <b>$${btcTicker.last.toFixed(0)}</b>`;
      if (btcTicker.percentage) msg += ` (${btcTicker.percentage > 0 ? '+' : ''}${btcTicker.percentage.toFixed(1)}%)`;
    } catch {}

    await sendWithKeyboard(msg);
    return;
  }

  // ===== РИСК =====
  if (cmd === 'risk') {
    let budgetInfo;
    try { budgetInfo = await getRealBudget(true); } catch {}

    let msg = `${V.shield} <b>РИСК</b>\n${V.line}\n\n`;

    if (budgetInfo) {
      const drop10 = budgetInfo.baseValue * 0.1;
      const drop20 = budgetInfo.baseValue * 0.2;
      msg += `Если монеты упадут:\n`;
      msg += `   -10%: потеря <b>~$${drop10.toFixed(2)}</b>\n`;
      msg += `   -20%: потеря <b>~$${drop20.toFixed(2)}</b>\n\n`;
      msg += `${V.shield} Резерв: $${budgetInfo.reserve.toFixed(2)} (${((budgetInfo.reserve / budgetInfo.totalValue) * 100).toFixed(0)}%)\n`;
      msg += `💵 Свободный USDT: $${budgetInfo.usdtFree.toFixed(2)}\n\n`;
    }

    msg += `<b>Экспозиция по парам:</b>\n`;
    const bal = await getBalances(true);
    let totalExposure = 0;
    for (const [symbol, grid] of Object.entries(st.grids)) {
      const base = symbol.split('/')[0];
      const total = (bal[base]?.free || 0) + (bal[base]?.used || 0);
      const usdVal = total * (grid.currentPrice || 0);
      totalExposure += usdVal;
      if (usdVal < 0.01) continue;
      const pct = budgetInfo ? (usdVal / budgetInfo.totalValue * 100) : 0;
      msg += `   ${base}: $${usdVal.toFixed(2)} (${pct.toFixed(0)}%)\n`;
    }

    msg += `\n📊 В монетах: <b>$${totalExposure.toFixed(2)}</b>`;
    if (budgetInfo) msg += ` / $${budgetInfo.totalValue.toFixed(2)} (${(totalExposure / budgetInfo.totalValue * 100).toFixed(0)}%)`;

    await sendWithKeyboard(msg);
    return;
  }

  // ===== ЛОГ =====
  if (cmd === 'log') {
    const recent = st.trades.slice(-10).reverse();

    let msg = `📜 <b>ПОСЛЕДНИЕ СДЕЛКИ</b>\n${V.line}\n\n`;

    if (recent.length === 0) {
      msg += `Сделок пока нет`;
    } else {
      for (const t of recent) {
        const time = t.time.split('T')[1]?.slice(0, 5) || '';
        const date = t.time.split('T')[0]?.slice(5) || '';
        const coin = t.symbol?.split('/')[0] || '?';
        if (t.profit) {
          msg += `${V.money} <code>${date} ${time}</code> ${coin} SELL +$${t.profit}\n`;
        } else {
          msg += `📥 <code>${date} ${time}</code> ${coin} BUY @ ${t.price}\n`;
        }
      }
    }

    msg += `\n${V.gem} Всего сделок: ${st.trades.length}`;

    await sendWithKeyboard(msg);
    return;
  }

  // ===== ЗАКРЫТЬ ПАРУ =====
  if (cmd === 'close_pair') {
    const symbol = `${arg}/USDT`;
    if (!st.grids[symbol]) {
      await sendTg(`${V.warn} Пара ${symbol} не найдена`);
      return;
    }
    log(`[TG] Закрытие ${symbol} по команде`);
    await closeGrid(symbol);
    config.pairs = config.pairs.filter(p => p.symbol !== symbol);
    saveConfig();
    await sendWithKeyboard(`✅ <b>${symbol}</b> закрыта\nОрдера отменены, монеты проданы`);
    return;
  }

  // ===== ДОБАВИТЬ ПАРУ =====
  if (cmd === 'add_pair') {
    const symbol = `${arg}/USDT`;
    if (config.pairs.find(p => p.symbol === symbol)) {
      await sendTg(`${V.warn} ${symbol} уже торгуется`);
      return;
    }
    try { exchange.market(symbol); } catch {
      await sendTg(`${V.warn} ${symbol} не найдена на HTX`);
      return;
    }

    const budgetInfo = await getRealBudget(true);
    const budget = Math.min(budgetInfo.usdtFree * 0.3, 50);
    if (budget < 10) {
      await sendTg(`${V.warn} Недостаточно USDT (свободно $${budgetInfo.usdtFree.toFixed(2)})`);
      return;
    }

    const newPair = { symbol, budget: +budget.toFixed(2), gridLines: 10, stepPercent: 1.5 };
    config.pairs.push(newPair);
    saveConfig();

    log(`[TG] Добавление ${symbol}, бюджет $${budget.toFixed(2)}`);
    await setupGrid(newPair, loadState());
    await sendWithKeyboard(`✅ <b>${symbol}</b> добавлена\nБюджет: $${budget.toFixed(2)}`);
    return;
  }

  // ===== ЗАМЕНИТЬ ПАРУ =====
  if (cmd === 'replace_pair') {
    const fromSym = `${arg}/USDT`;
    const toSym = `${value}/USDT`;

    if (!st.grids[fromSym]) {
      await sendTg(`${V.warn} Пара ${arg} не торгуется`);
      return;
    }
    if (st.grids[toSym]) {
      await sendTg(`${V.warn} ${value} уже активна`);
      return;
    }
    try { exchange.market(toSym); } catch {
      await sendTg(`${V.warn} ${value}/USDT нет на HTX`);
      return;
    }

    const fromConfig = config.pairs.find(p => p.symbol === fromSym);
    if (!fromConfig) {
      await sendTg(`${V.warn} ${arg} нет в конфиге`);
      return;
    }

    // Снимок sell-ордеров ДО закрытия (для отчёта)
    let sellsSnapshot = [];
    let bidPrice = 0;
    try {
      const ticker = await exchange.fetchTicker(fromSym);
      bidPrice = ticker.bid || ticker.last || 0;
      const liveOrders = await exchange.fetchOpenOrders(fromSym);
      const liveSells = liveOrders.filter(o => o.side === 'sell').sort((a,b)=>a.price-b.price);
      sellsSnapshot = liveSells.map(o => {
        // linkedFrom хранится в state.grids[sym].orders[sellPrice]
        const stateOrder = st.grids[fromSym]?.orders?.[o.price] || st.grids[fromSym]?.orders?.[String(o.price)];
        const buyPrice = stateOrder?.linkedFrom ? parseFloat(stateOrder.linkedFrom) : null;
        const profitVsSell = buyPrice ? ((o.price - buyPrice) / buyPrice * 100) : null;
        const profitVsBid = buyPrice ? ((bidPrice - buyPrice) / buyPrice * 100) : null;
        return { sellPrice: o.price, amount: o.amount, buyPrice, profitVsSell, profitVsBid };
      });
    } catch (e) { log(`[TG] Ошибка снимка sell ${fromSym}: ${e.message}`); }

    await sendTg(`🔄 <b>Замена ${arg} → ${value}</b>\nОтменяю buy, sell оставляю висеть...`);
    log(`[TG] Замена ${fromSym} → ${toSym} (keepSells)`);

    const closeResult = await closeGrid(fromSym, { keepSells: true });

    // Бюджет ROBO = освобождённый USDT из buy + остаток free, но не больше плана
    const bal = await getBalances(true);
    const usdtFree = bal.USDT?.free || 0;
    const newBudget = Math.min(fromConfig.budget, Math.max(closeResult.freedUSDT, usdtFree * 0.9));

    config.pairs = config.pairs.filter(p => p.symbol !== fromSym);
    const newPair = {
      symbol: toSym,
      budget: +newBudget.toFixed(2),
      gridLines: fromConfig.gridLines || 10,
      stepPercent: fromConfig.stepPercent || 1.5,
    };
    if (fromConfig.dynamicStep) newPair.dynamicStep = fromConfig.dynamicStep;
    if (fromConfig.ladder) newPair.ladder = fromConfig.ladder;
    config.pairs.push(newPair);
    saveConfig();

    // Отчёт по orphan-sells
    let report = `🔄 <b>${arg} → ${value}</b>\n${V.line}\n`;
    report += `Отменено buy: <b>${closeResult.cancelledBuys}</b> | освобождено <b>$${closeResult.freedUSDT.toFixed(2)}</b>\n`;
    if (sellsSnapshot.length > 0) {
      report += `\n👻 <b>Осиротевшие sell ${arg}</b> (висят сами):\n`;
      let totalLocked = 0;
      sellsSnapshot.forEach((s, i) => {
        const lockedUSDT = s.amount * s.sellPrice;
        totalLocked += lockedUSDT;
        const buyStr = s.buyPrice ? `buy ${s.buyPrice}` : 'buy ?';
        const sellPctStr = s.profitVsSell !== null ? `+${s.profitVsSell.toFixed(2)}%` : '';
        const bidPctStr = s.profitVsBid !== null
          ? (s.profitVsBid >= 0 ? `+${s.profitVsBid.toFixed(2)}%` : `${s.profitVsBid.toFixed(2)}%`)
          : '?';
        report += `  <b>#${i+1}</b> ${s.amount} @ ${s.sellPrice} (${buyStr}, sell ${sellPctStr})\n`;
        report += `      по bid ${bidPrice}: ${bidPctStr}\n`;
      });
      report += `Залочено ~$${totalLocked.toFixed(2)} в ${arg}\n`;
      report += `<i>Когда sell исполнится — придёт уведомление, USDT свободно</i>\n`;
      report += `<i>Хочешь продать руками: «продай ${arg}» или «отмени sell ${arg}»</i>\n`;
    }
    report += `\nНовый грид <b>${value}</b>: бюджет $${newBudget.toFixed(2)}`;
    await sendWithKeyboard(report);

    try {
      await setupGrid(newPair, loadState());
      await sendTg(`✅ <b>${value}</b> грид запущен`);
    } catch (e) {
      log(`[TG] Ошибка setupGrid ${toSym}: ${e.message}`);
      await sendTg(`${V.warn} ${value} не запустилась: ${e.message}\nЗапусти руками: «добавить ${value}»`);
    }
    return;
  }

  // ===== ОТМЕНА SELL ВРУЧНУЮ =====
  if (cmd === 'cancel_sells') {
    const symbol = `${arg}/USDT`;
    let openOrders;
    try { openOrders = await exchange.fetchOpenOrders(symbol); }
    catch (e) { await sendTg(`${V.warn} Ошибка fetchOpenOrders ${symbol}: ${e.message}`); return; }

    const sells = openOrders.filter(o => o.side === 'sell').sort((a,b) => a.price - b.price);
    if (sells.length === 0) {
      await sendTg(`${V.warn} У ${arg} нет открытых sell-ордеров`);
      return;
    }

    let bid = 0;
    try { const t = await exchange.fetchTicker(symbol); bid = t.bid || t.last || 0; } catch {}
    const grid = st.grids[symbol];

    // Список с индексами
    if (value === 'list') {
      let msg = `${grid?.orphaned ? '👻' : '📋'} <b>SELL ${arg}</b> (bid ${bid})\n${V.line}\n`;
      sells.forEach((o, i) => {
        const so = grid?.orders?.[o.price] || grid?.orders?.[String(o.price)];
        const buyP = so?.linkedFrom ? parseFloat(so.linkedFrom) : null;
        const sellPct = buyP ? `+${((o.price - buyP) / buyP * 100).toFixed(2)}%` : '';
        const bidPct = buyP && bid
          ? `${((bid - buyP) / buyP * 100 >= 0 ? '+' : '')}${((bid - buyP) / buyP * 100).toFixed(2)}%`
          : '?';
        msg += `<b>#${i+1}</b> ${o.amount} @ ${o.price} ${buyP ? `(buy ${buyP}, ${sellPct})` : ''}\n`;
        msg += `    по bid: ${bidPct}\n`;
      });
      msg += `\n<i>Отменить:</i>\n`;
      msg += `  «отмени sell ${arg} 1» — конкретный\n`;
      msg += `  «отмени sell ${arg} все» — все sell\n`;
      msg += `  «продай ${arg}» — отменить sell + продать монету по bid`;
      await sendWithKeyboard(msg);
      return;
    }

    // Отмена конкретного / всех
    const toCancel = value === 'all' ? sells : (sells[value - 1] ? [sells[value - 1]] : []);
    if (toCancel.length === 0) {
      await sendTg(`${V.warn} Нет sell #${value} у ${arg}`);
      return;
    }
    let cancelled = 0, freedAmount = 0;
    for (const o of toCancel) {
      try {
        await exchange.cancelOrder(o.id, symbol);
        cancelled++;
        freedAmount += o.amount;
        // Уберём из state
        const st2 = loadState();
        if (st2.grids[symbol]?.orders) {
          delete st2.grids[symbol].orders[o.price];
          delete st2.grids[symbol].orders[String(o.price)];
          saveState(st2);
        }
        await sleep(150);
      } catch (e) { log(`[${symbol}] Ошибка отмены sell ${o.id}: ${e.message}`); }
    }
    await sendWithKeyboard(`✅ Отменено sell <b>${arg}</b>: ${cancelled} шт\nОсвобождено ${freedAmount.toFixed(4)} ${arg} (теперь free на балансе)`);
    return;
  }

  // ===== 🔒 СЕЙФ (lockedProfit) =====
  if (cmd === 'safe') {
    const locked = st.lockedProfit || 0;
    const total = st.totalProfit || 0;
    let bi;
    try { bi = await getRealBudget(true); } catch { bi = null; }
    const usdtFree = bi ? (bi.usdtFree || 0) : 0;
    let msg = `🔒 <b>СЕЙФ</b>\n${V.line}\n\n`;
    msg += `🔒 Заморожено: <b>$${locked.toFixed(4)}</b>\n`;
    msg += `${V.gem} Копилка-стат (всего): <b>$${total.toFixed(2)}</b>\n`;
    msg += `💵 USDT свободно: $${usdtFree.toFixed(2)}\n`;
    if (locked > usdtFree) {
      msg += `\n${V.warn} Сейф больше свободного USDT — деньги в монетах. После закрытия sell-ов покроется.\n`;
    }
    msg += `\n<i>Сейф растёт с каждой сделки. Бот не использует эти деньги для торговли.\nКоманды:\n• <code>сейф вывести 10</code> — разморозить $10\n• <code>сейф вывести все</code> — разморозить всё</i>`;
    await sendTg(msg);
    return;
  }

  if (cmd === 'safe_withdraw') {
    const locked = st.lockedProfit || 0;
    if (locked <= 0) {
      await sendTg(`${V.warn} Сейф пуст`);
      return;
    }
    const amount = value === 'all' ? locked : Math.min(value, locked);
    if (!(amount > 0)) {
      await sendTg(`${V.warn} Неверная сумма`);
      return;
    }
    st.lockedProfit = +(locked - amount).toFixed(4);
    saveState(st);
    log(`[TG] Сейф: разморожено $${amount.toFixed(2)}, осталось $${st.lockedProfit.toFixed(2)}`);
    obsLog('Система', `🔓 **Сейф:** разморожено $${amount.toFixed(2)} | осталось $${st.lockedProfit.toFixed(2)}`);
    await sendTg(`🔓 Разморожено: <b>$${amount.toFixed(2)}</b>\n🔒 В сейфе: $${st.lockedProfit.toFixed(2)}\n<i>Деньги доступны для торговли со следующего цикла</i>`);
    return;
  }

  // ===== ПОЛНАЯ ПРОДАЖА ПАРЫ ВРУЧНУЮ =====
  if (cmd === 'sell_now') {
    const symbol = `${arg}/USDT`;
    if (!st.grids[symbol]) {
      // Может быть на балансе — продадим всё что есть
      const bal = await getBalances(true);
      if (!bal[arg]?.free || bal[arg].free < 0.0001) {
        await sendTg(`${V.warn} Нет ${arg} ни в гридах, ни на балансе`);
        return;
      }
    }
    await sendTg(`💰 <b>Продаю ${arg}</b>\nОтменяю sell-ордера, продаю по bid (3 мин timeout, потом market)...`);
    log(`[TG] Ручная продажа ${symbol}`);
    try {
      await closeGrid(symbol, { keepSells: false });
      // Удаляем grid из state и из config
      const st2 = loadState();
      delete st2.grids[symbol];
      saveState(st2);
      config.pairs = config.pairs.filter(p => p.symbol !== symbol);
      saveConfig();
      const bal = await getBalances(true);
      const usdtFree = bal.USDT?.free || 0;
      await sendWithKeyboard(`✅ <b>${arg}</b> продан\nUSDT свободно: $${usdtFree.toFixed(2)}`);
    } catch (e) {
      log(`[TG] Ошибка sell_now ${symbol}: ${e.message}`);
      await sendTg(`${V.warn} Ошибка продажи ${arg}: ${e.message}`);
    }
    return;
  }

  // ===== ИЗМЕНИТЬ ШАГ =====
  if (cmd === 'set_step') {
    const symbol = `${arg}/USDT`;
    const pc = config.pairs.find(p => p.symbol === symbol);
    if (!pc) {
      await sendTg(`${V.warn} ${symbol} не найдена`);
      return;
    }
    if (value < 0.5 || value > 5) {
      await sendTg(`${V.warn} Шаг должен быть 0.5-5%`);
      return;
    }
    const oldStep = pc.stepPercent;
    pc.stepPercent = value;
    saveConfig();
    log(`[TG] Шаг ${symbol}: ${oldStep}% -> ${value}%`);
    await sendWithKeyboard(`✅ <b>${symbol}</b> шаг: ${oldStep}% → <b>${value}%</b>\nПрименится при пересоздании грида`);
    return;
  }

  // ===== БЮДЖЕТ ПАРЫ (докинуть / забрать / задать) =====
  if (cmd === 'set_budget') {
    const symbol = `${arg}/USDT`;
    const pc = config.pairs.find(p => p.symbol === symbol);
    if (!pc) {
      await sendTg(`${V.warn} ${symbol} не найдена в пуле`);
      return;
    }
    const { sign, amount } = value;
    if (!(amount > 0)) {
      await sendTg(`${V.warn} Сумма должна быть > 0`);
      return;
    }
    const oldBudget = Number(pc.budget) || 0;
    let newBudget;
    if (sign === '+') newBudget = oldBudget + amount;
    else if (sign === '-') newBudget = oldBudget - amount;
    else newBudget = amount;
    if (newBudget < 2) {
      await sendTg(`${V.warn} Итоговый бюджет $${newBudget.toFixed(2)} слишком мал (мин $2)`);
      return;
    }

    const delta = newBudget - oldBudget;
    if (delta > 0) {
      const bal = await getBalances(true);
      const usdtFree = bal.USDT?.free || 0;
      if (usdtFree < delta) {
        await sendTg(`${V.warn} Свободно USDT: $${usdtFree.toFixed(2)}, нужно +$${delta.toFixed(2)}\n<i>Сначала освободи: <code>закрыть XXX</code> или <code>отмени sell XXX все</code></i>`);
        return;
      }
    }

    pc.budget = +newBudget.toFixed(2);
    saveConfig();
    const totalW = config.pairs.reduce((s, p) => s + (Number(p.budget) || 0), 0);
    const share = totalW > 0 ? (pc.budget / totalW * 100).toFixed(1) : '0';
    log(`[TG] Бюджет ${symbol}: $${oldBudget.toFixed(2)} -> $${pc.budget.toFixed(2)}`);

    await sendTg(`⏳ Бюджет ${arg}: $${oldBudget.toFixed(2)} → $${pc.budget.toFixed(2)} (доля ${share}%)\nПересоздаю грид...`);

    try {
      await cancelPairOrders(symbol);
      invalidateBalanceCache();
      await sleep(800);
      const rebuildState = loadState();
      if (rebuildState.grids[symbol]) rebuildState.grids[symbol].orders = {};
      saveState(rebuildState);
      await setupGrid(pc, loadState());
      const st2 = loadState();
      const realBudget = st2.grids[symbol]?.budget || 0;
      await sendWithKeyboard(`✅ <b>${arg}</b> бюджет: $${oldBudget.toFixed(2)} → <b>$${pc.budget.toFixed(2)}</b>\nДоля: <b>${share}%</b>\nРеальный грид-бюджет: <b>$${realBudget.toFixed(2)}</b>\n<i>Грид пересоздан</i>`);
    } catch (e) {
      log(`[TG] set_budget rebuild err ${symbol}: ${e.message}`);
      await sendTg(`${V.warn} Конфиг обновлён, но rebuild ошибка: ${e.message}\nСделай руками: <code>пересоздать</code>`);
    }
    return;
  }

  // ===== ПЕРЕСОЗДАТЬ =====
  if (cmd === 'rebuild') {
    await sendTg(`⏳ Пересоздаю гриды...`);
    log('[TG] Пересоздание гридов по команде');
    // Сначала отменяем ВСЕ ордера, чтобы освободить USDT для равного распределения
    for (const p of config.pairs) {
      await cancelPairOrders(p.symbol);
      await sleep(200);
    }
    invalidateBalanceCache();
    await sleep(1000); // ждём пока биржа обновит балансы
    const rebuildState = loadState();
    // Очищаем ордера в стейте
    for (const p of config.pairs) {
      if (rebuildState.grids[p.symbol]) rebuildState.grids[p.symbol].orders = {};
    }
    saveState(rebuildState);
    let rebuilt = 0;
    for (const p of config.pairs) {
      try {
        await setupGrid(p, loadState());
        rebuilt++;
      } catch (e) { log(`[${p.symbol}] Ошибка rebuild: ${e.message}`); }
      await sleep(500);
    }
    await sendWithKeyboard(`✅ <b>Гриды пересозданы</b>\n${rebuilt}/${config.pairs.length} пар`);
    return;
  }

  // ===== СТОП (существующий) =====
  if (cmd === 'stop') {
    const s = loadState();
    s.paused = true;
    saveState(s);
    log('СТОП по команде из Telegram');
    for (const p of config.pairs) await cancelPairOrders(p.symbol);
    await sendWithKeyboard(`🔴 <b>БОТ ОСТАНОВЛЕН</b>\n${V.thinLine}\nВсе ордера отменены\nНапиши <b>Пуск</b> чтобы возобновить`);
    return;
  }

  // ===== ПУСК (существующий) =====
  if (cmd === 'start') {
    const s = loadState();
    if (!s.paused) {
      await sendTg('🟢 Бот уже работает!');
      return;
    }
    s.paused = false;
    saveState(s);
    log('ПУСК по команде из Telegram');
    for (const p of config.pairs) await setupGrid(p, s);
    await sendWithKeyboard(`🟢 <b>БОТ ЗАПУЩЕН</b>\n${V.thinLine}\nГриды переустановлены`);
    return;
  }

  // ===== ПАУЗА ПАРЫ =====
  if (cmd === 'pause_pair') {
    const symbol = `${arg}/USDT`;
    if (!st.grids[symbol]) {
      await sendTg(`${V.warn} ${symbol} не найдена`);
      return;
    }
    await cancelPairOrders(symbol);
    st.grids[symbol].paused = true;
    saveState(st);
    log(`[TG] Пауза ${symbol}`);
    await sendWithKeyboard(`⏸ <b>${symbol}</b> на паузе\nОрдера отменены, монеты остаются\n<code>возобновить ${arg}</code>`);
    return;
  }

  // ===== ВОЗОБНОВИТЬ ПАРУ =====
  if (cmd === 'resume_pair') {
    const symbol = `${arg}/USDT`;
    if (!st.grids[symbol]) {
      await sendTg(`${V.warn} ${symbol} не найдена`);
      return;
    }
    delete st.grids[symbol].paused;
    delete st.grids[symbol]._lastFailedSetup;
    delete st.grids[symbol].pausedReason;
    delete st.grids[symbol].stopLossUntil;
    delete st.grids[symbol].stopLossUnrealized;
    delete st.grids[symbol].trendDown;
    delete st.grids[symbol].trendDownPct24h;
    saveState(st);
    const pairConfig = config.pairs.find(p => p.symbol === symbol)
      || { symbol, gridLines: 10, stepPercent: 1.5 };
    await setupGrid(pairConfig, loadState());
    await sendWithKeyboard(`▶️ <b>${symbol}</b> возобновлена`);
    return;
  }

  // ===== /HEALTH =====
  if (cmd === 'health') {
    const lt = st.trades[st.trades.length - 1];
    const lastTradeAgo = lt ? Math.round((Date.now() - new Date(lt.time).getTime()) / 60000) : null;
    let scanAge = null;
    try {
      const scanData = JSON.parse(fs.readFileSync(join(ROOT, 'scanner-result.json'), 'utf8'));
      scanAge = Math.round((Date.now() - new Date(scanData.time).getTime()) / 60000);
    } catch {}
    let totalOrders = 0, pausedPairs = 0;
    for (const grid of Object.values(st.grids)) {
      totalOrders += Object.values(grid.orders || {}).filter(o => o.status === 'open').length;
      if (grid.paused) pausedPairs++;
    }
    let msg = `${V.shield} <b>HEALTH</b>\n${V.line}\n\n`;
    msg += `${st.paused ? '🔴' : '🟢'} Бот: ${st.paused ? 'пауза' : 'активен'} | ⏱ ${formatUptime()}\n`;
    msg += `📋 Ордеров на бирже: <b>${totalOrders}</b>\n`;
    msg += `📊 Пар: ${Object.keys(st.grids).length}${pausedPairs ? ` (${pausedPairs} на паузе)` : ''}\n`;
    msg += `${V.bolt} Последняя сделка: ${lastTradeAgo !== null ? `${lastTradeAgo} мин назад` : 'нет'}\n`;
    msg += `🔍 Скан: ${scanAge !== null ? `${scanAge} мин назад` : 'нет данных'}\n`;
    msg += `${V.gem} Копилка: $${st.totalProfit.toFixed(2)} (milestone $${st.lastMilestone || 0})\n`;
    msg += `💾 Сделок в истории: ${st.trades.length}`;
    await sendWithKeyboard(msg);
    return;
  }

  // ===== ПОМОЩЬ (расширенная) =====
  if (cmd === 'help') {
    let msg = `❓ <b>КОМАНДЫ GRIDDY</b>\n${V.line}\n`;
    msg += `<i>Команды без регистра. &lt;X&gt; = тикер (ADA, SOL...).</i>\n\n`;

    msg += `<b>⚡ Быстрые</b>\n`;
    msg += `  <code>?</code> — жив/мёртв\n`;
    msg += `  <code>$</code> — профит сегодня\n\n`;

    msg += `<b>📊 Мониторинг</b>\n`;
    msg += `  <code>статус</code> — полная сводка\n`;
    msg += `  <code>профит</code> — P&amp;L по парам\n`;
    msg += `  <code>ордера</code> — открытые ордера + USDT\n`;
    msg += `  <code>баланс</code> — USDT + торговые монеты\n`;
    msg += `  <code>активы</code> — ВСЕ монеты (+hold) с $ оценкой\n`;
    msg += `  <code>сканер</code> — топ пары для грида\n`;
    msg += `  <code>рынок</code> — F&amp;G, BTC, новости\n`;
    msg += `  <code>риск</code> — экспозиция\n\n`;

    msg += `<b>📈 Аналитика</b>\n`;
    msg += `  <code>неделя</code> / <code>месяц</code> — итоги\n`;
    msg += `  <code>рекорд</code> — лучшие дни\n`;
    msg += `  <code>лог</code> — последние сделки\n\n`;

    msg += `<b>🔧 Управление парами</b>\n`;
    msg += `  <code>добавить XRP</code> — новая пара (бюджет авто)\n`;
    msg += `  <code>закрыть SOL</code> — полное закрытие + продажа\n`;
    msg += `  <code>заменить ADA ROBO</code> — свап пары:\n`;
    msg += `      buy отменяется, sell остаются висеть 👻\n`;
    msg += `      Можно: <code>заменить ADA на ROBO</code>, <code>замени ADA-ROBO</code>\n`;
    msg += `  <code>пауза SOL</code> / <code>возобновить SOL</code>\n`;
    msg += `  <code>шаг SOL 2.0</code> — изменить % шаг\n`;
    msg += `  <code>бюджет M +30</code> — докинуть $30 к паре (из свободного USDT)\n`;
    msg += `  <code>бюджет M -20</code> — забрать $20 с пары\n`;
    msg += `  <code>бюджет M 200</code> — задать абсолютный вес\n`;
    msg += `  <code>докинь M 30</code> — синоним <code>бюджет M +30</code>\n`;
    msg += `  <code>пересоздать</code> — rebuild всех гридов\n\n`;

    msg += `<b>👻 Orphan-sells</b> (после замены)\n`;
    msg += `  <code>отмени sell ADA</code> — список с #\n`;
    msg += `  <code>отмени sell ADA 1</code> — отменить #1\n`;
    msg += `  <code>отмени sell ADA все</code> — все sell\n`;
    msg += `  <code>продай ADA</code> — sell + ликвидация по bid (работает и для hold-монет)\n\n`;

    msg += `<b>⏸ Глобально</b>\n`;
    msg += `  <code>стоп</code> / <code>пуск</code> — пауза всего бота\n`;
    msg += `  <code>/health</code> — диагностика\n\n`;

    msg += `<i>Автоотчёты: 9:00 и 21:00 MSK</i>\n`;
    msg += `<i>Сканер шлёт топ-пары + предложения свапов раз в час</i>`;

    await sendWithKeyboard(msg);
    return;
  }
}

// ===== Авто-алерты (вызывается из главного цикла) =====
// TG-2: init из последней сделки в state, иначе BOT_START_TIME (а не Date.now() — чтоб не потерять inactivity)
let _lastTradeTime = (() => {
  try {
    const s = loadState();
    const lt = s.trades?.[s.trades.length - 1];
    return lt ? new Date(lt.time).getTime() : BOT_START_TIME;
  } catch { return BOT_START_TIME; }
})();
let _priceCache1h = {}; // symbol -> {price, time}
let _lastInactivityAlert = 0;

async function checkAutoAlerts(state) {
  // --- Неактивность (6 часов без сделок) ---
  const lastTrade = state.trades[state.trades.length - 1];
  if (lastTrade) {
    _lastTradeTime = new Date(lastTrade.time).getTime();
  }
  const hoursSinceLastTrade = (Date.now() - _lastTradeTime) / 3600000;
  // TG-5: throttle раз в 6ч (а не 5 мин через shouldLogError)
  if (hoursSinceLastTrade >= 6 && Date.now() - _lastInactivityAlert > 6 * 3600000) {
    _lastInactivityAlert = Date.now();
    await notifyInactivity(Math.floor(hoursSinceLastTrade));
  }

  // --- Milestone копилки ($5, $10, $25, $50, $100) ---
  // TG-1: персистим в state — после рестарта не спамим уже достигнутыми
  const milestones = [5, 10, 25, 50, 100];
  const lastMilestone = state.lastMilestone || 0;
  for (const m of milestones) {
    if (state.totalProfit >= m && lastMilestone < m) {
      state.lastMilestone = m;
      saveState(state);
      await notifyMilestone(m);
      break;
    }
  }

  // --- Резкое движение цены (>5% за час) ---
  for (const [symbol, grid] of Object.entries(state.grids)) {
    const now = Date.now();
    const cached = _priceCache1h[symbol];
    if (!cached || now - cached.time > 3600000) {
      _priceCache1h[symbol] = { price: grid.currentPrice, time: now };
      continue;
    }
    const change = (grid.currentPrice - cached.price) / cached.price * 100;
    if (Math.abs(change) >= 5 && shouldLogError(`spike_${symbol}`)) {
      await notifyPriceSpike(symbol, change, grid.currentPrice);
      _priceCache1h[symbol] = { price: grid.currentPrice, time: now };
    }
  }
}

// ===== Главный цикл =====
async function main() {
  log('╔══════════════════════════════════════╗');
  log('║   HTX SPOT MULTI-GRID BOT v2.0      ║');
  log('║   Compound | DynStep | Rebalance    ║');
  log('╚══════════════════════════════════════╝');

  // Telegram
  if (process.env.TG_BOT_TOKEN && process.env.TG_CHAT_ID) {
    initTelegram(process.env.TG_BOT_TOKEN, process.env.TG_CHAT_ID);
    await clearQueue(); // очищаем старые сообщения из очереди
    log('Telegram уведомления: ON');

    // Обработчик команд из Telegram
    onCommand(async (parsed) => {
      const { cmd, arg, value } = parsed;
      try {
        await handleTgCommand(cmd, arg, value);
      } catch (e) {
        log(`[TG] Ошибка команды ${cmd}: ${e.message}`);
        await sendTg(`${V.warn} Ошибка: ${e.message}`);
      }
    });

  } else {
    log('Telegram: OFF (добавь TG_BOT_TOKEN и TG_CHAT_ID в .env)');
  }

  await initExchange();

  // Скан при старте пропускаем — запустится в цикле через 30 мин
  log('Сканер: отложен до первого цикла');

  // Проверка новостей
  if (config.news?.enabled) {
    try {
      const newsResult = await analyzeNews(log);
      if (newsResult.action === 'PAUSE' && config.news.pauseOnNegative) {
        log('Новости негативные! Бот на паузе.');
        await notifyAlert('Негативные новости — бот на паузе');
        process.exit(0);
      }
    } catch (e) { log(`Ошибка новостей: ${e.message}`); }
  }

  // Миграция: trailing выключен, но остались "подвисшие" trailing-entries
  // Превращаем их в обычные limit sell по цене buyPrice*(1+step%)
  if (!config.trailing?.enabled) {
    const migState = loadState();
    let migrated = 0, migSkipped = 0;
    for (const [symbol, grid] of Object.entries(migState.grids || {})) {
      if (!grid.trailing || grid.trailing.length === 0) continue;
      const pairCfg = config.pairs.find(p => p.symbol === symbol);
      const stepPct = (grid.step || pairCfg?.stepPercent || 1.5) / 100;
      const keep = [];
      for (const entry of grid.trailing) {
        try {
          const market = exchange.markets?.[symbol];
          if (!market) { keep.push(entry); migSkipped++; continue; }
          const base = symbol.split('/')[0];
          const bal = await exchange.fetchBalance();
          const baseFree = bal[base]?.free || 0;
          const sellAmount = Math.min(entry.amount, baseFree);
          const minAmt = market.limits?.amount?.min || 0;
          if (sellAmount < minAmt) { migSkipped++; continue; }
          const targetPrice = entry.buyPrice * (1 + stepPct);
          const sellPrice = +exchange.priceToPrecision(symbol, targetPrice);
          // Уменьшаем amount на 0.3% перед precision чтобы не словить "insufficient" из-за округлений
          const safeAmount = sellAmount * 0.997;
          const sellAmt = +exchange.amountToPrecision(symbol, safeAmount);
          if (sellAmt < minAmt || sellAmt <= 0) { migSkipped++; continue; }
          const order = await exchange.createLimitSellOrder(symbol, sellAmt, sellPrice);
          grid.orders[sellPrice] = {
            id: order.id, side: 'sell', price: sellPrice,
            amount: sellAmt, status: 'open',
            placedAt: new Date().toISOString(),
          };
          migrated++;
          log(`[${symbol}] Миграция: trailing → limit sell @ ${sellPrice} (buy ${entry.buyPrice})`);
        } catch (e) {
          log(`[${symbol}] Миграция trailing ошибка: ${e.message}`);
          keep.push(entry);
          migSkipped++;
        }
        await sleep(300);
      }
      grid.trailing = keep;
    }
    if (migrated > 0 || migSkipped > 0) {
      saveState(migState);
      log(`Миграция trailing→limit: ${migrated} переведено, ${migSkipped} пропущено`);
      obsLog('Система', `🔄 Миграция trailing→limit sell: ${migrated} ордеров поставлено, ${migSkipped} пропущено`);
    }
  }

  // Синхронизируем ВСЕ пары (конфиг + стейт) с биржей
  const state = loadState();
  const allSyncSymbols = new Set(config.pairs.map(p => p.symbol));
  for (const sym of Object.keys(state.grids)) allSyncSymbols.add(sym);

  let totalSynced = 0;
  for (const symbol of allSyncSymbols) {
    const pairConfig = config.pairs.find(p => p.symbol === symbol)
      || { symbol, gridLines: 10, stepPercent: state.grids[symbol]?.step || 1.5 };
    try {
      const existingOrders = await exchange.fetchOpenOrders(symbol);
      if (existingOrders.length > 0) {
        log(`[${symbol}] Синхронизация: ${existingOrders.length} ордеров с биржи`);

        if (!state.grids[symbol]) state.grids[symbol] = { orders: {} };
        const grid = state.grids[symbol];
        grid.orders = {};
        const ticker = await exchange.fetchTicker(symbol);
        grid.currentPrice = ticker.last;
        // B4: не затираем накопленный compound budget и динамический step при наличии ордеров
        if (grid.budget === undefined) grid.budget = await getPairBudget(state, pairConfig);
        if (grid.step === undefined) grid.step = pairConfig.stepPercent;

        for (const o of existingOrders) {
          grid.orders[o.price] = {
            id: o.id, side: o.side, price: o.price,
            amount: o.amount, status: 'open',
            placedAt: o.datetime || new Date().toISOString(),
          };
        }
        totalSynced += existingOrders.length;
        saveState(state);

        // FIX: stale пара (≤2 ордеров + возраст >2ч) — форсируем setupGrid для разморозки (buy-only rebuild)
        const inConfig = config.pairs.find(p => p.symbol === symbol);
        const _ageH = grid.createdAt ? (Date.now() - grid.createdAt) / 3600000 : 0;
        if (inConfig && existingOrders.length <= 2 && _ageH > 2 && !grid.paused) {
          log(`[${symbol}] 🔧 Обнаружена зависшая пара (${existingOrders.length} ордеров, ${_ageH.toFixed(1)}ч) — форс rebuild`);
          try { await setupGrid(pairConfig, state); } catch (e) {
            log(`[${symbol}] rebuild ошибка: ${e.message}`);
          }
        }
      } else if (config.pairs.find(p => p.symbol === symbol)) {
        // Нет ордеров и пара в конфиге — создаём грид
        await setupGrid(pairConfig, state);
      } else {
        // Нет ордеров и пары нет в конфиге — убираем из стейта
        log(`[${symbol}] 0 ордеров, не в конфиге — убираю из стейта`);
        obsLog('Система', `🗑️ **${symbol}** удалена из стейта (0 ордеров, не в конфиге)`);
        delete state.grids[symbol];
        saveState(state);
      }
    } catch (e) {
      log(`Ошибка синхронизации ${symbol}: ${e.message}`);
      obsLog('Баги', `❌ Ошибка синхронизации **${symbol}**: ${e.message}`);
    }
    await sleep(500);
  }
  log(`Синхронизировано: ${totalSynced} ордеров по ${allSyncSymbols.size} парам`);

  // Self-heal: пересчёт pairProfits из trades (были расхождения из-за старых версий)
  try {
    const st = loadState();
    const recalc = {};
    for (const t of st.trades || []) {
      if (typeof t.profit === 'number') {
        recalc[t.symbol] = (recalc[t.symbol] || 0) + t.profit;
      }
    }
    let diff = 0;
    for (const sym of Object.keys(recalc)) {
      const oldVal = st.pairProfits?.[sym] || 0;
      if (Math.abs(oldVal - recalc[sym]) > 0.01) diff++;
    }
    if (diff > 0) {
      st.pairProfits = recalc;
      saveState(st);
      log(`[AUDIT] pairProfits пересчитан из trades: ${diff} расхождений исправлено`);
      obsLog('Система', `🔧 pairProfits self-heal: ${diff} пар пересчитано из истории trades`);
    }
  } catch (e) { log(`[AUDIT] pairProfits recalc ошибка: ${e.message}`); }

  // Telegram startup с реальным бюджетом (после initExchange + синхронизации)
  if (process.env.TG_BOT_TOKEN && process.env.TG_CHAT_ID) {
    try {
      const b = await getRealBudget(true);
      await notifyStartup(b.totalValue, config.pairs.length, {
        workingBudget: b.workingBudget,
        usdtTotal: b.usdtFree + b.usdtUsed,
        tradingValue: b.tradingValue,
        holdValue: b.holdValue,
        holdBreakdown: b.holdBreakdown,
      });
    } catch (e) {
      log(`[TG] Ошибка notifyStartup: ${e.message}`);
    }
  }

  log(`\nГриды запущены! Compound: ${config.compound?.enabled ? 'ON' : 'OFF'} | DynStep: ${config.dynamicStep?.enabled ? 'ON' : 'OFF'} | Rebalance: ${config.rebalance?.enabled ? 'ON' : 'OFF'}\n`);
  obsLog('Система', `🟢 **Бот запущен** | Пары: ${config.pairs.map(p => p.symbol).join(', ')} | Compound: ${config.compound?.enabled ? 'ON' : 'OFF'} | DynStep: ${config.dynamicStep?.enabled ? 'ON' : 'OFF'}`);

  // Пропускаем первые 3 цикла чтобы ордера успели появиться на бирже
  log('Ожидание 10 сек перед первой проверкой...');
  await sleep(10000);

  // Цикл мониторинга
  let cycle = 0;
  let lastNewsCheck = Date.now();
  let lastScanCheck = 0; // FIX: первый autoSwitch сразу (было Date.now() → первая ротация только через 30 мин)
  let lastRebalanceCheck = Date.now();
  const newsIntervalMs = (config.news?.checkIntervalMin || 5) * 60 * 1000;
  const scanIntervalMs = (config.scanner?.scanIntervalMin || 30) * 60 * 1000;
  const rebalanceIntervalMs = (config.rebalance?.checkIntervalMin || 60) * 60 * 1000;

  // [5] Обновление кэша динамического шага (каждые 10 мин)
  let lastDynStepCheck = Date.now();
  const dynStepIntervalMs = 10 * 60 * 1000;

  // Часовой отчёт в TG
  let lastHourlyReport = 0;

  while (true) {
    await sleep(config.checkIntervalSec * 1000);
    cycle++;

    // Telegram команды
    await checkCommands();

    // Новости
    if (config.news?.enabled && Date.now() - lastNewsCheck > newsIntervalMs) {
      lastNewsCheck = Date.now();
      try {
        const newsResult = await analyzeNews(log);
        obsLog('Новости', `Score: ${newsResult.score} (${newsResult.action}) | F&G: ${newsResult.fearGreed?.value || '?'} | ${newsResult.reasons.length > 0 ? newsResult.reasons.join(', ') : 'норма'}`);
        const st = loadState();

        if (newsResult.action === 'PAUSE' && config.news.pauseOnNegative) {
          if (!st.paused) {
            st.paused = true;
            saveState(st);
            log('ПАУЗА: негативные новости');
            obsLog('Новости', `⚠️ **ПАУЗА** — негативные новости`);
            await notifyAlert('Негативные новости — бот на паузе');
            for (const p of config.pairs) await cancelPairOrders(p.symbol);
          }
          continue;
        } else if (st.paused && newsResult.action !== 'PAUSE') {
          st.paused = false;
          saveState(st);
          log('ВОЗОБНОВЛЕНИЕ');
          obsLog('Система', `🟢 **Возобновление** — новости нормализовались`);
          await notifyAlert('Новости нормализовались — бот возобновлён');
          for (const p of config.pairs) await setupGrid(p, st);
        }
      } catch (e) { log(`Ошибка новостей: ${e.message}`); obsLog('Баги', `❌ Ошибка новостей: ${e.message}`); }
    }

    // Авто-переключение пар (читаем результат из scanner-worker)
    if (config.scanner?.enabled && config.scanner.autoSwitch && Date.now() - lastScanCheck > scanIntervalMs) {
      lastScanCheck = Date.now();
      try {
        await autoSwitchPairs();
      } catch (e) { log(`Ошибка авто-переключения: ${e.message}`); obsLog('Баги', `❌ Ошибка авто-переключения пар: ${e.message}`); }
    }

    // Пауза
    const currentState = loadState();
    if (currentState.paused) {
      if (cycle % 30 === 0) log('На паузе...');
      continue;
    }

    // Проверка всех гридов (из конфига + из стейта, чтобы не терять пары добавленные сканером)
    const allSymbols = new Set(config.pairs.map(p => p.symbol));
    for (const sym of Object.keys(currentState.grids)) allSymbols.add(sym);

    for (const symbol of allSymbols) {
      const pairConfig = config.pairs.find(p => p.symbol === symbol)
        || { symbol, gridLines: 10, stepPercent: currentState.grids[symbol]?.step || 1.5 };
      try {
        // Авто-восстановление пустых гридов (0 ордеров на бирже)
        const grid = currentState.grids[symbol];

        // === SAFETY: авто-сброс stop-loss после 24ч ===
        if (grid?.paused && grid.pausedReason === 'stop_loss' && grid.stopLossUntil && Date.now() > grid.stopLossUntil) {
          delete grid.paused;
          delete grid.pausedReason;
          delete grid.stopLossUntil;
          delete grid.stopLossUnrealized;
          saveState(currentState);
          log(`[${symbol}] 🟢 STOP-LOSS снят (24ч прошло)`);
          obsLog('Система', `🟢 **${symbol}** STOP-LOSS снят, торговля возобновлена`);
          try { await notifyAlert(`🟢 ${symbol}: STOP-LOSS снят (24ч прошло)`); } catch {}
        }

        // === SAFETY: проверка stop-loss + trend-gate каждые ~15 минут (cycle*5sec) ===
        if (config.safety?.enabled !== false && grid && !grid.orphaned && !grid.paused && cycle % 180 === 0) {
          try {
            const sf = await checkPairSafety(symbol, pairConfig, currentState);

            // Stop-loss: пауза пары на 24ч если unrealized < -15% бюджета
            if (sf.stopLoss) {
              grid.paused = true;
              grid.pausedReason = 'stop_loss';
              grid.stopLossUntil = Date.now() + 24 * 3600 * 1000;
              grid.stopLossUnrealized = sf.unrealizedPct;
              saveState(currentState);
              const thr = config.safety?.stopLossPercent ?? -15;
              log(`[${symbol}] 🛑 STOP-LOSS: unrealized ${sf.unrealizedPct}% < ${thr}% — пауза 24ч`);
              obsLog('Система', `🛑 **${symbol}** STOP-LOSS: unrealized ${sf.unrealizedPct}% — пауза 24ч`);
              try { await notifyAlert(`🛑 ${symbol} STOP-LOSS\nUnrealized: ${sf.unrealizedPct}%\nПауза на 24ч`); } catch {}
              continue;
            }

            // Trend-gate: меняем флаг trendDown при изменении тренда
            if (config.safety?.trendGate?.enabled !== false && sf.trendDown !== !!grid.trendDown) {
              grid.trendDown = sf.trendDown;
              grid.trendDownPct24h = sf.pct24h;
              saveState(currentState);
              if (sf.trendDown) {
                log(`[${symbol}] 📉 TREND DOWN: 24ч ${sf.pct24h}%, dom ${sf.trendDom} — buy-side выкл`);
                obsLog('Система', `📉 **${symbol}** TREND DOWN (24ч ${sf.pct24h}%) — buy-side приостановлен`);
              } else {
                log(`[${symbol}] 📈 TREND OK: 24ч ${sf.pct24h}% — buy-side вкл`);
                obsLog('Система', `📈 **${symbol}** TREND OK (24ч ${sf.pct24h}%) — buy-side восстановлен`);
              }
            }
          } catch (e) {
            log(`[${symbol}] safety check err: ${e.message}`);
          }
        }

        if (grid?.paused) continue; // пауза пары — пропускаем проверку

        // Orphan-grid: пара заменена, новые buy/sell не ставим. Только трекаем sell → когда все
        // исполнятся (или будут отменены руками) → удаляем grid из state.
        if (grid?.orphaned) {
          const openOrdsCount = Object.values(grid.orders || {}).filter(o => o.status === 'open').length;
          if (openOrdsCount === 0) {
            const st2 = loadState();
            delete st2.grids[symbol];
            saveState(st2);
            log(`[${symbol}] 👻 ORPHAN grid удалён (все sell исполнились/отменены)`);
            obsLog('Система', `👻 **${symbol}** orphan grid закрыт — все sell исполнились`);
            continue;
          }
          // checkGrid вызовем чтобы fetched orders отметили filled sell — но без auto-restore/tighten
          try { await checkGrid(pairConfig); } catch (e) { log(`[${symbol}] orphan checkGrid: ${e.message}`); }
          continue;
        }

        if (grid && Object.values(grid.orders || {}).filter(o => o.status === 'open').length === 0) {
          // Защита от бесконечного цикла: если уже пытались и не смогли — ждём 30 мин
          const lastFail = grid._lastFailedSetup || 0;
          if (Date.now() - lastFail < 30 * 60 * 1000) {
            continue; // пропускаем, недавно пробовали
          }
          const bal = await getBalances();
          const freeUsdt = bal.USDT?.free || 0;
          const minBudget = config.scanner?.minBudgetPerPair || 10;
          if (freeUsdt > minBudget) {
            log(`[${symbol}] 0 ордеров — автовосстановление (USDT: $${freeUsdt.toFixed(2)})`);
            obsLog('Система', `🔄 **${symbol}** автовосстановление грида`);
            const result = await setupGrid(pairConfig, currentState);
            if (result && result.buyCount + result.sellCount === 0) {
              // Не смогли поставить ни одного ордера — запоминаем
              const st = loadState();
              if (st.grids[symbol]) { st.grids[symbol]._lastFailedSetup = Date.now(); saveState(st); }
              log(`[${symbol}] Не удалось разместить ордера — повтор через 30 мин`);
            }
            await sleep(500);
            continue;
          }
        }

        // Авто-подтяжка: если ближайшие ордера слишком далеко от цены — пересоздать грид
        if (grid && cycle % 30 === 0) { // каждые ~5 мин
          const openOrds = Object.entries(grid.orders || {}).filter(([, o]) => o.status === 'open');
          const buys = openOrds.filter(([, o]) => o.side === 'buy').map(([p]) => parseFloat(p));
          const sells = openOrds.filter(([, o]) => o.side === 'sell').map(([p]) => parseFloat(p));
          if (buys.length > 0 || sells.length > 0) {
            try {
              const ticker = await exchange.fetchTicker(symbol);
              const price = ticker.last;
              const liveStep = getCurrentStep(symbol, grid.step || 1.5);
              const maxDist = liveStep * 2.5; // если ближайший ордер дальше 2.5x шага — подтянуть

              const nearBuy = buys.length > 0 ? Math.max(...buys) : 0;
              const nearSell = sells.length > 0 ? Math.min(...sells) : Infinity;
              const distBuy = nearBuy > 0 ? (price - nearBuy) / price * 100 : 999;
              const distSell = nearSell < Infinity ? (nearSell - price) / price * 100 : 999;

              // Подтягиваем если ОБА направления далеко, или одно пустое а другое далеко
              const needTighten = (distBuy > maxDist && distSell > maxDist)
                || (buys.length === 0 && distSell > maxDist)
                || (sells.length === 0 && distBuy > maxDist);

              if (needTighten) {
                log(`[${symbol}] Авто-подтяжка: buy ${distBuy.toFixed(1)}% / sell ${distSell.toFixed(1)}% (макс ${maxDist.toFixed(1)}%)`);
                obsLog('Система', `🔧 **${symbol}** авто-подтяжка грида (ордера далеко от цены)`);
                await setupGrid(pairConfig, currentState);
                await sleep(500);
                continue;
              }
            } catch {}
          }
        }

        const result = await checkGrid(pairConfig);
        if (result.filled > 0) {
          log(`[${pairConfig.symbol}] Обработано ${result.filled} ордеров`);
        }

        // Лесенка: после исполнения ИЛИ периодически (каждые 12 циклов ~1 мин) — доставить из очереди
        if (config.ladder?.enabled && (result.filled > 0 || cycle % 12 === 0)) {
          try {
            const market = getMarketInfo(symbol);
            await refillLadder(pairConfig, market);
          } catch (e) {
            log(`[${symbol}] refillLadder failed: ${e.message}`);
          }
        }
      } catch (e) {
        log(`[${pairConfig.symbol}] Ошибка: ${e.message}`);
        obsLog('Баги', `❌ **${pairConfig.symbol}** ошибка checkGrid: ${e.message}`);
      }
      await sleep(200);
    }

    // [6] Ребалансировка
    if (config.rebalance?.enabled && Date.now() - lastRebalanceCheck > rebalanceIntervalMs) {
      lastRebalanceCheck = Date.now();
      try { await checkRebalance(); } catch (e) { log(`Ошибка ребалансировки: ${e.message}`); obsLog('Баги', `❌ Ошибка ребалансировки: ${e.message}`); }
    }

    // [5] Обновление кэша шагов (каждые 10 мин) + пересоздание при большом изменении
    if (config.dynamicStep?.enabled && Date.now() - lastDynStepCheck > dynStepIntervalMs) {
      lastDynStepCheck = Date.now();
      const st = loadState();
      for (const pc of config.pairs) {
        try {
          const oldStep = st.grids[pc.symbol]?.step || pc.stepPercent;
          const newStep = await getDynamicStep(pc.symbol, pc.stepPercent);
          // Если шаг изменился более чем на 30% — пересоздать грид
          if (Math.abs(newStep - oldStep) / oldStep > 0.3) {
            log(`[${pc.symbol}] Шаг изменился ${oldStep}% → ${newStep}% (>30%) — пересоздание грида`);
            obsLog('Система', `🔧 **${pc.symbol}** пересоздание: шаг ${oldStep}% → ${newStep}%`);
            await setupGrid(pc, st);
            await sleep(500);
          }
        } catch {}
        await sleep(200);
      }
    }

    // Статус каждые 10 мин (лог)
    if (cycle % 60 === 0) {
      const sts = await printStatus();
      const st = loadState();
      const pairsSummary = Object.entries(st.grids).map(([sym, g]) => {
        const pp = st.pairProfits?.[sym] || 0;
        return `${sym}: $${pp.toFixed(4)}`;
      }).join(' | ');
      obsLog('Статус', `Бюджет: $${sts.budget.toFixed(2)} | Профит: $${sts.totalProfit.toFixed(4)} | Сделок сегодня: ${sts.trades} | ${pairsSummary}`);
    }

    // Авто-алерты (каждый цикл, внутри есть throttle)
    try { await checkAutoAlerts(loadState()); } catch {}

    // Часовой / Утренний / Вечерний отчёт в Telegram
    const nowHour = new Date();
    const mskHour = (nowHour.getUTCHours() + 3) % 24;
    const mskMin = nowHour.getUTCMinutes();
    if (mskMin === 0 && (!lastHourlyReport || Date.now() - lastHourlyReport > 50 * 60 * 1000)) {
      lastHourlyReport = Date.now();
      try {
        const st = loadState();
        const dayProfit = st.dayStats?.date === today() ? st.dayStats.profit : 0;
        const dayTrades = st.dayStats?.date === today() ? st.dayStats.trades : 0;

        // Утренний отчёт 9:00 MSK
        if (mskHour === 9) {
          // Считаем сделки с полуночи MSK (00:00 MSK = 21:00 UTC предыдущего дня)
          const todayStr = today(); // UTC дата
          const todayTrades = st.trades.filter(t => t.time.startsWith(todayStr) && t.profit);
          const todayProfit = todayTrades.reduce((s, t) => s + t.profit, 0);
          // Вчерашние сделки для сравнения
          const yesterdayStr = new Date(Date.now() - 86400000).toISOString().split('T')[0];
          const yesterdayTrades = st.trades.filter(t => t.time.startsWith(yesterdayStr) && t.profit);
          const yesterdayProfit = yesterdayTrades.reduce((s, t) => s + t.profit, 0);
          await notifyMorning({
            trades: todayTrades.length,
            profit: todayProfit,
            totalProfit: st.totalProfit,
            paused: st.paused,
            yesterdayProfit,
            yesterdayTrades: yesterdayTrades.length,
            dailyGoal: Math.max(1, (config.totalBudget || 600) * 0.01),
          });
          log(`[TG] Утренний отчёт отправлен`);
          // Воскресный недельный отчёт
          if (nowHour.getUTCDay() === 0) {
            const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
            const weekStats = getPeriodStats(st, weekAgo);
            await notifyWeekly({
              trades: weekStats.sellTrades,
              profit: weekStats.profit,
              totalProfit: st.totalProfit,
              bestPair: weekStats.bestPair,
              worstPair: weekStats.worstPair,
              avgDaily: weekStats.profit / 7,
            });
          }
        }
        // Вечерний отчёт 21:00 MSK
        else if (mskHour === 21) {
          // TG-7: bestPair за СЕГОДНЯ, а не накопленный pairProfits
          const todayStr = today();
          const todayPairProfits = {};
          for (const t of st.trades) {
            if (!t.time.startsWith(todayStr) || t.profit === undefined) continue;
            todayPairProfits[t.symbol] = (todayPairProfits[t.symbol] || 0) + t.profit;
          }
          const pairs = Object.entries(todayPairProfits).map(([s, p]) => ({ symbol: s, profit: p }));
          pairs.sort((a, b) => b.profit - a.profit);
          await notifyEvening({
            trades: dayTrades,
            dayProfit,
            totalProfit: st.totalProfit,
            bestPair: pairs[0] || null,
            streak: getStreak(st),
            dailyGoal: Math.max(1, (config.totalBudget || 600) * 0.01),
          });
          log(`[TG] Вечерний отчёт отправлен`);
        }
        // Обычный часовой
        else {
          let budgetInfo;
          try { budgetInfo = await getRealBudget(); } catch { budgetInfo = null; }

          let msg = `${V.clock} <b>${String(mskHour).padStart(2,'0')}:00</b>\n${V.thinLine}\n`;
          if (budgetInfo) {
            msg += `💼 $${budgetInfo.totalValue.toFixed(2)}`;
          }

          const pairParts = [];
          for (const [sym, grid] of Object.entries(st.grids)) {
            const coin = sym.split('/')[0];
            const pp = st.pairProfits?.[sym] || 0;
            pairParts.push(`${coin} $${grid.currentPrice}`);
          }
          msg += ` | ${pairParts.join(' · ')}\n`;
          msg += `${V.bolt} ${dayTrades} сделок | ${V.pnl(dayProfit)} | ${V.gem} $${st.totalProfit.toFixed(2)}`;

          await sendTg(msg);
          log(`[TG] Часовой отчёт отправлен (${mskHour}:00)`);
        }
      } catch (e) {
        log(`[TG] Ошибка отчёта: ${e.message}`);
        obsLog('Баги', `❌ Ошибка TG отчёта: ${e.message}`);
      }
    }

    // Дневной отчёт
    await dailyReport();
  }
}

// ===== Запуск с авто-рестартом =====
async function run() {
  while (true) {
    try {
      await main();
    } catch (e) {
      log(`FATAL: ${e.message}`);
      console.error(e);
      obsLog('Баги', `🔴 **FATAL CRASH**: ${e.message}`);
      await notifyAlert(`FATAL: ${e.message}`);
      log('Перезапуск через 30 сек...');
      await sleep(30000);
    }
  }
}

run();
