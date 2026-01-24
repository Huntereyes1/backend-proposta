// index.js — TORRE PF e-Alvará (TRT/TJ) — backend puro (v4.0)
// Endpoints: /scan, /gerar-dossie, /batch, /pack, /health, /debug/last

import express from "express";
import cors from "cors";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import morgan from "morgan";
import archiver from "archiver";
import pLimit from "p-limit";
import puppeteer from "puppeteer";
import QRCode from "qrcode";
import { fileURLToPath } from "url";

// ===== Paths / Boot =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const BASE_URL = process.env.BASE_URL || "https://seuapp.up.railway.app";
const PORT = Number(process.env.PORT || 3000);
const PDF_DIR = process.env.PDF_DIR || "/tmp/pdf";
const EXPORTS_DIR = process.env.EXPORTS_DIR || "/tmp/exports";
const TEMPLATE_PATH = path.join(__dirname, "template.html");

const MIN_TICKET_CENTS = Number(process.env.MIN_TICKET_CENTS || 2_000_000); // 20k
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);
const DEMO = String(process.env.DEMO || "true").toLowerCase() === "true"; // liga demos para /scan

if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });
if (!fs.existsSync(EXPORTS_DIR)) fs.mkdirSync(EXPORTS_DIR, { recursive: true });

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "2mb" }));
app.use(morgan("tiny"));

let lastPdfFile = null;

// Servir PDFs e exports
app.use("/pdf", express.static(PDF_DIR, {
  setHeaders: (res) => {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  },
}));
app.use("/exports", express.static(EXPORTS_DIR, {
  setHeaders: (res) => res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate"),
}));

app.get("/", (_req, res) =>
  res.send("Backend TORRE — Dossiê PF e-Alvará (TRT/TJ) v4.0 — sem Typebot/Make")
);

app.get("/health", (_req, res) => res.json({ ok: true, now: new Date().toISOString() }));

// ===== Utils =====
const toNumber = (v) =>
  typeof v === "number" ? v : Number(String(v ?? "").replace(/\./g, "").replace(",", "."));

const centavosToBRL = (c) =>
  (Math.round(c) / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: 2,
  });

const safe = (s = "") =>
  String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

function parseDataPtBRorISO(s) {
  if (!s) return "";
  const str = String(s).trim();
  const m = str.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) {
    const [_, dd, mm, yyyy] = m;
    const d = new Date(`${yyyy}-${mm}-${dd}T00:00:00`);
    return isNaN(d) ? "" : d;
  }
  const d = new Date(str);
  return isNaN(d) ? "" : d;
}

async function renderFromTemplate(vars) {
  let html = await fsp.readFile(TEMPLATE_PATH, "utf8");
  // QRCode: se tiver id_ato/link, gera QR e substitui {{qrcode_dataurl}}
  let qrcodeDataUrl = "";
  const link = (vars.id_ato || vars.link_oficial || "").toString().trim();
  if (link) {
    try { qrcodeDataUrl = await QRCode.toDataURL(link, { margin: 0 }); } catch {}
  }
  const allVars = { ...vars, qrcode_dataurl: qrcodeDataUrl };
  for (const [k, v] of Object.entries(allVars)) {
    html = html.replaceAll(`{{${k}}}`, v == null ? "" : String(v));
  }
  return html;
}

function makeWaLink(text) {
  const url = "https://wa.me/?text=" + encodeURIComponent(text);
  return url;
}

function makeEmailLink(subject, body) {
  const url = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  return url;
}

