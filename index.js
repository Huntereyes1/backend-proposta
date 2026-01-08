const express = require('express');
const cors = require('cors');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const app = express();

/* =================================================
   🔥 CORS MANUAL (resolve origin: null, preflight)
================================================= */

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

/* =================================================
   CORS PACKAGE (mantido)
================================================= */

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

app.options('*', cors());

/* =================================================
   BODY PARSER (CORRETO / NATIVO)
================================================= */

app.use(express.json());

/* =================================================
   CONFIGURAÇÃO DA PASTA DE PDF
================================================= */

const PDF_DIR = path.join(__dirname, 'pdf');

if (!fs.existsSync(PDF_DIR)) {
  fs.mkdirSync(PDF_DIR);
}

/* =================================================
   ROTA RAIZ
================================================= */

app.get('/', (req, res) => {
  res.send('Backend de propostas online 🚀');
});

/* =================================================
   ENDPOINT PRINCIPAL
================================================= */

app.post('/gerar-proposta', (req, res) => {
  try {
    const {
      nome_empresa,
      nome_cliente,
      nome_material,
      comprimento_m,
      largura_m,
      espessura_cm
    } = req.body;

    const comprimento = parseFloat(comprimento_m);
    const largura = parseFloat(largura_m);
    const espessura = parseFloat(espessura_cm);

    if (
      !nome_empresa ||
      !nome_cliente ||
      !nome_material ||
      isNaN(comprimento) ||
      isNaN(largura) ||
      isNaN(espessura)
    ) {
      return res.status(400).json({
        error: 'Dados inválidos. Verifique os campos enviados.'
      });
    }

    const area = comprimento * largura;
    const volume = area * (espessura / 100);

    const doc = new PDFDocument({ margin: 50 });
    const fileName = `proposta_${Date.now()}.pdf`;
    const filePath = path.join(PDF_DIR, fileName);

    const writeStream = fs.createWriteStream(filePath);
    doc.pipe(writeStream);

    doc.fontSize(16).text('Proposta Técnica', { underline: true });
    doc.moveDown();

    doc.fontSize(12).text(`Empresa: ${nome_empresa}`);
    doc.text(`Cliente: ${nome_cliente}`);
    doc.text(`Material: ${nome_material}`);
    doc.moveDown();

    doc.text(`Dimensões: ${comprimento} m x ${largura} m`);
    doc.text(`Espessura: ${espessura} cm`);
    doc.text(`Área: ${area.toFixed(2)} m²`);
    doc.text(`Volume: ${volume.toFixed(3)} m³`);
    doc.moveDown();

    doc.fontSize(10).text(
      'Documento gerado automaticamente. Não substitui cálculo estrutural normativo.'
    );

    doc.end();

    writeStream.on('finish', () => {
      res.json({
        status: 'ok',
        area: area.toFixed(2),
        volume: volume.toFixed(3),
        pdf: `/pdf/${fileName}`
      });
    });

    writeStream.on('error', (err) => {
      console.error(err);
      res.status(500).json({
        error: 'Erro ao gerar o PDF'
      });
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: 'Erro interno ao gerar proposta'
    });
  }
});

/* =================================================
   SERVIR PDFs PUBLICAMENTE
================================================= */

app.use('/pdf', express.static(PDF_DIR));

/* =================================================
   PORTA DINÂMICA (RAILWAY)
================================================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Backend rodando na porta ${PORT}`);
});
