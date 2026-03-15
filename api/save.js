import nodemailer from 'nodemailer';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const DATABASE_ID = process.env.NOTION_DB_ID;
  const GMAIL_PASS = process.env.GMAIL_APP_PASSWORD;

  if (!NOTION_TOKEN || !DATABASE_ID) {
    return res.status(500).json({ error: 'Missing Notion configuration' });
  }

  try {
    const d = req.body;
    const PROP_COMUNICACION = 'Comunicaci\u00f3n Efectiva';
    const PROP_TOLERANCIA = 'Tolerancia bajo Presi\u00f3n';
    const PROP_ORGANIZACION = 'Organizaci\u00f3n y Planeamiento';
    const PROP_AREAS = '\u00c1reas de Mejora';
    const PROP_PLAN = 'Plan de Acci\u00f3n';

    const properties = {
      "Evaluado": { title: [{ text: { content: d.evaluado || '' } }] },
      "Cargo Evaluado": { rich_text: [{ text: { content: d.cargoEvd || '' } }] },
      "Evaluador": { rich_text: [{ text: { content: d.evaluador || '' } }] },
      "Cargo Evaluador": { rich_text: [{ text: { content: d.cargoEv || '' } }] },
      "Local": { select: { name: d.local || 'BC1' } },
      "Fecha": { date: { start: d.fecha || new Date().toISOString().split('T')[0] } },
      "Puntaje General": { number: parseFloat(d.puntajeGeneral) || 0 },
      "Banda": { select: { name: d.banda || 'Bueno' } },
      "Trabajo en Equipo": { number: parseFloat(d.trabajoEquipo) || 0 },
      "Proactividad": { number: parseFloat(d.proactividad) || 0 },
      [PROP_COMUNICACION]: { number: parseFloat(d.comunicacion) || 0 },
      [PROP_TOLERANCIA]: { number: parseFloat(d.tolerancia) || 0 },
      [PROP_ORGANIZACION]: { number: parseFloat(d.organizacion) || 0 },
      "Fit Cultural": { number: parseFloat(d.fitCultural) || 0 },
    };

    if (d.fortalezas) properties["Fortalezas"] = { rich_text: [{ text: { content: d.fortalezas.substring(0, 2000) } }] };
    if (d.mejoras) properties[PROP_AREAS] = { rich_text: [{ text: { content: d.mejoras.substring(0, 2000) } }] };
    if (d.plan) properties[PROP_PLAN] = { rich_text: [{ text: { content: d.plan.substring(0, 2000) } }] };
    if (d.seguimiento) properties["Seguimiento"] = { date: { start: d.seguimiento } };

    let content = '## Detalle de Puntajes\n\n';
    if (d.detalle && Array.isArray(d.detalle)) {
      d.detalle.forEach(comp => {
        content += '### ' + comp.name + ' \u2014 ' + comp.avg + '\n';
        comp.questions.forEach(q => {
          content += '- ' + q.text + ': **' + q.score + '/5**\n';
        });
        content += '\n';
      });
    }

    const notionResp = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + NOTION_TOKEN,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ parent: { database_id: DATABASE_ID }, properties, children: content ? buildBlocks(content) : [] })
    });

    const result = await notionResp.json();
    if (!notionResp.ok) {
      console.error('Notion API error:', JSON.stringify(result));
      return res.status(notionResp.status).json({ error: result.message || 'Notion API error' });
    }

    // Google Calendar: create follow-up event if seguimiento date is set
    let calendarEventId = null;
    if (d.seguimiento) {
      try {
        calendarEventId = await createCalendarEvent(d);
      } catch (calErr) {
        console.error('Calendar error (non-fatal):', calErr.message);
      }
    }

    // Send email report
    let emailStatus = null;
    if (GMAIL_PASS) {
      try {
        const transporter = nodemailer.createTransport({
          service: 'gmail',
          auth: { user: 'focawear@gmail.com', pass: GMAIL_PASS }
        });

        const score = parseFloat(d.puntajeGeneral) || 0;
        const banda = d.banda || 'Bueno';
        const bandaColor = banda === 'Excelente' ? '#4ade80' : banda === 'Bueno' ? '#60a5fa' : banda === 'Necesita Mejora' ? '#facc15' : '#f87171';
        const scorePct = Math.round((score / 5) * 100);

        const subject = `📋 Evaluación ${d.evaluado || 'Sin nombre'} | ${d.local || 'BC'} | ${score.toFixed(1)}/5 — ${banda}`;

        const emailHtml = buildEmailHtml(d, result.url, bandaColor, scorePct);

        const info = await transporter.sendMail({
          from: '"BlackChicken People 👥" <focawear@gmail.com>',
          to: 'jonathan@blackchicken.cl, llige@blackchicken.cl',
          subject,
          html: emailHtml
        });
        emailStatus = info.messageId;
      } catch (emailErr) {
        console.error('Email error (non-fatal):', emailErr.message);
        emailStatus = 'error: ' + emailErr.message;
      }
    }

    return res.status(200).json({ success: true, pageId: result.id, url: result.url, calendarEventId, emailStatus });
  } catch (err) {
    console.error('Error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function getHex(v) {
  if (v >= 4) return '#4ade80';
  if (v >= 3) return '#60a5fa';
  if (v >= 2) return '#facc15';
  return '#f87171';
}

function buildEmailHtml(d, notionUrl, bandaColor, scorePct) {
  const score = parseFloat(d.puntajeGeneral) || 0;
  const banda = d.banda || 'Bueno';

  let compRows = '';
  if (d.detalle && Array.isArray(d.detalle)) {
    d.detalle.forEach(comp => {
      const avg = parseFloat(comp.avg) || 0;
      const color = getHex(avg);
      compRows += `
        <tr>
          <td style="padding:10px 16px;font-size:13px;color:#e0e0e0;border-bottom:1px solid #2a2a2a;">${comp.name}</td>
          <td style="padding:10px 16px;text-align:center;border-bottom:1px solid #2a2a2a;">
            <span style="background:${color}22;color:${color};font-weight:700;padding:3px 10px;border-radius:6px;font-size:13px;">${avg}/5</span>
          </td>
          <td style="padding:10px 16px;border-bottom:1px solid #2a2a2a;">
            <div style="background:#2a2a2a;border-radius:4px;height:8px;width:120px;">
              <div style="background:${color};width:${Math.round(avg/5*100)}%;height:100%;border-radius:4px;"></div>
            </div>
          </td>
        </tr>`;
      comp.questions.forEach(q => {
        const qColor = getHex(q.score);
        compRows += `
          <tr>
            <td style="padding:6px 16px 6px 32px;font-size:11px;color:#888;border-bottom:1px solid #1f1f1f;" colspan="2">↳ ${q.text}</td>
            <td style="padding:6px 16px;border-bottom:1px solid #1f1f1f;text-align:center;">
              <span style="background:${qColor}22;color:${qColor};font-weight:700;padding:2px 8px;border-radius:4px;font-size:11px;">${q.score}/5</span>
            </td>
          </tr>`;
      });
    });
  }

  const comentarios = [];
  if (d.fortalezas) comentarios.push({ label: '✅ FORTALEZAS', color: '#4ade80', text: d.fortalezas });
  if (d.mejoras) comentarios.push({ label: '⚠️ ÁREAS DE MEJORA', color: '#facc15', text: d.mejoras });
  if (d.plan) comentarios.push({ label: '🎯 PLAN DE ACCIÓN', color: '#60a5fa', text: d.plan });

  let comentariosHtml = '';
  comentarios.forEach(c => {
    comentariosHtml += `
      <div style="margin-bottom:16px;">
        <div style="font-size:11px;font-weight:700;color:${c.color};letter-spacing:0.5px;margin-bottom:6px;">${c.label}</div>
        <div style="background:#1a1a1a;border-left:3px solid ${c.color};padding:10px 14px;border-radius:0 6px 6px 0;font-size:13px;color:#ccc;font-style:italic;">${c.text}</div>
      </div>`;
  });

  const seguimientoHtml = d.seguimiento ? `
    <div style="background:#1a1505;border:1px solid #d4a843;border-radius:10px;padding:14px 18px;margin:20px 0;display:flex;align-items:center;gap:12px;">
      <span style="font-size:1.4rem;">🔔</span>
      <div>
        <div style="font-size:13px;font-weight:600;color:#d4a843;">Seguimiento programado</div>
        <div style="font-size:12px;color:#888;margin-top:2px;">Recordatorio agendado para el <strong style="color:#e0e0e0;">${d.seguimiento}</strong></div>
      </div>
    </div>` : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0f0f0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<div style="max-width:620px;margin:0 auto;padding:20px;">

  <!-- Header -->
  <div style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:14px 14px 0 0;padding:24px 28px;display:flex;align-items:center;gap:14px;">
    <div style="background:#d4a843;width:44px;height:44px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:18px;color:#111;flex-shrink:0;">BC</div>
    <div>
      <div style="font-size:18px;font-weight:700;color:white;">Evaluación de Desempeño</div>
      <div style="font-size:12px;color:#888;margin-top:2px;">BlackChicken People · ${d.local || 'BC'} · ${d.fecha || ''}</div>
    </div>
  </div>

  <!-- Score Banner -->
  <div style="background:${bandaColor}15;border:1px solid ${bandaColor}44;border-top:none;border-radius:0 0 14px 14px;padding:20px 28px;margin-bottom:16px;">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">
      <div>
        <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Evaluado(a)</div>
        <div style="font-size:20px;font-weight:800;color:white;">${d.evaluado || 'Sin nombre'}</div>
        <div style="font-size:13px;color:#aaa;margin-top:2px;">${d.cargoEvd || ''} · Evaluado por ${d.evaluador || ''} ${d.cargoEv ? '(' + d.cargoEv + ')' : ''}</div>
      </div>
      <div style="text-align:center;">
        <div style="font-size:42px;font-weight:900;color:${bandaColor};line-height:1;">${score.toFixed(1)}</div>
        <div style="font-size:11px;color:#888;">de 5.0</div>
        <div style="background:${bandaColor}22;color:${bandaColor};padding:4px 12px;border-radius:8px;font-size:12px;font-weight:700;margin-top:6px;">${banda}</div>
      </div>
    </div>
    <div style="margin-top:14px;">
      <div style="background:#2a2a2a;border-radius:6px;height:10px;">
        <div style="background:${bandaColor};width:${scorePct}%;height:100%;border-radius:6px;"></div>
      </div>
    </div>
  </div>

  <!-- Competencias -->
  <div style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;overflow:hidden;margin-bottom:16px;">
    <div style="padding:14px 18px;border-bottom:1px solid #2a2a2a;">
      <span style="font-size:13px;font-weight:700;color:#d4a843;text-transform:uppercase;letter-spacing:1px;">📊 Puntaje por Competencia</span>
    </div>
    <table style="width:100%;border-collapse:collapse;">
      <thead>
        <tr style="background:#111;">
          <th style="padding:8px 16px;text-align:left;font-size:11px;color:#555;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Competencia</th>
          <th style="padding:8px 16px;text-align:center;font-size:11px;color:#555;font-weight:600;">Puntaje</th>
          <th style="padding:8px 16px;font-size:11px;color:#555;font-weight:600;">Progreso</th>
        </tr>
      </thead>
      <tbody>${compRows}</tbody>
    </table>
  </div>

  ${comentariosHtml ? `<div style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;padding:18px;margin-bottom:16px;">
    <div style="font-size:13px;font-weight:700;color:#d4a843;text-transform:uppercase;letter-spacing:1px;margin-bottom:14px;">💬 Comentarios y Plan</div>
    ${comentariosHtml}
  </div>` : ''}

  ${seguimientoHtml}

  ${notionUrl ? `<div style="text-align:center;margin:20px 0;">
    <a href="${notionUrl}" style="background:#d4a843;color:#111;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px;display:inline-block;">📝 Ver en Notion</a>
  </div>` : ''}

  <!-- Footer -->
  <div style="text-align:center;font-size:11px;color:#333;padding:16px 0;border-top:1px solid #1a1a1a;margin-top:8px;">
    BlackChicken People · Sistema de Evaluaciones de Desempeño · ${new Date().toLocaleDateString('es-CL')}
  </div>
</div>
</body>
</html>`;
}

async function getGoogleAccessToken() {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error('Failed to get access token: ' + JSON.stringify(data));
  return data.access_token;
}

async function createCalendarEvent(d) {
  const accessToken = await getGoogleAccessToken();
  const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';

  const title = 'Seguimiento: ' + (d.evaluado || 'Evaluado');
  const description = [
    'Evaluaci\u00f3n de desempe\u00f1o realizada el ' + (d.fecha || ''),
    'Evaluador: ' + (d.evaluador || '') + ' (' + (d.cargoEv || '') + ')',
    'Local: ' + (d.local || ''),
    'Puntaje General: ' + (d.puntajeGeneral || '') + ' — Banda: ' + (d.banda || ''),
    '',
    d.plan ? 'Plan de Acci\u00f3n:\n' + d.plan : ''
  ].filter(Boolean).join('\n');

  const event = {
    summary: title,
    description: description,
    start: { date: d.seguimiento },
    end: { date: d.seguimiento },
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'email', minutes: 24 * 60 },
        { method: 'popup', minutes: 60 }
      ]
    }
  };

  const resp = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(event)
    }
  );

  const result = await resp.json();
  if (!resp.ok) throw new Error('Calendar API error: ' + JSON.stringify(result));
  return result.id;
}

function buildBlocks(markdown) {
  const blocks = [];
  const lines = markdown.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.startsWith('## ')) {
      blocks.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: [{ text: { content: line.replace('## ', '') } }] } });
    } else if (line.startsWith('### ')) {
      blocks.push({ object: 'block', type: 'heading_3', heading_3: { rich_text: [{ text: { content: line.replace('### ', '') } }] } });
    } else if (line.startsWith('- ')) {
      const text = line.replace('- ', '');
      const parts = text.split('**');
      const richText = [];
      parts.forEach((part, i) => { if (part) richText.push({ text: { content: part }, annotations: { bold: i % 2 === 1 } }); });
      blocks.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: richText } });
    } else {
      blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ text: { content: line } }] } });
    }
  }
  return blocks;
}
