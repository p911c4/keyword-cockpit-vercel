/* ═══════════════════════════════════════════════════════════════
   KEYWORD COCKPIT v2.0 — 구글 키워드 지표 API

   Google Ads API / KeywordPlanIdeaService.GenerateKeywordIdeas
   Basic Access 신청 시 제출한 설계 문서와 동일한 스펙으로 구현.

   ───────────────────────────────────────────────────────────────
   Vercel 환경변수
     GOOGLE_ADS_ENABLED=1                  ← 승인 후 1로 변경
     GOOGLE_ADS_DEVELOPER_TOKEN=...
     GOOGLE_ADS_CLIENT_ID=...
     GOOGLE_ADS_CLIENT_SECRET=...
     GOOGLE_ADS_REFRESH_TOKEN=...
     GOOGLE_ADS_CUSTOMER_ID=7346834600     ← 하위 계정, 하이픈 제거
     GOOGLE_ADS_LOGIN_CUSTOMER_ID=5391926993  ← MCC, 하이픈 제거
     GOOGLE_ADS_API_VERSION=v25            ← 선택, 기본 v25
     GOOGLE_ADS_DAILY_CAP=3000             ← 선택, 기본 3000
     SUPABASE_URL / SUPABASE_ANON_KEY(Secret 키 값)

   ⚠ 승인 후 최초 호출은 반드시 실데이터로 검증할 것.

   ───────────────────────────────────────────────────────────────
   엔드포인트
     GET  ?ping=1
       → { enabled, configured }

     POST { keyword: "키워드" }            (구 형식 { keywords:[...] }도 허용)
       → {
           enabled : true,
           cached  : bool,
           seed    : Metric,
           ideas   : Metric[],          // 연관 키워드 (최대 IDEA_LIMIT)
           source  : "Google Ads API (Keyword Planner)"
         }

     Metric = {
       kw            : string,
       volume : {
         raw   : number|null,           // API 원값 (버킷 스냅됨)
         min   : number|null,           // 표시용 구간 하한
         max   : number|null,           // 표시용 구간 상한
         label : string                 // "1천 ~ 1만"
       },
       competition      : "LOW"|"MEDIUM"|"HIGH"|"UNSPECIFIED",
       competitionIndex : number|null,  // 0~100
       cpc : { low: number|null, high: number|null, currency: "KRW" },
       monthly : [{ year, month, searches }]   // seed에만 채워짐
     }

   ───────────────────────────────────────────────────────────────
   설계 원칙 (변경 시 설계 문서와의 정합성 확인 필요)
     · read-only. mutate 계열 호출 없음
     · 캐시 우선. 미스일 때만 API 호출
     · 일일 상한 초과 시 API를 호출하지 않고 graceful degrade
     · 대량 조회 불가 — 요청당 시드 1개
═══════════════════════════════════════════════════════════════ */

const https = require('https');

/* ── 설정 ────────────────────────────────────────────────── */
const API_VERSION = process.env.GOOGLE_ADS_API_VERSION || 'v25';
const DAILY_CAP   = parseInt(process.env.GOOGLE_ADS_DAILY_CAP || '3000', 10);
const IDEA_LIMIT  = 20;      // 프론트에 내려줄 연관 키워드 수
const CACHE_DAYS  = 7;       // 설계 문서 기준 TTL
const GEO         = '2410';  // 대한민국
const LANG        = '1012';  // 한국어
const KW_MAX_LEN  = 80;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;   // 실제 값은 Secret 키

const CONFIGURED =
     !!process.env.GOOGLE_ADS_DEVELOPER_TOKEN
  && !!process.env.GOOGLE_ADS_REFRESH_TOKEN
  && !!process.env.GOOGLE_ADS_CLIENT_ID
  && !!process.env.GOOGLE_ADS_CLIENT_SECRET
  && !!process.env.GOOGLE_ADS_CUSTOMER_ID
  && !!process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;

const ENABLED = process.env.GOOGLE_ADS_ENABLED === '1' && CONFIGURED;

/* 허용 오리진 — 우리 도구 외부에서 이 API를 데이터 소스로 쓰지 못하게 막음.
   설계 문서의 "재배포·재판매 없음" 선언과 직결되는 부분이라 완화 금지. */
