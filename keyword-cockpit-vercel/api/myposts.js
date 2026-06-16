const https = require('https');

const BLOG_ID       = 'p911c4';
const RSS_URL       = `https://rss.blog.naver.com/${BLOG_ID}.xml`;
const CLIENT_ID     = process.env.NAVER_CLIENT_ID;
const CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;

function httpsGet(urlOrOpts, redirectCount, callback) {
  if (redirectCount > 5) return callback(new Error('Too many redirects'));
  let options;
  if (typeof urlOrOpts === 'string') {
    const p = new URL(urlOrOpts);
    options = { hostname: p.hostname, path: p.pathname + p.search, method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0' } };
  } else {
    options = urlOrOpts;
  }
  const req = https.request(options, res => {
    if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
      res.resume();
      const loc  = res.headers.location;
      const next = loc.startsWith('http') ? loc : `https://${options.hostname}${loc}`;
      return httpsGet(next, redirectCount + 1, callback);
    }
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => callback(null, res.statusCode, data));
  });
  req.on('error', callback);
  req.end();
}

// 정규화: 괄호·특수문자·공백 제거 후 소문자
function normalize(str) {
  return str.toLowerCase().replace(/[()（）\[\]【】\s\-_·•,./]/g, '');
}

// 한글/숫자/영문 토큰 분리
function tokenize(str) {
  return str.match(/[가-힣]+|[0-9]+|[a-zA-Z]+/g) || [];
}

// RSS 파싱
function parseRSS(xml) {
  const re = /<item>([\s\S]*?)<\/item>/gi;
  const items = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
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
  items.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  return items;
}

// RSS 검색 (최근 30개 내에서 키워드 필터)
function searchRSS(query, callback) {
  httpsGet(RSS_URL, 0, (err, statusCode, data) => {
    if (err) return callback([]);
    try {
      const allItems = parseRSS(data);
      const kwNorm   = normalize(query);
      const kwTokens = tokenize(query.toLowerCase());
      const matched  = allItems.filter(item => {
        const hayNorm = normalize(item.title + ' ' + item.description);
        const hayRaw  = (item.title + ' ' + item.description).toLowerCase();
        return hayNorm.includes(kwNorm)
          || (kwTokens.length > 1 && kwTokens.every(t => hayNorm.includes(t)))
          || hayRaw.includes(query.toLowerCase());
      });
      callback(matched);
    } catch(e) { callback([]); }
  });
}

// 네이버 블로그 검색 API
// 링크에 blogId(p911c4) 포함 여부로만 필터 — bloggername은 한글일 수 있으므로 제외
function searchAPI(query, callback) {
  const combined = encodeURIComponent(query);
  const apiPath  = `/v1/search/blog.json?query=${combined}&display=100&sort=sim`;
  const options  = {
    hostname: 'openapi.naver.com',
    path:     apiPath,
    method:   'GET',
    headers: {
      'X-Naver-Client-Id':     CLIENT_ID,
      'X-Naver-Client-Secret': CLIENT_SECRET,
    }
  };
  httpsGet(options, 0, (err, statusCode, data) => {
    if (err) return callback([]);
    try {
      const json  = JSON.parse(data);
      const items = (json.items || [])
        // ✅ 링크 URL에 blogId 포함 여부로만 판단 (bloggername은 한글이므로 제외)
        .filter(item => (item.link || '').toLowerCase().includes(BLOG_ID.toLowerCase()))
        .map(item => ({
          title:       item.title.replace(/<[^>]+>/g, ''),
          link:        item.link,
          description: (item.description || '').replace(/<[^>]+>/g, '').slice(0, 80),
          pubDate:     item.pubDate || '',
        }));
      callback(items);
    } catch(e) { callback([]); }
  });
}

// 링크 기준 중복 제거
function dedupe(items) {
  const seen = new Set();
  return items.filter(item => {
    if (seen.has(item.link)) return false;
    seen.add(item.link);
    return true;
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const { query } = req.query;
  if (!query) return res.status(400).json({ error: 'query 파라미터가 없습니다' });

  // RSS + API 병렬 실행
  const [rssItems, apiItems] = await Promise.all([
    new Promise(resolve => searchRSS(query, resolve)),
    new Promise(resolve => searchAPI(query, resolve)),
  ]);

  // RSS 우선 + API 보완, 중복 제거
  const merged = dedupe([...rssItems, ...apiItems]);

  return res.status(200).json({ items: merged, total: merged.length });
};
