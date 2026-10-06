// api/quote.js — Proxy Vercel → Tiingo (precio) + Alpha Vantage (fundamentales)
// Respaldo de precio: Twelve Data (solo si existe TWELVEDATA_API_KEY).
//
// Variables de entorno en Vercel (Settings → Environment Variables):
//   TIINGO_API_KEY        → obligatoria (precio, 52 semanas, cambio 1 año)
//   ALPHAVANTAGE_API_KEY  → obligatoria (P/E, P/S, EV/EBITDA, márgenes, revenue, FCF, target)
//   TWELVEDATA_API_KEY    → opcional (respaldo de precio)
//
// Presupuesto gratis de Alpha Vantage: 25 llamadas/día → 2 por análisis (OVERVIEW + CASH_FLOW).
// El caché de 6 h en el edge evita gastar llamadas si repites el mismo ticker.
//
// Devuelve EXACTAMENTE el formato de Yahoo (quoteSummary.result[0], números en { raw })
// para que index.html no cambie su parser.

const num = v => (v == null || v === '' || v === 'None' || v === '-' || isNaN(Number(v)) ? null : Number(v));
const nz  = v => { const n = num(v); return n === 0 ? null : n; };   // 0 = "sin dato" en ratios
const wrap = v => (v == null ? undefined : { raw: v });
const isoDaysAgo = d => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);

