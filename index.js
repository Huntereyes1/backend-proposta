// index.js — TORRE PF e-Alvará (TRT/TJ) — v3.4 (template.html)
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const app = express();

const BASE_URL = process.env.BASE_URL || "https://serene-luck-production.up.railway.app";
const PDF_DIR = "/tmp/pdf";
const TEMPLATE_PATH = path.join(__dirname, "template.html");

// ===== Boot =====
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

app.get("/", (_req, res) => res.send("Backend TORRE — Dossiê PF e-Alvará (TRT/TJ) v3.4"));

app.get("/pdf/proposta.pdf", (_req, res) => {
  if (!lastPdfFile) return res.status(404).send("PDF ainda não gerado.");
  return res.redirect(`${BASE_URL}/pdf/${lastPdfFile}`);
});

// ===== Helpers =====
const toNumber = (v) =>
  typeof v === "number" ? v : Number(String(v ?? "").replace(/\./g, "").replace(",", "."));

const centavosToBRL = (c) =>
  (Math.round(c) / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: 2,
  });

const safe = (s = "") => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

function renderFromTemplate(vars) {
  let html = fs.readFileSync(TEMPLATE_PATH, "utf8");
  for (const [k, v] of Object.entries(vars)) {
    html = html.replaceAll(`{{${k}}}`, v == null ? "" : String(v));
  }
  return html;
}

// ===== Handler =====
async function gerarDossieHandler(req, res) {
  try {
    const {
      tribunal, vara, processo, data_ato, pf_nome,
      valor_centavos, valor_reais,
      tipo_ato, banco_pagador, id_ato, fee_percent
    } = req.body || {};

    // regras TORRE
    const isPF = !!pf_nome && !/advogad|patron/i.test(String(pf_nome));
    const cents = Number.isFinite(valor_centavos)
      ? Number(valor_centavos)
      : Math.round(toNumber(valor_reais || 0) * 100);

    const hasTicket = Number.isFinite(cents) && cents >= 2_000_000; // ≥ R$20k
    const atoPronto = /(alvar[aá]|levantamento|libera[cç][aã]o)/i.test(String(tipo_ato || ""));

    if (!tribunal || !processo || !isPF || !hasTicket || !atoPronto) {
      return res.status(400).json({
        ok: false,
        error: "Dados inválidos: exigimos PF nominal, ticket ≥ R$ 20k e ato pronto.",
        debug: { tribunal, processo, pf_nome, valor_centavos: cents, tipo_ato, hasTicket, atoPronto }
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
      id_ato: safe(id_ato || ""),
      fee_percent: safe(fee_percent || "10–20"),
    });

    const fileName = `dossie-${Date.now()}.pdf`;
    const filePath = path.join(PDF_DIR, fileName);

    const browser = await puppeteer.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
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

// ===== Rotas =====
app.post(["/gerar-dossie", "/gerar-proposta"], gerarDossieHandler);

// Debug
app.get("/debug/last", (_req, res) => {
  const exists = lastPdfFile ? fs.existsSync(path.join(PDF_DIR, lastPdfFile)) : false;
  res.json({ lastPdfFile, exists, open: lastPdfFile ? `${BASE_URL}/pdf/${lastPdfFile}` : null });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor rodando na porta", PORT));
