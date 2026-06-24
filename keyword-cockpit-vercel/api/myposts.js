const https = require('https');
const CLIENT_ID     = process.env.NAVER_CLIENT_ID;
const CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;

function httpsGet(urlOrOpts, redirectCount, callback) {
  if (redirectCount > 5) return callback(new Error('Too many redirects'));
  let options;
  if (typeof urlOrOpts === 'string') {
    const p = new URL(urlOrOpts);
    options = { hostname: p.hostname, path: p.pathname + p.search, method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0' } };
  } else { options = urlOrOpts; }
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

function normalize(str) {
  return str.toLowerCase().replace(/[()（）\[\]【】\s\-_·•,./]/g, '');
}
function tokenize(str) {
  return str.match(/[가-힣]+|[0-9]+|[a-zA-Z]+/g) || [];
}
function extractPostNo(link) {
  const m1 = link.match(/blog\.naver\.com\/[^/]+\/(\d+)/);
  if (m1) return m1[1];
  const m2 = link.match(/logNo=(\d+)/);
  if (m2) return m2[1];
  return link;
}

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
    const tagRaw      = get('tag'); // 콤마로 구분된 글쓴이 직접 입력 해시태그
    const tags        = tagRaw ? tagRaw.split(',').map(t => t.trim()).filter(Boolean) : [];
    if (title && link) items.push({ title, link, description, pubDate, tags });
  }
  items.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  return items;
}

function searchRSS(query, blogId, callback) {
  const RSS_URL = `https://rss.blog.naver.com/${blogId}.xml`;
  httpsGet(RSS_URL, 0, (err, statusCode, data) => {
    if (err) return callback([]);
    try {
      const allItems = parseRSS(data);
      // __all__ 이면 전체 반환
      if (query === '__all__') return callback(allItems);
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

function searchAPI(query, blogId, callback) {
  // __all__ 이면 API 검색 스킵
  if (query === '__all__') return callback([]);
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
        .filter(item => (item.link || '').toLowerCase().includes(blogId.toLowerCase()))
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

function dedupe(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = extractPostNo(item.link);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const { query, blogId: qBlogId } = req.query;
  if (!query) return res.status(400).json({ error: 'query 파라미터가 없습니다' });

  const blogId = (qBlogId || 'p911c4').trim().toLowerCase();

  const [rssItems, apiItems] = await Promise.all([
    new Promise(resolve => searchRSS(query, blogId, resolve)),
    new Promise(resolve => searchAPI(query, blogId, resolve)),
  ]);

  const merged = dedupe([...rssItems, ...apiItems]);
  return res.status(200).json({ items: merged, total: merged.length });
};
