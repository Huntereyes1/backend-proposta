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
app.use('/pdf', express.static(PDF_DIR, {
  setHeaders: (res) => {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));

/* ================================
   HEALTHCHECK
================================ */
app.get('/', (req, res) => {
  res.send('Backend de propostas online 🚀');
});

/* ================================
   VIEWER (HTML SEM CACHE)
================================ */
app.get('/viewer', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  res.sendFile(path.join(__dirname, 'viewer.html'));
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
      espessura_cm
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
      return res.status(400).send('❌ Dados inválidos.');
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
    doc.moveDown();
    doc.fontSize(10).text(
      'Documento gerado automaticamente. Não substitui análise estrutural normativa.'
    );

    doc.end();

    stream.on('finish', () => {
      const viewerUrl =
        `${BASE_URL}/viewer?pdf=${fileName}&t=${Date.now()}`;

      // 🔥 STRING PURA para Redirect do Typebot
      res.send(viewerUrl);
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
