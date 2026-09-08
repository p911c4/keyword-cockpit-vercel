const https = require('https');

/* ═══════════════════════════════════════════════════════════════
   블로그 활동 지표 — 개발자센터 → NAVER API HUB 이관

   blog.js·trend.js와 같은 구조다. 구 방식과 신 방식을 한 파일에 두고
   환경변수로 고르며, ?api=legacy|hub 로 요청 단위 강제도 된다.

   이 파일에서 네이버 검색 API를 쓰는 곳은 두 군데였다.
     estimateTotalPosts()  총 포스팅 수 추정 — 계속 사용
     findMyRank()          키워드 노출 순위 — 2026-08-28 중단

   활동 지수와 최근 30일 발행 수는 RSS에서 직접 읽으므로 이관과 무관하다.

   환경변수
     NAVER_API_HUB=1                기본 경로를 HUB로 (없으면 구 방식)
     NAVER_HUB_CLIENT_ID / _SECRET  HUB Application 자격증명
     NAVER_CLIENT_ID / _SECRET      기존 개발자센터 키 (유예 기간 동안 유지)
   ═══════════════════════════════════════════════════════════════ */

const LEGACY = {
  hostname: 'openapi.naver.com',
  blogPath: q => `/v1/search/blog.json?${q}`,
  idHeader: 'X-Naver-Client-Id',
  scHeader: 'X-Naver-Client-Secret',
  idEnv:    'NAVER_CLIENT_ID',
  scEnv:    'NAVER_CLIENT_SECRET',
};
const HUB = {
  hostname: 'naverapihub.apigw.ntruss.com',
  blogPath: q => `/search/v1/blog?${q}&format=json`,
  idHeader: 'X-NCP-APIGW-API-KEY-ID',
  scHeader: 'X-NCP-APIGW-API-KEY',
  idEnv:    'NAVER_HUB_CLIENT_ID',
  scEnv:    'NAVER_HUB_CLIENT_SECRET',
};

/* 요청 단위 강제(?api=)가 환경변수보다 우선한다 — 병행 검증용 */
function pickApi(forced) {
  const useHub = forced === 'hub'    ? true
               : forced === 'legacy' ? false
               : process.env.NAVER_API_HUB === '1';
  return { useHub, cfg: useHub ? HUB : LEGACY };
}
function blogOptions(cfg, query) {
  return {
    hostname: cfg.hostname,
    path:     cfg.blogPath(query),
    method:   'GET',
    headers: {
      [cfg.idHeader]: process.env[cfg.idEnv],
      [cfg.scHeader]: process.env[cfg.scEnv],
    }
  };
}

