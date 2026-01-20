// index.js — v3.3 debug + compat: template_dossie.html OU template.html

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const app = express();

const BASE_URL = process.env.BASE_URL || "https://serene-luck-production.up.railway.app";
const PDF_DIR = "/tmp/pdf";

// tenta os dois nomes
const CANDIDATE_TEMPLATES = [
  path.join(__dirname, "template_dossie.html"),
  path.join(__dirname, "template.html"),
];

function pickTemplatePath() {
  for (const p of CANDIDATE_TEMPLATES) if (fs.existsSync(p)) return p;
  return CANDIDATE_TEMPLATES[0]; // default
}
let TEMPLATE_PATH = pickTemplatePath();

// --- BOOT ---
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "1mb" }));
if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });

let lastPdfFile = null;

app.use("/pdf", express.static(PDF_DIR, {
  setHeaders: (res) => {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  },
}));

app.get("/pdf/proposta.pdf", (_req, res) => {
  if (!lastPdfFile) return res.status(404).send("PDF ainda não gerado.");
  return res.redirect(`${BASE_URL}/pdf/${lastPdfFile}`);
});

app.get("/", (_req, res) => res.send("Backend TORRE — Dossiê PF e-Alvará (TRT/TJ) v3.3"));

// --- HELPERS ---
const toNumber = (v) =>
  typeof v === "number" ? v : Number(String(v || "").replace(/\./g, "").replace(",", "."));

const centavosToBRL = (c) =>
  (Math.round(c) / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: 2,
  });

function safe(str = "") {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function ensureTemplate() {
  TEMPLATE_PATH = pickTemplatePath();
  if (fs.existsSync(TEMPLATE_PATH)) return;
  // fallback mínimo
  const htmlMin = `<!doctype html><meta charset="utf-8"><title>Dossiê</title>
  <body style="font-family:Arial;padding:24px">
  <h1>Dossiê</h1>
  <p><b>Tribunal:</b> {{tribunal}}</p>
  <p><b>Vara:</b> {{vara}}</p>
  <p><b>Processo:</b> {{processo}}</p>
  <p><b>Data do ato:</b> {{data_ato}}</p>
  <p><b>PF:</b> {{pf_nome}}</p>
  <p><b>Tipo:</b> {{tipo_ato}}</p>
  <p><b>Banco:</b> {{banco_pagador}}</p>
  <p><b>Valor:</b> {{valor_brl}}</p>
  <p><b>ID/Link:</b> {{id_ato}}</p>
  <p><b>Fee:</b> {{fee_percent}}</p></body>`;
  fs.writeFileSync(TEMPLATE_PATH, htmlMin, "utf8");
}

function renderFromTemplate(vars) {
  ensureTemplate();
  let html = fs.readFileSync(TEMPLATE_PATH, "utf8");
  // substituição simples {{chave}} — não avalia expressões
  Object.entries(vars).forEach(([k, v]) => {
    html = html.replaceAll(`{{${k}}}`, v == null ? "" : String(v));
  });
  return html;
}

// --- HANDLER ---
async function gerarDossieHandler(req, res) {
  try {
    const {
      tribunal, vara, processo, data_ato, pf_nome,
      valor_centavos, valor_reais, tipo_ato, banco_pagador,
      link_oficial, id_ato, fee_percent
    } = req.body || {};

    const isPF = !!pf_nome && !/advogad|patron/i.test(String(pf_nome));
    const cents = Number.isFinite(valor_centavos)
      ? Number(valor_centavos)
      : Math.round(toNumber(valor_reais || 0) * 100);

    const hasTicket = Number.isFinite(cents) && cents >= 2000000; // ≥ R$ 20k
    const atoPronto = /(alvar[aá]|levantamento|libera[cç][aã]o)/i.test(
      (tipo_ato || "") + " " + (link_oficial || "")
    );

    if (!tribunal || !processo || !isPF || !hasTicket || !atoPronto) {
      return res.status(400).json({
        ok: false,
        error: "Dados inválidos: exigimos PF nominal, ticket ≥ R$ 20k e ato pronto (e-alvará/levantamento).",
        debug: { tribunal, processo, isPF, hasTicket, tipo_ato, link_oficial }
      });
    }

    const valorBRL = centavosToBRL(cents);
    const dataFmt = data_ato ? new Date(data_ato).toLocaleDateString("pt-BR") : "";

    const html = renderFromTemplate({
      tribunal: safe(tribunal),
      vara: safe(vara || ""),
      processo: safe(processo),
      data_ato: safe(dataFmt),
      pf_nome: safe(pf_nome),
      valor_brl: safe(valorBRL),
      tipo_ato: safe(tipo_ato || "e-Alvará"),
      banco_pagador: safe(banco_pagador || "BB/CEF"),
      link_oficial: safe(link_oficial || ""),
      id_ato: safe(id_ato || ""),
      fee_percent: safe(fee_percent || "10–20"),
    });

    const fileName = `dossie-${Date.now()}.pdf`;
    const filePath = path.join(PDF_DIR, fileName);

    const browser = await puppeteer.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      // se precisar: headless: "new",
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.pdf({
      path: filePath,
      format: "A4",
      margin: { top: "14mm", bottom: "14mm", left: "14mm", right: "14mm" },
      printBackground: true,
    });
    await browser.close();

    lastPdfFile = fileName;
    return res.json({ ok: true, url: `${BASE_URL}/pdf/proposta.pdf` });
  } catch (e) {
    console.error("Erro /gerar-dossie:", e);
    return res.status(500).json({ ok: false, error: "Erro interno ao gerar PDF.", cause: String(e && e.message || e) });
  }
}

// --- ROTAS ---
app.post(["/gerar-dossie", "/gerar-proposta"], gerarDossieHandler);

// debug helpers
app.get("/debug/template", (_req, res) => {
  res.json({
    picked: TEMPLATE_PATH,
    candidates: CANDIDATE_TEMPLATES,
    exists: fs.existsSync(TEMPLATE_PATH),
  });
});
app.get("/debug/last", (_req, res) => {
  const exists = lastPdfFile ? fs.existsSync(path.join(PDF_DIR, lastPdfFile)) : false;
  res.json({ lastPdfFile, exists, open: lastPdfFile ? `${BASE_URL}/pdf/${lastPdfFile}` : null });
});
app.get("/debug/ping", (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor rodando na porta", PORT));
