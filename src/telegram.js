import https from 'https';
import fs from 'fs';

const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

let botToken = null;
let chatId = null;
let lastUpdateId = 0;
let commandHandler = null;
let isProcessingCommand = false;
let ready = false;

const UPDATE_ID_FILE = 'tg-update-id.json';

function loadUpdateId() {
  try {
    const data = JSON.parse(fs.readFileSync(UPDATE_ID_FILE, 'utf8'));
    return data.lastUpdateId || 0;
  } catch { return 0; }
}

function saveUpdateId(id) {
  try { fs.writeFileSync(UPDATE_ID_FILE, JSON.stringify({ lastUpdateId: id })); } catch {}
}

export function initTelegram(token, chat) {
  botToken = token;
  chatId = chat;
  lastUpdateId = loadUpdateId();
}

export function onCommand(handler) {
  commandHandler = handler;
}

// ===== Визуальные константы =====
const V = {
  line: '━━━━━━━━━━━━━━━━━━━━',
  thinLine: '┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄',
  up: '🟢', down: '🔴', flat: '🟡',
  money: '💰', chart: '📊', rocket: '🚀',
  warn: '⚠️', fire: '🔥', target: '🎯',
  trophy: '🏆', crown: '👑', gem: '💎',
  clock: '🕐', bolt: '⚡', shield: '🛡️',
  bar(pct, len = 10) {
    const filled = Math.round(pct / 100 * len);
    return '█'.repeat(Math.min(filled, len)) + '░'.repeat(Math.max(len - filled, 0));
  },
  sparkLine(values) {
    const sparks = '▁▂▃▄▅▆▇█';
    if (!values.length) return '';
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    return values.map(v => sparks[Math.floor((v - min) / range * 7)]).join('');
  },
  pnl(val) {
    if (val > 0) return `+$${val.toFixed(4)}`;
    if (val < 0) return `-$${Math.abs(val).toFixed(4)}`;
    return '$0.00';
  },
  pnlIcon(val) {
    return val > 0 ? '🟢' : val < 0 ? '🔴' : '⚪';
  },
};

export { V };

// ===== Клавиатура =====
const MAIN_KEYBOARD = {
  keyboard: [
    ['📊 Статус', '💰 Профит', '💵 Баланс'],
    ['💎 Активы', '📋 Ордера', '🔍 Сканер'],
    ['🌍 Рынок', '📈 Неделя', '🏆 Рекорд'],
    ['🛡️ Риск', '📜 Лог', '❓ Помощь'],
  ],
  resize_keyboard: true,
  one_time_keyboard: false,
};

// ===== Отправка =====
function _tgOnce(method, body) {
  if (!botToken) return Promise.resolve(null);
  const data = JSON.stringify(body);
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${botToken}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      agent,
      timeout: 10000,
    }, (res) => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        try { resolve(JSON.parse(b)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(data);
    req.end();
  });
}

async function tgRequest(method, body, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    const result = await _tgOnce(method, body);
    if (result?.ok) return result;
    if (i < retries) await new Promise(r => setTimeout(r, 2000));
  }
  return null;
}

export async function sendTg(text, opts = {}) {
  const body = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (opts.keyboard) body.reply_markup = opts.keyboard;
  return tgRequest('sendMessage', body);
}

export async function sendWithKeyboard(text) {
  return sendTg(text, { keyboard: MAIN_KEYBOARD });
}

// ===== Получение сообщений =====
async function getUpdates() {
  if (!botToken) return [];
  const result = await tgRequest('getUpdates', {
    offset: lastUpdateId + 1,
    timeout: 1,
    limit: 10,
    allowed_updates: ['message', 'callback_query'],
  });
  return result?.ok ? (result.result || []) : [];
}

export async function clearQueue() {
  if (!botToken) return;
  try {
    const updates = await getUpdates();
    if (updates.length > 0) {
      lastUpdateId = updates[updates.length - 1].update_id;
      saveUpdateId(lastUpdateId);
    }
    ready = true;
  } catch { ready = true; }
}

