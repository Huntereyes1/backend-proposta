// index.js — TORRE PF e-Alvará (TRT/DEJT) — v5.2 (PDF via response.arrayBuffer)
// Endpoints: /scan, /relatorio, /gerar-dossie, /batch, /pack, /health, /debug/*

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
import pdfParse from "pdf-parse";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const PORT = Number(process.env.PORT || 3000);
const PDF_DIR = process.env.PDF_DIR || "/tmp/pdf";
const EXPORTS_DIR = process.env.EXPORTS_DIR || "/tmp/exports";
const TEMPLATE_PATH = path.join(__dirname, "template.html");

const MIN_TICKET_CENTS = Number(process.env.MIN_TICKET_CENTS || 2_000_000);
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);
const SCAN_TRIBUNAIS = String(process.env.SCAN_TRIBUNAIS || "TRT15");
const DEMO = /^(1|true|on)$/i.test(String(process.env.DEMO || "false"));
const TZ = process.env.TZ || "America/Sao_Paulo";

if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });
if (!fs.existsSync(EXPORTS_DIR)) fs.mkdirSync(EXPORTS_DIR, { recursive: true });

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "2mb" }));
app.use(morgan("tiny"));

let lastPdfFile = null;

// ===== Static
app.use(
  "/pdf",
  express.static(PDF_DIR, {
    setHeaders: (res) => {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Cache-Control", "no-store");
    },
  })
);
app.use("/exports", express.static(EXPORTS_DIR));

app.get("/", (_req, res) => res.send("Backend TORRE v5.2 — DEJT (PDF capture)"));
app.get("/health", (_req, res) =>
  res.json({ ok: true, now: new Date().toISOString(), tz: TZ })
);

// ===== Utils
const centavosToBRL = (c) =>
  (Math.round(c) / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: 2,
  });

const safe = (s = "") =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function brlToCents(brlStr) {
  const s = String(brlStr).replace(/\./g, "").replace(",", ".");
  const v = Number(s);
  return Number.isFinite(v) ? Math.round(v * 100) : NaN;
}

function _parecePF(nome) {
  if (!nome) return false;
  const s = nome.toUpperCase();
  if (
    s.includes(" LTDA") ||
    s.includes(" S.A") ||
    s.includes(" S/A") ||
    s.includes(" EPP") ||
    s.includes(" MEI ") ||
    s.includes(" EIRELI")
  )
    return false;
  return s.trim().split(/\s+/).length >= 2;
}

function pickProvavelPF(texto) {
  const linhas = (texto || "")
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const l of linhas) {
    if (/(benef|titular|credor|reclamante|autor)/i.test(l)) {
      const campo = l.replace(/.*?:/, "").replace(/\(.*?\)/g, "").trim();
      if (_parecePF(campo)) return campo;
    }
  }
  for (const l of linhas) if (_parecePF(l)) return l;
  return "";
}

