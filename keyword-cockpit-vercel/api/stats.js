const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

async function supabaseQuery(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`
    }
  });
  return res.json();
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
    const now = new Date();

    // 오늘 날짜 범위
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    // 7일 전
    const week = new Date(now - 7*24*60*60*1000).toISOString();
    // 30일 전
    const month = new Date(now - 30*24*60*60*1000).toISOString();

    // 전체 페이지뷰
    const [pvTotal, pvToday, pvWeek, pvMonth] = await Promise.all([
      supabaseQuery('page_views?select=count'),
      supabaseQuery(`page_views?select=count&created_at=gte.${todayStart}`),
      supabaseQuery(`page_views?select=count&created_at=gte.${week}`),
      supabaseQuery(`page_views?select=count&created_at=gte.${month}`),
    ]);

    // 인기 키워드 TOP 20 (전체)
    const kwAll = await supabaseQuery(
      'search_logs?select=keyword&order=created_at.desc&limit=1000'
    );

    // 키워드 집계
    const kwCount = {};
    (kwAll || []).forEach(r => {
      kwCount[r.keyword] = (kwCount[r.keyword] || 0) + 1;
    });
    const topKeywords = Object.entries(kwCount)
      .sort((a,b) => b[1]-a[1])
      .slice(0, 20)
      .map(([keyword, count]) => ({ keyword, count }));

    // 최근 7일 일별 페이지뷰
    const pvDaily = await supabaseQuery(
      `page_views?select=created_at&created_at=gte.${week}&order=created_at.asc`
    );
    const dailyMap = {};
    for (let i=6; i>=0; i--) {
      const d = new Date(now - i*24*60*60*1000);
      const key = d.toISOString().slice(0,10);
      dailyMap[key] = 0;
    }
    (pvDaily || []).forEach(r => {
      const key = r.created_at.slice(0,10);
      if (dailyMap[key] !== undefined) dailyMap[key]++;
    });
    const dailyViews = Object.entries(dailyMap).map(([date, count]) => ({ date, count }));

    // 최근 검색 키워드 20개
    const recentKw = await supabaseQuery(
      'search_logs?select=keyword,created_at&order=created_at.desc&limit=20'
    );

    return res.status(200).json({
      pageviews: {
        total:  pvTotal?.[0]?.count  || 0,
        today:  pvToday?.[0]?.count  || 0,
        week:   pvWeek?.[0]?.count   || 0,
        month:  pvMonth?.[0]?.count  || 0,
      },
      topKeywords,
      dailyViews,
      recentKeywords: recentKw || [],
    });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
