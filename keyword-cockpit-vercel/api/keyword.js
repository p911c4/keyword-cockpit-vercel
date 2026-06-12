const https  = require('https');
const crypto = require('crypto');

const CUSTOMER_ID = process.env.NAVER_CUSTOMER_ID;
const API_KEY     = process.env.NAVER_API_KEY;
const SECRET_KEY  = process.env.NAVER_SECRET_KEY;

function hmacSHA256(secret, message) {
  return crypto.createHmac('sha256', secret).update(message).digest('base64');
}

function httpsGet(options, redirectCount, callback) {
  if (redirectCount > 5) return callback(new Error('Too many redirects'));
  const req = https.request(options, res => {
    if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
      res.resume();
      const loc     = res.headers.location;
      const newUrl  = new URL(loc, `https://${options.hostname}`);
      const newOpts = Object.assign({}, options, {
        hostname: newUrl.hostname,
        path:     newUrl.pathname + newUrl.search,
      });
      return httpsGet(newOpts, redirectCount + 1, callback);
    }
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => callback(null, res.statusCode, data));
  });
  req.on('error', callback);
  req.end();
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { keywords } = req.body || {};
  if (!keywords?.length) return res.status(400).json({ error: 'keywords 필드가 없습니다' });

  const qs       = keywords.map(k => `hintKeywords=${encodeURIComponent(k)}`).join('&') + '&showDetail=1';
  const basePath = '/keywordstool';
  const fullPath = `${basePath}?${qs}`;
  const ts       = Date.now().toString();
  const sig      = hmacSHA256(SECRET_KEY, `${ts}.GET.${basePath}`);

  const options = {
    hostname: 'api.naver.com',
    path:     fullPath,
    method:   'GET',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Timestamp':  ts,
      'X-API-KEY':    API_KEY,
      'X-Customer':   CUSTOMER_ID,
      'X-Signature':  sig,
    }
  };

  httpsGet(options, 0, (err, statusCode, data) => {
    if (err) return res.status(502).json({ error: 'Naver API 연결 실패: ' + err.message });
    if (!data || data.trim() === '') return res.status(502).json({ error: '빈 응답' });
    try {
      const json = JSON.parse(data);
      return res.status(statusCode).json(json);
    } catch(e) {
      return res.status(502).json({ error: '응답 파싱 오류: ' + data.slice(0, 100) });
    }
  });
};
