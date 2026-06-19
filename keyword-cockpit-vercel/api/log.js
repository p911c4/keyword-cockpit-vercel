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

  const { type, keyword } = req.body || {};

  try {
    if (type === 'pageview') {
      await supabaseInsert('page_views', { created_at: new Date().toISOString() });
    } else if (type === 'search' && keyword) {
      await supabaseInsert('search_logs', { keyword, created_at: new Date().toISOString() });
    }
    return res.status(200).json({ ok: true });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
