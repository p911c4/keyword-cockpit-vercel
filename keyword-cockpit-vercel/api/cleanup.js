const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const CRON_SECRET  = process.env.CRON_SECRET; // Vercel Cron 외 임의 호출 방지용 (선택)

const RETENTION_DAYS = 30; // 원본 로그 보관 기간
const KST_OFFSET_MS  = 9 * 60 * 60 * 1000;

/* UTC ISO → KST 기준 YYYY-MM-DD (stats.js와 같은 규칙) */
function toKSTDateString(isoString) {
  return new Date(new Date(isoString).getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/* ── 일별 요약 적재 ──
   집계는 DB 안에서 한다 (rollup_daily_stats RPC).

   예전에는 여기서 전 행을 읽어 JS로 셌는데, PostgREST 의 서버측 행 상한
   (db-max-rows = 10,000)에 걸려 조용히 잘렸다. limit 을 크게 줘도 넘지 못하고,
   searches 합이 정확히 10000 에서 멈추는 증상으로 드러났다.
   DB 안에서 group by 하면 상한이 적용되지 않고 호출 한 번으로 끝난다. */
async function rollupDaily(cutoffISO) {
  const cutoffDay = cutoffISO ? toKSTDateString(cutoffISO) : null;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/rollup_daily_stats`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_cutoff_day: cutoffDay }),
  });
  const body = await res.text();
  if (!res.ok) return { ok: false, status: res.status, error: body.slice(0, 300) };
  return { ok: true, upserted: parseInt(body, 10) || 0, cutoffDay };
}

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

    /* 순서가 중요하다 — 반드시 삭제 전에 요약한다 */
    const rollup = await rollupDaily(cutoff);

    /* ?rollupOnly=1       — 삭제 없이 요약만 (크론을 기다리지 않고 채워 넣을 때)
       ?rollupOnly=1&all=1 — 경계 보호를 풀고 전체를 다시 집계.
                             잘못 적재된 과거 값을 바로잡을 때만 쓴다. */
    if (req.query && (req.query.rollupOnly === '1' || req.query.rollupOnly === 'true')) {
      const all = req.query.all === '1' || req.query.all === 'true';
      const r = all ? await rollupDaily(null) : rollup;
      return res.status(200).json({ ok: true, rollupOnly: true, all, rollup: r });
    }

    const [pv, sl] = await Promise.all([
      supabaseDelete('page_views', cutoff),
      supabaseDelete('search_logs', cutoff),
    ]);

    return res.status(200).json({
      ok: true,
      retentionDays: RETENTION_DAYS,
      cutoff,
      rollup,
      deleted: {
        page_views:  pv.deleted,
        search_logs: sl.deleted,
      },
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
