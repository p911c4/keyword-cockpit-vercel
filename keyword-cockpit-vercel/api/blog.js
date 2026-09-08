const https = require('https');

/* ═══════════════════════════════════════════════════════════════
   네이버 블로그 검색 — 개발자센터 → NAVER API HUB 이관

   구 방식과 신 방식을 한 파일에 두고 환경변수로 고른다.
   이관 가이드가 요구하는 "같은 질의를 양쪽으로 호출해 비교"를 하려면
   한쪽을 지워서는 안 된다. ?api=legacy|hub 로 요청 단위 강제도 가능하다.

   전환 절차
     ① HUB 키를 환경변수에 넣고 ?api=hub 로 응답을 대조
     ② 이상 없으면 NAVER_API_HUB=1 로 기본값 전환
     ③ 2027-06-30 이후 구 방식 코드 제거

   환경변수
     NAVER_API_HUB=1                기본 경로를 HUB로 (없으면 구 방식)
     NAVER_HUB_CLIENT_ID            HUB Application의 Client ID
     NAVER_HUB_CLIENT_SECRET        HUB Application의 Client Secret
     NAVER_CLIENT_ID / _SECRET      기존 개발자센터 키 (유예 기간 동안 유지)
   ═══════════════════════════════════════════════════════════════ */

const LEGACY = {
  hostname: 'openapi.naver.com',
  idHeader: 'X-Naver-Client-Id',
  scHeader: 'X-Naver-Client-Secret',
  idEnv:    'NAVER_CLIENT_ID',
  scEnv:    'NAVER_CLIENT_SECRET',
};
const HUB = {
  hostname: 'naverapihub.apigw.ntruss.com',
  idHeader: 'X-NCP-APIGW-API-KEY-ID',
  scHeader: 'X-NCP-APIGW-API-KEY',
  idEnv:    'NAVER_HUB_CLIENT_ID',
  scEnv:    'NAVER_HUB_CLIENT_SECRET',
};

function httpsGet(options, redirectCount, callback) {
  if (redirectCount > 5) return callback(new Error('Too many redirects'));
  const req = https.request(options, res => {
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      res.resume();
      const newUrl  = new URL(res.headers.location, `https://${options.hostname}`);
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

/* HUB는 게이트웨이 오류를 최상위 error 객체로, 검색 오류를 평면형 errorCode로 준다.
   기존 코드처럼 errorCode 하나만 읽으면 401·403·429를 통째로 놓친다. */
function normalizeError(json, statusCode) {
  if (json && json.error && typeof json.error === 'object') {
    return { code: json.error.errorCode || String(statusCode), message: json.error.message || '' };
  }
  if (json && json.errorCode) {
    return { code: json.errorCode, message: json.errorMessage || '' };
  }
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const { query, display = '10' } = req.query;
  if (!query) return res.status(400).json({ error: 'query 파라미터가 없습니다' });

  /* sort 통과 — 화면은 계속 sim(정확도). date와 비교하면
     "색인에서 빠진 것"과 "정확도 정렬에서 밀린 것"을 구분할 수 있다. */
  const sort  = ['sim', 'date'].includes(req.query.sort) ? req.query.sort : 'sim';
  const start = /^\d+$/.test(req.query.start || '') ? req.query.start : '1';

  /* 요청 단위 강제(?api=)가 환경변수보다 우선한다 — 병행 검증용 */
  const forced = req.query.api;
  const useHub = forced === 'hub'    ? true
               : forced === 'legacy' ? false
               : process.env.NAVER_API_HUB === '1';
  const cfg = useHub ? HUB : LEGACY;
  const id = process.env[cfg.idEnv];
  const secret = process.env[cfg.scEnv];

  if (!id || !secret) {
    return res.status(500).json({
      error: `인증 정보가 없습니다 (${cfg.idEnv} / ${cfg.scEnv})`,
      source: useHub ? 'hub' : 'legacy',
    });
  }

  const q = encodeURIComponent(query);
  const path = useHub
    /* HUB는 확장자가 사라지고 format 파라미터로 응답 형식을 고른다 */
    ? `/search/v1/blog?query=${q}&display=${display}&start=${start}&sort=${sort}&format=json`
    : `/v1/search/blog.json?query=${q}&display=${display}&start=${start}&sort=${sort}`;

  const options = {
    hostname: cfg.hostname,
    path,
    method:  'GET',
    headers: { [cfg.idHeader]: id, [cfg.scHeader]: secret },
  };

  httpsGet(options, 0, (err, statusCode, data) => {
    if (err) return res.status(502).json({ error: '블로그 API 연결 실패: ' + err.message });

    let json;
    try {
      json = JSON.parse(data);
    } catch (e) {
      return res.status(502).json({ error: '응답 파싱 오류' });
    }

    const e = normalizeError(json, statusCode);
    if (e || statusCode >= 400) {
      /* 원문은 서버 로그에만 남기고 클라이언트에는 코드만 준다 */
      console.error('[blog]', useHub ? 'hub' : 'legacy', statusCode, e && e.code, e && e.message);
      return res.status(statusCode >= 400 ? statusCode : 502).json({
        error:  `블로그 검색 실패 (${useHub ? 'HUB' : 'legacy'} ${e ? e.code : statusCode})`,
        source: useHub ? 'hub' : 'legacy',
      });
    }

    /* 진단 — 결과의 호스트 분포를 함께 돌려준다.
       네이버 블로그가 정말 0건인지 한눈에 확인할 수 있다. */
    if (req.query.diag === '1' && Array.isArray(json.items)) {
      const hosts = {};
      json.items.forEach(it => {
        let h = '(없음)';
        try { h = new URL(it.link).hostname.replace(/^(www|m)\./, ''); } catch (x) {}
        hosts[h] = (hosts[h] || 0) + 1;
      });
      json._diag = {
        source: useHub ? 'hub' : 'legacy',
        sort, start,
        total:   json.total,
        counted: json.items.length,
        hosts,
        sample:  json.items.slice(0, 3).map(it => ({ link: it.link, bloggerlink: it.bloggerlink })),
      };
    }
    return res.status(statusCode).json(json);
  });
};