/* ── Tiingo: último cierre + rango 52 semanas + cambio 1 año ── */
async function priceFromTiingo(ticker, key) {
  const h = { Authorization: `Token ${key}`, 'Content-Type': 'application/json' };
  const url = `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(ticker.toLowerCase())}/prices` +
              `?startDate=${isoDaysAgo(372)}&format=json`;
  const r = await fetch(url, { headers: h, signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(j) || !j.length) throw new Error((j && j.detail) || `Tiingo ${r.status}`);

  const last = j[j.length - 1], first = j[0];
  const highs = j.map(d => num(d.adjHigh)).filter(v => v != null);
  const lows  = j.map(d => num(d.adjLow)).filter(v => v != null);
  return {
    source: 'tiingo',
    asOf: last.date,
    price: num(last.close),
    high52: highs.length ? Math.max(...highs) : null,
    low52:  lows.length  ? Math.min(...lows)  : null,
    change1y: num(first.adjClose) ? num(last.adjClose) / num(first.adjClose) - 1 : null,
  };
}

async function nameFromTiingo(ticker, key) {
  try {
    const r = await fetch(`https://api.tiingo.com/tiingo/daily/${encodeURIComponent(ticker.toLowerCase())}`, {
      headers: { Authorization: `Token ${key}` }, signal: AbortSignal.timeout(10000),
    });
    const j = await r.json();
    return j && j.name ? j.name : null;
  } catch { return null; }
}

/* ── Twelve Data: respaldo de precio ── */
async function priceFromTwelve(ticker, key) {
  const r = await fetch(`https://api.twelvedata.com/quote?symbol=${encodeURIComponent(ticker)}&apikey=${key}`,
                        { signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => null);
  if (!j || j.status === 'error' || j.close == null) throw new Error((j && j.message) || 'Twelve Data sin precio');
  const fw = j.fifty_two_week || {};
  return {
    source: 'twelvedata', asOf: j.datetime || null, name: j.name || null,
    price: num(j.close), high52: num(fw.high), low52: num(fw.low), change1y: null,
  };
}

/* ── Alpha Vantage: fundamentales ── */
async function avCall(fn, ticker, key) {
  const url = `https://www.alphavantage.co/query?function=${fn}&symbol=${encodeURIComponent(ticker)}&apikey=${key}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => null);
  if (!j) throw new Error(`${fn}: respuesta inválida`);
  // Límite diario/por minuto o endpoint premium → AV responde con "Note" / "Information"
  if (j.Note || j.Information) throw new Error(`${fn}: ${(j.Note || j.Information).slice(0, 140)}`);
  if (j['Error Message']) throw new Error(`${fn}: ${j['Error Message'].slice(0, 140)}`);
  return j;
}

async function fundamentalsFromAV(ticker, key) {
  const ov = await avCall('OVERVIEW', ticker, key);
  if (!ov.Symbol) throw new Error('OVERVIEW vacío (¿ETF o ticker no cubierto?)');

  const revenue = nz(ov.RevenueTTM), gross = num(ov.GrossProfitTTM);
  const out = {
    name: ov.Name || null,
    sector: ov.Sector ? ov.Sector.charAt(0) + ov.Sector.slice(1).toLowerCase() : null,
    currency: ov.Currency || 'USD',
    marketCap: nz(ov.MarketCapitalization),
    peTTM: nz(ov.TrailingPE) ?? nz(ov.PERatio),
    peForward: nz(ov.ForwardPE),
    ps: nz(ov.PriceToSalesRatioTTM),
    pb: nz(ov.PriceToBookRatio),
    evEbitda: nz(ov.EVToEBITDA),
    revenue,
    revenueGrowth: num(ov.QuarterlyRevenueGrowthYOY),
    grossMargin: revenue && gross != null ? gross / revenue : null,
    profitMargin: num(ov.ProfitMargin),
    target: nz(ov.AnalystTargetPrice),
    high52: nz(ov['52WeekHigh']),
    low52: nz(ov['52WeekLow']),
    fcf: null,
  };

  // Free Cash Flow TTM = suma de los últimos 4 trimestres (flujo operacional − capex)
  try {
    const cf = await avCall('CASH_FLOW', ticker, key);
    const q = (cf.quarterlyReports || []).slice(0, 4);
    if (q.length === 4) {
      let total = 0, ok = true;
      for (const r of q) {
        const ocf = num(r.operatingCashflow), capex = num(r.capitalExpenditures);
        if (ocf == null || capex == null) { ok = false; break; }
        total += ocf - Math.abs(capex);
      }
      if (ok) out.fcf = total;
    }
  } catch (e) { out.fcfError = e.message; }

  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ticker = (req.query.ticker || '').toString().trim().toUpperCase();
  if (!ticker) return res.status(400).json({ error: 'Falta el parámetro ticker' });

  const TIINGO = process.env.TIINGO_API_KEY;
  const AV     = process.env.ALPHAVANTAGE_API_KEY;
  const TWELVE = process.env.TWELVEDATA_API_KEY;
  if (!TIINGO && !TWELVE) return res.status(500).json({ error: 'Falta TIINGO_API_KEY en Vercel' });

  const warnings = [];

  // Precio y fundamentales en paralelo
  const [pxRes, fdRes] = await Promise.allSettled([
    TIINGO ? priceFromTiingo(ticker, TIINGO) : Promise.reject(new Error('sin TIINGO_API_KEY')),
    AV ? fundamentalsFromAV(ticker, AV) : Promise.reject(new Error('sin ALPHAVANTAGE_API_KEY')),
  ]);

  let px = pxRes.status === 'fulfilled' ? pxRes.value : null;
  if (!px) {
    warnings.push(`tiingo: ${pxRes.reason && pxRes.reason.message}`);
    if (TWELVE) {
      try { px = await priceFromTwelve(ticker, TWELVE); }
      catch (e) { warnings.push(`twelvedata: ${e.message}`); }
    }
  }
  const fd = fdRes.status === 'fulfilled' ? fdRes.value : null;
  if (!fd) warnings.push(`alphavantage: ${fdRes.reason && fdRes.reason.message}`);
  if (fd && fd.fcfError) warnings.push(`alphavantage: ${fd.fcfError}`);

  if (!px || px.price == null) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: 'No se pudo obtener el precio', details: warnings });
  }

  let name = (fd && fd.name) || px.name || null;
  if (!name && TIINGO) name = await nameFromTiingo(ticker, TIINGO);

  const f = fd || {};
  const payload = {
    source: `${px.source}${fd ? '+alphavantage' : ''}`,
    fundamentals: !!fd,
    asOf: px.asOf,
    warnings,
    quoteSummary: { result: [ {
      price: {
        longName:  name || ticker,
        shortName: name || ticker,
        currency:  f.currency || 'USD',
        sector:    f.sector || null,
        regularMarketPrice: wrap(px.price),
        marketCap: wrap(f.marketCap),
      },
      summaryDetail: {
        trailingPE: wrap(f.peTTM),
        forwardPE:  wrap(f.peForward),
        fiftyTwoWeekHigh: wrap(px.high52 ?? f.high52),
        fiftyTwoWeekLow:  wrap(px.low52 ?? f.low52),
      },
      defaultKeyStatistics: {
        priceToSalesTrailing12Months: wrap(f.ps),
        priceToBook: wrap(f.pb),
        enterpriseToEbitda: wrap(f.evEbitda),
        '52WeekChange': wrap(px.change1y),
      },
      financialData: {
        revenueGrowth: wrap(f.revenueGrowth),
        grossMargins:  wrap(f.grossMargin),
        profitMargins: wrap(f.profitMargin),
        freeCashflow:  wrap(f.fcf),
        totalRevenue:  wrap(f.revenue),
        targetMeanPrice: wrap(f.target),
      },
    } ] },
  };

  // Con fundamentales completos: caché 6 h. Si faltaron (ej. límite diario de AV): solo 10 min,
  // para que el próximo intento los vuelva a buscar.
  res.setHeader('Cache-Control', fd
    ? 's-maxage=21600, stale-while-revalidate=86400'
    : 's-maxage=600');
  return res.status(200).json(payload);
};
