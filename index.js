// index.js — TORRE PF e-Alvará (TRT) — v5.1 (PDF do caderno suportado)
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

if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });
if (!fs.existsSync(EXPORTS_DIR)) fs.mkdirSync(EXPORTS_DIR, { recursive: true });

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "2mb" }));
app.use(morgan("tiny"));

let lastPdfFile = null;

app.use("/pdf", express.static(PDF_DIR, {
  setHeaders: (res) => {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Cache-Control", "no-store");
  },
}));
app.use("/exports", express.static(EXPORTS_DIR));

app.get("/", (_req, res) => res.send("Backend TORRE v5.1 — DEJT (caderno PDF)"));
app.get("/health", (_req, res) => res.json({ ok: true, now: new Date().toISOString() }));

// ===== Utils
const centavosToBRL = (c) =>
  (Math.round(c) / 100).toLocaleString("pt-BR", {
    style: "currency", currency: "BRL", minimumFractionDigits: 2,
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
  if (s.includes(" LTDA") || s.includes(" S.A") || s.includes(" S/A") ||
      s.includes(" EPP") || s.includes(" MEI ") || s.includes(" EIRELI")) return false;
  return s.trim().split(/\s+/).length >= 2;
}

function pickProvavelPF(texto) {
  const linhas = (texto || "").split(/\n+/).map((l) => l.trim()).filter(Boolean);
  for (const l of linhas) {
    if (/(benef|titular|credor|reclamante|autor)/i.test(l)) {
      const campo = l.replace(/.*?:/, "").replace(/\(.*?\)/g, "").trim();
      if (_parecePF(campo)) return campo;
    }
  }
  for (const l of linhas) if (_parecePF(l)) return l;
  return "";
}

// ===== Template & QR
async function renderFromTemplate(vars) {
  let html = await fsp.readFile(TEMPLATE_PATH, "utf8");
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
  return "https://wa.me/?text=" + encodeURIComponent(text);
}
function makeEmailLink(subject, body) {
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

// ===== Regex e DEJT
const DEJT_URL = "https://dejt.jt.jus.br/dejt/f/n/diariocon";
const RX_PROC = /\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/g;
const RX_MOEDA = /R\$\s*([\d\.]+,\d{2})/g;
const RX_ALVAR = /(alvar[aá]|levantamento|libera[cç][aã]o)/i;
const RX_BANCO = /(CEF|CAIXA|BANCO\s+DO\s+BRASIL|BB)/i;

// Helper de espera
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ====== Navegação/listagem → abrir caderno
async function clickPesquisarReal(page) {
  const tryClickIn = async (ctx) => {
    try {
      const selId = '[id="corpo:formulario:botaoAcaoPesquisar"]';
      const btn = await ctx.$(selId);
      if (btn) {
        await ctx.$eval(selId, el => el.scrollIntoView({ block: "center" }));
        await ctx.click(selId, { delay: 30 });
        return "page.click(corpo:formulario:botaoAcaoPesquisar)";
      }
      const btnPesquisar = await ctx.$('input[value="Pesquisar"]');
      if (btnPesquisar) {
        await ctx.$eval('input[value="Pesquisar"]', el => el.scrollIntoView({ block: "center" }));
        await ctx.click('input[value="Pesquisar"]', { delay: 30 });
        return "page.click(input[value=Pesquisar])";
      }
      return null;
    } catch { return null; }
  };
  let how = await tryClickIn(page);
  if (how) return how;
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    how = await tryClickIn(f);
    if (how) return how + " (iframe)";
  }
  return "no-button-found";
}

async function waitJsfResult(page, beforeLen) {
  await Promise.race([
    page.waitForResponse(r => r.request().method() === "POST", { timeout: 15000 }),
    page.waitForNetworkIdle({ idleTime: 1500, timeout: 15000 }).catch(() => {})
  ]).catch(() => {});
  await page.waitForSelector("table tbody tr, .ui-datatable, .rich-table, a[href*='visualizar']", { timeout: 12000 }).catch(() => {});
  await page.waitForFunction(
    prev => (document.body.innerText || "").length > prev + 500,
    { timeout: 20000 }, beforeLen
  ).catch(() => {});
  await sleep(800);
}

async function openFirstCaderno(page) {
  return await page.evaluate(() => {
    function execOnclick(onclick) {
      if (!onclick) return false;
      const cleaned = onclick.replace(/;?\s*return\s+(false|true)\s*;?\s*$/i, "");
      try { eval(cleaned); return true; } catch { return false; }
    }
    const link = document.querySelector('a.link-download, a[onclick*="plcLogicaItens"], [onclick*="j_id132"]');
    if (!link) return { ok: false, how: "no-link" };
    const oc = link.getAttribute("onclick") || "";
    if (oc && execOnclick(oc)) return { ok: true, how: "eval onclick" };
    link.click();
    return { ok: true, how: "click()" };
  });
}

// ====== NOVO: baixa o PDF do caderno (DEJT retorna no mesmo endpoint)
async function tryDownloadCadernoPdf(page, { save = true, label = "" } = {}) {
  // aguardará a primeira resposta que pareça PDF do diário
  const pdfRespPromise = page.waitForResponse((resp) => {
    const url = resp.url();
    if (!/dejt\.jt\.jus\.br\/dejt\/f\/n\/diariocon/i.test(url)) return false;
    const ct = (resp.headers()["content-type"] || "").toLowerCase();
    return ct.includes("application/pdf");
  }, { timeout: 15000 }).catch(() => null);

  // tenta clicar no link (se ainda não clicado)
  await page.evaluate(() => {
    const link = document.querySelector('a.link-download, a[onclick*="plcLogicaItens"], [onclick*="j_id132"]');
    if (link) {
      const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
      link.dispatchEvent(ev);
      if (typeof link.click === "function") link.click();
    } else if (typeof window.submitForm === "function") {
      try { window.submitForm("corpo:formulario", 1, { source: "corpo:formulario:plcLogicaItens:0:j_id132" }); } catch {}
    }
  });

  const resp = await pdfRespPromise;
  if (!resp) return { ok: false, reason: "no-pdf-response" };

  const buf = await resp.buffer().catch(() => null);
  if (!buf || !buf.length) return { ok: false, reason: "empty-buffer" };

  let saved = null;
  if (save) {
    const fname = `dejt-caderno-${Date.now()}${label ? "-" + label : ""}.pdf`;
    const fpath = path.join(PDF_DIR, fname);
    await fsp.writeFile(fpath, buf);
    saved = fname;
    lastPdfFile = fname;
  }
  return { ok: true, buffer: buf, file: saved };
}

// ====== NOVO: parser simples do texto do diário
function extractItemsFromDiarioText(text, { orgao, dataISO }) {
  // Estratégia: encontra ocorrências com "alvar" + processo + valor no raio de 800 chars
  const items = [];
  const idxs = [];
  const lower = text.toLowerCase();
  let start = 0;
  while (true) {
    const i = lower.indexOf("alvar", start);
    if (i === -1) break;
    idxs.push(i);
    start = i + 4;
  }
  for (const i of idxs) {
    const bloco = text.substring(Math.max(0, i - 600), Math.min(text.length, i + 800));
    const proc = (bloco.match(RX_PROC) || [])[0] || "";
    if (!proc) continue;

    let valorCents = NaN, m;
    while ((m = RX_MOEDA.exec(bloco))) {
      const cents = brlToCents(m[1]);
      if (!Number.isFinite(valorCents) || cents > valorCents) valorCents = cents;
    }
    if (!Number.isFinite(valorCents)) continue;

    const pf = pickProvavelPF(bloco);
    if (!pf) continue;

    const banco = (RX_BANCO.exec(bloco)?.[1] || "").toUpperCase().includes("CAIXA") ? "CEF" :
                  (RX_BANCO.exec(bloco)?.[1] || "").toUpperCase().includes("BB") ? "BB" : "BB/CEF";

    items.push({
      tribunal: orgao,
      vara: "",
      processo: proc,
      data_ato: dataISO,
      pf_nome: pf,
      valor_centavos: valorCents,
      tipo_ato: "e-Alvará",
      banco_pagador: banco,
      id_ato: `DEJT:${orgao}:${dataISO}:${proc}`,
      link_oficial: "", // no PDF não tem link direto do ato
    });
  }
  return items;
}

// ===== Debug endpoints
app.get("/debug/env", (_req, res) => {
  res.json({
    BASE_URL, DEMO, MIN_TICKET_CENTS, SCAN_TRIBUNAIS, CONCURRENCY,
    PDF_DIR, EXPORTS_DIR, TZ: process.env.TZ || null,
    PUPPETEER_EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH ? "(set)" : "(unset)",
  });
});

// Debug: testa especificamente o download do caderno (e salva PDF)
app.get("/debug/download", async (req, res) => {
  const logs = [];
  const log = (msg) => { console.log(msg); logs.push(msg); };
  try {
    const tribunais = String(req.query.tribunais || "TRT15");
    const dataParam = req.query.data || null;

    const d = dataParam ? new Date(dataParam) : new Date();
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    const dataPt = `${dd}/${mm}/${yyyy}`;
    const dataISO = `${yyyy}-${mm}-${dd}`;

    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--lang=pt-BR"],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    });
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ "Accept-Language": "pt-BR,pt;q=0.9" });
    await page.goto(DEJT_URL, { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(1500);

    // configura formulário
    await page.evaluate((dataPt) => {
      const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
      for (const r of radios) {
        if (r.value === "J" || /judici/i.test(r.id || "")) { r.checked = true; r.click(); }
      }
      const all = Array.from(document.querySelectorAll("input"));
      const ini = all.find(i => /data.?ini/i.test((i.id || "") + (i.name || "")));
      const fim = all.find(i => /data.?fim/i.test((i.id || "") + (i.name || "")));
      if (ini) { ini.value = dataPt; ini.dispatchEvent(new Event("change", { bubbles: true })); }
      if (fim) { fim.value = dataPt; fim.dispatchEvent(new Event("change", { bubbles: true })); }
    }, dataPt);

    const numTribunal = tribunais.replace(/\D/g, "");
    await page.evaluate((num) => {
      const selects = document.querySelectorAll("select");
      for (const sel of selects) {
        for (const opt of sel.options) {
          const numOpt = (opt.textContent || "").replace(/\D/g, "");
          if (numOpt === num) { sel.value = opt.value; sel.dispatchEvent(new Event("change", { bubbles: true })); return; }
        }
      }
    }, numTribunal);

    await sleep(800);
    await clickPesquisarReal(page);
    await waitJsfResult(page, 900);

    // pega metadados do link
    const linkInfo = await page.evaluate(() => {
      const link = document.querySelector('a.link-download, a[onclick*="plcLogicaItens"]');
      if (!link) return null;
      return {
        href: link.getAttribute("href"),
        onclick: link.getAttribute("onclick"),
        classe: link.className,
        html: link.outerHTML.substring(0, 300)
      };
    });
    log(`[download] link: ${JSON.stringify(linkInfo)}`);

    // tenta baixar o PDF
    const pdf = await tryDownloadCadernoPdf(page, { save: true, label: numTribunal });
    await browser.close();

    res.json({
      ok: true,
      data: dataPt,
      linkInfo,
      pdf_saved: !!pdf.file,
      pdf_file: pdf.file ? `${BASE_URL}/pdf/${pdf.file}` : null,
      reason: pdf.ok ? null : pdf.reason,
      logs
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ===== MINERADOR PRINCIPAL (agora tenta PDF do caderno)
async function scanMiner({ limit = 60, tribunais = "TRT15", data = null }) {
  if (DEMO) return { items: [], registrosBrutos: [], totalBruto: 0, discards: {} };

  const logs = [];
  const log = (msg) => { console.log(msg); logs.push(msg); };

  const d = data ? new Date(data) : new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  const dataPt = `${dd}/${mm}/${yyyy}`;
  const dataISO = `${yyyy}-${mm}-${dd}`;

  log(`[miner] Iniciando scan para ${tribunais} em ${dataPt}`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--lang=pt-BR"],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  });

  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ "Accept-Language": "pt-BR,pt;q=0.9" });
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36");
  page.setDefaultNavigationTimeout(60000);
  page.setDefaultTimeout(30000);

  await page.goto(DEJT_URL, { waitUntil: "networkidle2", timeout: 60000 });
  await sleep(1500);

  // Marca opções e datas
  await page.evaluate((dataPt) => {
    const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
    for (const r of radios) {
      if (r.value === "J" || /judici/i.test(r.id || "") || /judici/i.test(r.name || "")) {
        r.checked = true; r.click(); r.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    const all = Array.from(document.querySelectorAll("input"));
    const ini = all.find(i => /data.?ini|dt.?ini/i.test((i.id || "") + (i.name || "")));
    const fim = all.find(i => /data.?fim|dt.?fim/i.test((i.id || "") + (i.name || "")));
    if (ini) { ini.value = dataPt; ini.dispatchEvent(new Event("change", { bubbles: true })); }
    if (fim) { fim.value = dataPt; fim.dispatchEvent(new Event("change", { bubbles: true })); }
  }, dataPt);

  // normalizador
  const norm = (s) => String(s || "").toUpperCase().replace(/\s+/g, " ").replace(/TRT\s*(\d+).*/i, "TRT$1").trim();

  // mapeia órgãos disponíveis
  const orgaosDisponiveis = await page.evaluate(() => {
    const candidatos = [
      'select[name*="tribunal"]', 'select[id*="tribunal"]',
      'select[name*="orgao"]', 'select[id*="orgao"]',
      'select[name*="Tribunal"]', 'select[id*="Tribunal"]'
    ];
    let sel = null;
    for (const s of candidatos) {
      const x = document.querySelector(s);
      if (x && x.options && x.options.length > 1) { sel = x; break; }
    }
    if (!sel) {
      const all = document.querySelectorAll("select");
      for (const s of all) { if (s.options && s.options.length > 5) { sel = s; break; } }
    }
    if (!sel) return [];
    return Array.from(sel.options || []).map(o => ({ value: o.value, label: (o.textContent || "").trim() }));
  });

  const mapDisp = orgaosDisponiveis.map(o => ({ value: o.value, code: norm(o.label), label: o.label }));
  const tribunaisRaw = String(tribunais || SCAN_TRIBUNAIS || "TRT15").trim();
  let lista;
  if (/^(ALL|\*|TRT\*)$/i.test(tribunaisRaw)) {
    lista = mapDisp.filter(o => /^TRT\d+$/i.test(o.code)).map(o => o.code);
  } else {
    const pedidos = tribunaisRaw.split(/\s*,\s*/).filter(Boolean).map(norm);
    const setDisp = new Set(mapDisp.map(o => o.code));
    lista = pedidos.filter(p => setDisp.has(p));
  }
  if (!lista.length && mapDisp.length > 0) {
    const primeiro = mapDisp.find(o => /^TRT\d+$/i.test(o.code));
    if (primeiro) lista = [primeiro.code];
  }
  if (!lista.length) lista = ["TRT15"];
  log(`[miner] Varredura: ${lista.join(", ")}`);

  const registrosBrutos = [];
  const outItems = [];
  const discards = { sem_ato: 0, sem_processo: 0, sem_valor: 0, sem_pf: 0, erro_pagina: 0 };

  for (const orgao of lista) {
    if (outItems.length >= limit) break;

    // seleciona órgão
    const selecionou = await page.evaluate((orgao) => {
      const candidatos = [
        'select[name*="tribunal"]', 'select[id*="tribunal"]',
        'select[name*="orgao"]', 'select[id*="orgao"]'
      ];
      let sel = null;
      for (const s of candidatos) {
        const x = document.querySelector(s);
        if (x && x.options && x.options.length > 1) { sel = x; break; }
      }
      if (!sel) {
        const all = document.querySelectorAll("select");
        for (const s of all) if (s.options && s.options.length > 5) { sel = s; break; }
      }
      if (!sel) return { ok: false, reason: "select não encontrado" };
      const numPedido = String(orgao).replace(/\D/g, "");
      const alvo = Array.from(sel.options || []).find(o => (o.textContent || "").replace(/\D/g, "") === numPedido);
      if (!alvo) return { ok: false, reason: "opção não encontrada" };
      sel.value = alvo.value; sel.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, selecionado: alvo.textContent };
    }, orgao);
    if (!selecionou.ok) { log(`[miner] Falha selecionar ${orgao}: ${selecionou.reason}`); continue; }

    await sleep(600);
    const beforeLen = await page.evaluate(() => document.body.innerText.length);
    await clickPesquisarReal(page);
    await waitJsfResult(page, beforeLen);

    // verificamos se há listagem de cadernos
    const temCaderno = await page.evaluate(() => {
      const body = document.body.innerText || "";
      return /Edi[çc][ãa]o\s+\d+/i.test(body) || /Caderno.*Judici/i.test(body);
    });

    if (temCaderno) {
      // abre (executa onclick/click) e tenta baixar PDF resultante
      await openFirstCaderno(page);
      await sleep(800);
      const pdfRes = await tryDownloadCadernoPdf(page, { save: false });
      if (pdfRes.ok) {
        const text = (await pdfParse(pdfRes.buffer)).text || "";
        registrosBrutos.push({ href: "PDF-CADERNO", tam: text.length });
        const itens = extractItemsFromDiarioText(text, { orgao, dataISO });
        for (const it of itens) {
          if (outItems.length >= limit) break;
          if (!RX_ALVAR.test("e-Alvará")) continue;
          if (!_parecePF(it.pf_nome)) { discards.sem_pf++; continue; }
          if (!Number.isFinite(it.valor_centavos)) { discards.sem_valor++; continue; }
          outItems.push(it);
        }
        // segue próximo órgão
        continue;
      } else {
        log(`[miner] Não conseguiu baixar PDF: ${pdfRes.reason} — fallback links`);
      }
    }

    // ====== Fallback: varrendo links (código antigo)
    const linksAtos = await page.evaluate(() => {
      const links = new Set();
      const body = document.body.innerText || "";
      if (/alvar[aá]/i.test(body)) {
        document.querySelectorAll("a").forEach((a) => {
          const t = (a.textContent || "").toLowerCase().trim();
          const href = a.href || a.getAttribute("href") || "";
          if (
            t.includes("visualizar") || t.includes("inteiro teor") ||
            t.includes("conteúdo") || t.includes("conteudo") ||
            t.includes("exibir") || t.includes("abrir") || t.includes("ver") ||
            (href || "").includes("visualizar") || (href || "").includes("teor")
          ) {
            if (href && !href.startsWith("javascript:void")) {
              links.add(href.startsWith("http") ? href : (href.startsWith("/") ? "https://dejt.jt.jus.br" + href : href));
            }
          }
          if (href.includes("dejt.jt.jus.br") && !href.includes("diariocon")) links.add(href);
        });
        document.querySelectorAll("[onclick]").forEach((el) => {
          const oc = el.getAttribute("onclick") || "";
          const m = oc.match(/window\.open\(['"]([^'"]+)['"]/);
          if (m) links.add(m[1].startsWith("http") ? m[1] : "https://dejt.jt.jus.br" + m[1]);
        });
        document.querySelectorAll("td a[href]").forEach((a) => {
          const href = a.href || a.getAttribute("href") || "";
          if (href && !href.startsWith("javascript:void") && !href.includes("diariocon")) {
            links.add(href.startsWith("http") ? href : "https://dejt.jt.jus.br" + href);
          }
        });
      }
      return Array.from(links).slice(0, 100);
    });

    for (const href of linksAtos) {
      if (outItems.length >= limit) break;
      try {
        const pg = await browser.newPage();
        pg.setDefaultTimeout(15000);
        await pg.goto(href, { waitUntil: "domcontentloaded", timeout: 15000 });
        const conteudo = await pg.$eval("body", (el) => el.innerText || "").catch(() => "");
        await pg.close();

        registrosBrutos.push({ href, tam: conteudo.length });

        if (!conteudo || conteudo.length < 100) { discards.erro_pagina++; continue; }
        if (!RX_ALVAR.test(conteudo)) { discards.sem_ato++; continue; }

        const proc = (conteudo.match(RX_PROC) || [])[0] || "";
        if (!proc) { discards.sem_processo++; continue; }

        let valorCents = NaN, m;
        while ((m = RX_MOEDA.exec(conteudo))) {
          const cents = brlToCents(m[1]);
          if (!Number.isFinite(valorCents) || cents > valorCents) valorCents = cents;
        }
        if (!Number.isFinite(valorCents)) { discards.sem_valor++; continue; }

        const pf_nome = pickProvavelPF(conteudo);
        if (!pf_nome) { discards.sem_pf++; continue; }

        outItems.push({
          tribunal: orgao, vara: "", processo: proc, data_ato: dataISO,
          pf_nome, valor_centavos: valorCents, tipo_ato: "e-Alvará",
          banco_pagador: /CEF|CAIXA/i.test(conteudo) ? "CEF" : "BB",
          id_ato: href, link_oficial: href,
        });
      } catch { discards.erro_pagina++; }
    }
  }

  await browser.close();
  log(`[miner] Finalizado: ${outItems.length} itens`);

  return { items: outItems, registrosBrutos, totalBruto: registrosBrutos.length, discards, logs };
}

// ===== /scan
app.get("/scan", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 60), 120);
    const tribunais = String(req.query.tribunais || SCAN_TRIBUNAIS || "TRT15");
    const data = req.query.data || null;
    const wantDebug = String(req.query.debug || "0") === "1";

    const { items: brutos, registrosBrutos, totalBruto, discards, logs } = await scanMiner({
      limit, tribunais, data,
    });

    const filtrados = brutos.filter((c) => {
      const cents = Number(c.valor_centavos);
      const isPF = _parecePF(c.pf_nome);
      const atoPronto = RX_ALVAR.test(String(c.tipo_ato || ""));
      return c.tribunal && c.processo && isPF && Number.isFinite(cents) && cents >= MIN_TICKET_CENTS && atoPronto;
    });

    if (wantDebug) {
      return res.json({
        ok: true, data, tribunais, total_bruto: totalBruto,
        total_filtrado: filtrados.length,
        amostras_brutas: registrosBrutos.slice(0, 10),
        contadores_descartes: discards,
        itens_filtrados_preview: filtrados.slice(0, 5),
        logs: logs?.slice(-30)
      });
    }

    res.json({ ok: true, items: filtrados.slice(0, limit) });
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

    const { items: brutos, registrosBrutos, totalBruto, discards, logs } = await scanMiner({
      limit: limit * 3, tribunais, data,
    });

    const filtrados = brutos
      .filter((c) => {
        const isPF = _parecePF(c.pf_nome);
        const hasTicket = Number(c.valor_centavos) >= MIN_TICKET_CENTS;
        const atoPronto = RX_ALVAR.test(String(c.tipo_ato || ""));
        return c.processo && isPF && hasTicket && atoPronto;
      })
      .slice(0, limit);

    if (wantDebug) {
      return res.json({
        ok: true, data, tribunais, total_bruto: totalBruto,
        total_filtrado: filtrados.length,
        contadores_descartes: discards,
        amostras_brutas: registrosBrutos.slice(0, 10),
        itens_filtrados_preview: filtrados.slice(0, 5),
        logs: logs?.slice(-30)
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

    const rows = filtrados.map((c, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${safe(c.pf_nome)}</td>
        <td>${safe(c.processo)}</td>
        <td>${safe(c.tribunal)}</td>
        <td>${safe(c.tipo_ato || "e-Alvará")}</td>
        <td>${centavosToBRL(c.valor_centavos)}</td>
        <td><a href="${safe(c.link_oficial || c.id_ato || "#")}">ato</a></td>
      </tr>`
    ).join("");

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
<h1>Dossiê Consolidado — ${filtrados.length} casos (${safe(tribunais)} / ${dataLabel})</h1>
<div class="meta">Regra TORRE: PF nominal • Ticket ≥ ${centavosToBRL(MIN_TICKET_CENTS)} • Ato pronto</div>
<table>
  <thead><tr><th>#</th><th>PF</th><th>Processo</th><th>Tribunal</th><th>Ato</th><th>Valor</th><th>Prova</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
</html>`;

    const fileName = `relatorio-${Date.now()}.pdf`;
    const filePath = path.join(PDF_DIR, fileName);

    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    });
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
        link: c.link_oficial || c.id_ato,
      })),
    });
  } catch (e) {
    console.error("Erro /relatorio:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ===== /gerar-dossie
app.post(["/gerar-dossie", "/gerar-proposta"], async (req, res) => {
  try {
    const {
      tribunal, vara, processo, data_ato, pf_nome,
      valor_centavos, valor_reais, tipo_ato,
      banco_pagador, id_ato, link_oficial, fee_percent,
    } = req.body || {};

    const isPF = _parecePF(pf_nome);
    const cents = Number.isFinite(valor_centavos)
      ? Number(valor_centavos)
      : Math.round(Number(String(valor_reais || 0).replace(/\./g, "").replace(",", ".")) * 100);

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

    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    });
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

    const pitch = `${pf_nome}, no ${tribunal} proc. ${processo} há ${tipo_ato || "e-Alvará"} de ${valorBRL} em seu nome.\nTe guio BB/CEF em 3–7 dias; você só me paga 10–20% após cair. Dossiê: ${BASE_URL}/pdf/${fileName}`;
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

// ===== /batch
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
        } catch (e) { return { ok: false, error: String(e) }; }
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
      const valor = Number.isFinite(c.valor_centavos) ? centavosToBRL(c.valor_centavos) : c.valor_reais || "";
      lines.push([
        c.tribunal || "",
        c.processo || "",
        (c.pf_nome || "").replace(/,/g, " "),
        valor,
        r.url || "",
        r.whatsapp || "",
        r.ok ? "OK" : "ERRO",
      ].map((x) => `"${String(x ?? "").replace(/"/g, '""')}"`).join(","));
    }
    await fsp.writeFile(csvPath, lines.join("\n"), "utf8");

    return res.json({ ok: true, items: out, csv: `${BASE_URL}/exports/${csvName}` });
  } catch (e) {
    console.error("Erro /batch:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ===== /pack
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

// ===== Utils finais
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
app.listen(PORT, () => console.log(`TORRE v5.1 rodando na porta ${PORT}`));
process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));
