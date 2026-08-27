// ─────────────────────────────────────────────────────────────
//  api/notion.js — Proxy Notion para el Selector del panel
//  Vive en Vercel (serverless). Guarda el token de Notion como
//  variable de entorno NOTION_TOKEN (nunca en el navegador/repo).
//  Consulta la API REST de Notion y devuelve las filas aplanadas,
//  con CORS abierto para que GitHub Pages pueda llamarlo.
// ─────────────────────────────────────────────────────────────

// Amplía el tiempo máximo de ejecución de la función serverless.
// Necesario para paginar bases grandes: cada página es un viaje a Notion.
// 60 s es el tope en el plan Hobby de Vercel (en Pro puede subir más).
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  // ── Control de tiempo ──────────────────────────────────────
  // vercel.json ahora concede 60 s (tope del plan Hobby). Paginamos con un
  // presupuesto de 50 s para devolver algo SIEMPRE, en vez de morir con 504.
  // OJO: los dos numeros deben moverse juntos. Si vercel.json vuelve a 30,
  // este presupuesto tiene que bajar a ~20000 o el 504 regresa.
  const T0 = Date.now();
  const PRESUPUESTO_MS = 50000;
  const MAX_PAGES = Number(req.query.max) > 0 ? Number(req.query.max) : 200;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.NOTION_TOKEN;

  // ── Diagnóstico: abre /api/notion?diag=1 en el navegador para ver qué detecta el servidor.
  //    No revela el valor del token; solo si existe, su largo, su nombre y el entorno. ──
  if (req.query.diag !== undefined) {
    return res.status(200).json({
      NOTION_TOKEN_detectada: typeof token === 'string' && token.length > 0,
      NOTION_TOKEN_largo: token ? token.length : 0,
      empieza_con_ntn: token ? token.slice(0, 4) === 'ntn_' : false,
      variables_con_notion: Object.keys(process.env).filter(k => /notion/i.test(k)),
      entorno_actual: process.env.VERCEL_ENV || 'desconocido',
      pista: (token && token.length)
        ? 'Token presente. Si el Selector aún falla, revisa que empiece con ntn_ y que la integración esté compartida con cada base (··· → Conexiones).'
        : 'El servidor NO ve el token. Causas posibles: (1) el nombre no es exactamente NOTION_TOKEN (mayúsculas/espacios), (2) se guardó en otro entorno y no en Production, (3) el valor quedó vacío, (4) no se hizo un deploy NUEVO después de guardarla.',
    });
  }

  if (!token) return res.status(500).json({
    error: 'Falta NOTION_TOKEN en Vercel (Settings → Environment Variables)',
    variables_con_notion: Object.keys(process.env).filter(k => /notion/i.test(k)),
    entorno_actual: process.env.VERCEL_ENV || 'desconocido',
    ayuda: 'Abre /api/notion?diag=1 para diagnosticar. Suele ser: nombre distinto a NOTION_TOKEN, entorno equivocado (debe incluir Production), o valor vacío.',
  });

  const id = String(req.query.ds || '').replace('collection://', '').replace(/-/g, '').trim();
  if (!id) return res.status(400).json({ error: 'Falta el parámetro ds (id de la base/data source)' });
  // formatea el UUID con guiones (8-4-4-4-12)
  const uuid = id.length === 32
    ? `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`
    : id;

  // Intenta como database (API clásica) y, si no existe, como data source (API nueva).
  const attempts = [
    { url: `https://api.notion.com/v1/databases/${uuid}/query`,    ver: '2022-06-28' },
    { url: `https://api.notion.com/v1/data_sources/${uuid}/query`, ver: '2025-09-03' },
  ];

  let lastErr = null;
  for (const a of attempts) {
    try {
      // ── Paginación completa: recorre TODA la base, no solo las primeras 100 filas.
      //    Notion entrega máx. 100 por request; se sigue el cursor mientras has_more sea true.
      const results = [];
      let cursor = undefined;
      let okFormat = false;
      let parcial  = false;
      let motivo   = null;

      // Tope de seguridad: 200 páginas = 20.000 filas. Freno anti-loop-infinito;
      // el límite real es el timeout de la función (ver maxDuration arriba).
      for (let page = 0; page < MAX_PAGES; page++) {
        // FRENO REAL: si nos acercamos al limite de la funcion, cortamos y
        // devolvemos lo que alcanzamos. Mejor una lista parcial que un 504.
        if (Date.now() - T0 > PRESUPUESTO_MS) { parcial = true; motivo = 'presupuesto de tiempo agotado'; break; }

        const body = { page_size: 100 };
        if (cursor) body.start_cursor = cursor;

        const r = await fetch(a.url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Notion-Version': a.ver,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });
        const data = await r.json();

        if (!r.ok) {
          if (page === 0) {
            lastErr = { status: r.status, code: data?.code, message: data?.message };
          } else {
            // Fallo a mitad de la paginacion (429, corte de red, etc).
            // ANTES esto devolvia una lista incompleta como si estuviera completa.
            // Ahora queda marcado para no sortear sobre datos a medias.
            parcial = true;
            motivo  = `pagina ${page}: ${data?.code || r.status}`;
          }
          break;
        }

        okFormat = true;
        for (const row of (data.results || [])) results.push(flatten(row));

        if (data.has_more && data.next_cursor) {
          cursor = data.next_cursor;
        } else {
          break;
        }
      }

      if (okFormat) {
        // Cache en el CDN de Vercel: la primera consulta paga el costo, las
        // siguientes salen al instante. Agrega &fresh=1 para saltarse la cache.
        res.setHeader('Cache-Control', req.query.fresh !== undefined
          ? 'no-store'
          : 's-maxage=3600, stale-while-revalidate=86400');
        return res.status(200).json({
          items: results,
          source: a.ver,
          count: results.length,
          parcial,                       // true = la lista NO esta completa
          motivo,                        // por que se corto
          ms: Date.now() - T0,
        });
      }
      // si es "no encontrado", prueba el siguiente formato; si es auth/otro, corta
      if (lastErr?.code && lastErr.code !== 'object_not_found') break;
    } catch (e) {
      lastErr = { message: e.message };
    }
  }
  return res.status(lastErr?.status || 502).json({
    error: lastErr?.message || 'No se pudo consultar Notion',
    code: lastErr?.code || null,
    hint: 'Verifica que la integración esté compartida con esa base (··· → Conexiones) y que el id sea correcto.',
  });
}

