// api/history.js — Proxy Vercel → Tiingo (histórico diario para el análisis técnico)
// Respaldo: Twelve Data (solo si existe TWELVEDATA_API_KEY).
//
// Variables de entorno en Vercel (Settings → Environment Variables):
//   TIINGO_API_KEY        → obligatoria
//   TWELVEDATA_API_KEY    → opcional (respaldo)
// Las keys NUNCA llegan al browser ni van en el código.
//
// Devuelve EXACTAMENTE el formato de Yahoo (chart.result[0].indicators.quote[0])
// para que index.html no cambie su parser.

const DAYS = 320; // ~1,3 años de ruedas: alcanza para SMA200, MACD, Fibonacci

const num = v => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));
const isoDaysAgo = d => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);

async function fromTiingo(ticker, key) {
  const url = `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(ticker.toLowerCase())}/prices` +
              `?startDate=${isoDaysAgo(Math.ceil(DAYS * 1.5))}&format=json`;
  const r = await fetch(url, {
    headers: { Authorization: `Token ${key}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(j) || !j.length) {
    throw new Error((j && j.detail) || `Tiingo ${r.status}`);
  }
  // Tiingo entrega de viejo → nuevo. Usamos precios AJUSTADOS (por splits y
  // dividendos) para que un split no rompa las medias móviles.
  const rows = j.slice(-DAYS);
  return {
    source: 'tiingo',
    lastDate: rows[rows.length - 1].date,
    close:  rows.map(d => num(d.adjClose)),
    open:   rows.map(d => num(d.adjOpen)),
    high:   rows.map(d => num(d.adjHigh)),
    low:    rows.map(d => num(d.adjLow)),
    volume: rows.map(d => num(d.adjVolume)),
  };
}

async function fromTwelveData(ticker, key) {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(ticker)}` +
              `&interval=1day&outputsize=${DAYS}&apikey=${key}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => null);
  if (!j || j.status === 'error' || !Array.isArray(j.values) || !j.values.length) {
    throw new Error((j && j.message) || 'Twelve Data sin datos');
  }
  const rows = j.values.slice().reverse(); // viene nuevo → viejo
  return {
    source: 'twelvedata',
    lastDate: rows[rows.length - 1].datetime,
    close:  rows.map(d => num(d.close)),
    open:   rows.map(d => num(d.open)),
    high:   rows.map(d => num(d.high)),
    low:    rows.map(d => num(d.low)),
    volume: rows.map(d => num(d.volume)),
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ticker = (req.query.ticker || '').toString().trim().toUpperCase();
  if (!ticker) return res.status(400).json({ error: 'Falta el parámetro ticker' });

  const TIINGO = process.env.TIINGO_API_KEY;
  const TWELVE = process.env.TWELVEDATA_API_KEY;
  if (!TIINGO && !TWELVE) {
    return res.status(500).json({ error: 'Falta TIINGO_API_KEY en Vercel' });
  }

  const errors = [];
  let data = null;

  if (TIINGO) {
    try { data = await fromTiingo(ticker, TIINGO); }
    catch (e) { errors.push(`tiingo: ${e.message}`); }
  }
  if (!data && TWELVE) {
    try { data = await fromTwelveData(ticker, TWELVE); }
    catch (e) { errors.push(`twelvedata: ${e.message}`); }
  }

  if (!data) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: 'Sin datos históricos', details: errors });
  }

  const { source, lastDate, ...q } = data;
  res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400'); // 6 h en el edge
  return res.status(200).json({
    source,
    lastDate,
    warnings: errors,
    chart: { result: [ {
      meta: { symbol: ticker, source },
      indicators: { quote: [ q ] },
    } ] },
  });
};
