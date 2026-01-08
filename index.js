const express = require('express');
const cors = require('cors');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const app = express();

/* ================================
   BASE URL (RAILWAY)
================================ */
const BASE_URL =
  process.env.BASE_URL || 'https://serene-luck-production.up.railway.app';

/* ================================
   MIDDLEWARE
================================ */
app.use(cors({ origin: '*' }));
app.use(express.json());

/* ================================
   DIRETÓRIO TEMP
================================ */
const PDF_DIR = '/tmp/pdf';
if (!fs.existsSync(PDF_DIR)) {
  fs.mkdirSync(PDF_DIR, { recursive: true });
}

/* ================================
   CONTROLE DO ÚLTIMO PDF
================================ */
let ultimoPdfGerado = null;

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
      return res.status(400).send('❌ Dados inválidos.');
    }

    const area = comprimento * largura;
    const volume = area * (espessura / 100);

    const fileName = `proposta_${Date.now()}.pdf`;
    const filePath = path.join(PDF_DIR, fileName);

    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    /* ================================
       HEADER VISUAL
    ================================ */
    doc.rect(0, 0, doc.page.width, 80).fill('#111111');

    doc
      .fillColor('#FFFFFF')
      .fontSize(20)
      .text('PROPOSTA TÉCNICA • ORÇAMENTO', 50, 25);

    doc
      .fontSize(10)
      .fillColor('#CCCCCC')
      .text('Sistema Automatizado de Engenharia', 50, 55);

    doc.moveDown(3);
    doc.fillColor('#000000');

    /* ================================
       DADOS DO PROJETO
    ================================ */
    doc.fontSize(12).font('Helvetica-Bold').text('DADOS DO PROJETO');
    doc.moveDown(0.5);

    doc.font('Helvetica').fontSize(11);
    doc.text(`Empresa: ${nome_empresa}`);
    doc.text(`Cliente: ${nome_cliente}`);
    doc.text(`Serviço: ${tipo_servico}`);
    doc.text(`Material: ${nome_material}`);

    doc.moveDown(1);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#DDDDDD');
    doc.moveDown(1);

    /* ================================
       DIMENSÕES
    ================================ */
    const boxY = doc.y;
    doc.rect(50, boxY, 495, 90).fill('#F5F5F5');

    doc
      .fillColor('#000000')
      .font('Helvetica-Bold')
      .fontSize(12)
      .text('DIMENSÕES INFORMADAS', 60, boxY + 10);

    doc.font('Helvetica').fontSize(11);
    doc.text(`Comprimento: ${comprimento} m`, 60, boxY + 35);
    doc.text(`Largura: ${largura} m`, 60, boxY + 50);
    doc.text(`Espessura: ${espessura} cm`, 60, boxY + 65);

    doc.moveDown(7);

    /* ================================
       RESULTADOS
    ================================ */
    const resultY = doc.y;
    doc.rect(50, resultY, 495, 110).fill('#EDEDED');

    doc
      .fillColor('#000000')
      .font('Helvetica-Bold')
      .fontSize(13)
      .text('RESULTADOS TÉCNICOS', 60, resultY + 10);

    doc
      .fontSize(20)
      .text(`Área Total: ${area.toFixed(2)} m²`, 60, resultY + 45);

    doc
      .fontSize(20)
      .text(`Volume Calculado: ${volume.toFixed(3)} m³`, 60, resultY + 75);

    doc.moveDown(8);

    /* ================================
       TEXTO LEGAL
    ================================ */
    doc
      .fontSize(10)
      .fillColor('#444444')
      .text(
        'Os valores apresentados foram calculados automaticamente por sistema técnico, ' +
        'seguindo critérios geométricos padronizados. Este documento destina-se ao apoio ' +
        'de processos de orçamento, planejamento e tomada de decisão técnica, não ' +
        'substituindo análises estruturais normativas ou responsabilidade profissional.',
        { align: 'justify', lineGap: 4 }
      );

    /* ================================
       RODAPÉ
    ================================ */
    doc
      .fontSize(9)
      .fillColor('#777777')
      .text(
        `Documento gerado em ${new Date().toLocaleDateString('pt-BR')} • Plataforma Técnica Automatizada`,
        50,
        780,
        { align: 'center' }
      );

    doc.end();

    stream.on('finish', () => {
      ultimoPdfGerado = fileName;

      res.send(
        `✅ Proposta gerada com sucesso!\n\n` +
        `📄 PDF aberto automaticamente pelo sistema:\n` +
        `${BASE_URL}/pdf/ultimo?t=${Date.now()}`
      );
    });

    stream.on('error', () => {
      res.status(500).send('❌ Erro ao gerar o PDF.');
    });

  } catch (err) {
    res.status(500).send('❌ Erro interno.');
  }
});

/* ================================
   PDF ÚLTIMO (ANTI-CACHE REAL)
================================ */
app.get('/pdf/ultimo', (req, res) => {
  if (!ultimoPdfGerado) {
    return res.status(404).send('Nenhum PDF gerado ainda.');
  }

  const filePath = path.join(PDF_DIR, ultimoPdfGerado);

  // 🔥 HEADERS QUE OBRIGAM DOWNLOAD NOVO (CELULAR / WEBVIEW)
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');

  res.sendFile(filePath);
});

/* ================================
   START
================================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Servidor rodando na porta', PORT);
});