// ===== Miner (mínimo viável)
// /scan retorna casos válidos já filtrados TORRE.
// Modo DEMO gera 15 linhas falsas com valores 30–80k e dados coerentes.
async function scanMiner({ limit = 60, tribunais = "TRT15" }) {
  if (DEMO) {
    const items = [];
    const tlist = tribunais.split(",").map(s => s.trim()).filter(Boolean);
    for (let i = 0; i < Math.min(limit, 60); i++) {
      const valor = (Math.floor(Math.random() * 50) + 30) * 1000; // 30k–80k
      const cents = valor * 100;
      const t = tlist[i % tlist.length];
      const num = String(1000000 + i) + "-00.2024.5.15.000" + ((i % 9) + 1);
      items.push({
        tribunal: `${t}`,
        vara: `VT ${1 + (i % 10)} — Cidade ${1 + (i % 5)}`,
        processo: num,
        data_ato: new Date().toISOString().slice(0,10),
        pf_nome: `BENEFICIARIO DEMO ${i+1}`,
        valor_centavos: cents,
        tipo_ato: i % 2 ? "e-Alvará" : "Levantamento",
        banco_pagador: i % 3 === 0 ? "BB" : "CEF",
        id_ato: `https://portal.exemplo/${t}/ato/${i+1000}`,
        link_oficial: `https://portal.exemplo/${t}/proc/${num}`
      });
    }
    // Regra TORRE já atendida, mas limita a 15 no front
    return items;
  }

  // ===== PROD FUTURO (rabisque aqui seu scraper real):
  // 1) Use fetch() para páginas recentes do TRT/TJ alvo
  // 2) Parseie HTML com RegExp simples (ou troque por Cheerio/Playwright)
  // 3) Aplique filtros TORRE e retorne array no formato abaixo
  // Por enquanto, sem DEMO = vazio (evita quebrar deploy)
  return [];
}

// ===== /scan
app.get("/scan", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 60), 120);
    const tribunais = String(req.query.tribunais || process.env.SCAN_TRIBUNAIS || "TRT15");
    const cases = await scanMiner({ limit, tribunais });

    // Filtro TORRE (por segurança)
    const filtered = cases.filter(c => {
      const cents = Number(c.valor_centavos);
      const isPF = !!c.pf_nome && !/advogad|patron/i.test(String(c.pf_nome));
      const atoPronto = /(alvar[aá]|levantamento|libera[cç][aã]o)/i.test(String(c.tipo_ato || ""));
      return c.tribunal && c.processo && isPF && (cents >= MIN_TICKET_CENTS) && atoPronto;
    });

    res.json({ ok: true, items: filtered.slice(0, limit) });
  } catch (e) {
    console.error("Erro /scan:", e);
    res.status(500).json({ ok: false, error: "Falha no scan", cause: String(e?.message || e) });
  }
});

// ===== /gerar-dossie
app.post(["/gerar-dossie", "/gerar-proposta"], async (req, res) => {
  try {
    const {
      tribunal, vara, processo, data_ato, pf_nome,
      valor_centavos, valor_reais,
      tipo_ato, banco_pagador, id_ato, link_oficial, fee_percent
    } = req.body || {};

    const isPF = !!pf_nome && !/advogad|patron/i.test(String(pf_nome));
    const cents = Number.isFinite(valor_centavos)
      ? Number(valor_centavos)
      : Math.round(toNumber(valor_reais || 0) * 100);

    const hasTicket = Number.isFinite(cents) && cents >= MIN_TICKET_CENTS;
    const atoPronto = /(alvar[aá]|levantamento|libera[cç][aã]o)/i.test(String(tipo_ato || ""));

    if (!tribunal || !processo || !isPF || !hasTicket || !atoPronto) {
      return res.status(400).json({
        ok: false,
        error: "Regras TORRE: PF nominal, ticket ≥ R$ 20k e ato pronto.",
        debug: { tribunal, processo, pf_nome, valor_centavos, tipo_ato, hasTicket, atoPronto }
      });
    }

    const valorBRL = centavosToBRL(cents);
    const d = parseDataPtBRorISO(data_ato);
    const dataFmt = d ? d.toLocaleDateString("pt-BR") : "";

    const html = await renderFromTemplate({
      tribunal: safe(tribunal),
      vara: safe(vara || ""),
      processo: safe(processo),
      data_ato: safe(dataFmt),
      pf_nome: safe(pf_nome),
      valor_brl: safe(valorBRL),
      tipo_ato: safe(tipo_ato || "e-Alvará"),
      banco_pagador: safe(banco_pagador || "BB/CEF"),
      id_ato: safe(id_ato || link_oficial || ""),
      fee_percent: safe(fee_percent || "10–20"),
      link_oficial: safe(link_oficial || "")
    });

    const fileName = `dossie-${Date.now()}.pdf`;
    const filePath = path.join(PDF_DIR, fileName);

    const browser = await puppeteer.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.pdf({
      path: filePath,
      format: "A4",
      margin: { top: "14mm", bottom: "14mm", left: "14mm", right: "14mm" },
      printBackground: true
    });
    await browser.close();

    lastPdfFile = fileName;

    // Mensagens prontas (2 linhas) + links
    const pitch1 = `${pf_nome}, no ${tribunal} proc. ${processo} há ${tipo_ato || "e-Alvará"} de ${valorBRL} em seu nome.\nTe guio BB/CEF em 3–7 dias; você só me paga 10–20% após cair. Dossiê: ${BASE_URL}/pdf/${fileName}`;
    const wa = makeWaLink(pitch1);
    const email = makeEmailLink(
      `Dossiê — ${tribunal} — proc. ${processo}`,
      `${pitch1}\n\nSem adiantamento. Verifique o ato: ${id_ato || link_oficial || ""}`
    );

    return res.json({
      ok: true,
      url: `${BASE_URL}/pdf/${fileName}`,
      last: `${BASE_URL}/pdf/proposta.pdf`,
      whatsapp: wa,
      email,
      file: fileName
    });
  } catch (e) {
    console.error("Erro /gerar-dossie:", e);
    return res.status(500).json({ ok: false, error: "Erro ao gerar PDF", cause: String(e?.message || e) });
  }
});