function makeWaLink(text) {
  return "https://wa.me/?text=" + encodeURIComponent(text);
}
function makeEmailLink(subject, body) {
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(
    body
  )}`;
}

// ===== Consts / Regex
const DEJT_URL = "https://dejt.jt.jus.br/dejt/f/n/diariocon";
const RX_PROC = /\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/g;
const RX_MOEDA = /R\$\s*([\d\.]+,\d{2})/g;
const RX_ALVAR = /(alvar[aá]|levantamento|libera[cç][aã]o)/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ===== Puppeteer helpers
async function launchBrowser() {
  return puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--lang=pt-BR"],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  });
}

async function clickPesquisarReal(page) {
  const tryClickIn = async (ctx) => {
    try {
      const selId = '[id="corpo:formulario:botaoAcaoPesquisar"]';
      const btn = await ctx.$(selId);
      if (btn) {
        await ctx.$eval(selId, (el) => el.scrollIntoView({ block: "center" }));
        await ctx.click(selId, { delay: 30 });
        return 'page.click(corpo:formulario:botaoAcaoPesquisar)';
      }
      const btnPesquisar = await ctx.$('input[value="Pesquisar"]');
      if (btnPesquisar) {
        await ctx.$eval('input[value="Pesquisar"]', (el) =>
          el.scrollIntoView({ block: "center" })
        );
        await ctx.click('input[value="Pesquisar"]', { delay: 30 });
        return "page.click(input[value=Pesquisar])";
      }
      return null;
    } catch {
      return null;
    }
  };
  let how = await tryClickIn(page);
  if (how) return how;
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    how = await tryClickIn(f);
    if (how) return how + " (in iframe)";
  }
  return "no-button-found";
}

async function waitJsfResult(page, beforeLen) {
  await Promise.race([
    page.waitForResponse((r) => r.request().method() === "POST", {
      timeout: 15000,
    }),
    page.waitForNetworkIdle({ idleTime: 1500, timeout: 15000 }).catch(() => {}),
  ]).catch(() => {});
  await page
    .waitForSelector(
      "table tbody tr, .ui-datatable, .rich-table, a[href*='visualizar']",
      { timeout: 12000 }
    )
    .catch(() => {});
  await page
    .waitForFunction(
      (prev) => (document.body.innerText || "").length > prev + 500,
      { timeout: 20000 },
      beforeLen
    )
    .catch(() => {});
  await sleep(800);
}

// Puppeteer v23+: Response.buffer() foi removido. Usar arrayBuffer().
async function responseToBuffer(resp) {
  try {
    const ab = await resp.arrayBuffer();
    return Buffer.from(ab);
  } catch {
    return Buffer.alloc(0);
  }
}

/**
 * Abre o primeiro caderno do tribunal e CAPTURA o PDF da resposta (quando o "Baixar" faz submitForm()).
 * Retorna { how, pdfUrl, pdfPath, pdfBuffer }.
 */
async function openFirstCadernoAndGetPdf(page) {
  // Armadilha para respostas PDF (com fallback de espera explícita)
  const pdfResponses = [];
  const responseHandler = async (response) => {
    try {
      const url = response.url();
      const ct = (response.headers()["content-type"] || "").toLowerCase();
      if (ct.includes("application/pdf")) {
        const buf = await responseToBuffer(response);
        if (buf && buf.length > 1000) {
          pdfResponses.push({ url, buf });
        }
      }
    } catch {}
  };
  page.on("response", responseHandler);

  // Executa o "Baixar" via onclick JSF
  const result = await page.evaluate(() => {
    function execOnclick(onclick) {
      if (!onclick) return { ok: false, reason: "no-onclick" };
      const cleaned = onclick.replace(/;?\s*return\s+(false|true)\s*;?\s*$/i, "");
      try {
        eval(cleaned);
        return { ok: true, method: "eval onclick" };
      } catch (e) {
        return { ok: false, reason: "eval-error: " + e.message.substring(0, 80) };
      }
    }
    const link =
      document.querySelector("a.link-download") ||
      document.querySelector('a[onclick*="plcLogicaItens"]') ||
      null;
    if (!link) {
      return { ok: false, reason: "link-download-not-found" };
    }
    const oc = link.getAttribute("onclick") || "";
    const r = execOnclick(oc);
    return { ...r, onclick: oc.substring(0, 160) };
  });

  // Aguarda uma resposta application/pdf explicitamente (além do response listener)
  const waitPdf = page
    .waitForResponse(
      (r) => {
        const ct = (r.headers()["content-type"] || "").toLowerCase();
        return ct.includes("application/pdf");
      },
      { timeout: 15000 }
    )
    .catch(() => null);

  // Mais um ciclo de rede
  await page.waitForNetworkIdle({ idleTime: 1000, timeout: 12000 }).catch(() => {});
  const waited = await waitPdf;
  if (waited) {
    const buf = await responseToBuffer(waited);
    if (buf && buf.length > 1000) {
      pdfResponses.push({ url: waited.url(), buf });
    }
  }

  page.off("response", responseHandler);

  if (!result.ok && pdfResponses.length === 0) {
    return { how: "caderno-não-encontrado: " + (result.reason || "unknown") };
  }

  if (pdfResponses.length === 0) {
    return { how: (result.method || "clicked") + " — sem PDF na resposta" };
  }

  // Salva primeiro PDF
  const { url: pdfUrl, buf } = pdfResponses[0];
  const pdfName = `diario-${Date.now()}.pdf`;
  const pdfPath = path.join(PDF_DIR, pdfName);
  await fsp.writeFile(pdfPath, buf);

  return { how: result.method || "eval onclick", pdfUrl, pdfPath, pdfBuffer: buf };
}

async function parsePdfBufferToText(buf) {
  try {
    const { text } = await pdfParse(buf);
    return text || "";
  } catch {
    return "";
  }
}

async function gotoDejtAndConfigure(page, { dataPt, tribunalNumero }) {
  await page.setExtraHTTPHeaders({ "Accept-Language": "pt-BR,pt;q=0.9" });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
  );
  await page.goto(DEJT_URL, { waitUntil: "networkidle2", timeout: 60000 });
  await sleep(1200);

  // Marca Judiciário e Disponibilização + datas
  await page.evaluate((dataPt) => {
    const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
    for (const r of radios) {
      if (r.value === "J" || /judici/i.test(r.id || "") || /judici/i.test(r.name || "")) {
        r.checked = true;
        r.click();
        r.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    const dispo = radios.find(
      (r) =>
        /disponibiliza/i.test(r.id || "") ||
        /disponibiliza/i.test(r.name || "") ||
        /Disponibiliza/i.test(
          (document.querySelector(`label[for="${r.id}"]`)?.textContent || "")
        )
    );
    if (dispo) {
      dispo.checked = true;
      dispo.dispatchEvent(new Event("click", { bubbles: true }));
      dispo.dispatchEvent(new Event("change", { bubbles: true }));
    }
    function setDate(inp, val) {
      if (!inp) return;
      inp.focus();
      inp.dispatchEvent(new Event("focus", { bubbles: true }));
      inp.value = "";
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      inp.value = val;
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      inp.dispatchEvent(new Event("change", { bubbles: true }));
      inp.blur();
      inp.dispatchEvent(new Event("blur", { bubbles: true }));
    }
    const all = Array.from(document.querySelectorAll("input"));
    const ini = all.find((i) => /data.?ini|dt.?ini/i.test((i.id || "") + (i.name || "")));
    const fim = all.find((i) => /data.?fim|dt.?fim/i.test((i.id || "") + (i.name || "")));
    setDate(ini, dataPt);
    setDate(fim, dataPt);
  }, dataPt);
  await sleep(400);

  // Seleciona tribunal por número no texto
  await page.evaluate((num) => {
    const selects = document.querySelectorAll("select");
    for (const sel of selects) {
      if (sel.options && sel.options.length > 5) {
        for (const opt of sel.options) {
          const texto = (opt.textContent || "").trim();
          const onlyNum = texto.replace(/\D/g, "");
          if (onlyNum === num) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
          }
        }
      }
    }
    return false;
  }, tribunalNumero);
  await sleep(700);

  const beforeLen = await page.evaluate(() => document.body.innerText.length);
  await clickPesquisarReal(page);
  await waitJsfResult(page, beforeLen);
}

// ===== DEBUG
app.get("/debug/env", (_req, res) => {
  res.json({
    BASE_URL,
    DEMO,
    MIN_TICKET_CENTS,
    SCAN_TRIBUNAIS,
    CONCURRENCY,
    PDF_DIR,
    EXPORTS_DIR,
    TZ,
    PUPPETEER_EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH ? "(set)" : "(unset)",
  });
});

// Testa o clique de Baixar e captura PDF
app.get("/debug/download", async (req, res) => {
  const logs = [];
  const log = (m) => {
    logs.push(m);
    console.log(m);
  };
  try {
    const tribunais = String(req.query.tribunais || "TRT15");
    const dataParam = req.query.data || null;

    const d = dataParam ? new Date(dataParam) : new Date();
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    const dataPt = `${dd}/${mm}/${yyyy}`;
    const num = tribunais.replace(/\D/g, "") || "15";

    const browser = await launchBrowser();
    const page = await browser.newPage();

    await gotoDejtAndConfigure(page, { dataPt, tribunalNumero: num });

    // Espelha o que você viu: inspeciona o link e executa
    const linkInfo = await page.evaluate(() => {
      const link =
        document.querySelector("a.link-download") ||
        document.querySelector('a[onclick*="plcLogicaItens"]') ||
        null;
      if (!link) return null;
      return {
        href: link.getAttribute("href"),
        onclick: link.getAttribute("onclick"),
        classe: link.className,
        html: link.outerHTML.substring(0, 300),
      };
    });
    log("[download] link: " + JSON.stringify(linkInfo));

    const opened = await openFirstCadernoAndGetPdf(page);
    await browser.close();

    const okPdf = !!opened.pdfPath;
    return res.json({
      ok: true,
      data: dataPt,
      linkInfo,
      pdf_saved: okPdf,
      pdf_file: okPdf ? `${BASE_URL}/pdf/${path.basename(opened.pdfPath)}` : null,
      reason: okPdf ? null : opened.how || "no-pdf",
      logs,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e), logs });
  }
});

// Mostra estrutura pós-pesquisa e tenta capturar PDF também
app.get("/debug/pesquisa", async (req, res) => {
  const logs = [];
  const log = (m) => {
    logs.push(m);
    console.log(m);
  };
  try {
    const tribunais = String(req.query.tribunais || "TRT15");
    const dataParam = req.query.data || null;

    const d = dataParam ? new Date(dataParam) : new Date();
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    const dataPt = `${dd}/${mm}/${yyyy}`;
    const num = tribunais.replace(/\D/g, "") || "15";

    const browser = await launchBrowser();
    const page = await browser.newPage();

    await gotoDejtAndConfigure(page, { dataPt, tribunalNumero: num });

    const bodyLenBefore = await page.evaluate(() => document.body.innerText.length);

    const opened = await openFirstCadernoAndGetPdf(page);

    let textSample = "";
    if (opened.pdfBuffer) {
      const text = await parsePdfBufferToText(opened.pdfBuffer);
      textSample = text.substring(0, 2000);
    }

    await browser.close();

    return res.json({
      ok: true,
      data: dataPt,
      tribunais,
      resultado: {
        tamanhoBody: bodyLenBefore,
        textoPdfSample: textSample,
        pdf: opened.pdfPath ? `${BASE_URL}/pdf/${path.basename(opened.pdfPath)}` : null,
        pdfUrl: opened.pdfUrl || null,
        how: opened.how || "",
      },
      logs,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e), logs });
  }
});

// ===== MINERADOR baseado em PDF do caderno
async function fetchDiarioPdfText({ data, tribunal }) {
  const d = data ? new Date(data) : new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  const dataPt = `${dd}/${mm}/${yyyy}`;
  const num = String(tribunal || "TRT15").replace(/\D/g, "") || "15";

  const browser = await launchBrowser();
  const page = await browser.newPage();
  await gotoDejtAndConfigure(page, { dataPt, tribunalNumero: num });
  const opened = await openFirstCadernoAndGetPdf(page);
  await browser.close();

  if (!opened.pdfBuffer) return { pdfText: "", pdfPath: null, how: opened.how || "" };
  const text = await parsePdfBufferToText(opened.pdfBuffer);
  return {
    pdfText: text || "",
    pdfPath: opened.pdfPath || null,
    how: opened.how || "",
  };
}

function extractCandidatesFromDiarioText(text, dateISO, tribunalCode = "TRT15") {
  if (!text) return [];
  const blocks = text.split(/(?=\n.*?(ALVAR[ÁA]|LEVANTAMENTO|LIBERA[ÇC][AÃ]O).*?\n)/i);
  const out = [];
  for (const raw of blocks) {
    if (!RX_ALVAR.test(raw)) continue;
    const proc = (raw.match(RX_PROC) || [])[0] || "";
    if (!proc) continue;

    let valorCents = NaN;
    let m;
    while ((m = RX_MOEDA.exec(raw))) {
      const cents = brlToCents(m[1]);
      if (!Number.isFinite(valorCents) || cents > valorCents) valorCents = cents;
    }
    if (!Number.isFinite(valorCents)) continue;

    const pf = pickProvavelPF(raw);
    if (!pf) continue;

    out.push({
      tribunal: tribunalCode,
      vara: "",
      processo: proc,
      data_ato: dateISO,
      pf_nome: pf,
      valor_centavos: valorCents,
      tipo_ato: "e-Alvará",
      banco_pagador: /CEF|CAIXA/i.test(raw) ? "CEF" : "BB",
      id_ato: "",
      link_oficial: "",
      _amostra: raw.substring(0, 800),
    });
  }
  return out;
}

async function scanMiner({ limit = 60, tribunais = "TRT15", data = null }) {
  if (DEMO) return { items: [], totalBruto: 0, discards: {}, logs: ["DEMO on"] };

  const d = data ? new Date(data) : new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const iso = `${yyyy}-${mm}-${dd}`;

  const pedidos = String(tribunais || SCAN_TRIBUNAIS || "TRT15")
    .split(/\s*,\s*/)
    .filter(Boolean);

  const logs = [];
  const out = [];
  const discards = { sem_pdf: 0, sem_matches: 0 };

  for (const orgao of pedidos) {
    const { pdfText, how } = await fetchDiarioPdfText({
      data: iso,
      tribunal: orgao,
    });

    logs.push(`[miner] ${orgao}: ${how || "—"}; texto=${pdfText.length}`);

    if (!pdfText) {
      discards.sem_pdf++;
      continue;
    }

    const candidates = extractCandidatesFromDiarioText(pdfText, iso, orgao);
    if (!candidates.length) {
      discards.sem_matches++;
      continue;
    }

    for (const c of candidates) {
      out.push(c);
      if (out.length >= limit) break;
    }
    if (out.length >= limit) break;
  }

  return { items: out.slice(0, limit), totalBruto: out.length, discards, logs };
}

// ===== /scan
app.get("/scan", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 60), 120);
    const tribunais = String(req.query.tribunais || SCAN_TRIBUNAIS || "TRT15");
    const data = req.query.data || null;
    const wantDebug = String(req.query.debug || "0") === "1";

    const { items, totalBruto, discards, logs } = await scanMiner({
      limit,
      tribunais,
      data,
    });

    if (wantDebug) {
      return res.json({
        ok: true,
        data,
        tribunais,
        total: items.length,
        total_bruto: totalBruto,
        discards,
        preview: items.slice(0, 3),
        logs: logs.slice(-40),
      });
    }

    res.json({ ok: true, items: items.slice(0, limit) });
  } catch (e) {
    console.error("Erro /scan:", e);
    res.status(500).json({ ok: false, error: "Falha no scan", cause: String(e?.message || e) });
  }
});

// ===== /relatorio
app.get("/relatorio", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 15), 50);
    const data = req.query.data || null;
    const tribunais = String(req.query.tribunais || SCAN_TRIBUNAIS || "TRT15");
    const wantDebug = String(req.query.debug || "0") === "1";

    const { items, totalBruto, discards, logs } = await scanMiner({
      limit: limit * 3,
      tribunais,
      data,
    });

    const filtrados = items
      .filter((c) => {
        const isPF = _parecePF(c.pf_nome);
        const hasTicket = Number(c.valor_centavos) >= MIN_TICKET_CENTS;
        const atoPronto = RX_ALVAR.test(String(c.tipo_ato || ""));
        return c.processo && isPF && hasTicket && atoPronto;
      })
      .slice(0, limit);

    if (wantDebug) {
      return res.json({
        ok: true,
        data,
        tribunais,
        total_bruto: totalBruto,
        total_filtrado: filtrados.length,
        contadores_descartes: discards,
        preview: filtrados.slice(0, 5),
        logs: logs?.slice(-30),
      });
    }

    if (!filtrados.length) {
      return res.status(404).json({
        ok: false,
        error: `Nada elegível no DEJT (${tribunais}) para a data.`,
        total_bruto: totalBruto,
        total_filtrado: 0,
      });
    }

    const rows = filtrados
      .map(
        (c, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${safe(c.pf_nome)}</td>
        <td>${safe(c.processo)}</td>
        <td>${safe(c.tribunal)}</td>
        <td>${safe(c.tipo_ato || "e-Alvará")}</td>
        <td>${centavosToBRL(c.valor_centavos)}</td>
        <td>${safe(c._amostra || "").substring(0, 120)}...</td>
      </tr>`
      )
      .join("");

    const dataLabel = data
      ? new Date(data).toLocaleDateString("pt-BR")
      : new Date().toLocaleDateString("pt-BR");

    const html = `<!doctype html><html lang="pt-br"><meta charset="utf-8">
<title>Dossiê Consolidado — ${filtrados.length} casos</title>
<style>
  body{font-family:system-ui,Arial;margin:24px;color:#111}
  h1{font-size:20px;margin:0 0 12px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{border:1px solid #ddd;padding:8px;vertical-align:top}
  th{background:#f4f6f8;text-align:left}
  .meta{opacity:.75;font-size:12px;margin-bottom:12px}
</style>
<h1>Dossiê Consolidado — ${filtrados.length} casos (${safe(
      tribunais
    )} / ${dataLabel})</h1>
<div class="meta">Regra TORRE: PF nominal • Ticket ≥ ${centavosToBRL(
      MIN_TICKET_CENTS
    )} • Ato pronto</div>
<table>
  <thead><tr><th>#</th><th>PF</th><th>Processo</th><th>Tribunal</th><th>Ato</th><th>Valor</th><th>Trecho (debug)</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
</html>`;

    const fileName = `relatorio-${Date.now()}.pdf`;
    const filePath = path.join(PDF_DIR, fileName);

    const browser = await launchBrowser();
    const pg = await browser.newPage();
    await pg.setContent(html, { waitUntil: "networkidle0" });
    await pg.pdf({
      path: filePath,
      format: "A4",
      margin: { top: "12mm", right: "12mm", bottom: "14mm", left: "12mm" },
      printBackground: true,
    });
    await browser.close();

    lastPdfFile = fileName;

    return res.json({
      ok: true,
      count: filtrados.length,
      url: `${BASE_URL}/pdf/${fileName}`,
      items: filtrados.map((c) => ({
        pf_nome: c.pf_nome,
        processo: c.processo,
        valor: centavosToBRL(c.valor_centavos),
        tribunal: c.tribunal,
      })),
    });
  } catch (e) {
    console.error("Erro /relatorio:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ===== /gerar-dossie
async function renderFromTemplate(vars) {
  let html = await fsp.readFile(TEMPLATE_PATH, "utf8");
  let qrcodeDataUrl = "";
  const link = (vars.id_ato || vars.link_oficial || "").toString().trim();
  if (link) {
    try {
      qrcodeDataUrl = await QRCode.toDataURL(link, { margin: 0 });
    } catch {}
  }
  const allVars = { ...vars, qrcode_dataurl: qrcodeDataUrl };
  for (const [k, v] of Object.entries(allVars)) {
    html = html.replaceAll(`{{${k}}}`, v == null ? "" : String(v));
  }
  return html;
}

app.post(["/gerar-dossie", "/gerar-proposta"], async (req, res) => {
  try {
    const {
      tribunal,
      vara,
      processo,
      data_ato,
      pf_nome,
      valor_centavos,
      valor_reais,
      tipo_ato,
      banco_pagador,
      id_ato,
      link_oficial,
      fee_percent,
    } = req.body || {};

    const isPF = _parecePF(pf_nome);
    const cents = Number.isFinite(valor_centavos)
      ? Number(valor_centavos)
      : Math.round(
          Number(String(valor_reais || 0).replace(/\./g, "").replace(",", ".")) * 100
        );

    const hasTicket = Number.isFinite(cents) && cents >= MIN_TICKET_CENTS;
    const atoPronto = RX_ALVAR.test(String(tipo_ato || ""));

    if (!tribunal || !processo || !isPF || !hasTicket || !atoPronto) {
      return res.status(400).json({
        ok: false,
        error: "Regras TORRE: PF nominal, ticket ≥ R$ 20k e ato pronto.",
      });
    }

    const valorBRL = centavosToBRL(cents);

    const html = await renderFromTemplate({
      tribunal: safe(tribunal),
      vara: safe(vara || ""),
      processo: safe(processo),
      data_ato: safe(data_ato || ""),
      pf_nome: safe(pf_nome),
      valor_brl: safe(valorBRL),
      tipo_ato: safe(tipo_ato || "e-Alvará"),
      banco_pagador: safe(banco_pagador || "BB/CEF"),
      id_ato: safe(id_ato || link_oficial || ""),
      fee_percent: safe(fee_percent || "10–20"),
      link_oficial: safe(link_oficial || ""),
    });

    const fileName = `dossie-${Date.now()}.pdf`;
    const filePath = path.join(PDF_DIR, fileName);

    const browser = await launchBrowser();
    const pg = await browser.newPage();
    await pg.setContent(html, { waitUntil: "networkidle0" });
    await pg.pdf({
      path: filePath,
      format: "A4",
      margin: { top: "14mm", bottom: "14mm", left: "14mm", right: "14mm" },
      printBackground: true,
    });
    await browser.close();

    lastPdfFile = fileName;

    const pitch = `${pf_nome}, no ${tribunal} proc. ${processo} há ${
      tipo_ato || "e-Alvará"
    } de ${valorBRL} em seu nome.\nTe guio BB/CEF em 3–7 dias; você só me paga 10–20% após cair. Dossiê: ${BASE_URL}/pdf/${fileName}`;

    return res.json({
      ok: true,
      url: `${BASE_URL}/pdf/${fileName}`,
      whatsapp: makeWaLink(pitch),
      email: makeEmailLink(`Dossiê — ${tribunal} — proc. ${processo}`, pitch),
      file: fileName,
    });
  } catch (e) {
    console.error("Erro /gerar-dossie:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ===== /batch & /pack
app.post("/batch", async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ ok: false, error: "Envie items: []" });

    const limit = pLimit(CONCURRENCY);
    const results = [];

    for (const body of items) {
      const run = async () => {
        try {
          const response = await fetch(`${BASE_URL}/gerar-dossie`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          return response.json();
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      };
      results.push(limit(run));
    }

    const out = await Promise.all(results);

    const csvName = `lote-${Date.now()}.csv`;
    const csvPath = path.join(EXPORTS_DIR, csvName);

    const lines = ['tribunal,processo,pf_nome,valor,pdf_url,whatsapp,status'];
    for (let i = 0; i < items.length; i++) {
      const c = items[i];
      const r = out[i] || {};
      const valor = Number.isFinite(c.valor_centavos)
        ? centavosToBRL(c.valor_centavos)
        : c.valor_reais || "";
      lines.push(
        [
          c.tribunal || "",
          c.processo || "",
          (c.pf_nome || "").replace(/,/g, " "),
          valor,
          r.url || "",
          r.whatsapp || "",
          r.ok ? "OK" : "ERRO",
        ]
          .map((x) => `"${String(x ?? "").replace(/"/g, '""')}"`)
          .join(",")
      );
    }
    await fsp.writeFile(csvPath, lines.join("\n"), "utf8");

    return res.json({
      ok: true,
      items: out,
      csv: `${BASE_URL}/exports/${csvName}`,
    });
  } catch (e) {
    console.error("Erro /batch:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

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
    await new Promise((resolve) => output.on("close", resolve));

    res.json({ ok: true, zip: `${BASE_URL}/exports/${zipName}` });
  } catch (e) {
    console.error("Erro /pack:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ===== Aux
app.get("/pdf/proposta.pdf", (_req, res) => {
  if (!lastPdfFile) return res.status(404).send("PDF ainda não gerado.");
  return res.redirect(`${BASE_URL}/pdf/${lastPdfFile}`);
});

app.get("/debug/last", (_req, res) => {
  res.json({
    lastPdfFile,
    exists: lastPdfFile ? fs.existsSync(path.join(PDF_DIR, lastPdfFile)) : false,
    open: lastPdfFile ? `${BASE_URL}/pdf/${lastPdfFile}` : null,
  });
});

// ===== Start
app.listen(PORT, () => console.log(`TORRE v5.2 rodando na porta ${PORT}`));

process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));
