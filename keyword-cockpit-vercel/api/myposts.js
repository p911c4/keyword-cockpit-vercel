const https = require('https');

const BLOG_ID = 'p911c4';
// 네이버 블로그 RSS — 최근 100개 포스팅
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
      const next = res.headers.location.startsWith('http')
        ? res.headers.location
        : `https://${parsed.hostname}${res.headers.location}`;
      return httpsGet(next, redirectCount + 1, callback);
    }
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => callback(null, res.statusCode, data));
  });
  req.on('error', callback);
  req.end();
}

// XML에서 <tag>내용</tag> 파싱
function extractAll(xml, tag) {
  const results = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  let m;
  while ((m = re.exec(xml)) !== null) {
    results.push(m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim());
  }
  return results;
}

// RSS 아이템 파싱
function parseRSS(xml) {
  // <item>...</item> 블록 추출
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  const items = [];
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const title       = (extractAll(block, 'title')[0]       || '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"');
    const link        = extractAll(block, 'link')[0]        || '';
    const description = (extractAll(block, 'description')[0] || '').replace(/<[^>]+>/g,'').slice(0, 80);
    const pubDate     = extractAll(block, 'pubDate')[0]     || '';
    if (title && link) items.push({ title, link, description, pubDate });
  }
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

      // 키워드 토큰으로 필터링 (띄어쓰기 제거 후 매칭)
      const kwNorm = query.replace(/\s+/g, '').toLowerCase();
      const kwTokens = query.toLowerCase().split(/\s+/).filter(Boolean);

      const matched = allItems.filter(item => {
        const haystack = (item.title + ' ' + item.description).replace(/\s+/g, '').toLowerCase();
        // 전체 키워드 붙인 버전 OR 개별 토큰 모두 포함
        const fullMatch  = haystack.includes(kwNorm);
        const tokenMatch = kwTokens.every(t => haystack.includes(t));
        return fullMatch || tokenMatch;
      });

      return res.status(200).json({ items: matched, total: matched.length });

    } catch(e) {
      return res.status(502).json({ error: 'RSS 파싱 오류: ' + e.message, items: [] });
    }
  });
};
