# 📊 HTX Spot Grid Trading Bot

> Мульти-парный бот **спот-грид-торговли** на HTX с автосканером пар, новостным фильтром, динамическим шагом сетки, защитой капитала и полноценным пультом управления в **Telegram**.

**Стек:** `Node.js (ES Modules)` · `ccxt` · `child_process` (scanner-worker) · `Telegram Bot API` · `dotenv`
**Тип:** личный проект (pet-project), работал на реальном счёте HTX
**Объём:** ~6 400 строк (ядро + сканер + Telegram + утилиты)

---

## 🎯 Что это

Grid-бот одновременно ведёт сетки по нескольким парам (M, CFG, ZEC, CHZ, PENGU, ROBO и др.). По каждой паре он выставляет лесенку лимитных ордеров на покупку/продажу с заданным шагом и зарабатывает на колебаниях цены внутри диапазона. Бот полностью автономен и управляется из Telegram.

## 🧩 Ключевые возможности

- **Мульти-грид:** независимые сетки на каждую пару со своим бюджетом, числом уровней и шагом (`grid-config.json`).
- **Автосканер пар** (`scanner.js`) — запускается **отдельным child-процессом с авто-рестартом** (`scanner-worker.js`), чтобы тяжёлое сканирование не блокировало торговый цикл. Оценивает все пары HTX по объёму, дневному диапазону, тренду и grid-score; может авто-подменять слабые пары.
- **Динамический шаг сетки** — ширина шага подстраивается под волатильность пары (min/max step), с кэшированием.
- **Новостной фильтр** (`news.js`) — Fear & Greed + новостные источники; при негативном фоне сетка ставится на паузу.
- **Лесенка ордеров (ladder):** держим лишь N активных покупок/продаж у цены + safety-order на отдалении — экономия USDT и контроль экспозиции.
- **Защита капитала (safety):** стоп-лосс по паре, trend-gate (не докупать в явном даунтренде по 24ч-изменению и доминирующему тренду).
- **Трейлинг-стопы**, ребаланс бюджета, «сейф» (физическая заморозка прибыли, compound-режим).
- **Telegram-пульт** (`telegram.js`, ~550 строк): статус, P&L, дневные/недельные отчёты, стрики, рекорды, ручные команды управления, алерты по движениям и майлстоунам — на естественном языке («как дела», «стоп», «сейф») и слэш-командах.
- **Логирование в Obsidian** — все сделки/сканы/события пишутся в дневные `.md`-заметки для аналитики 24/7.
- **Кэширование и троттлинг** запросов (бюджет, баланс, шаг, OHLCV) — чтобы укладываться в rate-limit биржи.

## 🏗 Архитектура

```
src/
  index.js          Торговое ядро: загрузка сеток, checkGrid, refillLadder,
                    trailing, rebalance, autoSwitch, отчёты, обработка TG-команд
  scanner.js        Сканер всех пар HTX → grid-score, кандидаты на торговлю
  scanner-worker.js Обёртка: запуск сканера как отдельного процесса + рестарт
  telegram.js       Пульт управления: парсинг команд, клавиатуры, уведомления
  news.js           Fear & Greed + новостной фон → пауза при негативе
  maintenance/      Разовые ops-утилиты (проверка баланса/ордеров, прайминг
                    состояния, аварийные продажи, аналитика 7д) — выносил
                    рутинные операции в отдельные скрипты, чтобы не трогать ядро
```

**Почему сканер — отдельный процесс.** Полное сканирование сотен пар по OHLCV — дорого и долго. Запуск его внутри основного цикла подвешивал бы торговлю и Telegram. Поэтому сканер вынесен в child-процесс с авто-рестартом: торговое ядро остаётся отзывчивым, а результаты читает из снапшота (`scanner-result.json`).

## ⚙️ Конфигурация

Вся стратегия описана декларативно в `grid-config.example.json`: список пар с бюджетами/шагами, параметры сканера, лесенки, новостного фильтра, safety и сейфа. Менять стратегию можно без правки кода.

## 🛠 Запуск

```bash
npm install
cp .env.example .env                       # ключи HTX + TG_BOT_TOKEN/TG_CHAT_ID
cp grid-config.example.json grid-config.json
npm start                                  # node src/index.js (сам форкает scanner-worker)
```

> ⚠️ Бот работает с реальными деньгами. Это демонстрационный код из портфолио; запуск — на свой риск.

## 📌 Чему научился

Проектированию долгоживущего автономного сервиса: разделение тяжёлой работы на child-процессы, кэширование под rate-limit, декларативная конфигурация стратегии, защита капитала, построение богатого Telegram-интерфейса на естественном языке и интеграция биржевого API через ccxt.
<img width="1882" height="234" alt="image" src="https://github.com/user-attachments/assets/8100d28a-a5fa-4a9c-a9a3-4b8b259ef196" />
<img width="500" height="171" alt="image" src="https://github.com/user-attachments/assets/a71b29a8-4d40-46b6-8f25-6fbd643f2817" />
<img width="419" height="506" alt="image" src="https://github.com/user-attachments/assets/14d4c548-d204-49fb-a2cf-dd780830fcbc" />
<img width="409" height="122" alt="image" src="https://github.com/user-attachments/assets/b21d8823-8150-48f0-b771-2b0c7eb10061" />
<img width="501" height="1182" alt="image" src="https://github.com/user-attachments/assets/a7cdf4b4-5168-4f24-b27c-49479594c7a3" />
<img width="513" height="1239" alt="image" src="https://github.com/user-attachments/assets/21157b57-e3bd-4012-8793-69c0d3141502" />
<img width="420" height="958" alt="image" src="https://github.com/user-attachments/assets/5936cccf-7a2b-46aa-9ff3-b289e6d9a008" />
<img width="398" height="473" alt="image" src="https://github.com/user-attachments/assets/b8b0f6c3-7275-4a19-b58a-f1401b32d8a0" />
<img width="1193" height="459" alt="image" src="https://github.com/user-attachments/assets/2ac395f3-abfc-412b-a3bc-97fceb7b8399" />
<img width="1199" height="528" alt="image" src="https://github.com/user-attachments/assets/d1aa2d93-324e-4c59-8c3d-b18cd44d49e3" />
<img width="1207" height="524" alt="image" src="https://github.com/user-attachments/assets/725d0767-df7c-4f26-9552-88bcde35e8f4" />
<img width="1204" height="535" alt="image" src="https://github.com/user-attachments/assets/67d21c88-2078-4c18-9378-4cc6de68b244" />

