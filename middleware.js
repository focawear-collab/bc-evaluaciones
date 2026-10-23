// Cierre de la app por fuera de BlackChicken APP (gate). Corre en el borde de Vercel, antes que todo
// (HTML, /api, .json): sin la cookie bc_gate firmada → redirige al portal.
// Entrada: el portal ya validó el PIN y que esta app esté en el portal de la persona (/api/ir), y manda
//   https://<esta app>/api/sso?t=sso1~persona~vence~dominio~emitido~firma   (HMAC-SHA256 con SSO_SECRET)
// Aquí se verifica (firma, dominio = esta app, emitido hace < 2 min, no vencido) y se abre la cookie
// hasta que venza la sesión del portal (12 h). Después, vuelve a pedir el PIN en el portal.
// Env: SSO_SECRET (el mismo del portal). Kit: blackchicken-app/sso-kit/gate/
export const config = { matcher: '/((?!favicon.ico).*)' };

const PORTAL = 'https://blackchicken-app.vercel.app/';
const COOKIE = 'bc_gate';
const enc = new TextEncoder();

async function hmac(texto) {
  const k = await crypto.subtle.importKey('raw', enc.encode(process.env.SSO_SECRET || ''), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const s = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(texto)));
  return Array.from(s, (b) => b.toString(16).padStart(2, '0')).join('');
}
function igual(a, b) { a = String(a); b = String(b); if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
// Sin cookie: al portal, con ?volver=<esta página> para que después del PIN vuelva aquí y no al inicio.
const alPortal = (volver) => new Response(null, { status: 302, headers: { Location: volver ? PORTAL + '?volver=' + encodeURIComponent(volver) : PORTAL, 'Cache-Control': 'no-store' } });
const destino = (r) => (typeof r === 'string' && r.length < 4000 && /^\/(?![\/\\])/.test(r)) ? r : '/';

export default async function middleware(request) {
  if (!process.env.SSO_SECRET) return new Response('Acceso no configurado', { status: 503 });
  const url = new URL(request.url);
  const host = url.hostname;

  // 1) Canje del pase del portal
  if (url.pathname === '/api/sso') {
    const p = String(url.searchParams.get('t') || '').split('~');
    if (p.length !== 6 || p[0] !== 'sso1') return alPortal();
    const base = p.slice(0, 5).join('~');
    const persona = Number(p[1]), hasta = Number(p[2]), emitido = Number(p[4]), ahora = Date.now();
    if (!igual(p[5], await hmac(base)) || p[3] !== host || !(persona > 0) || !(hasta > ahora) || !(ahora - emitido < 120000)) return alPortal();
    const firma = await hmac(['gate', host, persona, hasta].join('~'));
    return new Response(null, { status: 302, headers: {
      Location: url.origin + destino(url.searchParams.get('r')), 'Cache-Control': 'no-store', // absoluta: Next.js no acepta redirecciones relativas
      'Set-Cookie': `${COOKIE}=${persona}~${hasta}~${firma}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.floor((hasta - ahora) / 1000)}`,
    } });
  }

  // 2) Todo lo demás exige la cookie vigente de ESTA app
  const c = (request.headers.get('cookie') || '').split(/; */).find((x) => x.startsWith(COOKIE + '='));
  if (c) {
    const [persona, hasta, firma] = c.slice(COOKIE.length + 1).split('~');
    if (Number(hasta) > Date.now() && igual(firma, await hmac(['gate', host, persona, hasta].join('~')))) return; // sigue
  }
  return alPortal(request.method === 'GET' && !url.pathname.startsWith('/api/') ? url.href : '');
}
export { middleware };
