// api/history.js — Proxy Vercel → Twelve Data (histórico diario para análisis técnico)
// Reemplaza a Yahoo Finance (que bloquea las IP de Vercel con 502).
// La API key va en la variable de entorno TWELVEDATA_API_KEY
// (Vercel → Project → Settings → Environment Variables). NUNCA se expone al browser.
//
// Devuelve EXACTAMENTE el mismo formato que Yahoo (chart.result[0].indicators.quote[0])
// para que el index.html NO necesite cambios en su parser.

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ticker = (req.query.ticker || '').toString().trim().toUpperCase();
  const KEY = process.env.TWELVEDATA_API_KEY;
  if (!ticker) return res.status(400).json({ error: 'Falta el parámetro ticker' });
  if (!KEY)    return res.status(500).json({ error: 'Falta TWELVEDATA_API_KEY en Vercel' });

  try {
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(ticker)}` +
                `&interval=1day&outputsize=320&apikey=${KEY}`;
    const r = await fetch(url);
    const j = await r.json();

    if (!j || j.status === 'error' || !Array.isArray(j.values) || !j.values.length) {
      return res.status(502).json({ error: (j && j.message) || 'Sin datos históricos' });
    }

    // Twelve Data entrega del más NUEVO al más VIEJO → invertimos a viejo→nuevo
    const rows = j.values.slice().reverse();
    const num = v => (v == null || v === '' ? null : Number(v));

    const payload = {
      chart: { result: [ {
        meta: { symbol: ticker, source: 'twelvedata' },
        indicators: { quote: [ {
          close:  rows.map(d => num(d.close)),
          open:   rows.map(d => num(d.open)),
          high:   rows.map(d => num(d.high)),
          low:    rows.map(d => num(d.low)),
          volume: rows.map(d => num(d.volume)),
        } ] }
      } ] }
    };

    // Cachea 1 h en el edge → cuida el presupuesto de 800 llamadas/día
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json(payload);
  } catch (e) {
    return res.status(502).json({ error: e.message || 'Error consultando Twelve Data' });
  }
};
