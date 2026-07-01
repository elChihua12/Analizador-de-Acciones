// ─────────────────────────────────────────────────────────────
//  api/notion.js — Proxy Notion para el Selector del panel
//  Vive en Vercel (serverless). Guarda el token de Notion como
//  variable de entorno NOTION_TOKEN (nunca en el navegador/repo).
//  Consulta la API REST de Notion y devuelve las filas aplanadas,
//  con CORS abierto para que GitHub Pages pueda llamarlo.
// ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.NOTION_TOKEN;
  if (!token) return res.status(500).json({ error: 'Falta NOTION_TOKEN en Vercel (Settings → Environment Variables)' });

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
      const r = await fetch(a.url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Notion-Version': a.ver,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ page_size: 100 }),
      });
      const data = await r.json();
      if (r.ok) {
        const items = (data.results || []).map(flatten);
        return res.status(200).json({ items, source: a.ver });
      }
      lastErr = { status: r.status, code: data?.code, message: data?.message };
      // si es "no encontrado", prueba el siguiente formato; si es auth/otro, corta
      if (data?.code !== 'object_not_found') break;
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
