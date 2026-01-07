const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.json());

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

    // 🔢 CÁLCULO LIMPO (sem erro, sem mágica)
    const espessura = parseFloat(espessura_cm); // "12 cm" -> 12
    const area = comprimento_m * largura_m;
    const volume = area * (espessura / 100);

    // 📄 GERAR PDF
    const doc = new PDFDocument();
    const fileName = `proposta_${Date.now()}.pdf`;
    const filePath = path.join(__dirname, fileName);

    doc.pipe(fs.createWriteStream(filePath));

    doc.fontSize(16).text('Proposta Técnica', { underline: true });
    doc.moveDown();

    doc.fontSize(12).text(`Empresa: ${nome_empresa}`);
    doc.text(`Cliente: ${nome_cliente}`);
    doc.text(`Material: ${nome_material}`);
    doc.moveDown();

    doc.text(`Dimensões: ${comprimento_m} m x ${largura_m} m`);
    doc.text(`Espessura: ${espessura} cm`);
    doc.text(`Área: ${area.toFixed(2)} m²`);
    doc.text(`Volume: ${volume.toFixed(3)} m³`);
    doc.moveDown();

    doc.fontSize(10).text(
      'Documento gerado automaticamente. Não substitui cálculo estrutural normativo.'
    );

    doc.end();

    res.json({
      status: 'ok',
      area: area.toFixed(2),
      volume: volume.toFixed(3),
      pdf: `/${fileName}`
    });

  } catch (err) {
    res.status(500).json({ error: 'Erro ao gerar proposta' });
  }
});

app.use(express.static(__dirname));

app.listen(3000, () => {
  console.log('Backend rodando em http://localhost:3000');
});