// ===== Парсинг команд =====
function parseCommand(text) {
  const t = text.trim().toLowerCase();

  // Быстрые
  if (t === '?' || t === 'живой' || t === 'живой?' || t === 'пинг') return { cmd: 'ping' };
  if (t === '$' || t === '💲') return { cmd: 'dollar' };

  // Существующие
  if (t === 'как дела' || t === 'как дела?' || t === 'статус' || t === '/status' || t === '📊 статус') return { cmd: 'status' };
  if (t === 'стоп' || t === '/stop') return { cmd: 'stop' };
  if (t === 'пуск' || t === '/start' || t === 'старт') return { cmd: 'start' };
  if (t === 'помощь' || t === '/help' || t === '❓ помощь') return { cmd: 'help' };

  // Аналитика
  if (t === 'профит' || t === '💰 профит') return { cmd: 'profit' };
  const profitPeriod = t.match(/^профит[:\s]+(today|yesterday|week|\d{4}-\d{2}-\d{2})$/);
  if (profitPeriod) return { cmd: 'profit', arg: profitPeriod[1] };
  if (t === 'неделя' || t === '📈 неделя') return { cmd: 'week' };
  if (t === 'месяц') return { cmd: 'month' };
  if (t === 'рекорд' || t === '🏆 рекорд') return { cmd: 'record' };

  // Мониторинг
  if (t === 'ордера' || t === '📋 ордера') return { cmd: 'orders' };
  if (t === 'баланс' || t === '💵 баланс') return { cmd: 'balance' };
  if (t === 'активы' || t === '💎 активы') return { cmd: 'assets' };
  if (t === 'сканер' || t === '🔍 сканер') return { cmd: 'scanner' };
  if (t === 'рынок' || t === '🌍 рынок') return { cmd: 'market' };
  if (t === 'риск' || t === '🛡️ риск') return { cmd: 'risk' };

  // Управление
  if (t === 'лог' || t === '📜 лог') return { cmd: 'log' };
  if (t === 'пересоздать') return { cmd: 'rebuild' };

  // С аргументом
  const closeMatch = t.match(/^закрыть\s+(\w+)/);
  if (closeMatch) return { cmd: 'close_pair', arg: closeMatch[1].toUpperCase() };

  const addMatch = t.match(/^добавить\s+(\w+)/);
  if (addMatch) return { cmd: 'add_pair', arg: addMatch[1].toUpperCase() };

  const replaceMatch = t.match(/^замен(?:ить|и|яем)\s+(\w+)[\s\-]+(?:на\s+)?(\w+)/);
  if (replaceMatch) return { cmd: 'replace_pair', arg: replaceMatch[1].toUpperCase(), value: replaceMatch[2].toUpperCase() };

  const stepMatch = t.match(/^шаг\s+(\w+)\s+([\d.]+)/);
  if (stepMatch) return { cmd: 'set_step', arg: stepMatch[1].toUpperCase(), value: parseFloat(stepMatch[2]) };

  // Бюджет пары: "бюджет M +30", "бюджет M -20", "бюджет M 200" (абсолют), "докинь M 30" (= +30)
  const budgetMatch = t.match(/^(?:бюджет|докин(?:ь|уть))\s+(\w+)\s+(\+|-)?(\d+(?:\.\d+)?)/);
  if (budgetMatch) {
    const isDokin = /^докин/.test(t);
    const sign = isDokin ? '+' : (budgetMatch[2] || '=');
    return { cmd: 'set_budget', arg: budgetMatch[1].toUpperCase(), value: { sign, amount: parseFloat(budgetMatch[3]) } };
  }

  // Отмена sell-ордеров: "отмени sell ADA", "отмени sell ADA 1", "отмени sell ADA все"
  const cancelSellMatch = t.match(/^отмен(?:и|ить)\s+sell\s+(\w+)(?:\s+(\d+|все|all))?/);
  if (cancelSellMatch) {
    const v = cancelSellMatch[2];
    return {
      cmd: 'cancel_sells',
      arg: cancelSellMatch[1].toUpperCase(),
      value: v ? (v === 'все' || v === 'all' ? 'all' : parseInt(v)) : 'list',
    };
  }

  // Полная продажа пары: "продай ADA" — отменить все sell + market sell остатка
  const sellNowMatch = t.match(/^прода(?:й|ть)\s+(\w+)/);
  if (sellNowMatch) return { cmd: 'sell_now', arg: sellNowMatch[1].toUpperCase() };

  const pauseMatch = t.match(/^пауза\s+(\w+)/);
  if (pauseMatch) return { cmd: 'pause_pair', arg: pauseMatch[1].toUpperCase() };

  const resumeMatch = t.match(/^возобновить\s+(\w+)/);
  if (resumeMatch) return { cmd: 'resume_pair', arg: resumeMatch[1].toUpperCase() };

  // /health — диагностика
  if (t === '/health' || t === 'здоровье') return { cmd: 'health' };

  // 🔒 Сейф (lockedProfit) — показать / разморозить
  if (t === 'сейф' || t === '🔒 сейф') return { cmd: 'safe' };
  const safeWithdraw = t.match(/^сейф\s+(?:вывести|размор(?:озить)?|анлок|unlock)\s+(\d+(?:\.\d+)?|все|all)/);
  if (safeWithdraw) {
    const v = safeWithdraw[1];
    return { cmd: 'safe_withdraw', value: (v === 'все' || v === 'all') ? 'all' : parseFloat(v) };
  }

  return null;
}

