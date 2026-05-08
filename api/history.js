export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
 
  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: 'ticker requerido' });
 
  const BASE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer': 'https://finance.yahoo.com/',
    'Origin': 'https://finance.yahoo.com',
  };
 
  try {
    // Paso 1: crumb
    const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: BASE_HEADERS,
    });
 
    if (crumbRes.ok) {
      const crumb = await crumbRes.text();
      const cookies = crumbRes.headers.get('set-cookie') || '';
 
      const urls = [
        `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1y&crumb=${encodeURIComponent(crumb)}`,
        `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1y&crumb=${encodeURIComponent(crumb)}`,
      ];
 
      for (const url of urls) {
        try {
          const r = await fetch(url, { headers: { ...BASE_HEADERS, Cookie: cookies } });
          if (!r.ok) continue;
          const data = await r.json();
          if (data?.chart?.result?.[0]) return res.json(data);
        } catch { continue; }
      }
    }
 
    // Fallback sin crumb
    const fallbackUrls = [
      `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1y`,
      `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1y`,
    ];
 
    for (const url of fallbackUrls) {
      try {
        const r = await fetch(url, { headers: BASE_HEADERS });
        if (!r.ok) continue;
        const data = await r.json();
        if (data?.chart?.result?.[0]) return res.json(data);
      } catch { continue; }
    }
 
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
 
  return res.status(502).json({ error: 'Yahoo Finance histórico no respondió' });
}
