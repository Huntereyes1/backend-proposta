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
   CONTROLE DO ÚLTIMO PDF
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
      res.setHeader('Cache-Control', 'no-store');
    },
  })
);

/* ================================
   ROTA FIXA
================================ */
app.get('/pdf/proposta.pdf', (req, res) => {
  if (!lastPdfFile) {
    return res.status(404).send('PDF ainda não gerado');
  }
  res.redirect(`${BASE_URL}/pdf/${lastPdfFile}`);
});

/* ================================
   HEALTHCHECK
================================ */
app.get('/', (req, res) => {
  res.send('Backend de comprovação online 🚜');
});

/* ================================
   GERAR RELATÓRIO
================================ */
app.post('/gerar-proposta', (req, res) => {
  try {
    const {
      nome_empresa,
      nome_cliente,
      tipo_servico,
      comprimento_m,
      largura_m,
      altura_m,
    } = req.body;

    const comprimento = Number(comprimento_m);
    const largura = Number(largura_m);
    const altura = Number(altura_m);

    if (
      !nome_empresa ||
      !nome_cliente ||
      !tipo_servico ||
      !Number.isFinite(comprimento) ||
      !Number.isFinite(largura) ||
      !Number.isFinite(altura)
    ) {
      return res.status(400).send('❌ Dados inválidos.');
    }

    const area = comprimento * largura;
    const volume = area * altura;

    const fileName = `relatorio-${Date.now()}.pdf`;
    const filePath = path.join(PDF_DIR, fileName);

    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    doc.fontSize(16).text('RELATÓRIO TÉCNICO DE MEDIÇÃO E COMPROVAÇÃO', {
      align: 'center',
    });

    doc.moveDown();
    doc.fontSize(12);
    doc.text(`Empresa: ${nome_empresa}`);
    doc.text(`Responsável: ${nome_cliente}`);
    doc.text(`Tipo de serviço: ${tipo_servico}`);

    doc.moveDown();
    doc.text(`Comprimento: ${comprimento} m`);
    doc.text(`Largura: ${largura} m`);
    doc.text(`Altura média: ${altura} m`);

    doc.moveDown();
    doc.text(`Área calculada: ${area.toFixed(2)} m²`);
    doc.text(`Volume calculado: ${volume.toFixed(2)} m³`);

    doc.end();

    stream.on('finish', () => {
      lastPdfFile = fileName;
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
