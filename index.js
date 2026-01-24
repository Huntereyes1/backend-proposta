// index.js — TORRE PF e-Alvará (TRT/TJ) — backend puro (v4.1, DEJT real)
// Endpoints: /scan, /relatorio, /gerar-dossie, /batch, /pack, /health, /debug/last

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
const DEMO = false; // <<<<< DESLIGADO SEMPRE

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
  res.send("Backend TORRE — Dossiê PF e-Alvará (TRT/TJ) v4.1 — DEJT real")
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

// ===== Heurísticas e RegEx para DEJT =====
const DEJT_URL = "https://dejt.jt.jus.br/dejt/f/n/diariocon?pesquisacaderno=J&evento=y";
const RX_PROC = /\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/g;
const RX_MOEDA = /R\$\s*([\d\.]+,\d{2})/g;
const RX_ALVAR = /(alvar[aá]|levantamento|libera[cç][aã]o)/i;

function _parecePF(nome) {
  if (!nome) return false;
  const s = nome.toUpperCase();
  if (s.includes(" LTDA") || s.includes(" S.A") || s.includes(" S/A") || s.includes(" EPP") || s.includes(" MEI ")) return false;
  return s.trim().split(/\s+/).length >= 2;
}
function brlToCents(brlStr) {
  const s = String(brlStr).replace(/\./g, "").replace(",", ".");
  const v = Number(s);
  return Number.isFinite(v) ? Math.round(v * 100) : NaN;
}
function pickProvavelPF(texto) {
  const linhas = (texto || "").split(/\n+/).map(l => l.trim()).filter(Boolean);
  for (const l of linhas) {
    if (/(benef|titular|credor|reclamante)/i.test(l)) {
      const campo = l.replace(/.*?:/,'').replace(/\(.*?\)/g,'').trim();
      if (_parecePF(campo)) return campo;
    }
  }
  for (const l of linhas) if (_parecePF(l)) return l;
  return "";
}

// ===== Miner real (DEJT) — retorna itens já no formato do /scan
async function scanMiner({ limit = 60, tribunais = "TRT15", data = null }) {
  if (DEMO) return []; // segurança: nunca usar DEMO

  const d = data ? new Date(data) : new Date();
  const dd = String(d.getDate()).padStart(2,"0");
  const mm = String(d.getMonth()+1).padStart(2,"0");
  const yyyy = d.getFullYear();
  const dataPt = `${dd}/${mm}/${yyyy}`;

  const browser = await puppeteer.launch({ args: ["--no-sandbox","--disable-setuid-sandbox"] });
  const page = await browser.newPage();

  // 1) abre DEJT "Diários > Judiciário"
  await page.goto(DEJT_URL, { waitUntil: "domcontentloaded" });

  // 2) Preenche datas e seleciona TRT-15 com duas tentativas
  await page.evaluate((dataPt) => {
    // datas
    const ini = document.querySelector('input[name="dataIni"], input#dataIni');
    const fim = document.querySelector('input[name="dataFim"], input#dataFim');
    if (ini) { ini.value = ""; ini.dispatchEvent(new Event("input")); ini.value = dataPt; ini.dispatchEvent(new Event("change")); }
    if (fim) { fim.value = ""; fim.dispatchEvent(new Event("input")); fim.value = dataPt; fim.dispatchEvent(new Event("change")); }
  }, dataPt);

  // tenta selecionar órgão por texto
  const okSelect = await page.evaluate(() => {
    const sel = document.querySelector('select[name="tribunal"], select#orgaos, select#tribunal, select[name="orgao"]');
    if (!sel) return false;
    const opts = Array.from(sel.options || []);
    const alvo = opts.find(o => (o.textContent||"").includes("TRT 15"));
    if (!alvo) return false;
    sel.value = alvo.value;
    sel.dispatchEvent(new Event("change"));
    return true;
  });

  // TODO (se seu ambiente exigir): se okSelect === false, use page.select com o VALUE que você inspecionar no DOM.

  // 3) Clica "Pesquisar"
  try {
    await Promise.all([
      page.click('input[type="submit"][value="Pesquisar"], button:has-text("Pesquisar"), input#btnPesquisar'),
      page.waitForNavigation({ waitUntil: "networkidle2" })
    ]);
  } catch {
    // fallback: se não houver navegação, segue
  }

  // 4) Coleta links "Visualizar Texto"
  const linksTexto = await page.$$eval('a', as => as
    .filter(a => /Visualizar Texto/i.test(a.textContent || ""))
    .map(a => a.href)
  );

  const items = [];
  for (let i = 0; i < linksTexto.length && items.length < limit; i++) {
    const href = linksTexto[i];
    try {
      const pg = await browser.newPage();
      await pg.goto(href, { waitUntil: "domcontentloaded" });
      const conteudo = await pg.$eval('body', el => el.innerText || "");
      await pg.close();

      if (!RX_ALVAR.test(conteudo)) continue;

      const procs = (conteudo.match(RX_PROC) || []).slice(0,1);
      const processo = procs[0] || "";

      let valorCents = NaN;
      let m;
      while ((m = RX_MOEDA.exec(conteudo))) {
        const cents = brlToCents(m[1]);
        if (!Number.isFinite(valorCents) || cents > valorCents) valorCents = cents;
      }
      if (!Number.isFinite(valorCents)) continue;

      const tipo_ato = RX_ALVAR.test(conteudo) ? "e-Alvará" : "Levantamento";
      const pf_nome = pickProvavelPF(conteudo);
      if (!pf_nome) continue;

      items.push({
        tribunal: "TRT15",
        vara: "",
        processo,
        data_ato: `${yyyy}-${mm}-${dd}`,
        pf_nome,
        valor_centavos: valorCents,
        tipo_ato,
        banco_pagador: /CEF/i.test(conteudo) ? "CEF" : "BB",
        id_ato: href,
        link_oficial: href
      });
    } catch {}
  }

  await browser.close();
  return items;
}

