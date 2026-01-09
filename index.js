const express = require('express');
const cors = require('cors');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
   GERAR PROPOSTA (ID ÚNICO)
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

    // 🔥 ID ÚNICO POR PROPOSTA
    const proposalId = crypto.randomUUID();
    const fileName = `proposta_${proposalId}.pdf`;
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
      // 🔥 URL FIXA + ID (Typebot friendly)
      res.send(`${BASE_URL}/abrir-proposta/${proposalId}`);
    });

    stream.on('error', () => {
      res.status(500).send('Erro ao gerar PDF');
    });

  } catch (err) {
    res.status(500).send('Erro interno');
  }
});

/* ================================
   ABRIR PROPOSTA (ROTA FIXA)
================================ */
app.get('/abrir-proposta/:id', (req, res) => {
  const { id } = req.params;
  const filePath = path.join(PDF_DIR, `proposta_${id}.pdf`);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Proposta não encontrada');
  }

  // 🔥 REDIRECT DIRETO PARA O PDF
  res.redirect(`/pdf/proposta_${id}.pdf?t=${Date.now()}`);
});

/* ================================
   START
================================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Servidor rodando na porta', PORT);
});
