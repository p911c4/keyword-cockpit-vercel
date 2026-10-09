const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const CRON_SECRET  = process.env.CRON_SECRET; // Vercel Cron 외 임의 호출 방지용 (선택)

const RETENTION_DAYS = 30; // 원본 로그 보관 기간
const KST_OFFSET_MS  = 9 * 60 * 60 * 1000;

/* UTC ISO → KST 기준 YYYY-MM-DD (stats.js와 같은 규칙) */
function toKSTDateString(isoString) {
  return new Date(new Date(isoString).getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

async function supabaseGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
  });
  return res.json();
}

/* ── 일별 요약 적재 ──
   삭제 "전에" 센다. 지운 뒤에 세면 그날치가 통째로 사라진다.

   남아 있는 전 구간을 매번 다시 집계해 upsert 한다. 비용은 하루 한 번
   수만 행 읽기로 끝나고, 대신 세 가지가 공짜로 따라온다.
     · 첫 실행이 곧 과거 30일 백필
     · 크론이 하루 걸러뛰어도 다음 실행에서 자동 복구
     · 진행 중이던 당일 값도 다음 날 완성치로 덮어써짐 */
async function rollupDaily(cutoffISO) {
  const [pv, sl, gops] = await Promise.all([
    supabaseGet('page_views?select=created_at&limit=100000'),
    supabaseGet('search_logs?select=created_at,source&event=is.null&limit=100000'),
    supabaseGet('google_api_usage?select=day,ops&limit=1000'),
  ]);

  const rows = {};
  const row = (d) => rows[d] || (rows[d] = {
    day: d, pageviews: 0, searches: 0,
    src_naver: 0, src_google: 0, src_both: 0, google_ops: 0,
  });

  (Array.isArray(pv) ? pv : []).forEach(r => { row(toKSTDateString(r.created_at)).pageviews++; });
  (Array.isArray(sl) ? sl : []).forEach(r => {
    const e = row(toKSTDateString(r.created_at));
    e.searches++;
    if (r.source === 'naver')  e.src_naver++;
    else if (r.source === 'google') e.src_google++;
    else if (r.source === 'both')   e.src_both++;
  });
  /* google_api_usage 는 이미 일별이라 그대로 옮긴다 */
  (Array.isArray(gops) ? gops : []).forEach(r => { row(r.day).google_ops = Number(r.ops) || 0; });

  /* ── 경계 날짜 보호 ──
     삭제 기준이 "30일 전 이 시각"이라 날짜 경계와 어긋난다. 그래서 가장 오래된
     날은 매일 앞부분이 잘린 채 남고, 전 구간을 다시 집계하면 어제 정확히 적어 둔
     값을 오늘 깎인 값으로 덮어쓰게 된다. 하루에 몇 시간씩 과거가 사라진다.

     cutoff 가 걸친 날과 그 이전은 쓰지 않는다. 그 날들은 아직 온전했던
     지난 실행에서 이미 기록됐다. 이후 날짜만 쓰면 모든 행이 완전한 하루가 된다. */
  const cutoffDay = cutoffISO ? toKSTDateString(cutoffISO) : null;
  const payload = Object.values(rows).filter(r => !cutoffDay || r.day > cutoffDay);
  const skipped = Object.keys(rows).length - payload.length;
  if (!payload.length) return { upserted: 0, skipped };

  const res = await fetch(`${SUPABASE_URL}/rest/v1/daily_stats`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(payload.map(r => ({ ...r, updated_at: new Date().toISOString() }))),
  });
  return { upserted: res.ok ? payload.length : 0, skipped, ok: res.ok, status: res.status };
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

    /* ?rollupOnly=1 — 삭제 없이 요약만. 테이블을 새로 만든 직후
       크론을 기다리지 않고 과거 30일을 채워 넣을 때 쓴다. */
    if (req.query && (req.query.rollupOnly === '1' || req.query.rollupOnly === 'true')) {
      return res.status(200).json({ ok: true, rollupOnly: true, rollup });
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