const ALLOWED_ORIGINS = [
  'https://tool.keywordcockpit.com',
  'https://keywordcockpit.com',
  'https://www.keywordcockpit.com',
];

/* ── 공통 HTTPS ──────────────────────────────────────────── */
function httpsJSON(options, body, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : {}; } catch { json = null; }
        resolve({ status: res.statusCode, json, raw: data });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('ETIMEDOUT')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function sbHeaders(extra) {
  return Object.assign({
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
  }, extra || {});
}

/* ── 액세스 토큰 (인스턴스 메모리 캐시) ──────────────────────
   Vercel 인스턴스가 살아있는 동안 재사용. 토큰 수명 1시간 중 55분만 사용. */
let _token = null;          // { value, exp }

async function getAccessToken() {
  if (_token && Date.now() < _token.exp) return _token.value;

  const body = new URLSearchParams({
    client_id:     process.env.GOOGLE_ADS_CLIENT_ID,
    client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
    refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
    grant_type:    'refresh_token',
  }).toString();

  const { status, json } = await httpsJSON({
    hostname: 'oauth2.googleapis.com',
    path: '/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);

  if (status !== 200 || !json || !json.access_token) {
    /* invalid_grant = 리프레시 토큰 폐기됨.
       (권한 삭제 / 비밀번호 변경 / 동의화면이 Testing으로 되돌아간 경우)
       → gads-setup.js 재실행 후 환경변수 교체 필요 */
    const e = new Error('OAUTH_FAILED');
    e.detail = (json && json.error) || `status ${status}`;
    throw e;
  }

  _token = { value: json.access_token, exp: Date.now() + 55 * 60 * 1000 };
  return _token.value;
}

/* ── 쿼터 카운터 ─────────────────────────────────────────── */
async function bumpOps(n) {
  if (!SUPABASE_URL) return 0;
  try {
    const u = new URL(SUPABASE_URL);
    const body = JSON.stringify({ p_n: n });
    const { json } = await httpsJSON({
      hostname: u.hostname,
      path: '/rest/v1/rpc/bump_google_ops',
      method: 'POST',
      headers: sbHeaders({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      }),
    }, body);
    return typeof json === 'number' ? json : 0;
  } catch { return 0; }
}

async function peekOps() {
  if (!SUPABASE_URL) return 0;
  try {
    const u = new URL(SUPABASE_URL);
    const { json } = await httpsJSON({
      hostname: u.hostname,
      path: '/rest/v1/rpc/peek_google_ops',
      method: 'POST',
      headers: sbHeaders({ 'Content-Type': 'application/json', 'Content-Length': 2 }),
    }, '{}');
    return typeof json === 'number' ? json : 0;
  } catch { return 0; }
}

/* ── 캐시 ────────────────────────────────────────────────── */
async function cacheGet(keyword) {
  if (!SUPABASE_URL) return null;
  try {
    const u = new URL(SUPABASE_URL);
    /* PostgREST 값은 URL 인코딩. eq. 필터라 in.() 파싱 문제를 겪지 않음. */
    const path = '/rest/v1/google_kw_cache'
      + `?keyword=eq.${encodeURIComponent(keyword)}`
      + `&geo=eq.${GEO}&lang=eq.${LANG}`
      + '&select=payload,fetched_at&limit=1';

    const { json } = await httpsJSON({
      hostname: u.hostname, path, method: 'GET', headers: sbHeaders(),
    });
    if (!Array.isArray(json) || !json.length) return null;

    const row = json[0];
    const age = Date.now() - new Date(row.fetched_at).getTime();
    if (age > CACHE_DAYS * 86400 * 1000) return null;   // 만료
    return row.payload;
  } catch { return null; }
}

async function cacheSet(keyword, payload) {
  if (!SUPABASE_URL) return;
  try {
    const u = new URL(SUPABASE_URL);
    const body = JSON.stringify([{
      keyword, geo: GEO, lang: LANG,
      payload, fetched_at: new Date().toISOString(),
    }]);
    await httpsJSON({
      hostname: u.hostname,
      path: '/rest/v1/google_kw_cache',
      method: 'POST',
      headers: sbHeaders({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Prefer: 'resolution=merge-duplicates,return=minimal',
      }),
    }, body);
  } catch { /* 캐시 실패는 조회 자체를 막지 않음 */ }
}

/* ── 값 정규화 ───────────────────────────────────────────── */

/* avgMonthlySearches는 광고 집행 이력이 없는 계정에서 넓은 버킷으로 스냅되어
   돌아옵니다. 정확한 수치인 척 표시하지 않도록 구간으로 변환합니다.
   (설계 문서 4장 "Search volume is shown as a range" 항목) */
function toVolume(raw) {
  const n = raw == null ? null : parseInt(raw, 10);
  if (n == null || Number.isNaN(n)) {
    return { raw: null, min: null, max: null, label: '데이터 없음' };
  }
  if (n === 0)  return { raw: 0, min: 0, max: 0, label: '0' };
  if (n < 10)   return { raw: n, min: 0, max: 10, label: '10 미만' };

  const mag = Math.pow(10, Math.floor(Math.log10(n)));
  const min = mag;
  const max = mag * 10;
  return { raw: n, min, max, label: `${fmtKo(min)} ~ ${fmtKo(max)}` };
}

function fmtKo(n) {
  if (n >= 100000000) return `${n / 100000000}억`;
  if (n >= 10000)     return `${n / 10000}만`;
  if (n >= 1000)      return `${n / 1000}천`;
  return String(n);
}

/* micros → 원 단위. 계정 통화가 KRW이므로 1,000,000 micros = 1원 */
function toWon(micros) {
  if (micros == null) return null;
  const v = Number(micros) / 1e6;
  return Number.isFinite(v) ? Math.round(v) : null;
}

function toMetric(row, withMonthly) {
  const m = row.keywordIdeaMetrics || {};
  const out = {
    kw: row.text,
    volume: toVolume(m.avgMonthlySearches),
    competition: m.competition || 'UNSPECIFIED',
    competitionIndex: m.competitionIndex != null
      ? parseInt(m.competitionIndex, 10) : null,
    cpc: {
      low:  toWon(m.lowTopOfPageBidMicros),
      high: toWon(m.highTopOfPageBidMicros),
      currency: 'KRW',
    },
    monthly: [],
  };
  if (withMonthly && Array.isArray(m.monthlySearchVolumes)) {
    out.monthly = m.monthlySearchVolumes.map(v => ({
      year: parseInt(v.year, 10),
      month: v.month,                        // "JANUARY" 등 enum
      searches: v.monthlySearches != null
        ? parseInt(v.monthlySearches, 10) : null,
    }));
  }
  return out;
}

/* ── Google Ads API 호출 ─────────────────────────────────── */
async function fetchIdeas(keyword) {
  const token = await getAccessToken();
  const cid   = process.env.GOOGLE_ADS_CUSTOMER_ID;

  const body = JSON.stringify({
    language: `languageConstants/${LANG}`,
    geoTargetConstants: [`geoTargetConstants/${GEO}`],
    keywordPlanNetwork: 'GOOGLE_SEARCH',
    includeAdultKeywords: false,
    keywordSeed: { keywords: [keyword] },
  });

  const { status, json, raw } = await httpsJSON({
    hostname: 'googleads.googleapis.com',
    path: `/${API_VERSION}/customers/${cid}:generateKeywordIdeas`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
      /* MCC 하위 계정을 조회하므로 필수. 빠지면 권한 오류. */
      'login-customer-id': process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);

  if (status !== 200) {
    const e = new Error('ADS_API_ERROR');
    e.status = status;
    e.detail = extractAdsError(json) || String(raw || '').slice(0, 300);
    throw e;
  }

  const rows = Array.isArray(json.results) ? json.results : [];
  /* 시드와 정확히 일치하는 행이 시드 지표. 없으면 첫 행을 시드로 사용. */
  const norm = s => String(s || '').trim().toLowerCase();
  const seedRow = rows.find(r => norm(r.text) === norm(keyword)) || rows[0] || null;

  const seed  = seedRow ? toMetric(seedRow, true) : null;
  const ideas = rows
    .filter(r => r !== seedRow)
    .slice(0, IDEA_LIMIT)
    .map(r => toMetric(r, false));

  return { seed, ideas };
}

function extractAdsError(json) {
  try {
    const arr = Array.isArray(json) ? json : [json];
    const err = arr[0] && arr[0].error;
    if (!err) return null;
    const d = (err.details && err.details[0] && err.details[0].errors) || [];
    if (d.length) {
      const code = d[0].errorCode ? JSON.stringify(d[0].errorCode) : '';
      return `${code} ${d[0].message || ''}`.trim();
    }
    return err.message || null;
  } catch { return null; }
}

/* 내부 오류를 사용자에게 그대로 노출하지 않고 코드로 치환 */
function publicError(e) {
  const s = `${e.message || ''} ${e.detail || ''}`;
  if (s.includes('DEVELOPER_TOKEN_NOT_APPROVED'))
    return { code: 'NOT_APPROVED', msg: '구글 데이터 승인 대기 중입니다.' };
  if (s.includes('CUSTOMER_NOT_ENABLED'))
    return { code: 'ACCOUNT_SETUP',  msg: '구글 광고 계정 설정이 필요합니다.' };
  if (e.message === 'OAUTH_FAILED')
    return { code: 'AUTH',           msg: '구글 인증을 갱신해야 합니다.' };
  if (s.includes('RESOURCE_EXHAUSTED') || e.status === 429)
    return { code: 'RATE_LIMIT',     msg: '요청이 많습니다. 잠시 후 다시 시도해 주세요.' };
  return { code: 'UNAVAILABLE', msg: '구글 데이터를 가져오지 못했습니다.' };
}

/* ── 핸들러 ──────────────────────────────────────────────── */
module.exports = async (req, res) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  /* 플래그 확인용 핑 — 프론트가 페이지 로드 시 1회 호출 */
  if (req.method === 'GET') {
    return res.status(200).json({ enabled: ENABLED, configured: CONFIGURED });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ enabled: ENABLED, error: 'METHOD_NOT_ALLOWED' });
  }
  if (!ENABLED) {
    return res.status(200).json({ enabled: false, seed: null, ideas: [] });
  }

  try {
    /* 입력 검증 — 잘못된 입력이 오퍼레이션을 소비하지 않도록 API 호출 전에 처리 */
    const b = req.body || {};
    let keyword = b.keyword;
    if (!keyword && Array.isArray(b.keywords)) keyword = b.keywords[0];  // 구 형식 호환
    keyword = String(keyword || '').replace(/\s+/g, ' ').trim();

    if (!keyword) {
      return res.status(400).json({ enabled: true, error: 'BAD_REQUEST',
        message: '키워드를 입력해 주세요.' });
    }
    if (keyword.length > KW_MAX_LEN) {
      return res.status(400).json({ enabled: true, error: 'BAD_REQUEST',
        message: `키워드는 ${KW_MAX_LEN}자 이하로 입력해 주세요.` });
    }

    const cacheKey = keyword.toLowerCase();

    /* 1) 캐시 우선 */
    const hit = await cacheGet(cacheKey);
    if (hit) {
      return res.status(200).json({
        enabled: true, cached: true,
        seed: hit.seed, ideas: hit.ideas,
        source: 'Google Ads API (Keyword Planner)',
      });
    }

    /* 2) 일일 상한 확인 — 초과 시 API를 호출하지 않고 정상 응답으로 축소 */
    const used = await peekOps();
    if (used >= DAILY_CAP) {
      return res.status(200).json({
        enabled: true, cached: false, seed: null, ideas: [],
        error: 'DAILY_CAP',
        message: '오늘 구글 데이터 조회 한도에 도달했습니다. 네이버 데이터는 정상 제공됩니다.',
      });
    }

    /* 3) API 호출 */
    const { seed, ideas } = await fetchIdeas(keyword);
    await bumpOps(1);

    if (seed) await cacheSet(cacheKey, { seed, ideas });

    return res.status(200).json({
      enabled: true, cached: false, seed, ideas,
      source: 'Google Ads API (Keyword Planner)',
    });

  } catch (e) {
    /* 서버 로그에는 원인을 남기고, 응답에는 코드만 내보냅니다 */
    console.error('[google-keyword]', e.message, e.detail || '', e.status || '');
    const pe = publicError(e);
    return res.status(200).json({
      enabled: true, cached: false, seed: null, ideas: [],
      error: pe.code, message: pe.msg,
    });
  }
};