function httpsGet(urlOrOpts, redirectCount, callback) {
  if (redirectCount > 5) return callback(new Error('Too many redirects'));
  let options;
  if (typeof urlOrOpts === 'string') {
    const p = new URL(urlOrOpts);
    options = { hostname: p.hostname, path: p.pathname + p.search, method: 'GET',
                headers: { 'User-Agent': 'Mozilla/5.0' } };
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

// RSS 파싱 — pubDate 포함
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

// blogId로 실제 포스팅 수 추정 — display=100으로 blogId 필터 후 비율로 추정
function estimateTotalPosts(blogId, cfg, callback) {
  const query = `query=${encodeURIComponent(blogId)}&display=100&sort=date`;
  httpsGet(blogOptions(cfg, query), 0, (err, statusCode, data) => {
    if (err) return callback(0, 0);
    try {
      const json  = JSON.parse(data);
      const total = json.total || 0;
      const items = json.items || [];
      const myCount = items.filter(item => {
        const l = (item.link        || '').toLowerCase();
        const n = (item.bloggername || '').toLowerCase();
        const b = (item.bloggerlink || '').toLowerCase();
        return l.includes(blogId.toLowerCase())
            || n.includes(blogId.toLowerCase())
            || b.includes(blogId.toLowerCase());
      }).length;
      // 100개 샘플 중 내 포스팅 비율로 전체 추정
      const ratio     = items.length > 0 ? myCount / items.length : 0;
      const estimated = Math.round(total * ratio);
      callback(estimated, myCount);
    } catch(e) { callback(0, 0); }
  });
}

// 키워드 순위 조회
function findMyRank(keyword, blogId, cfg, callback) {
  /* ── 2026-08-28 임시 중단 ──
     아래 조회는 sort=sim을 쓰는데, 이 정렬이 네이버 블로그를 사실상 반환하지
     않는 현상이 확인됐다. 실제 네이버 검색에서 상위에 있는 글이 API 결과
     100건 안에 아예 나타나지 않는 사례를 성격이 다른 여러 키워드에서 확인했다.
     틀린 순위를 보여주는 것이 순위를 보여주지 않는 것보다 나쁘므로 쉰다.
     정상화되면 이 return 한 줄만 지우면 원래대로 동작한다. */
  return callback(null, [], true);

  // eslint-disable-next-line no-unreachable
  const query = `query=${encodeURIComponent(keyword)}&display=100&sort=sim`;
  httpsGet(blogOptions(cfg, query), 0, (err, statusCode, data) => {
    if (err) return callback(err, []);
    try {
      const json  = JSON.parse(data);
      const items = json.items || [];
      const found = [];
      items.forEach((item, idx) => {
        const l = (item.link        || '').toLowerCase();
        const n = (item.bloggername || '').toLowerCase();
        const b = (item.bloggerlink || '').toLowerCase();
        if (l.includes(blogId.toLowerCase())
         || n.includes(blogId.toLowerCase())
         || b.includes(blogId.toLowerCase())) {
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
  /* 기본값 하드코딩 없음 — 설정하지 않았으면 조회하지 않는다 */
  const blogId = (qBlogId || '').trim().toLowerCase();
  if (!blogId) return res.status(400).json({ error: 'blogId 파라미터가 없습니다' });

  const { useHub, cfg } = pickApi(req.query.api);
  if (!process.env[cfg.idEnv] || !process.env[cfg.scEnv]) {
    return res.status(500).json({
      error:  `인증 정보가 없습니다 (${cfg.idEnv} / ${cfg.scEnv})`,
      source: useHub ? 'hub' : 'legacy',
    });
  }

  const RSS_URL = `https://rss.blog.naver.com/${blogId}.xml`;

  // RSS + 추정 포스팅 수 병렬 실행
  const rssPromise = new Promise(resolve => {
    httpsGet(RSS_URL, 0, (err, statusCode, data) => {
      if (err) return resolve({ rssItems: [], rssCount: 0, recent30: 0, lastDate: null });
      try {
        const items    = parseRSS(data);
        const now      = new Date();
        const d30ago   = new Date(now - 30 * 24 * 60 * 60 * 1000);
        const recent30 = items.filter(i => new Date(i.pubDate) >= d30ago).length;
        const lastDate = items[0]?.pubDate || null;
        resolve({ rssItems: items, rssCount: items.length, recent30, lastDate });
      } catch(e) { resolve({ rssItems: [], rssCount: 0, recent30: 0, lastDate: null }); }
    });
  });

  const totalPromise = new Promise(resolve => {
    estimateTotalPosts(blogId, cfg, (estimated, sample) => resolve({ estimated, sample }));
  });

  const rankPromise = keyword
    ? new Promise(resolve => {
        findMyRank(keyword, blogId, cfg, (err, found, suspended) =>
          resolve({ ranks: err ? [] : found, suspended: !!suspended }));
      })
    : Promise.resolve({ ranks: [], suspended: false });

  const [rssResult, totalResult, rank] =
    await Promise.all([rssPromise, totalPromise, rankPromise]);

  // 총 포스팅 수: RSS는 최근 분량만 제공 → API 추정값 우선, 없으면 RSS 카운트
  const totalPosts = totalResult.estimated > rssResult.rssCount
    ? totalResult.estimated
    : rssResult.rssCount;

  const out = {
    blogId,
    stats: {
      total:     totalPosts,
      rssCount:  rssResult.rssCount,
      recent30:  rssResult.recent30,
      lastDate:  rssResult.lastDate,
    },
    /* suspended=true면 "노출 없음"이 아니라 "조회하지 않음"이다.
       프런트가 이 둘을 구분하지 못하면 사용자에게 거짓을 말하게 된다. */
    ranking: { ranks: rank.ranks, suspended: rank.suspended },
  };
  if (req.query.diag === '1') {
    out._diag = {
      source:    useHub ? 'hub' : 'legacy',
      host:      cfg.hostname,
      estimated: totalResult.estimated,
      sample:    totalResult.sample,
      rssCount:  rssResult.rssCount,
    };
  }
  return res.status(200).json(out);
};