export async function checkCommands() {
  if (!botToken || !commandHandler || !ready) return;
  if (isProcessingCommand) return;

  try {
    const updates = await getUpdates();
    if (updates.length === 0) return;

    const maxId = updates[updates.length - 1].update_id;
    if (maxId > lastUpdateId) {
      lastUpdateId = maxId;
      saveUpdateId(lastUpdateId);
    }

    // Собираем уникальные команды
    const commands = [];
    const seen = new Set();
    for (const update of updates) {
      let text = null;
      let callbackId = null;
      let fromChat = null;
      if (update.message?.text) {
        fromChat = update.message.chat.id;
        text = update.message.text;
      } else if (update.callback_query?.data) {
        fromChat = update.callback_query.message?.chat?.id ?? update.callback_query.from.id;
        text = update.callback_query.data;
        callbackId = update.callback_query.id;
      } else continue;

      if (String(fromChat) !== String(chatId)) continue;

      const parsed = parseCommand(text);
      if (callbackId) tgRequest('answerCallbackQuery', { callback_query_id: callbackId }).catch(() => {});
      if (!parsed) continue;

      const key = parsed.cmd + (parsed.arg || '') + (parsed.value || '');
      if (seen.has(key)) continue;
      seen.add(key);
      commands.push(parsed);
    }

    if (commands.length === 0) return;
    isProcessingCommand = true;

    for (const parsed of commands) {
      await commandHandler(parsed);
    }

    isProcessingCommand = false;
  } catch {
    isProcessingCommand = false;
  }
}

// ===== Форматированные уведомления =====

export async function notifyTrade(symbol, side, price, profit) {
  const coin = symbol.split('/')[0];
  let msg;
  if (side === 'orphan_sell') {
    msg = `👻 <b>ORPHAN SELL ${coin}</b>\n` +
      `${V.thinLine}\n` +
      `Цена: <code>${price}</code>\n` +
      `Профит: <b>${V.pnl(profit || 0)}</b>\n` +
      `<i>Пара была заменена — USDT теперь свободно</i>`;
  } else if (side === 'sell' && profit) {
    msg = `${V.money} <b>SELL ${coin}</b>\n` +
      `${V.thinLine}\n` +
      `Цена: <code>${price}</code>\n` +
      `Профит: <b>${V.pnl(profit)}</b>\n`;
  } else {
    msg = `📥 <b>BUY ${coin}</b>\n` +
      `Цена: <code>${price}</code>`;
  }
  await sendTg(msg);
}

