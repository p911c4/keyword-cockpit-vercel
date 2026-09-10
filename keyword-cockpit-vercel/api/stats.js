const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

// UTC ISO 문자열 → KST 기준 YYYY-MM-DD
function toKSTDateString(isoString) {
  const utcDate = new Date(isoString);
  const kstDate = new Date(utcDate.getTime() + KST_OFFSET_MS);
  return kstDate.toISOString().slice(0, 10);
}

// "KST 기준 오늘 00:00"을 UTC ISO 문자열로 변환
function kstTodayStartUTC() {
  const now = new Date();
  const kstNow = new Date(now.getTime() + KST_OFFSET_MS);
  const y = kstNow.getUTCFullYear();
  const m = kstNow.getUTCMonth();
  const d = kstNow.getUTCDate();
  // KST 00:00 = UTC 전날 15:00 이므로, UTC 기준 날짜로 만든 뒤 9시간을 다시 빼준다
  return new Date(Date.UTC(y, m, d) - KST_OFFSET_MS).toISOString();
}

// "KST 기준 N일 전 00:00"을 UTC ISO 문자열로 변환
function kstDaysAgoStartUTC(daysAgo) {
  const now = new Date();
  const kstNow = new Date(now.getTime() + KST_OFFSET_MS);
  const y = kstNow.getUTCFullYear();
  const m = kstNow.getUTCMonth();
  const d = kstNow.getUTCDate() - daysAgo;
  return new Date(Date.UTC(y, m, d) - KST_OFFSET_MS).toISOString();
}

