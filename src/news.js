import https from 'https';

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.request({
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      agent: httpsAgent,
      timeout: 15000,
      headers: { 'User-Agent': 'HTX-Grid-Bot/1.0' },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

// Fear & Greed Index
export async function getFearGreed() {
  try {
    const data = await fetchJSON('https://api.alternative.me/fng/?limit=1');
    if (!data?.data?.[0]) return null;
    const fg = data.data[0];
    return {
      value: parseInt(fg.value),
      label: fg.value_classification,
      timestamp: new Date(fg.timestamp * 1000).toISOString(),
    };
  } catch {
    return null;
  }
}

// CryptoPanic — бесплатный API для крипто-новостей
export async function getCryptoNews() {
  try {
    // Публичный эндпоинт без API ключа — последние важные новости
    const data = await fetchJSON('https://cryptopanic.com/api/free/v1/posts/?auth_token=free&public=true&filter=important&kind=news');
    if (!data?.results) return [];

    return data.results.slice(0, 10).map(item => ({
      title: item.title,
      source: item.source?.title || 'unknown',
      published: item.published_at,
      currencies: (item.currencies || []).map(c => c.code),
      sentiment: item.votes ? analyzeSentiment(item.votes) : 'neutral',
    }));
  } catch {
    return [];
  }
}

function analyzeSentiment(votes) {
  const pos = (votes.positive || 0) + (votes.liked || 0) + (votes.important || 0);
  const neg = (votes.negative || 0) + (votes.disliked || 0) + (votes.toxic || 0);
  if (pos > neg * 2) return 'positive';
  if (neg > pos * 2) return 'negative';
  return 'neutral';
}

// CoinGecko — глобальные данные рынка
export async function getMarketOverview() {
  try {
    const data = await fetchJSON('https://api.coingecko.com/api/v3/global');
    if (!data?.data) return null;
    const d = data.data;
    return {
      btcDominance: d.market_cap_percentage?.btc?.toFixed(1),
      totalMarketCap: d.total_market_cap?.usd,
      marketCapChange24h: d.market_cap_change_percentage_24h_usd?.toFixed(2),
      totalVolume24h: d.total_volume?.usd,
    };
  } catch {
    return null;
  }
}

// Полный анализ новостей — возвращает рекомендацию
export async function analyzeNews(log) {
  const [fearGreed, news, market] = await Promise.all([
    getFearGreed(),
    getCryptoNews(),
    getMarketOverview(),
  ]);

  let score = 50; // нейтральный
  let reasons = [];

  // Fear & Greed
  if (fearGreed) {
    log(`Fear & Greed: ${fearGreed.value} (${fearGreed.label})`);
    if (fearGreed.value < 20) {
      score -= 20;
      reasons.push(`Extreme Fear (${fearGreed.value})`);
    } else if (fearGreed.value < 35) {
      score -= 10;
      reasons.push(`Fear (${fearGreed.value})`);
    } else if (fearGreed.value > 75) {
      score += 10;
      reasons.push(`Greed (${fearGreed.value})`);
    }
  }

  // Новости
  if (news.length > 0) {
    const negNews = news.filter(n => n.sentiment === 'negative');
    const posNews = news.filter(n => n.sentiment === 'positive');
    log(`Новости: ${news.length} шт (${posNews.length} позитив, ${negNews.length} негатив)`);

    if (negNews.length >= 3) {
      score -= 25;
      reasons.push(`${negNews.length} негативных новостей`);
    } else if (negNews.length >= 2) {
      score -= 15;
      reasons.push(`${negNews.length} негативных новостей`);
    }
    if (posNews.length >= 3) {
      score += 15;
      reasons.push(`${posNews.length} позитивных новостей`);
    }

    // Логируем топ новости
    for (const n of news.slice(0, 5)) {
      log(`  [${n.sentiment}] ${n.title}`);
    }
  }

  // Глобальный рынок
  if (market) {
    const change = parseFloat(market.marketCapChange24h);
    log(`Рынок: BTC dom ${market.btcDominance}%, капитализация ${change > 0 ? '+' : ''}${change}%`);
    if (change < -5) {
      score -= 20;
      reasons.push(`Рынок -${Math.abs(change)}% за 24ч`);
    } else if (change < -3) {
      score -= 10;
      reasons.push(`Рынок -${Math.abs(change)}% за 24ч`);
    }
  }

  // Результат
  let action = 'RUN'; // продолжать торговлю
  if (score < 20) {
    action = 'PAUSE';
    log(`НОВОСТИ: ПАУЗА (score ${score}) — ${reasons.join(', ')}`);
  } else if (score < 35) {
    action = 'CAUTION';
    log(`НОВОСТИ: ОСТОРОЖНО (score ${score}) — ${reasons.join(', ')}`);
  } else {
    log(`НОВОСТИ: ОК (score ${score})`);
  }

  return { score, action, reasons, fearGreed, newsCount: news.length };
}