export async function notifyDailyReport(stats) {
  let msg = `${V.chart} <b>ИТОГИ ДНЯ</b>\n${V.line}\n\n`;
  msg += `${V.bolt} Сделок: <b>${stats.trades}</b>\n`;
  msg += `${V.money} Профит: <b>${V.pnl(stats.dayProfit)}</b>\n`;
  msg += `${V.gem} Копилка: <b>$${stats.totalProfit.toFixed(2)}</b>\n`;
  msg += `💼 Бюджет: $${stats.budget.toFixed(2)}\n\n`;

  if (stats.pairs.length > 0) {
    msg += `<b>По парам:</b>\n`;
    for (const p of stats.pairs) {
      msg += `  ${V.pnlIcon(p.profit)} ${p.symbol}: ${V.pnl(p.profit)}\n`;
    }
  }
  await sendWithKeyboard(msg);
}

export async function notifyAlert(text) {
  await sendTg(`${V.warn} <b>ALERT</b>\n${V.thinLine}\n${text}`);
}

export async function notifyRebalance(from, to, amount) {
  await sendTg(`🔄 <b>РЕБАЛАНСИРОВКА</b>\n${V.thinLine}\n${from} → ${to}\nПеренос: $${amount.toFixed(2)}`);
}

// ===== Авто-уведомления (вызываются из index.js) =====

export async function notifyMorning(stats) {
  let msg = `☀️ <b>ДОБРОЕ УТРО</b>\n${V.line}\n\n`;
  msg += `С полуночи:\n`;
  msg += `  ${V.bolt} Сделок: <b>${stats.trades}</b>\n`;
  msg += `  ${V.money} Профит: <b>${V.pnl(stats.profit)}</b>\n\n`;
  if (stats.yesterdayTrades !== undefined) {
    msg += `Вчера:\n`;
    msg += `  ${V.bolt} Сделок: <b>${stats.yesterdayTrades}</b>\n`;
    msg += `  ${V.money} Профит: <b>${V.pnl(stats.yesterdayProfit)}</b>\n\n`;
  }
  msg += `${V.gem} Копилка: <b>$${stats.totalProfit.toFixed(2)}</b>\n`;
  msg += `${stats.paused ? '🔴 Бот на паузе' : '🟢 Бот работает'}\n`;
  const dailyGoal = stats.dailyGoal || 5;
  msg += `${V.target} Цель дня: $${dailyGoal.toFixed(2)}`;
  await sendWithKeyboard(msg);
}

export async function notifyEvening(stats) {
  let msg = `🌙 <b>ИТОГИ ДНЯ</b>\n${V.line}\n\n`;
  msg += `${V.bolt} Сделок: <b>${stats.trades}</b>\n`;
  msg += `${V.money} Профит: <b>${V.pnl(stats.dayProfit)}</b>\n`;
  msg += `${V.gem} Копилка: <b>$${stats.totalProfit.toFixed(2)}</b>\n\n`;

  if (stats.bestPair) {
    msg += `${V.crown} Лучшая пара: <b>${stats.bestPair.symbol}</b> ${V.pnl(stats.bestPair.profit)}\n`;
  }
  if (stats.streak > 0) {
    msg += `${V.fire} Streak: <b>${stats.streak} дн</b> в плюсе подряд\n`;
  }
  const dailyGoal = stats.dailyGoal || 5;
  const pct = Math.min(100, (stats.dayProfit / dailyGoal) * 100);
  msg += `\n${V.target} Цель $${dailyGoal.toFixed(2)}: ${V.bar(pct)} ${pct.toFixed(0)}%`;
  await sendWithKeyboard(msg);
}

