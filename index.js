const express = require('express');
const cors = require('cors');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const app = express();

/* ================================
   BASE URL (PROD / RAILWAY)
================================ */
const BASE_URL =
  process.env.BASE_URL || 'https://serene-luck-production.up.railway.app';

/* ================================
   ARMAZENA O ÚLTIMO PDF GERADO
================================ */
let lastPdfFile = null;

/* ================================
   CORS
================================ */
app.use(cors({ origin: '*' }));
app.use(express.json());

/* ================================
   HEALTHCHECK
================================ */
app.get('/', (req, res) => {
  res.send('Backend de propostas online 🚀');
});

/* ================================
   DIRETÓRIO TEMP (RAILWAY SAFE)
================================ */
const PDF_DIR = '/tmp/pdf';
if (!fs.existsSync(PDF_DIR)) {
  fs.mkdirSync(PDF_DIR, { recursive: true });
}

/* ================================
   GERAR PROPOSTA
================================ */
app.post('/gerar-proposta', async (req, res) => {
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

    const comprimento = Number(String(comprimento_m).replace(',', '.'));
    const largura = Number(String(largura_m).replace(',', '.'));
    const espessura = Number(String(espessura_cm).replace(',', '.'));

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

    /* ================================
       CÁLCULOS
    ================================ */
    const area = comprimento * largura;
    const volume = area * (espessura / 100);

    /* ================================
       GERAR PDF
    ================================ */
    const fileName = `proposta_${Date.now()}.pdf`;
    const filePath = path.join(PDF_DIR, fileName);

    const doc = new PDFDocument({ margin: 50 });
    const stream = fs.createWriteStream(filePath);

    doc.pipe(stream);

    doc.fontSize(18).text('Proposta Técnica', { underline: true });
    doc.moveDown();

    doc.fontSize(12);
    doc.text(`Empresa: ${nome_empresa}`);
    doc.text(`Cliente: ${nome_cliente}`);
    doc.text(`Serviço: ${tipo_servico}`);
    doc.text(`Material: ${nome_material}`);
    doc.moveDown();

    doc.text(`Comprimento: ${comprimento} m`);
    doc.text(`Largura: ${largura} m`);
    doc.text(`Espessura: ${espessura} cm`);
    doc.moveDown();

    doc.text(`Área: ${area.toFixed(2)} m²`);
    doc.text(`Volume: ${volume.toFixed(3)} m³`);
    doc.moveDown();

    doc.fontSize(10).text(
      'Documento gerado automaticamente. Não substitui cálculo estrutural normativo.'
    );

    doc.end();

    stream.on('finish', () => {
      // 🔥 salva o último PDF
      lastPdfFile = fileName;

      // resposta simples (Typebot friendly)
      res.send(
        `✅ Proposta técnica gerada com sucesso.\n\n` +
        `📐 Área: ${area.toFixed(2)} m²\n` +
        `📦 Volume: ${volume.toFixed(3)} m³\n\n` +
        `📄 Clique no link abaixo para abrir o PDF:\n` +
        `${BASE_URL}/pdf/ultimo`
      );
    });

    stream.on('error', err => {
      console.error(err);
      res.status(500).send('Erro ao gerar PDF');
    });

  } catch (err) {
    console.error(err);
    res.status(500).send('Erro interno');
  }
});

/* ================================
   ENDPOINT FIXO: ÚLTIMO PDF
================================ */
app.get('/pdf/ultimo', (req, res) => {
  if (!lastPdfFile) {
    return res.status(404).send('Nenhum PDF gerado ainda.');
  }

  res.sendFile(path.join(PDF_DIR, lastPdfFile));
});

/* ================================
   SERVIR PDFs (ACESSO DIRETO)
================================ */
app.use('/pdf', express.static(PDF_DIR));

/* ================================
   PORTA
================================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Servidor rodando na porta', PORT);
});