// ===== /batch — recebe { items: [Case, ...] } e gera PDFs em fila
app.post("/batch", async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ ok: false, error: "Envie items: []" });

    const limit = pLimit(CONCURRENCY);
    const results = [];
    for (let i = 0; i < items.length; i++) {
      const body = items[i];
      const run = () => fetch(`${BASE_URL}/gerar-dossie`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }).then(r => r.json()).catch(e => ({ ok:false, error:String(e) }));
      results.push(limit(run));
    }
    const out = await Promise.all(results);

    // Monta CSV simples
    const now = new Date();
    const stamp = now.toISOString().slice(0,19).replace(/[:T]/g,"-");
    const csvName = `lote-${stamp}.csv`;
    const csvPath = path.join(EXPORTS_DIR, csvName);

    const lines = [
      "tribunal,processo,pf_nome,valor,link_oficial,pdf_url,whatsapp_link,status"
    ];
    for (let i = 0; i < items.length; i++) {
      const c = items[i];
      const r = out[i] || {};
      const valor = Number.isFinite(c.valor_centavos) ? centavosToBRL(c.valor_centavos) : (c.valor_reais || "");
      lines.push([
        c.tribunal || "",
        c.processo || "",
        (c.pf_nome || "").replaceAll(",", " "),
        valor,
        c.link_oficial || c.id_ato || "",
        r.url || "",
        r.whatsapp || "",
        r.ok ? "OK" : "ERRO"
      ].map(x => `"${String(x ?? "").replaceAll('"','""')}"`).join(","));
    }
    await fsp.writeFile(csvPath, lines.join("\n"), "utf8");

    return res.json({
      ok: true,
      items: out,
      csv: `${BASE_URL}/exports/${csvName}`
    });
  } catch (e) {
    console.error("Erro /batch:", e);
    res.status(500).json({ ok: false, error: "Erro no batch", cause: String(e?.message || e) });
  }
});

// ===== /pack — { files: ["dossie-....pdf", ...] } → zip
app.post("/pack", async (req, res) => {
  try {
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    if (!files.length) return res.status(400).json({ ok: false, error: "Envie files: []" });

    const zipName = `lote-${Date.now()}.zip`;
    const zipPath = path.join(EXPORTS_DIR, zipName);

    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.pipe(output);

    for (const f of files) {
      const p = path.join(PDF_DIR, path.basename(f));
      if (fs.existsSync(p)) archive.file(p, { name: path.basename(p) });
    }
    await archive.finalize();

    output.on("close", () => {
      res.json({ ok: true, zip: `${BASE_URL}/exports/${zipName}` });
    });
  } catch (e) {
    console.error("Erro /pack:", e);
    res.status(500).json({ ok: false, error: "Erro no pack", cause: String(e?.message || e) });
  }
});

// ===== Debug
app.get("/pdf/proposta.pdf", (_req, res) => {
  if (!lastPdfFile) return res.status(404).send("PDF ainda não gerado.");
  return res.redirect(`${BASE_URL}/pdf/${lastPdfFile}`);
});

app.get("/debug/last", (_req, res) => {
  const exists = lastPdfFile ? fs.existsSync(path.join(PDF_DIR, lastPdfFile)) : false;
  res.json({ lastPdfFile, exists, open: lastPdfFile ? `${BASE_URL}/pdf/${lastPdfFile}` : null });
});

// ===== Start
app.listen(PORT, () => console.log("Servidor rodando na porta", PORT));
