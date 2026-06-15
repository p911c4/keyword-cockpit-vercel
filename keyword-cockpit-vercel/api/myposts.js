const https = require('https');

const BLOG_ID = 'p911c4';
const RSS_URL = `https://rss.blog.naver.com/${BLOG_ID}.xml`;

function httpsGet(url, redirectCount, callback) {
  if (redirectCount > 5) return callback(new Error('Too many redirects'));
  const parsed = new URL(url);
  const options = {
    hostname: parsed.hostname,
    path:     parsed.pathname + parsed.search,
    method:   'GET',
    headers:  { 'User-Agent': 'Mozilla/5.0' }
  };
  const req = https.request(options, res => {
    if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
      res.resume();
      const loc  = res.headers.location;
      const next = loc.startsWith('http') ? loc : `https://${parsed.hostname}${loc}`;
      return httpsGet(next, redirectCount + 1, callback);
    }
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => callback(null, res.statusCode, data));
  });
  req.on('error', callback);
  req.end();
}

function parseRSS(xml) {
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  const items  = [];
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const get = tag => {
      const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
      const x = r.exec(block);
      return x ? x[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
    };
    const title       = get('title').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
    const link        = get('link');
    const description = get('description').replace(/<[^>]+>/g,'').slice(0, 80);
    const pubDate     = get('pubDate');
    if (title && link) items.push({ title, link, description, pubDate });
  }
  // RSS는 이미 최신순이지만 명시적으로 날짜 내림차순 정렬
  items.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  return items;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const { query } = req.query;
  if (!query) return res.status(400).json({ error: 'query 파라미터가 없습니다' });

  httpsGet(RSS_URL, 0, (err, statusCode, data) => {
    if (err) return res.status(502).json({ error: 'RSS 연결 실패: ' + err.message, items: [] });

    try {
      const allItems = parseRSS(data);

      // 키워드 매칭 — 최신순 유지
      const kwNorm   = query.replace(/\s+/g, '').toLowerCase();
      const kwTokens = query.toLowerCase().split(/\s+/).filter(Boolean);

      const matched = allItems.filter(item => {
        const hay = (item.title + ' ' + item.description).replace(/\s+/g, '').toLowerCase();
        return hay.includes(kwNorm) || kwTokens.every(t => hay.includes(t));
      });

      return res.status(200).json({ items: matched, total: matched.length });

    } catch(e) {
      return res.status(502).json({ error: 'RSS 파싱 오류: ' + e.message, items: [] });
    }
  });
};
