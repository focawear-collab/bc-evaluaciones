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

    // Build properties
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
      "ComunicaciÃ³n Efectiva": { number: parseFloat(d.comunicacion) || 0 },
      "Tolerancia bajo PresiÃ³n": { number: parseFloat(d.tolerancia) || 0 },
      "OrganizaciÃ³n y Planeamiento": { number: parseFloat(d.organizacion) || 0 },
      "Fit Cultural": { number: parseFloat(d.fitCultural) || 0 },
    };

    if (d.fortalezas) properties["Fortalezas"] = { rich_text: [{ text: { content: d.fortalezas.substring(0, 2000) } }] };
    if (d.mejoras) properties["Ãreas de Mejora"] = { rich_text: [{ text: { content: d.mejoras.substring(0, 2000) } }] };
    if (d.plan) properties["Plan de AcciÃ³n"] = { rich_text: [{ text: { content: d.plan.substring(0, 2000) } }] };
    if (d.seguimiento) properties["Seguimiento"] = { date: { start: d.seguimiento } };

    // Build page content with detailed scores
    let content = `## Detalle de Puntajes\n\n`;
    if (d.detalle && Array.isArray(d.detalle)) {
      d.detalle.forEach(comp => {
        content += `### ${comp.name} â ${comp.avg}\n`;
        comp.questions.forEach(q => {
          content += `- ${q.text}: **${q.score}/5**\n`;
        });
        content += `\n`;
      });
    }

    const response = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        parent: { database_id: DATABASE_ID },
        properties,
        children: content ? buildBlocks(content) : []
      })
    });

    const result = await response.json();
    if (!response.ok) {
      console.error('Notion API error:', JSON.stringify(result));
      return res.status(response.status).json({ error: result.message || 'Notion API error' });
    }

    return res.status(200).json({ success: true, pageId: result.id, url: result.url });
  } catch (err) {
    console.error('Error:', err);
    return res.status(500).json({ error: err.message });
  }
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
      parts.forEach((part, i) => {
        if (part) richText.push({ text: { content: part }, annotations: { bold: i % 2 === 1 } });
      });
      blocks.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: richText } });
    } else {
      blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ text: { content: line } }] } });
    }
  }
  return blocks;
}
