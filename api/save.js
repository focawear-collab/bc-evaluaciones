import nodemailer from 'nodemailer';

const EMAIL_RECIPIENTS = [
  'talentos@blackchicken.cl',
  'jonathan@blackchicken.cl',
  'llige@blackchicken.cl'
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const DATABASE_ID = process.env.NOTION_DB_ID;

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

    // Email con PDF adjunto via nodemailer
    let emailSent = false;
    let emailError = null;
    try {
      emailSent = await sendEvaluationEmail(d);
    } catch (emailErr) {
      console.error('Email error (non-fatal):', emailErr.message);
      emailError = emailErr.message;
    }

    return res.status(200).json({
      success: true,
      pageId: result.id,
      url: result.url,
      calendarEventId,
      emailSent,
      emailError
    });
  } catch (err) {
    console.error('Error:', err);
    return res.status(500).json({ error: err.message });
  }
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
      headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(event)
    }
  );
  const result = await resp.json();
  if (!resp.ok) throw new Error('Calendar API error: ' + JSON.stringify(result));
  return result.id;
}

async function sendEvaluationEmail(d) {
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.GMAIL_APP_PASSWORD || process.env.SMTP_PASS;
  if (!smtpUser || !smtpPass) {
    throw new Error('Missing SMTP configuration (SMTP_USER / GMAIL_APP_PASSWORD)');
  }

  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: { user: smtpUser, pass: smtpPass }
  });

  const puntaje = parseFloat(d.puntajeGeneral) || 0;
  const banda = d.banda || 'Sin banda';
  const subject = `Evaluación de Desempeño — ${d.evaluado || 'Empleado'} (${banda} · ${puntaje.toFixed(1)}/5.0) — ${d.local || 'BC'}`;

  const attachments = [];
  if (d.pdfBase64) {
    attachments.push({
      filename: 'Evaluacion_' + (d.evaluado || 'Empleado').replace(/\s+/g, '_') + '.pdf',
      content: Buffer.from(d.pdfBase64, 'base64'),
      contentType: 'application/pdf'
    });
  }

  const emailHTML = d.emailHTML || buildFallbackEmailHTML(d);

  await transporter.sendMail({
    from: `"BlackChicken Evaluaciones" <${smtpUser}>`,
    to: EMAIL_RECIPIENTS.join(', '),
    subject,
    html: emailHTML,
    attachments
  });

  return true;
}

function buildFallbackEmailHTML(d) {
  const puntaje = parseFloat(d.puntajeGeneral) || 0;
  return `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
    <div style="background:#0f0f14;padding:20px;border-radius:8px 8px 0 0;text-align:center">
      <h2 style="color:#D4A843;margin:0">Evaluación de Desempeño</h2>
      <p style="color:#999;margin:4px 0 0;font-size:13px">BlackChicken</p>
    </div>
    <div style="padding:20px;border:1px solid #e0e0e0;border-top:none">
      <p><strong>Evaluado:</strong> ${d.evaluado || '—'} (${d.cargoEvd || '—'})</p>
      <p><strong>Evaluador:</strong> ${d.evaluador || '—'} (${d.cargoEv || '—'})</p>
      <p><strong>Local:</strong> ${d.local || '—'} · <strong>Fecha:</strong> ${d.fecha || '—'}</p>
      <p style="font-size:24px;font-weight:bold;text-align:center">${puntaje.toFixed(1)} — ${d.banda || '—'}</p>
      <p style="font-size:12px;color:#888;text-align:center">Ver PDF adjunto para el informe completo.</p>
    </div></div>`;
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
