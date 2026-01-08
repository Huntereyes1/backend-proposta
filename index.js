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
   DIRETÓRIO TEMP (RAILWAY)
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

    const doc = new PDFDocument({
      margin: 50,
      size: 'A4'
    });

    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    /* ================================
       HEADER
    ================================ */
    doc
      .fontSize(20)
      .fillColor('#111111')
      .text('PROPOSTA TÉCNICA', { align: 'left' });

    doc
      .moveDown(0.5)
      .fontSize(10)
      .fillColor('#666666')
      .text('Documento gerado automaticamente por sistema técnico.', {
        align: 'left'
      });

    doc.moveDown(1.5);

    /* ================================
       DADOS PRINCIPAIS
    ================================ */
    doc
      .fontSize(12)
      .fillColor('#000000')
      .text(`Empresa: `, { continued: true })
      .font('Helvetica-Bold')
      .text(nome_empresa);

    doc
      .font('Helvetica')
      .text(`Cliente: `, { continued: true })
      .font('Helvetica-Bold')
      .text(nome_cliente);

    doc
      .font('Helvetica')
      .text(`Serviço: `, { continued: true })
      .font('Helvetica-Bold')
      .text(tipo_servico);

    doc
      .font('Helvetica')
      .text(`Material: `, { continued: true })
      .font('Helvetica-Bold')
      .text(nome_material);

    doc.moveDown(1.5);

    /* ================================
       DIMENSÕES
    ================================ */
    doc
      .font('Helvetica-Bold')
      .fontSize(13)
      .text('DIMENSÕES INFORMADAS');

    doc.moveDown(0.5);

    doc
      .font('Helvetica')
      .fontSize(11)
      .text(`Comprimento: ${comprimento} m`)
      .text(`Largura: ${largura} m`)
      .text(`Espessura: ${espessura} cm`);

    doc.moveDown(1.5);

    /* ================================
       RESULTADOS (DESTAQUE)
    ================================ */
    doc
      .font('Helvetica-Bold')
      .fontSize(13)
      .text('RESULTADOS TÉCNICOS');

    doc.moveDown(0.8);

    doc
      .fontSize(16)
      .fillColor('#000000')
      .text(`Área Total: ${area.toFixed(2)} m²`);

    doc
      .moveDown(0.3)
      .fontSize(16)
      .text(`Volume Calculado: ${volume.toFixed(3)} m³`);

    doc.moveDown(2);

    /* ================================
       TEXTO DE AUTORIDADE
    ================================ */
    doc
      .fontSize(10)
      .fillColor('#444444')
      .text(
        'Os valores apresentados foram calculados automaticamente por sistema técnico, ' +
        'seguindo critérios geométricos padronizados. Este documento visa apoiar ' +
        'processos de orçamento e planejamento, não substituindo análise estrutural normativa.',
        {
          align: 'justify',
          lineGap: 4
        }
      );

    doc.moveDown(2);

    /* ================================
       RODAPÉ
    ================================ */
    doc
      .fontSize(9)
      .fillColor('#888888')
      .text(
        `Documento gerado em ${new Date().toLocaleDateString('pt-BR')} • Sistema automático`,
        { align: 'center' }
      );

    doc.end();

    stream.on('finish', () => {
      ultimoPdfGerado = fileName;

      // Retorno simples (Typebot não usa isso, mas mantém consistência)
      res.send(
        `✅ Proposta gerada com sucesso!\n\n` +
        `📐 Área: ${area.toFixed(2)} m²\n` +
        `📦 Volume: ${volume.toFixed(3)} m³\n\n` +
        `📄 PDF disponível em:\n` +
        `${BASE_URL}/pdf/ultimo`
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
   PDF ÚLTIMO (LINK FIXO)
================================ */
app.get('/pdf/ultimo', (req, res) => {
  if (!ultimoPdfGerado) {
    return res.status(404).send('Nenhum PDF gerado ainda.');
  }

  const filePath = path.join(PDF_DIR, ultimoPdfGerado);
  res.sendFile(filePath);
});

/* ================================
   START
================================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Servidor rodando na porta', PORT);
});
