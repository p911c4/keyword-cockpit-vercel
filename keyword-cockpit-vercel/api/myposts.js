const https = require('https');

const CLIENT_ID     = process.env.NAVER_CLIENT_ID;
const CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;
const BLOG_ID       = 'p911c4';
const RSS_URL       = `https://rss.blog.naver.com/${BLOG_ID}.xml`;

function httpsGet(urlOrOptions, redirectCount, callback) {
  if (redirectCount > 5) return callback(new Error('Too many redirects'));

  let options;
  if (typeof urlOrOptions === 'string') {
    const parsed = new URL(urlOrOptions);
    options = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers:  { 'User-Agent': 'Mozilla/5.0' }
    };
  } else {
    options = urlOrOptions;
  }

  const req = https.request(options, res => {
    if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
      res.resume();
      const loc = res.headers.location;
      const next = loc.startsWith('http') ? loc : `https://${options.hostname}${loc}`;
      return httpsGet(next, redirectCount + 1, callback);
    }
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => callback(null, res.statusCode, data));
  });
  req.on('error', callback);
  req.end();
}

// RSS 파싱 (fallback용)
function parseRSS(xml) {
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  const items  = [];
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const get = tag => {
      const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
      const x = r.exec(block);
      return x ? x[1].replace(/<!\[CDATA\[|\]\]>/g,'').trim() : '';
    };
    const title       = get('title').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
    const link        = get('link');
    const description = get('description').replace(/<[^>]+>/g,'').slice(0, 80);
    if (title && link) items.push({ title, link, description, bloggername: BLOG_ID });
  }
  return items;
}

// 네이버 블로그 검색 API — "키워드" 검색 후 p911c4 필터 (관련도순)
function searchNaverBlog(query, callback) {
  // 쿼리에 블로그 ID를 추가해서 해당 블로그 포스팅이 상위에 오도록 유도
  const combinedQuery = encodeURIComponent(`${query} ${BLOG_ID}`);
  const apiPath = `/v1/search/blog.json?query=${combinedQuery}&display=100&sort=sim`;

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
      const items = (json.items || []).filter(item => {
        const l = (item.link        || '').toLowerCase();
        const n = (item.bloggername || '').toLowerCase();
        const b = (item.bloggerlink || '').toLowerCase();
        return l.includes(BLOG_ID) || n.includes(BLOG_ID) || b.includes(BLOG_ID);
      });
      callback(null, items);
    } catch(e) {
      callback(e, []);
    }
  });
}

// RSS fallback — 키워드 필터링
function searchRSS(query, callback) {
  httpsGet(RSS_URL, 0, (err, statusCode, data) => {
    if (err) return callback(err, []);
    try {
      const allItems = parseRSS(data);
      const kwNorm   = query.replace(/\s+/g,'').toLowerCase();
      const kwTokens = query.toLowerCase().split(/\s+/).filter(Boolean);
      const matched  = allItems.filter(item => {
        const hay = (item.title + ' ' + item.description).replace(/\s+/g,'').toLowerCase();
        return hay.includes(kwNorm) || kwTokens.every(t => hay.includes(t));
      });
      callback(null, matched);
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

  const { query } = req.query;
  if (!query) return res.status(400).json({ error: 'query 파라미터가 없습니다' });

  // 1차: 네이버 블로그 검색 API (관련도순)
  searchNaverBlog(query, (err, apiItems) => {
    if (!err && apiItems.length > 0) {
      // API에서 뉴카 포스팅 찾음 → 관련도순 그대로 반환
      return res.status(200).json({ items: apiItems, total: apiItems.length, source: 'api' });
    }

    // 2차 fallback: RSS 파싱 (API에서 못 찾은 경우)
    searchRSS(query, (err2, rssItems) => {
      if (err2) return res.status(502).json({ error: 'RSS 오류: ' + err2.message, items: [] });
      return res.status(200).json({ items: rssItems, total: rssItems.length, source: 'rss' });
    });
  });
};
