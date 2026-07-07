const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const CRON_SECRET  = process.env.CRON_SECRET; // Vercel Cron 외 임의 호출 방지용 (선택)

const RETENTION_DAYS = 30; // 보관 기간 — 화면이 30일까지만 보여주므로 그 이상은 불필요

async function supabaseDelete(table, beforeISO) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/${table}?created_at=lt.${beforeISO}`,
    {
      method: 'DELETE',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'count=exact',
      },
    }
  );
  const countHeader = res.headers.get('content-range'); // 예: "*/123"
  const deleted = countHeader ? countHeader.split('/')[1] : null;
  return { ok: res.ok, status: res.status, deleted };
}

module.exports = async (req, res) => {
  // Vercel Cron이 보내는 요청인지 간단히 검증 (CRON_SECRET 설정 시에만 체크)
  if (CRON_SECRET) {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ error: '인증 실패' });
    }
  }

  try {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const [pv, sl] = await Promise.all([
      supabaseDelete('page_views', cutoff),
      supabaseDelete('search_logs', cutoff),
    ]);

    return res.status(200).json({
      ok: true,
      retentionDays: RETENTION_DAYS,
      cutoff,
      deleted: {
        page_views:  pv.deleted,
        search_logs: sl.deleted,
      },
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
