// api/quote.js — Proxy Vercel → Twelve Data (precio + rango 52 semanas)
// Reemplaza a Yahoo Finance. La API key va en la env var TWELVEDATA_API_KEY.
//
// Devuelve EXACTAMENTE el mismo formato que Yahoo (quoteSummary.result[0]) para no
// tocar el parser de index.html. Los números van envueltos en { raw: valor } igual
// que Yahoo.
//
// NOTA: el plan GRATIS de Twelve Data no incluye P/E, market cap ni márgenes; esos
// campos van vacíos y se completan con el PANTALLAZO de Yahoo (visión de Claude) o,
// si no hay pantallazo, con el conocimiento de Claude.

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ticker = (req.query.ticker || '').toString().trim().toUpperCase();
  const KEY = process.env.TWELVEDATA_API_KEY;
  if (!ticker) return res.status(400).json({ error: 'Falta el parámetro ticker' });
  if (!KEY)    return res.status(500).json({ error: 'Falta TWELVEDATA_API_KEY en Vercel' });

  try {
    const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(ticker)}&apikey=${KEY}`;
    const r = await fetch(url);
    const j = await r.json();

    if (!j || j.status === 'error' || j.close == null) {
      return res.status(502).json({ error: (j && j.message) || 'Ticker no encontrado' });
    }

    const num  = v => (v == null || v === '' || isNaN(v) ? null : Number(v));
    const wrap = v => (v == null ? undefined : { raw: v });   // formato Yahoo { raw }
    const fw = j.fifty_two_week || {};

    const payload = {
      quoteSummary: { result: [ {
        price: {
          longName:  j.name || ticker,
          shortName: j.name || ticker,
          currency:  j.currency || 'USD',
          regularMarketPrice: wrap(num(j.close)),
        },
        summaryDetail: {
          fiftyTwoWeekHigh: wrap(num(fw.high)),
          fiftyTwoWeekLow:  wrap(num(fw.low)),
        },
        defaultKeyStatistics: {},   // sin fundamentales en el free tier → pantallazo/Claude
        financialData: {},
      } ] }
    };

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
    return res.status(200).json(payload);
  } catch (e) {
    return res.status(502).json({ error: e.message || 'Error consultando Twelve Data' });
  }
};