export async function notifyWeekly(stats) {
  let msg = `📅 <b>ИТОГИ НЕДЕЛИ</b>\n${V.line}\n\n`;
  msg += `${V.bolt} Сделок: <b>${stats.trades}</b>\n`;
  msg += `${V.money} Профит: <b>${V.pnl(stats.profit)}</b>\n`;
  msg += `${V.gem} Копилка: <b>$${stats.totalProfit.toFixed(2)}</b>\n\n`;
  if (stats.bestPair) msg += `${V.crown} Лучшая: ${stats.bestPair.symbol} ${V.pnl(stats.bestPair.profit)}\n`;
  if (stats.worstPair) msg += `${V.down} Худшая: ${stats.worstPair.symbol} ${V.pnl(stats.worstPair.profit)}\n`;
  if (stats.avgDaily !== undefined) msg += `\n📊 Ср. в день: ${V.pnl(stats.avgDaily)}`;
  await sendWithKeyboard(msg);
}

export async function notifyInactivity(hours) {
  await sendTg(`${V.warn} <b>ВНИМАНИЕ</b>\n${V.thinLine}\nБот не совершал сделок <b>${hours}ч</b>\n\nВозможно рынок стоит или есть проблема`);
}

export async function notifyPriceSpike(symbol, changePct, price) {
  const icon = changePct > 0 ? V.rocket : '💥';
  await sendTg(
    `${icon} <b>ДВИЖЕНИЕ ${symbol.split('/')[0]}</b>\n${V.thinLine}\n` +
    `${changePct > 0 ? '+' : ''}${changePct.toFixed(1)}% за час\n` +
    `Цена: <code>$${price}</code>`
  );
}

export async function notifyMilestone(amount) {
  const icons = { 5: '⭐', 10: '🌟', 25: V.gem, 50: V.trophy, 100: V.crown };
  const icon = icons[amount] || V.fire;
  await sendTg(
    `${icon} <b>MILESTONE!</b>\n${V.line}\n\n` +
    `Копилка достигла <b>$${amount}</b>! ${V.rocket}`
  );
}

// ===== Стартовое сообщение =====
export async function notifyStartup(budget, pairs, details) {
  let msg = `🟢 <b>GRID BOT ЗАПУЩЕН</b>\n${V.line}\n\n`;
  msg += `💼 Общий баланс биржи: <b>$${budget.toFixed(2)}</b>\n`;
  if (details) {
    if (details.usdtTotal !== undefined) msg += `💵 USDT: $${details.usdtTotal.toFixed(2)}\n`;
    if (details.tradingValue !== undefined) msg += `🪙 Торговые монеты: $${details.tradingValue.toFixed(2)}\n`;
    if (details.holdValue !== undefined && details.holdValue > 1) {
      const coins = details.holdBreakdown
        ? Object.entries(details.holdBreakdown).filter(([, v]) => v > 1).map(([c]) => c).join(', ')
        : '';
      msg += `💤 Hold: $${details.holdValue.toFixed(2)}${coins ? ` (${coins})` : ''}\n`;
    }
    if (details.workingBudget !== undefined) msg += `⚙️ Рабочий капитал: <b>$${details.workingBudget.toFixed(2)}</b>\n`;
  }
  msg += `📊 Пар: <b>${pairs}</b>\n\n`;
  msg += `Используй кнопки ниже ${V.bolt}`;
  await sendWithKeyboard(msg);
}

const LADDER_CALIBRATION = 2.7;

function estimateDailyProfit(movement48, step, budget, gridLines) {
  const fees = 0.4;
  if (!step || step <= fees || !budget || !gridLines) return 0;
  const orderSize = budget / gridLines;
  const profitPerCycle = orderSize * (step - fees) / 100;
  const dailyMovement = movement48 / 2;
  const roundTripsPerDay = dailyMovement / (step * 2);
  return Math.max(0, roundTripsPerDay * profitPerCycle * LADDER_CALIBRATION);
}

function fmtMoney(v) {
  if (v >= 1) return '$' + v.toFixed(1);
  if (v >= 0.1) return '$' + v.toFixed(2);
  return '~$0';
}

