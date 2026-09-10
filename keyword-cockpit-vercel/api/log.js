const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

async function supabaseInsert(table, data) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(data)
  });
  return res.ok;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { type, keyword, source, fromSource } = req.body || {};

  /* 프런트가 보낸 값을 그대로 믿지 않는다. 셋 중 하나가 아니면 null로 저장한다. */
  const SRC = ['naver', 'google', 'both'];
  const src  = SRC.includes(source)     ? source     : null;
  const from = SRC.includes(fromSource) ? fromSource : null;

  try {
    if (type === 'pageview') {
      await supabaseInsert('page_views', { created_at: new Date().toISOString() });
    } else if (type === 'search' && keyword) {
      await supabaseInsert('search_logs', {
        keyword, source: src, created_at: new Date().toISOString()
      });
    } else if (type === 'switch' && from && src) {
      /* 전환은 검색과 섞이면 검색 수가 부풀려진다. 같은 테이블에 두되
         event 컬럼으로 갈라 두고, 집계 시 event is null 인 행만 검색으로 센다. */
      await supabaseInsert('search_logs', {
        keyword: keyword || null, source: src, from_source: from,
        event: 'switch', created_at: new Date().toISOString()
      });
    }
    return res.status(200).json({ ok: true });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
