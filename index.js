const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// 📁 Pasta de PDFs
const PDF_DIR = path.join(__dirname, 'pdf');

// Cria a pasta /pdf se não existir (blindagem total)
if (!fs.existsSync(PDF_DIR)) {
  fs.mkdirSync(PDF_DIR);
}

// 🟢 Rota raiz (opcional, mas evita "Cannot GET /")
app.get('/', (req, res) => {
  res.send('Backend de propostas online 🚀');
});

// Endpoint principal
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

    // 🔒 SANITIZAÇÃO DE NÚMEROS
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

    // 🔢 CÁLCULOS
    const area = comprimento * largura;
    const volume = area * (espessura / 100);

    // 📄 GERAR PDF
    const doc = new PDFDocument({ margin: 50 });
    const fileName = `proposta_${Date.now()}.pdf`;
    const filePath = path.join(PDF_DIR, fileName);

    doc.pipe(fs.createWriteStream(filePath));

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

    // ✅ RESPOSTA LIMPA
    res.json({
      status: 'ok',
      area: area.toFixed(2),
      volume: volume.toFixed(3),
      pdf: `/pdf/${fileName}`
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno ao gerar proposta' });
  }
});

// 🌐 Servir PDFs publicamente
app.use('/pdf', express.static(PDF_DIR));

// 🚀 PORTA DINÂMICA (Railway)
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Backend rodando na porta ${PORT}`);
});
