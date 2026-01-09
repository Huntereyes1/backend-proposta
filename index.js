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
   🔥 CONTROLE DO ÚLTIMO PDF
================================ */
let lastPdfFile = null;

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
   ROTA DE COMPATIBILIDADE 🔥
   /pdf/proposta.pdf
================================ */
app.get('/pdf/proposta.pdf', (req, res) => {
  if (!lastPdfFile) {
    return res.status(404).send('PDF ainda não gerado');
  }

  // 🔥 REDIRECIONA PARA O PDF REAL (URL ÚNICA)
  res.redirect(`${BASE_URL}/pdf/${lastPdfFile}`);
});

/* ================================
   HEALTHCHECK
================================ */
app.get('/', (req, res) => {
  res.send('Backend de propostas online 🚀');
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
      return res.status(400).send('❌ Dados inválidos.');
    }

    const area = comprimento * largura;
    const volume = area * (espessura / 100);

    /* ================================
       🔥 PDF COM NOME ÚNICO
    ================================ */
    const uniqueName = `proposta-${Date.now()}.pdf`;
    const filePath = path.join(PDF_DIR, uniqueName);

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
    doc
      .fontSize(10)
      .text(
        'Documento gerado automaticamente. Não substitui análise estrutural normativa.'
      );

    doc.end();

    stream.on('finish', () => {
      // 🔥 guarda o último PDF
      lastPdfFile = uniqueName;

      // 🔥 retorna URL ÚNICA (mobile perfeito)
      res.send(`${BASE_URL}/pdf/${uniqueName}`);
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