export async function notifyScannerTop(top, minScore, activeSymbols, pairsConfig, baselineBudget) {
  const active = new Set(activeSymbols || []);
  const configByPair = {};
  for (const p of (pairsConfig || [])) configByPair[p.symbol] = p;

  const baseBudget = baselineBudget || 40;
  const baseStep = 1.5;
  const baseGrids = 10;

  const fmtSym = s => s.replace('/USDT', '').slice(0, 7);

  const newOnes = (top || [])
    .filter(c => !active.has(c.symbol) && c.gridScore >= minScore)
    .sort((a, b) => b.gridScore - a.gridScore)
    .slice(0, 5)
    .map(c => ({
      ...c,
      // v4: используем реальный effectiveStep пары если есть, иначе baseStep
      forecast: estimateDailyProfit(c.movement48, c.effectiveStep || baseStep, baseBudget, baseGrids),
    }));

  const activeList = (top || [])
    .filter(c => active.has(c.symbol))
    .sort((a, b) => b.gridScore - a.gridScore)
    .map(c => {
      const cfg = configByPair[c.symbol] || {};
      const budget = cfg.budget || baseBudget;
      const step = cfg.stepPercent || baseStep;
      const grids = cfg.gridLines || baseGrids;
      return {
        ...c,
        budget,
        forecast: estimateDailyProfit(c.movement48, step, budget, grids),
      };
    });

  if (!newOnes.length && !activeList.length) return;

  const topForecast = Math.max(
    ...activeList.map(c => c.forecast),
    ...newOnes.map(c => c.forecast),
    0
  );

  function label(f) {
    if (topForecast === 0) return '';
    if (f >= 5) return ' 🔥';
    if (f >= topForecast * 0.5) return '';
    if (f < 0.2) return '  слабая';
    return '';
  }

  let msg = `🔍 <b>СКАНЕР — раз в час</b>\n<i>Данные за 3 дня</i>\n${V.thinLine}\n`;

  if (activeList.length) {
    msg += `\n<b>📊 Сейчас торгуем:</b>\n`;
    for (const c of activeList) {
      const sym = fmtSym(c.symbol);
      const fcast = '~' + fmtMoney(c.forecast) + '/день';
      const verdict = c.verdict || '';
      msg += `<code>${sym.padEnd(7)} ${fcast.padEnd(14)}</code>${label(c.forecast)} ${verdict}\n`;
    }
  }

  if (newOnes.length) {
    msg += `\n<b>🆕 Новые пары</b> (если дать $${baseBudget}):\n`;
    for (const c of newOnes) {
      const sym = fmtSym(c.symbol);
      const fcast = '~' + fmtMoney(c.forecast) + '/день';
      const verdict = c.verdict || '';
      msg += `<code>${sym.padEnd(7)} ${fcast.padEnd(14)}</code> ${verdict}\n`;
    }
  }

  const suggestions = [];
  if (newOnes.length && activeList.length) {
    const weakActive = activeList.filter(a => a.forecast < 0.2);
    const strongNew = newOnes.filter(n => n.forecast >= 0.5);
    if (weakActive.length && strongNew.length) {
      const w = weakActive[weakActive.length - 1];
      const n = strongNew[0];
      suggestions.push(`${fmtSym(n.symbol)} (~${fmtMoney(n.forecast)}/день) может быть лучше чем ${fmtSym(w.symbol)} (~${fmtMoney(w.forecast)}/день)`);
    }
    const best = newOnes[0];
    const bestActive = activeList[0];
    if (best && bestActive && best.forecast > bestActive.forecast * 1.2 && bestActive.forecast < 2) {
      const dup = suggestions.some(s => s.includes(fmtSym(best.symbol)));
      if (!dup) suggestions.push(`${fmtSym(best.symbol)} выглядит сильнее чем ${fmtSym(bestActive.symbol)} — стоит рассмотреть`);
    }
  }

  if (suggestions.length) {
    msg += `\n\n<b>💡 Совет:</b>\n`;
    for (const s of suggestions) msg += `• ${s}\n`;
    msg += `<i>Сам ничего не меняю — решай ты.</i>`;
  }

  await sendTg(msg);
}
