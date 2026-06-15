const https = require('https');
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

// RSS 파싱 — 최근 50개 + pubDate
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

// 네이버 블로그 검색 API — blogId로 총 포스팅 수 조회
function getTotalCount(blogId, callback) {
  // "site:blog.naver.com/blogId" 형식으로 검색해서 total 가져오기
  const query   = encodeURIComponent(blogId);
  const apiPath = `/v1/search/blog.json?query=${query}&display=1&sort=date`;
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
    if (err) return callback(0);
    try {
      const json = JSON.parse(data);
      // total에서 해당 블로그 포스팅만 필터된 수는 직접 못 구함
      // 대신 blogId 포함 항목만 카운트 (display=100으로 샘플링)
      callback(json.total || 0);
    } catch(e) { callback(0); }
  });
}

// blogId로 실제 포스팅 수 추정 — display=100으로 blogId 필터 후 비율로 추정
function estimateTotalPosts(blogId, callback) {
  const query   = encodeURIComponent(blogId);
  const apiPath = `/v1/search/blog.json?query=${query}&display=100&sort=date`;
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
    if (err) return callback(0, 0);
    try {
      const json  = JSON.parse(data);
      const total = json.total || 0;
      const items = json.items || [];
      const myCount = items.filter(item => {
        const l = (item.link        || '').toLowerCase();
        const n = (item.bloggername || '').toLowerCase();
        const b = (item.bloggerlink || '').toLowerCase();
        return l.includes(blogId.toLowerCase()) || n.includes(blogId.toLowerCase()) || b.includes(blogId.toLowerCase());
      }).length;
      // 100개 샘플 중 내 포스팅 비율로 전체 추정
      const ratio    = items.length > 0 ? myCount / items.length : 0;
      const estimated = Math.round(total * ratio);
      callback(estimated, myCount);
    } catch(e) { callback(0, 0); }
  });
}

// 키워드 순위 조회
function findMyRank(keyword, blogId, callback) {
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
        if (l.includes(blogId.toLowerCase()) || n.includes(blogId.toLowerCase()) || b.includes(blogId.toLowerCase())) {
          found.push({
            rank:        idx + 1,
            title:       item.title.replace(/<[^>]+>/g,''),
            link:        item.link,
            description: (item.description||'').replace(/<[^>]+>/g,'').slice(0,60),
          });
        }
      });
      callback(null, found);
    } catch(e) { callback(e, []); }
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const { keyword, blogId: qBlogId } = req.query;
  const blogId = (qBlogId || 'p911c4').trim().toLowerCase();

  const RSS_URL = `https://rss.blog.naver.com/${blogId}.xml`;

  // RSS + 추정 포스팅 수 병렬 실행
  const rssPromise = new Promise(resolve => {
    httpsGet(RSS_URL, 0, (err, statusCode, data) => {
      if (err) return resolve({ rssItems: [], rssCount: 0, recent30: 0, lastDate: null });
      try {
        const items   = parseRSS(data);
        const now     = new Date();
        const d30ago  = new Date(now - 30 * 24 * 60 * 60 * 1000);
        const recent30 = items.filter(i => new Date(i.pubDate) >= d30ago).length;
        const lastDate = items[0]?.pubDate || null;
        resolve({ rssItems: items, rssCount: items.length, recent30, lastDate });
      } catch(e) { resolve({ rssItems: [], rssCount: 0, recent30: 0, lastDate: null }); }
    });
  });

  const totalPromise = new Promise(resolve => {
    estimateTotalPosts(blogId, (estimated, sample) => resolve({ estimated, sample }));
  });

  const rankPromise = keyword
    ? new Promise(resolve => {
        findMyRank(keyword, blogId, (err, found) => resolve(err ? [] : found));
      })
    : Promise.resolve([]);

  const [rssResult, totalResult, ranks] = await Promise.all([rssPromise, totalPromise, rankPromise]);

  // 총 포스팅 수: RSS는 최근 50개만 제공 → API 추정값 우선, 없으면 RSS 카운트
  const totalPosts = totalResult.estimated > rssResult.rssCount
    ? totalResult.estimated
    : rssResult.rssCount;

  return res.status(200).json({
    blogId,
    stats: {
      total:     totalPosts,
      rssCount:  rssResult.rssCount,
      recent30:  rssResult.recent30,
      lastDate:  rssResult.lastDate,
    },
    ranking: { ranks },
  });
};