async function supabaseQuery(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`
    }
  });
  return res.json();
}

// 정확한 행 개수 조회 전용 — PostgREST의 count=exact 방식.
// select=count 만으로는 응답 페이지네이션(기본 최대 1000행) 안에서 집계될 수 있어
// 실제 총량과 어긋날 수 있으므로, HEAD 요청 + Content-Range 헤더로 정확한 카운트를 받는다.
async function supabaseCount(pathWithoutSelect) {
  const url = `${SUPABASE_URL}/rest/v1/${pathWithoutSelect}`;
  const res = await fetch(url, {
    method: 'HEAD',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer': 'count=exact',
    }
  });
  // Content-Range: 0-24/1276  ← 마지막 숫자가 전체 개수
  const range = res.headers.get('content-range');
  if (!range) return 0;
  const total = range.split('/')[1];
  return total === '*' ? 0 : parseInt(total, 10) || 0;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();

  // 비밀번호 인증
  const auth = req.headers['authorization'] || '';
  const token = auth.replace('Bearer ', '');
  if (token !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: '인증 실패' });
  }

  try {
    // 오늘 날짜 범위 (KST 기준 00:00)
    const todayStart = kstTodayStartUTC();
    // 7일 전 (KST 기준 00:00, 오늘 포함 7일 구간)
    const week = kstDaysAgoStartUTC(6);
    // 30일 전 (KST 기준 00:00, 오늘 포함 30일 구간)
    const month = kstDaysAgoStartUTC(29);

    // 전체 페이지뷰
    const [pvTotal, pvToday, pvWeek, pvMonth] = await Promise.all([
      supabaseCount('page_views?select=created_at'),
      supabaseCount(`page_views?select=created_at&created_at=gte.${todayStart}`),
      supabaseCount(`page_views?select=created_at&created_at=gte.${week}`),
      supabaseCount(`page_views?select=created_at&created_at=gte.${month}`),
    ]);

    // 키워드 검색 횟수 (오늘/7일/30일/누적) — page_views와 동일한 방식으로 search_logs 집계
    /* event is null 인 행만 검색이다. 소스 전환(event='switch')이 같은
       테이블에 들어오므로, 이 조건을 빼면 검색 수가 부풀려진다. */
    const SEARCH_ONLY = 'event=is.null';
    const [kwTotal, kwToday, kwWeek, kwMonth] = await Promise.all([
      supabaseCount(`search_logs?select=created_at&${SEARCH_ONLY}`),
      supabaseCount(`search_logs?select=created_at&${SEARCH_ONLY}&created_at=gte.${todayStart}`),
      supabaseCount(`search_logs?select=created_at&${SEARCH_ONLY}&created_at=gte.${week}`),
      supabaseCount(`search_logs?select=created_at&${SEARCH_ONLY}&created_at=gte.${month}`),
    ]);

    // 인기 키워드 TOP 20 (전체) — limit을 넉넉히 잡아 누적 검색량이 많아도 전체 기간을 반영
    const kwAll = await supabaseQuery(
      `search_logs?select=keyword,source&${SEARCH_ONLY}&order=created_at.desc&limit=20000`
    );

    // 키워드 집계
    const kwCount = {};
    (kwAll || []).forEach(r => {
      const e = kwCount[r.keyword] || (kwCount[r.keyword] =
        { count: 0, naver: 0, google: 0, both: 0, unknown: 0 });
      e.count++;
      e[r.source || 'unknown']++;
    });
    const topKeywords = Object.entries(kwCount)
      .sort((a,b) => b[1].count - a[1].count)
      .slice(0, 20)
      .map(([keyword, v]) => ({ keyword, ...v }));

    /* ── 소스별 집계 ──
       2026-09 이전 기록에는 source가 없다. null은 unknown으로 묶어
       "기록 전"으로 표시한다 — 0으로 처리하면 과거가 사라진 것처럼 보인다. */
    const srcCount = (rows) => {
      const o = { naver: 0, google: 0, both: 0, unknown: 0 };
      (rows || []).forEach(r => { o[r.source || 'unknown']++; });
      return o;
    };
    const sourceTotals = srcCount(kwAll);

    // 최근 30일 일별 페이지뷰 (KST 기준 날짜로 집계)
    // limit을 넉넉히 명시 — Supabase REST 기본 응답 제한(보통 1000행)에 걸려
    // 방문/검색이 많은 달에는 뒷부분 데이터가 잘려 카드 합계와 어긋날 수 있음
    const pvDaily = await supabaseQuery(
      `page_views?select=created_at&created_at=gte.${month}&order=created_at.asc&limit=20000`
    );
    const dailyMap = {};
    for (let i = 29; i >= 0; i--) {
      const key = toKSTDateString(kstDaysAgoStartUTC(i));
      dailyMap[key] = 0;
    }
    (pvDaily || []).forEach(r => {
      const key = toKSTDateString(r.created_at);
      if (dailyMap[key] !== undefined) dailyMap[key]++;
    });
    const dailyViews = Object.entries(dailyMap).map(([date, count]) => ({ date, count }));

    // 30일 평균 (일별 합 ÷ 30)
    const monthAvg = dailyViews.length
      ? Math.round((dailyViews.reduce((sum, d) => sum + d.count, 0) / dailyViews.length) * 10) / 10
      : 0;

    // 최근 30일 일별 검색 횟수 (KST 기준 날짜로 집계, 페이지뷰와 동일 구조)
    const kwDaily = await supabaseQuery(
      `search_logs?select=created_at,source&${SEARCH_ONLY}&created_at=gte.${month}&order=created_at.asc&limit=20000`
    );
    const kwDailyMap = {};
    for (let i = 29; i >= 0; i--) {
      const key = toKSTDateString(kstDaysAgoStartUTC(i));
      kwDailyMap[key] = 0;
    }
    const kwDailySrc = {};
    for (const k of Object.keys(kwDailyMap)) {
      kwDailySrc[k] = { naver: 0, google: 0, both: 0, unknown: 0 };
    }
    (kwDaily || []).forEach(r => {
      const key = toKSTDateString(r.created_at);
      if (kwDailyMap[key] !== undefined) {
        kwDailyMap[key]++;
        kwDailySrc[key][r.source || 'unknown']++;
      }
    });
    const dailySearches = Object.entries(kwDailyMap)
      .map(([date, count]) => ({ date, count, ...kwDailySrc[date] }));

    // 30일 검색 평균
    const monthSearchAvg = dailySearches.length
      ? Math.round((dailySearches.reduce((sum, d) => sum + d.count, 0) / dailySearches.length) * 10) / 10
      : 0;

    // 최근 검색 키워드 20개
    const recentKw = await supabaseQuery(
      `search_logs?select=keyword,created_at,source&${SEARCH_ONLY}&order=created_at.desc&limit=20`
    );

    /* ── 소스 전환 ──
       결과를 보고 있는 상태에서 토글을 옮긴 기록. 검색 후 실제로
       다른 소스를 봤는지가 여기서 나온다. */
    const switches = await supabaseQuery(
      `search_logs?select=source,from_source,created_at&event=eq.switch&created_at=gte.${month}&limit=20000`
    );
    const switchPairs = {};
    (switches || []).forEach(r => {
      const k = `${r.from_source}\u2192${r.source}`;
      switchPairs[k] = (switchPairs[k] || 0) + 1;
    });
    const sourceSwitches = Object.entries(switchPairs)
      .sort((a,b) => b[1]-a[1])
      .map(([pair, count]) => ({ pair, count }));
    const switchTotal = (switches || []).length;

    return res.status(200).json({
      sourceTotals,
      sourceSwitches,
      switchTotal,
      pageviews: {
        total:  pvTotal  || 0,
        today:  pvToday  || 0,
        week:   pvWeek   || 0,
        month:  pvMonth  || 0,
      },
      searches: {
        total:  kwTotal  || 0,
        today:  kwToday  || 0,
        week:   kwWeek   || 0,
        month:  kwMonth  || 0,
      },
      topKeywords,
      dailyViews,
      monthAvg,
      dailySearches,
      monthSearchAvg,
      recentKeywords: recentKw || [],
    });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