// Aplana las propiedades de una página de Notion a un objeto plano { Campo: valor }.
function flatten(page) {
  const out = { url: page.url || null };
  const props = page.properties || {};
  for (const [name, p] of Object.entries(props)) out[name] = readProp(p);
  return out;
}
function readProp(p) {
  switch (p?.type) {
    case 'title':        return (p.title || []).map(t => t.plain_text).join('');
    case 'rich_text':    return (p.rich_text || []).map(t => t.plain_text).join('');
    case 'select':       return p.select?.name ?? null;
    case 'status':       return p.status?.name ?? null;
    case 'multi_select': return (p.multi_select || []).map(s => s.name).join(', ');
    case 'url':          return p.url ?? null;
    case 'email':        return p.email ?? null;
    case 'phone_number': return p.phone_number ?? null;
    case 'number':       return p.number ?? null;
    case 'checkbox':     return !!p.checkbox;
    case 'date':         return p.date?.start ?? null;
    case 'people':       return (p.people || []).map(x => x.name).filter(Boolean).join(', ');
    case 'files':        return p.files?.[0]?.file?.url || p.files?.[0]?.external?.url || null;
    case 'formula':      return p.formula?.string ?? p.formula?.number ?? p.formula?.boolean ?? null;
    case 'rollup':       return p.rollup?.number ?? null;
    default:             return null;
  }
}
