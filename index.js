const express = require('express');
const cors = require('cors');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const app = express();

/* ================================
   BASE URL
================================ */
const BASE_URL =
  process.env.BASE_URL || 'https://serene-luck-production.up.railway.app';

/* ================================
   MIDDLEWARE
================================ */
app.use(cors({ origin: '*' }));
app.use(express.json());

/* ================================
   DIRETÓRIO PDF
================================ */
const PDF_DIR = '/tmp/pdf';
if (!fs.existsSync(PDF_DIR)) {
  fs.mkdirSync(PDF_DIR, { recursive: true });
}

/* ================================
   SERVIR PDFs (SEM CACHE)
================================ */
app.use(
  '/pdf',
  express.static(PDF_DIR, {
    setHeaders: (res) => {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    },
  })
);

/* ================================
   HEALTHCHECK
================================ */
app.get('/', (req, res) => {
  res.send('Backend de propostas online 🚀');
});

/* ================================
   VIEWER HTML (PÁGINA INTERMEDIÁRIA)
================================ */
app.get('/viewer', (req, res) => {
  const pdfUrl = req.query.pdf;

  if (!pdfUrl) {
    return res.status(400).send('PDF não informado');
  }

  res.send(`
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Proposta Técnica</title>

  <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700&display=swap" rel="stylesheet">

  <style>
    body {
      font-family: 'Montserrat', sans-serif;
      background: #0f0f0f;
      color: #ffffff;
      margin: 0;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
    }

    .card {
      background: #1a1a1a;
      padding: 32px;
      border-radius: 12px;
      max-width: 420px;
      width: 90%;
      text-align: center;
      box-shadow: 0 0 40px rgba(0,0,0,0.4);
    }

    h1 {
      font-size: 20px;
      margin-bottom: 12px;
      font-weight: 700;
    }

    p {
      font-size: 14px;
      color: #cccccc;
      margin-bottom: 24px;
    }

    a.button {
      display: inline-block;
      background: #00c853;
      color: #000000;
      text-decoration: none;
      padding: 14px 22px;
      border-radius: 8px;
      font-weight: 700;
      font-size: 14px;
    }

    .footer {
      margin-top: 20px;
      font-size: 11px;
      color: #777;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>Proposta Técnica Gerada</h1>
    <p>Clique no botão abaixo para abrir o PDF da proposta técnica.</p>

    <a class="button" href="${pdfUrl}" target="_blank">
      Abrir PDF
    </a>

    <div class="footer">
      Sistema Automatizado de Engenharia
    </div>
  </div>
</body>
</html>
  `);
});

/* ================================
   GERAR PROPOSTA
================================ */
app.post('/gerar-proposta', (req, res) => {
  try {
    const {
      nome_empresa,
      nome_cliente,
      tipo_servico,
      nome_material,
      comprimento_m,
      largura_m,
      espessura_cm,
    } = req.body;

    const comprimento = Number(comprimento_m);
    const largura = Number(largura_m);
    const espessura = Number(espessura_cm);

    if (
      !nome_empresa ||
      !nome_cliente ||
      !tipo_servico ||
      !nome_material ||
      !Number.isFinite(comprimento) ||
      !Number.isFinite(largura) ||
      !Number.isFinite(espessura)
    ) {
      return res.status(400).send('Dados inválidos');
    }

    const area = comprimento * largura;
    const volume = area * (espessura / 100);

    const fileName = `proposta_${Date.now()}.pdf`;
    const filePath = path.join(PDF_DIR, fileName);

    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    doc.fontSize(18).text('PROPOSTA TÉCNICA', { underline: true });
    doc.moveDown();

    doc.fontSize(12);
    doc.text(`Empresa: ${nome_empresa}`);
    doc.text(`Cliente: ${nome_cliente}`);
    doc.text(`Serviço: ${tipo_servico}`);
    doc.text(`Material: ${nome_material}`);
    doc.moveDown();

    doc.text(`Área: ${area.toFixed(2)} m²`);
    doc.text(`Volume: ${volume.toFixed(3)} m³`);

    doc.end();

    stream.on('finish', () => {
      const pdfLink = `${BASE_URL}/pdf/${fileName}`;
      const viewerLink = `${BASE_URL}/viewer?pdf=${encodeURIComponent(
        pdfLink
      )}`;

      // 🔥 STRING PURA — IDEAL PARA TYPEBOT
      res.send(viewerLink);
    });

    stream.on('error', () => {
      res.status(500).send('Erro ao gerar PDF');
    });
  } catch (err) {
    res.status(500).send('Erro interno');
  }
});

/* ================================
   START
================================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Servidor rodando na porta', PORT);
});
