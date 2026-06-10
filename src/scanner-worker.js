// Отдельный процесс сканера — не блокирует основного бота
import 'dotenv/config';
import './fetch-patch.js';
import ccxt from 'ccxt';
import https from 'https';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { scanPairs } from './scanner.js';
import { initTelegram, notifyScannerTop } from './telegram.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const RESULT_FILE = join(ROOT, 'scanner-result.json');
const CONFIG_FILE = join(ROOT, 'grid-config.json');
const STATE_FILE = join(ROOT, 'grid-state.json');
const NOTIFY_FILE = join(ROOT, 'last-scanner-notify.json');
const NOTIFY_INTERVAL_MS = 60 * 60 * 1000;
const MAX_RETRIES = 10;

function loadLastNotify() {
  try { return JSON.parse(fs.readFileSync(NOTIFY_FILE, 'utf8')).time || 0; } catch { return 0; }
}
function saveLastNotify(time) {
  try { fs.writeFileSync(NOTIFY_FILE, JSON.stringify({ time })); } catch {}
}
function getActiveSymbols() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return Object.keys(state.grids || {});
  } catch { return []; }
}
function getMinScore() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return cfg.scanner?.minGridScore ?? 65;
  } catch { return 65; }
}
function getPairsConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return cfg.pairs || [];
  } catch { return []; }
}
function getBaselineBudget() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const pairs = cfg.pairs || [];
    const big = pairs.filter(p => p.budget >= 20);
    if (!big.length) return 40;
    const avg = big.reduce((s, p) => s + p.budget, 0) / big.length;
    return Math.round(avg / 10) * 10;
  } catch { return 40; }
}

// B1: читаем интервал из конфига каждый раз (чтобы TG изменения config подхватывались)
function getIntervalMin() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return cfg.scanner?.scanIntervalMin || 30;
  } catch { return 30; }
}

function log(msg) {
  const ts = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
  console.log(`[${ts}] [SCANNER] ${msg}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function createExchange() {
  const exchange = new ccxt.htx({
    apiKey: process.env.HTX_API_KEY,
    secret: process.env.HTX_API_SECRET,
    timeout: 30000,
    options: { defaultType: 'spot' },
    agent: new https.Agent({ rejectUnauthorized: false }),
  });

  for (let i = 1; i <= MAX_RETRIES; i++) {
    try {
      await exchange.loadMarkets();
      log(`Рынки загружены: ${Object.keys(exchange.markets).length} пар`);
      return exchange;
    } catch (e) {
      log(`loadMarkets попытка ${i}/${MAX_RETRIES}: ${e.message}`);
      await sleep(Math.min(i * 5000, 30000));
    }
  }
  return null;
}

async function run() {
  let exchange = null;
  let consecutiveErrors = 0;

  if (process.env.TG_BOT_TOKEN && process.env.TG_CHAT_ID) {
    initTelegram(process.env.TG_BOT_TOKEN, process.env.TG_CHAT_ID);
    log('Telegram уведомления ON (раз в час — топ новых пар)');
  }

  while (true) {
    // Создаём/пересоздаём exchange если нужно
    if (!exchange) {
      log('Инициализация exchange...');
      exchange = await createExchange();
      if (!exchange) {
        log('Не удалось загрузить рынки, повтор через 60 сек');
        await sleep(60000);
        continue;
      }
      consecutiveErrors = 0;
    }

    try {
      const result = await scanPairs(exchange, log);
      fs.writeFileSync(RESULT_FILE, JSON.stringify({
        time: new Date().toISOString(),
        top: result,
      }, null, 2));
      log(`Результат записан: ${result.length} пар`);
      consecutiveErrors = 0;

      if (process.env.TG_BOT_TOKEN && process.env.TG_CHAT_ID) {
        const lastNotify = loadLastNotify();
        const now = Date.now();
        if (now - lastNotify >= NOTIFY_INTERVAL_MS) {
          try {
            await notifyScannerTop(result, getMinScore(), getActiveSymbols(), getPairsConfig(), getBaselineBudget());
            saveLastNotify(now);
            log('TG уведомление отправлено');
          } catch (err) {
            log(`TG уведомление не отправлено: ${err.message}`);
          }
        }
      }
    } catch (e) {
      consecutiveErrors++;
      log(`Ошибка скана (${consecutiveErrors}): ${e.message}`);

      // После 3 ошибок подряд — пересоздаём exchange (VPN мог упасть)
      if (consecutiveErrors >= 3) {
        log('Слишком много ошибок подряд — пересоздаю exchange');
        exchange = null;
        await sleep(15000);
        continue;
      }
    }

    const intervalMs = getIntervalMin() * 60 * 1000;
    log(`Следующий скан через ${getIntervalMin()} мин`);
    await sleep(intervalMs);
  }
}

// Ловим необработанные ошибки — перезапуск вместо смерти
process.on('uncaughtException', (e) => {
  log(`uncaughtException: ${e.message}`);
});
process.on('unhandledRejection', (e) => {
  log(`unhandledRejection: ${e?.message || e}`);
});

run().catch(e => {
  log(`FATAL: ${e.message} — перезапуск через 30 сек`);
  setTimeout(() => run(), 30000);
});
