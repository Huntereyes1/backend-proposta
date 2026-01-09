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
      res.setHeader(
        'Cache-Control',
        'no-store, no-cache, must-revalidate, proxy-revalidate'
      );
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
   GERAR PROPOSTA (COM TEMPLATE CANVA)
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
      return res.status(400).send('❌ Dados inválidos.');
    }

    const area = comprimento * largura;
    const volume = area * (espessura / 100);

    /* ================================
       PDF ÚNICO (SEM CACHE)
    ================================ */
    const fileName = `proposta-${Date.now()}.pdf`;
    const filePath = path.join(PDF_DIR, fileName);

    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    /* ================================
       TEMPLATE DO CANVA (FUNDO)
       ⚠ template.png NA MESMA PASTA
    ================================ */
    const templatePath = path.join(__dirname, 'template.png');
    doc.image(templatePath, 0, 0, {
      width: 595.28,
      height: 841.89,
    });

    /* ================================
       TEXTO SOBRE O TEMPLATE
       (AJUSTE UMA VEZ SÓ)
    ================================ */
    doc.fillColor('#000');
    doc.fontSize(12);

    doc.text(nome_empresa, 90, 260);
    doc.text(nome_cliente, 90, 285);
    doc.text(tipo_servico, 90, 310);
    doc.text(nome_material, 90, 335);

    doc.text(`${area.toFixed(2)} m²`, 90, 390);
    doc.text(`${volume.toFixed(3)} m³`, 90, 420);

    doc.end();

    stream.on('finish', () => {
      res.send(`${BASE_URL}/pdf/${fileName}`);
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
