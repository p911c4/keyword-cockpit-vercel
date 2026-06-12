const https = require('https');

const CLIENT_ID     = process.env.NAVER_CLIENT_ID;
const CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { keyword } = req.body || {};
  if (!keyword) return res.status(400).json({ error: 'keyword 필드가 없습니다' });

  // 최근 12개월 (이번달 제외)
  const endDate   = new Date();
  endDate.setMonth(endDate.getMonth() - 1);
  endDate.setDate(1);
  const startDate = new Date(endDate);
  startDate.setMonth(startDate.getMonth() - 11);

  const fmt     = d => d.toISOString().slice(0, 7) + '-01';
  const payload = JSON.stringify({
    startDate:     fmt(startDate),
    endDate:       fmt(endDate),
    timeUnit:      'month',
    keywordGroups: [{ groupName: keyword, keywords: [keyword] }],
    device: '', ages: [], gender: ''
  });

  const payloadBuf = Buffer.from(payload, 'utf8');

  const options = {
    hostname: 'openapi.naver.com',
    path:     '/v1/datalab/search',
    method:   'POST',
    headers: {
      'Content-Type':          'application/json; charset=utf-8',
      'Content-Length':        payloadBuf.length,
      'X-Naver-Client-Id':     CLIENT_ID,
      'X-Naver-Client-Secret': CLIENT_SECRET,
    }
  };

  const apiReq = https.request(options, apiRes => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => {
      if (!data || data.trim() === '') return res.status(502).json({ error: 'DataLab 빈 응답' });
      try {
        const json = JSON.parse(data);
        return res.status(apiRes.statusCode).json(json);
      } catch(e) {
        return res.status(502).json({ error: 'DataLab 응답 파싱 오류' });
      }
    });
  });

  apiReq.on('error', err => res.status(502).json({ error: 'DataLab 연결 실패: ' + err.message }));
  apiReq.write(payloadBuf);
  apiReq.end();
};