// ===== /scan (usa miner real + filtro TORRE) — retorno JSON
app.get("/scan", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 60), 120);
    const tribunais = String(req.query.tribunais || process.env.SCAN_TRIBUNAIS || "TRT15");
    const data = req.query.data || null;

    const cases = await scanMiner({ limit, tribunais, data });

    const filtered = cases.filter(c => {
      const cents = Number(c.valor_centavos);
      const isPF = _parecePF(c.pf_nome);
      const atoPronto = RX_ALVAR.test(String(c.tipo_ato || ""));
      return c.tribunal && c.processo && isPF && (cents >= MIN_TICKET_CENTS) && atoPronto;
    });

    res.json({ ok: true, items: filtered.slice(0, limit) });
  } catch (e) {
    console.error("Erro /scan:", e);
    res.status(500).json({ ok: false, error: "Falha no scan", cause: String(e?.message || e) });
  }
});

// ===== /relatorio — varre DEJT, filtra TORRE e gera 1 PDF consolidado (top N)
app.get("/relatorio", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 15), 50);
    const data = req.query.data || null;

    const brutos = await scanMiner({ limit: limit * 3, tribunais: "TRT15", data });
    const filtrados = brutos.filter(c => {
      const isPF = _parecePF(c.pf_nome);
      const hasTicket = Number(c.valor_centavos) >= MIN_TICKET_CENTS;
      const atoPronto = RX_ALVAR.test(String(c.tipo_ato||""));
      return c.processo && isPF && hasTicket && atoPronto;
    }).slice(0, limit);

    if (!filtrados.length) {
      return res.status(404).json({ ok:false, error:"Nada elegível no DEJT (TRT-15) para a data." });
    }

    const rows = filtrados.map((c,i) => `
      <tr>
        <td>${i+1}</td>
        <td>${safe(c.pf_nome)}</td>
        <td>${safe(c.processo)}</td>
        <td>${safe(c.tribunal)}</td>
        <td>${safe(c.tipo_ato||"e-Alvará")}</td>
        <td>${centavosToBRL(c.valor_centavos)}</td>
        <td><a href="${safe(c.link_oficial||c.id_ato||"#")}">ato</a></td>
      </tr>
    `).join("");

    const dataLabel = data ? new Date(data).toLocaleDateString("pt-BR") : new Date().toLocaleDateString("pt-BR");
    const html = `
<!doctype html><html lang="pt-br"><meta charset="utf-8">
<title>Dossiê Consolidado — ${filtrados.length} casos</title>
<style>
  body{font-family:system-ui,Segoe UI,Roboto,Arial;margin:24px;color:#111}
  h1{font-size:20px;margin:0 0 12px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{border:1px solid #ddd;padding:8px;vertical-align:top}
  th{background:#f4f6f8;text-align:left}
  .meta{opacity:.75;font-size:12px;margin-bottom:12px}
</style>
<h1>Dossiê Consolidado — ${filtrados.length} casos (TRT-15 / ${dataLabel})</h1>
<div class="meta">
  Regra TORRE: PF nominal • Ticket ≥ ${centavosToBRL(MIN_TICKET_CENTS)} • Ato pronto (alvará/levantamento)
</div>
<table>
  <thead>
    <tr><th>#</th><th>PF</th><th>Processo</th><th>Tribunal</th><th>Ato</th><th>Valor</th><th>Prova</th></tr>
  </thead>
  <tbody>${rows}</tbody>
</table>
</html>`;

    const fileName = `relatorio-${Date.now()}.pdf`;
    const filePath = path.join(PDF_DIR, fileName);

    const browser = await puppeteer.launch({ args:["--no-sandbox","--disable-setuid-sandbox"] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.pdf({
      path: filePath,
      format: "A4",
      margin: { top: "12mm", right: "12mm", bottom: "14mm", left: "12mm" },
      printBackground: true
    });
    await browser.close();

    lastPdfFile = fileName;

    return res.json({
      ok: true,
      count: filtrados.length,
      url: `${BASE_URL}/pdf/${fileName}`,
      preview: `${BASE_URL}/pdf/${fileName}#view=fitH`,
      items: filtrados.map(c => ({
        pf_nome: c.pf_nome,
        processo: c.processo,
        valor: centavosToBRL(c.valor_centavos),
        link: c.link_oficial || c.id_ato
      }))
    });
  } catch (e) {
    console.error("Erro /relatorio:", e);
    res.status(500).json({ ok:false, error:String(e?.message||e) });
  }
});

// ===== /gerar-dossie (individual)
app.post(["/gerar-dossie", "/gerar-proposta"], async (req, res) => {
  try {
    const {
      tribunal, vara, processo, data_ato, pf_nome,
      valor_centavos, valor_reais,
      tipo_ato, banco_pagador, id_ato, link_oficial, fee_percent
    } = req.body || {};

    const isPF = _parecePF(pf_nome);
    const cents = Number.isFinite(valor_centavos)
      ? Number(valor_centavos)
      : Math.round(toNumber(valor_reais || 0) * 100);

    const hasTicket = Number.isFinite(cents) && cents >= MIN_TICKET_CENTS;
    const atoPronto = RX_ALVAR.test(String(tipo_ato || ""));

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

    return res.json({ ok: true, items: out, csv: `${BASE_URL}/exports/${csvName}` });
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
