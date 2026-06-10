import https from 'https';
import ccxt from 'ccxt';

const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

ccxt.htx.prototype.fetch = async function(url, method = 'GET', headers = {}, body = undefined) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const reqHeaders = { ...headers };
    if (body) reqHeaders['Content-Type'] = 'application/json';

    const req = https.request({
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: reqHeaders,
      agent,
      timeout: 25000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const fakeResponse = {
          headers: new Headers(res.headers),
          status: res.statusCode,
          text: async () => data,
          buffer: () => Buffer.from(data),
        };
        resolve(this.handleRestResponse(fakeResponse, url, method, headers, body));
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new ccxt.RequestTimeout(this.id + ' ' + method + ' ' + url + ' request timed out'));
    });
    req.on('error', (e) => {
      reject(new ccxt.NetworkError(this.id + ' ' + method + ' ' + url + ' fetch failed: ' + e.message));
    });

    if (body) req.write(body);
    req.end();
  });
};
