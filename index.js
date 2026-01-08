const express = require('express');
const cors = require('cors');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const app = express();

/* ================================
   CORS SIMPLES E ESTÁVEL
================================ */
app.use(cors({ origin: '*' }));
app.use(express.json());

/* ================================
   HEALTHCHECK / RAIZ
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
      !nome_material ||
      !Number.isFinite(comprimento) ||
      !Number.isFinite(largura) ||
      !Number.isFinite(espessura)
    ) {
      return res.status(400).json({ error: 'Dados inválidos' });
    }

    const area = comprimento * largura;
    const volume = area * (espessura / 100);

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
      res.json({
        status: 'ok',
        area: area.toFixed(2),
        volume: volume.toFixed(3),
        pdf: `/pdf/${fileName}`
      });
    });

    stream.on('error', err => {
      console.error(err);
      res.status(500).json({ error: 'Erro ao gerar PDF' });
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

/* ================================
   SERVIR PDFs
================================ */
app.use('/pdf', express.static(PDF_DIR));

/* ================================
   PORTA
================================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Servidor rodando na porta', PORT);
});
