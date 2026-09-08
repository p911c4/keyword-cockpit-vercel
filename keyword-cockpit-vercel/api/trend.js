const https = require('https');

/* ═══════════════════════════════════════════════════════════════
   네이버 검색어 트렌드 — 개발자센터 → NAVER API HUB 이관

   blog.js와 같은 구조다. 구 방식과 신 방식을 한 파일에 두고
   환경변수로 고르며, ?api=legacy|hub 로 요청 단위 강제도 된다.

   요청 바디는 개발자센터와 동일하다 (startDate·endDate·timeUnit·keywordGroups).
   달라지는 것은 도메인·경로·인증 헤더 세 가지뿐이다.

   한도가 크게 바뀐다 — 개발자센터는 일 1,000회였고 HUB는 일 제한 없이
   월 50,000회다. 이 프로젝트에서 실익이 가장 큰 이관이다.

   환경변수
     NAVER_API_HUB=1                기본 경로를 HUB로 (없으면 구 방식)
     NAVER_HUB_CLIENT_ID / _SECRET  HUB Application 자격증명
     NAVER_CLIENT_ID / _SECRET      기존 개발자센터 키 (유예 기간 동안 유지)
   ═══════════════════════════════════════════════════════════════ */

const LEGACY = {
  hostname: 'openapi.naver.com',
  path:     '/v1/datalab/search',
  idHeader: 'X-Naver-Client-Id',
  scHeader: 'X-Naver-Client-Secret',
  idEnv:    'NAVER_CLIENT_ID',
  scEnv:    'NAVER_CLIENT_SECRET',
};
const HUB = {
  hostname: 'naverapihub.apigw.ntruss.com',
  path:     '/search-trend/v1/search',
  idHeader: 'X-NCP-APIGW-API-KEY-ID',
  scHeader: 'X-NCP-APIGW-API-KEY',
  idEnv:    'NAVER_HUB_CLIENT_ID',
  scEnv:    'NAVER_HUB_CLIENT_SECRET',
};

/* HUB는 게이트웨이 오류를 최상위 error 객체로, 조회 오류를 평면형 errorCode로 준다.
   errorCode 하나만 읽으면 401·403·429를 통째로 놓친다. */
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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { keyword } = req.body || {};
  if (!keyword) return res.status(400).json({ error: 'keyword 필드가 없습니다' });

  /* 요청 단위 강제(?api=)가 환경변수보다 우선한다 — 병행 검증용 */
  const forced = req.query && req.query.api;
  const useHub = forced === 'hub'    ? true
               : forced === 'legacy' ? false
               : process.env.NAVER_API_HUB === '1';
  const cfg = useHub ? HUB : LEGACY;
  const id = process.env[cfg.idEnv];
  const secret = process.env[cfg.scEnv];

  if (!id || !secret) {
    return res.status(500).json({
      error:  `인증 정보가 없습니다 (${cfg.idEnv} / ${cfg.scEnv})`,
      source: useHub ? 'hub' : 'legacy',
    });
  }

  /* 최근 12개월 (이번달 제외).
     UTC 변환으로 날짜가 하루 밀리지 않도록 연·월을 직접 조립한다. */
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const start = new Date(end.getFullYear(), end.getMonth() - 11, 1);
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;

  /* device·ages·gender는 선택 항목이다. 구 방식은 빈 문자열을 받아줬지만
     HUB 문서는 pc|mo 만 정의하므로, 값이 없으면 아예 보내지 않는다. */
  const payloadBuf = Buffer.from(JSON.stringify({
    startDate:     fmt(start),
    endDate:       fmt(end),
    timeUnit:      'month',
    keywordGroups: [{ groupName: keyword, keywords: [keyword] }],
  }), 'utf8');

  const options = {
    hostname: cfg.hostname,
    path:     cfg.path,
    method:   'POST',
    headers: {
      'Content-Type':   'application/json; charset=utf-8',
      'Content-Length': payloadBuf.length,
      [cfg.idHeader]:   id,
      [cfg.scHeader]:   secret,
    }
  };

  const apiReq = https.request(options, apiRes => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => {
      if (!data || data.trim() === '') {
        return res.status(502).json({ error: '트렌드 빈 응답', source: useHub ? 'hub' : 'legacy' });
      }
      let json;
      try {
        json = JSON.parse(data);
      } catch (e) {
        return res.status(502).json({ error: '트렌드 응답 파싱 오류', source: useHub ? 'hub' : 'legacy' });
      }

      const e = normalizeError(json, apiRes.statusCode);
      if (e || apiRes.statusCode >= 400) {
        /* 원문은 서버 로그에만 남기고 클라이언트에는 코드만 준다 */
        console.error('[trend]', useHub ? 'hub' : 'legacy', apiRes.statusCode,
                      e && e.code, e && e.message);
        return res.status(apiRes.statusCode >= 400 ? apiRes.statusCode : 502).json({
          error:  `트렌드 조회 실패 (${useHub ? 'HUB' : 'legacy'} ${e ? e.code : apiRes.statusCode})`,
          source: useHub ? 'hub' : 'legacy',
        });
      }

      if (req.query && req.query.diag === '1') {
        const pts = (json.results && json.results[0] && json.results[0].data) || [];
        json._diag = {
          source: useHub ? 'hub' : 'legacy',
          startDate: fmt(start), endDate: fmt(end),
          points: pts.length,
          first: pts[0] || null, last: pts[pts.length - 1] || null,
        };
      }
      return res.status(apiRes.statusCode).json(json);
    });
  });

  apiReq.on('error', err => {
    console.error('[trend] 연결 실패', useHub ? 'hub' : 'legacy', err.message);
    res.status(502).json({ error: '트렌드 연결 실패', source: useHub ? 'hub' : 'legacy' });
  });
  apiReq.write(payloadBuf);
  apiReq.end();
};
