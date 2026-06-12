const https = require('https');

const CLIENT_ID     = process.env.NAVER_CLIENT_ID;
const CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const { query } = req.query;
  if (!query) return res.status(400).json({ error: 'query 파라미터가 없습니다', items: [] });

  // Open API 100개 가져와서 p911c4 필터링
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
    if (err) return res.status(502).json({ error: err.message, items: [] });
    try {
      const json  = JSON.parse(data);
      const all   = json.items || [];
      const mine  = all.filter(item => {
        const link = (item.link || '').toLowerCase();
        const blog = (item.bloggerlink || '').toLowerCase();
        const name = (item.bloggername || '').toLowerCase();
        return link.includes('p911c4') || blog.includes('p911c4') || name === '뉴카';
      }).slice(0, 3);

      const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(req.headers['user-agent'] || '');
      const searchUrl = isMobile
        ? `https://m.blog.naver.com/PostSearchList.naver?blogId=p911c4&orderType=sim&pageAccess=direct&periodType=all&searchText=${encodeURIComponent(query)}`
        : `https://blog.naver.com/PostSearchList.naver?blogId=p911c4&searchText=${encodeURIComponent(query)}`;

      return res.status(200).json({ items: mine, searchUrl });
    } catch(e) {
      return res.status(200).json({ items: [], searchUrl: '' });
    }
  });
};
