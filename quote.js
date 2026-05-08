export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: 'ticker requerido' });

  const modules = 'price,summaryDetail,defaultKeyStatistics,financialData';
  const urls = [
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=${modules}`,
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=${modules}`,
  ];

  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
  };

  for (const url of urls) {
    try {
      const response = await fetch(url, { headers: HEADERS });
      if (!response.ok) continue;
      const data = await response.json();
      if (data?.quoteSummary?.result?.[0]) {
        return res.json(data);
      }
    } catch { continue; }
  }

  return res.status(502).json({ error: 'Yahoo Finance no respondió' });
}
