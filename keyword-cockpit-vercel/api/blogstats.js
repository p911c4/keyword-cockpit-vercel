const https = require('https');

const CLIENT_ID     = process.env.NAVER_CLIENT_ID;
const CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;
const BLOG_ID       = 'p911c4';
const RSS_URL       = `https://rss.blog.naver.com/${BLOG_ID}.xml`;

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

// RSS → 포스팅 목록 파싱
function parseRSS(xml) {
  const re = /<item>([\s\S]*?)<\/item>/gi;
  const items = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const get = tag => {
      const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
      const x = r.exec(block);
      return x ? x[1].replace(/<!\[CDATA\[|\]\]>/g,'').trim() : '';
    };
    const pubDate = get('pubDate');
    const title   = get('title').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
    const link    = get('link');
    if (title && link) items.push({ title, link, pubDate });
  }
  items.sort((a,b) => new Date(b.pubDate) - new Date(a.pubDate));
  return items;
}

// 네이버 블로그 검색 → 내 블로그 노출 순위 찾기
function findMyRank(keyword, callback) {
  const query   = encodeURIComponent(keyword);
  const apiPath = `/v1/search/blog.json?query=${query}&display=100&sort=sim`;
  const options = {
    hostname: 'openapi.naver.com',
    path:     apiPath,
    method:   'GET',
    headers: {
      'X-Naver-Client-Id':     CLIENT_ID,
      'X-Naver-Client-Secret': CLIENT_SECRET,
    }
  };
  httpsGet(options, 0, (err, statusCode, data) => {
    if (err) return callback(err, []);
    try {
      const json  = JSON.parse(data);
      const items = json.items || [];
      const found = [];
      items.forEach((item, idx) => {
        const l = (item.link        || '').toLowerCase();
        const n = (item.bloggername || '').toLowerCase();
        const b = (item.bloggerlink || '').toLowerCase();
        if (l.includes(BLOG_ID) || n.includes(BLOG_ID) || b.includes(BLOG_ID)) {
          found.push({
            rank:        idx + 1,
            title:       item.title.replace(/<[^>]+>/g,''),
            link:        item.link,
            description: (item.description||'').replace(/<[^>]+>/g,'').slice(0,60),
            pubDate:     item.pubDate || '',
          });
        }
      });
      callback(null, found);
    } catch(e) {
      callback(e, []);
    }
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const { keyword } = req.query;

  // ── 1. RSS 기반 블로그 활동 지표 ──
  const rssPromise = new Promise(resolve => {
    httpsGet(RSS_URL, 0, (err, statusCode, data) => {
      if (err) return resolve({ total: 0, recent30: 0, lastDate: null, error: err.message });
      try {
        const items   = parseRSS(data);
        const now     = new Date();
        const d30ago  = new Date(now - 30 * 24 * 60 * 60 * 1000);
        const recent30 = items.filter(i => new Date(i.pubDate) >= d30ago).length;
        const lastDate = items[0]?.pubDate || null;
        resolve({ total: items.length, recent30, lastDate });
      } catch(e) {
        resolve({ total: 0, recent30: 0, lastDate: null, error: e.message });
      }
    });
  });

  // ── 2. 키워드 노출 순위 (keyword 파라미터 있을 때만) ──
  const rankPromise = keyword
    ? new Promise(resolve => {
        findMyRank(keyword, (err, found) => {
          if (err) return resolve({ ranks: [], error: err.message });
          resolve({ ranks: found });
        });
      })
    : Promise.resolve({ ranks: [] });

  const [rssResult, rankResult] = await Promise.all([rssPromise, rankPromise]);

  return res.status(200).json({
    blogId:   BLOG_ID,
    stats:    rssResult,
    ranking:  rankResult,
  });
};
