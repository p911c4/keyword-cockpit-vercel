const https = require('https');

const CLIENT_ID     = process.env.NAVER_CLIENT_ID;
const CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;
const BLOG_ID       = 'p911c4'; // 뉴카 블로그 ID

function httpsGet(options, redirectCount, callback) {
  if (redirectCount > 5) return callback(new Error('Too many redirects'));
  const req = https.request(options, res => {
    if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
      res.resume();
      const loc    = res.headers.location;
      const newUrl = new URL(loc, `https://${options.hostname}`);
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const { query } = req.query;
  if (!query) return res.status(400).json({ error: 'query 파라미터가 없습니다' });

  // display=100으로 최대한 많이 가져온 뒤 뉴카 블로그만 필터
  const apiPath = `/v1/search/blog.json?query=${encodeURIComponent(query)}&display=100&sort=sim`;

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
    if (err) return res.status(502).json({ error: '블로그 API 연결 실패: ' + err.message });

    try {
      const json = JSON.parse(data);
      if (statusCode !== 200) {
        return res.status(statusCode).json({ error: json.errorMessage || '네이버 API 오류', items: [] });
      }

      const allItems = json.items || [];

      // 링크 또는 bloggername 으로 뉴카 포스팅 필터링
      const myItems = allItems.filter(item => {
        const linkMatch     = item.link        && item.link.toLowerCase().includes(BLOG_ID.toLowerCase());
        const bloggerMatch  = item.bloggername && item.bloggername.toLowerCase().includes(BLOG_ID.toLowerCase());
        const blogUrlMatch  = item.bloggerlink && item.bloggerlink.toLowerCase().includes(BLOG_ID.toLowerCase());
        return linkMatch || bloggerMatch || blogUrlMatch;
      });

      return res.status(200).json({ items: myItems, total: myItems.length });

    } catch(e) {
      return res.status(502).json({ error: '응답 파싱 오류', items: [] });
    }
  });
};
