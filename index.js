// index.js — TORRE PF e-Alvará (TRT) — v5.1 UNIFICADA
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
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const PORT = Number(process.env.PORT || 3000);
const PDF_DIR = process.env.PDF_DIR || "/tmp/pdf";
const EXPORTS_DIR = process.env.EXPORTS_DIR || "/tmp/exports";
const TEMPLATE_PATH = path.join(__dirname, "template.html");
const DEJT_URL = "https://dejt.jt.jus.br/dejt/f/n/diariocon";

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

app.get("/", (_req, res) => res.send("Backend TORRE v5.1 — DEJT Unificada"));
app.get("/health", (_req, res) => res.json({ ok: true, now: new Date().toISOString() }));

// ===== Utils básicas
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const safe = (s = "") => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const centavosToBRL = (c) => (Math.round(c) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 2 });
function brlToCents(brlStr) {
  const s = String(brlStr).replace(/\./g, "").replace(",", ".");
  const v = Number(s);
  return Number.isFinite(v) ? Math.round(v * 100) : NaN;
}
function _parecePF(nome) {
  if (!nome) return false;
  const s = nome.toUpperCase();
  if (s.includes(" LTDA") || s.includes(" S.A") || s.includes(" S/A") || s.includes(" EPP") || s.includes(" MEI ") || s.includes(" EIRELI")) return false;
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
  if (link) { try { qrcodeDataUrl = await QRCode.toDataURL(link, { margin: 0 }); } catch {} }
  const allVars = { ...vars, qrcode_dataurl: qrcodeDataUrl };
  for (const [k, v] of Object.entries(allVars)) {
    html = html.replaceAll(`{{${k}}}`, v == null ? "" : String(v));
  }
  return html;
}
function makeWaLink(text) { return "https://wa.me/?text=" + encodeURIComponent(text); }
function makeEmailLink(subject, body) { return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`; }

// ===== Regex chaves
const RX_PROC = /\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/g;
const RX_MOEDA = /R\$\s*([\d\.]+,\d{2})/g;
const RX_ALVAR = /(alvar[aá]|levantamento|libera[cç][aã]o)/i;

// ===== Puppeteer helpers
async function launchBrowser() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--lang=pt-BR"],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  });
  return browser;
}

// Prepara filtros de pesquisa
async function prepararPesquisa(page, tribunais, dataPt) {
  await page.evaluate(() => {
    const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
    for (const r of radios) {
      if (r.value === "J" || /judici/i.test(r.id || "") || /judici/i.test(r.name || "")) {
        r.checked = true; r.click();
        r.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    const dispo = radios.find(r =>
      /disponibiliza/i.test(r.id || "") ||
      /disponibiliza/i.test(r.name || "") ||
      /Disponibiliza/i.test((document.querySelector(`label[for="${r.id}"]`)?.textContent || ""))
    );
    if (dispo) {
      dispo.checked = true;
      dispo.dispatchEvent(new Event("click", { bubbles: true }));
      dispo.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });

  await page.evaluate((dataPt) => {
    function setDate(inp, val) {
      if (!inp) return false;
      inp.focus();
      inp.dispatchEvent(new Event("focus", { bubbles: true }));
      inp.value = "";
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      inp.value = val;
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      inp.dispatchEvent(new Event("change", { bubbles: true }));
      inp.blur();
      inp.dispatchEvent(new Event("blur", { bubbles: true }));
      return true;
    }
    const all = Array.from(document.querySelectorAll("input"));
    const ini = all.find(i => /data.?ini|dt.?ini/i.test((i.id || "") + (i.name || "")));
    const fim = all.find(i => /data.?fim|dt.?fim/i.test((i.id || "") + (i.name || "")));
    setDate(ini, dataPt); setDate(fim, dataPt);
  }, dataPt);

  const numTribunal = String(tribunais || "TRT15").replace(/\D/g, "");
  await page.evaluate((num) => {
    const selects = document.querySelectorAll("select");
    for (const sel of selects) {
      const opts = Array.from(sel.options || []);
      for (const opt of opts) {
        const texto = (opt.textContent || "");
        const digits = texto.replace(/\D/g, "");
        if (digits === num) {
          sel.value = opt.value;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          return texto.trim();
        }
      }
    }
    return null;
  }, numTribunal);
}

// Clique real no botão Pesquisar (main + iframes)
async function clickPesquisarReal(page) {
  const tryClickIn = async (ctx) => {
    try {
      const selId = '[id="corpo:formulario:botaoAcaoPesquisar"]';
      const btn = await ctx.$(selId);
      if (btn) {
        await ctx.$eval(selId, el => el.scrollIntoView({ block: "center" }));
        await ctx.click(selId, { delay: 30 });
        return 'page.click(corpo:formulario:botaoAcaoPesquisar)';
      }
      const btn2 = await ctx.$('input[value="Pesquisar"]');
      if (btn2) {
        await ctx.$eval('input[value="Pesquisar"]', el => el.scrollIntoView({ block: "center" }));
        await ctx.click('input[value="Pesquisar"]', { delay: 30 });
        return 'page.click(input[value=Pesquisar])';
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
    if (how) return how + " (iframe)";
  }
  return "no-button-found";
}

// Espera retorno JSF
async function waitJsfResult(page, beforeLen) {
  await Promise.race([
    page.waitForResponse(r => r.request().method() === 'POST', { timeout: 15000 }),
    page.waitForNetworkIdle({ idleTime: 1500, timeout: 15000 }).catch(() => {})
  ]).catch(() => {});
  await page.waitForSelector("table tbody tr, .ui-datatable, .rich-table, a[href*='visualizar']", { timeout: 12000 }).catch(() => {});
  await page.waitForFunction(
    prev => (document.body.innerText || '').length > prev + 500,
    { timeout: 20000 }, 
    beforeLen
  ).catch(() => {});
  await sleep(700);
}

// Abre o primeiro caderno (executa onclick submitForm; captura popup se houver)
async function openFirstCaderno(page, browser) {
  const newPagePromise = new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 10000);
    browser.once('targetcreated', async (target) => {
      clearTimeout(t);
      try { resolve(await target.page()); } catch { resolve(null); }
    });
  });

  const result = await page.evaluate(() => {
    function execOnclick(onclick) {
      if (!onclick) return false;
      const cleaned = onclick.replace(/;?\s*return\s+(false|true)\s*;?\s*$/i, '');
      try { eval(cleaned); return true; } catch { return false; }
    }
    const link = document.querySelector('a.link-download, a[onclick*="plcLogicaItens"], a.OraLink[href="#"]');
    if (link) {
      const oc = link.getAttribute('onclick') || '';
      if (oc && execOnclick(oc)) return { ok: true, method: 'eval onclick' };
      link.click();
      return { ok: true, method: 'click' };
    }
    if (typeof window.submitForm === 'function') {
      try { window.submitForm('corpo:formulario', 1, { source:'corpo:formulario:plcLogicaItens:0:j_id132' }); return { ok: true, method: 'submitForm direto' }; }
      catch (e) { return { ok: false, error: e.message }; }
    }
    return { ok: false, error: 'nenhum link encontrado' };
  });

  if (!result.ok) return 'caderno-não-encontrado: ' + (result.error || '');

  await page.waitForNetworkIdle({ idleTime: 1200, timeout: 15000 }).catch(() => {});
  const newPage = await newPagePromise;
  if (newPage) {
    const newUrl = newPage.url();
    await newPage.close();
    if (newUrl && newUrl !== 'about:blank') {
      await page.goto(newUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      return 'navegou para nova página: ' + newUrl.substring(0, 80);
    }
  }
  await sleep(600);
  return result.method;
}

async function waitCadernoLoaded(page) {
  await Promise.race([
    page.waitForSelector("table, .ui-datatable, .rich-table, a[href*='teor'], a[href*='visualizar']", { timeout: 15000 }),
    page.waitForNetworkIdle({ idleTime: 1200, timeout: 15000 }).catch(() => {})
  ]).catch(() => {});
  await sleep(600);
}

// ===== /debug/download — dispara "Baixar" e CAPTURA o PDF (buffer) em /tmp/pdf
app.get("/debug/download", async (req, res) => {
  const logs = [];
  const log = (m) => { console.log(m); logs.push(m); };

  try {
    const tribunais = String(req.query.tribunais || "TRT15");
    const dataParam = req.query.data || null;
    const d = dataParam ? new Date(dataParam) : new Date();
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    const dataPt = `${dd}/${mm}/${yyyy}`;

    const browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ "Accept-Language": "pt-BR,pt;q=0.9" });

    let capturedPdf = null;
    page.on("response", async (response) => {
      try {
        const status = response.status();
        const ctype = (response.headers()["content-type"] || "").toLowerCase();
        if (!capturedPdf && status === 200 && ctype.includes("application/pdf")) {
          const buf = await response.buffer();
          if (buf && buf.length) {
            const fileName = `dejt-caderno-${Date.now()}.pdf`;
            const filePath = path.join(PDF_DIR, fileName);
            await fsp.writeFile(filePath, buf);
            capturedPdf = { fileName, filePath, url: response.url() };
            lastPdfFile = fileName;
          }
        }
      } catch {}
    });

    await page.goto(DEJT_URL, { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(1200);
    await prepararPesquisa(page, tribunais, dataPt);

    await clickPesquisarReal(page);
    await Promise.race([
      page.waitForResponse(r => r.request().method() === "POST", { timeout: 15000 }).catch(() => {}),
      page.waitForNetworkIdle({ idleTime: 1200, timeout: 15000 }).catch(() => {}),
    ]);

    const linkInfo = await page.evaluate(() => {
      const link = document.querySelector('a.link-download, a[onclick*="plcLogicaItens"], a.OraLink[href="#"]');
      if (!link) return null;
      return {
        href: link.getAttribute("href"),
        onclick: link.getAttribute("onclick"),
        classe: link.className,
        html: link.outerHTML.substring(0, 400),
      };
    });

    if (linkInfo) log("[download] link: " + JSON.stringify(linkInfo));

    if (linkInfo?.onclick) {
      const how = await page.evaluate((onclickRaw) => {
        const cleaned = String(onclickRaw).replace(/;?\s*return\s+false\s*;?\s*$/i, "");
        try { eval(cleaned); return "eval onclick"; } catch (e) { return "eval falhou: " + (e?.message || String(e)); }
      }, linkInfo.onclick);
      log("[download] Disparo: " + how);

      await Promise.race([
        page.waitForNetworkIdle({ idleTime: 1500, timeout: 15000 }).catch(() => {}),
        page.waitForResponse(r => (r.headers()["content-type"] || "").toLowerCase().includes("application/pdf"), { timeout: 15000 }).catch(() => {}),
      ]);
    }

    if (!capturedPdf && linkInfo) {
      try {
        await page.click('a.link-download');
        await Promise.race([
          page.waitForNetworkIdle({ idleTime: 1500, timeout: 15000 }).catch(() => {}),
          page.waitForResponse(r => (r.headers()["content-type"] || "").toLowerCase().includes("application/pdf"), { timeout: 15000 }).catch(() => {}),
        ]);
      } catch {}
    }

    await browser.close();

    if (capturedPdf) {
      return res.json({
        ok: true,
        data: dataPt,
        linkInfo,
        pdf_saved: true,
        pdf_file: capturedPdf.fileName,
        url: `${BASE_URL}/pdf/${capturedPdf.fileName}`,
        logs,
      });
    }

    return res.json({
      ok: true,
      data: dataPt,
      linkInfo,
      pdf_saved: false,
      pdf_file: null,
      reason: linkInfo ? "disparou onclick/click mas não houve PDF" : "link-download não encontrado",
      logs,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e), logs });
  }
});

// ===== /debug/pesquisa — valida listagem e tenta abrir caderno
app.get("/debug/pesquisa", async (req, res) => {
  const logs = [];
  const log = (m) => { console.log(m); logs.push(m); };

  try {
    const tribunais = String(req.query.tribunais || "TRT15");
    const dataParam = req.query.data || null;
    const d = dataParam ? new Date(dataParam) : new Date();
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    const dataPt = `${dd}/${mm}/${yyyy}`;

    log(`[debug] Iniciando pesquisa para ${tribunais} em ${dataPt}`);
    const browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ "Accept-Language": "pt-BR,pt;q=0.9" });
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36");

    await page.goto(DEJT_URL, { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(1200);
    await prepararPesquisa(page, tribunais, dataPt);

    log("[debug] Disparando pesquisa com clique real...");
    const beforeLen = await page.evaluate(() => document.body.innerText.length);
    const jsfInfo = await page.evaluate(() => ({
      submitForm: typeof window.submitForm === "function",
      mojarra: !!window.mojarra?.ab,
      PrimeFaces: !!window.PrimeFaces?.ab,
      A4J: !!window.A4J?.AJAX?.Submit
    }));
    log(`[debug] Funções JSF disponíveis: ${JSON.stringify(jsfInfo)}`);

    const how = await clickPesquisarReal(page);
    log(`[debug] Método de disparo real: ${how}`);

    await waitJsfResult(page, beforeLen);

    let afterLen = await page.evaluate(() => document.body.innerText.length);
    log(`[debug] Body após primeiro disparo: ${afterLen} chars`);

    const temCaderno = await page.evaluate(() => {
      const body = document.body.innerText || "";
      return /Edi[çc][ãa]o\s+\d+/i.test(body) || /Caderno.*Judici/i.test(body);
    });

    if (temCaderno) {
      log("[debug] Caderno encontrado na listagem! Abrindo...");
      const howCaderno = await openFirstCaderno(page, browser);
      log(`[debug] Abrindo caderno: ${howCaderno}`);
      await waitCadernoLoaded(page);
      afterLen = await page.evaluate(() => document.body.innerText.length);
      log(`[debug] Body após abrir caderno: ${afterLen} chars`);
    }

    const resultado = await page.evaluate(() => {
      const body = document.body.innerText || "";
      const links = [];
      document.querySelectorAll("a").forEach(a => {
        const texto = (a.textContent || "").trim();
        const href = a.getAttribute("href") || "";
        if (texto || href) links.push({ texto: texto.substring(0, 80), href: href.substring(0, 300) });
      });
      const linksAto = [];
      document.querySelectorAll("a").forEach(a => {
        const t = (a.textContent || "").toLowerCase();
        const h = (a.getAttribute("href") || "").toLowerCase();
        const oc = (a.getAttribute("onclick") || "").toLowerCase();
        if (
          t.includes("visualizar") || t.includes("inteiro teor") ||
          t.includes("conteúdo") || t.includes("conteudo") ||
          h.includes("visualizar") || h.includes("inteiro") || h.includes("conteudo") ||
          h.includes("teor") || oc.includes("window.open")
        ) {
          linksAto.push({
            texto: (a.textContent || "").substring(0, 50),
            href: a.getAttribute("href") || "",
            onclick: (a.getAttribute("onclick") || "").substring(0, 120),
          });
        }
      });
      return {
        tamanhoBody: body.length,
        temAlvara: /alvar[aá]/i.test(body),
        temProcesso: /\d{7}-\d{2}\.\d{4}/.test(body),
        trechoBody: body.substring(0, 2000),
        totalLinks: links.length,
        primeirosLinks: links.slice(0, 12),
        linksAto: linksAto.slice(0, 20),
      };
    });

    await browser.close();

    return res.json({ ok: true, data: dataPt, tribunais, resultado, logs });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e), logs });
  }
});

// ===== /debug/caderno e /debug/botao (mantidos p/ diagnóstico rápido)
app.get("/debug/caderno", async (req, res) => {
  const logs = [];
  const log = (m) => { console.log(m); logs.push(m); };
  try {
    const tribunais = String(req.query.tribunais || "TRT15");
    const dataParam = req.query.data || null;
    const d = dataParam ? new Date(dataParam) : new Date();
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    const dataPt = `${dd}/${mm}/${yyyy}`;

    const browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ "Accept-Language": "pt-BR,pt;q=0.9" });
    await page.goto(DEJT_URL, { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(1200);
    await prepararPesquisa(page, tribunais, dataPt);
    await clickPesquisarReal(page);
    await waitJsfResult(page, 900);

    const htmlInfo = await page.evaluate(() => {
      const clicaveis = [];
      document.querySelectorAll("a, button, input, img, span, td, tr").forEach(el => {
        const onclick = el.getAttribute("onclick") || "";
        const href = el.getAttribute("href") || "";
        if (!onclick && !href) return;
        const texto = (el.textContent || el.value || el.alt || el.title || "").trim().substring(0, 100);
        const tag = el.tagName;
        const id = el.id || "";
        const classe = el.className || "";
        clicaveis.push({ tag, id, classe: classe.substring(0, 50), texto: texto.substring(0, 80), href: href.substring(0, 200), onclick: onclick.substring(0, 300) });
      });
      const downloads = clicaveis.filter(c => /download|baixar|visualizar|abrir|window\.open/i.test(c.onclick + c.href + c.texto));
      let tableHtml = "";
      document.querySelectorAll("table, div").forEach(el => {
        if (/Edi[çc][ãa]o.*\d+.*Caderno/i.test(el.textContent || "")) {
          if (!tableHtml || el.outerHTML.length < tableHtml.length) tableHtml = el.outerHTML;
        }
      });
      return { totalClicaveis: clicaveis.length, downloads, todosClicaveis: clicaveis.slice(0, 30), tableHtml: tableHtml.substring(0, 8000) };
    });

    await browser.close();
    res.json({ ok: true, data: dataPt, tribunais, downloads: htmlInfo.downloads, todosClicaveis: htmlInfo.todosClicaveis, tableHtml: htmlInfo.tableHtml, logs });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e), logs });
  }
});

app.get("/debug/botao", async (_req, res) => {
  try {
    const browser = await launchBrowser();
    const page = await browser.newPage();
    await page.goto(DEJT_URL, { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(1200);
    const info = await page.evaluate(() => {
      const btn = document.getElementById("corpo:formulario:botaoAcaoPesquisar") || document.querySelector('input[value="Pesquisar"]');
      if (!btn) return { encontrado: false };
      return {
        encontrado: true,
        id: btn.id, name: btn.name, type: btn.type, value: btn.value,
        onclick: btn.getAttribute("onclick"), className: btn.className,
        temSubmitForm: typeof window.submitForm === "function",
        temMojarra: !!window.mojarra?.ab,
        temPrimeFaces: !!window.PrimeFaces?.ab,
        temA4J: !!window.A4J?.AJAX?.Submit,
      };
    });
    await browser.close();
    res.json({ ok: true, info });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ===== Minerador principal
async function scanMiner({ limit = 60, tribunais = "TRT15", data = null }) {
  if (DEMO) return { items: [], registrosBrutos: [], totalBruto: 0, discards: {} };

  const logs = [];
  const log = (m) => { console.log(m); logs.push(m); };

  const d = data ? new Date(data) : new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  const dataPt = `${dd}/${mm}/${yyyy}`;

  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ "Accept-Language": "pt-BR,pt;q=0.9" });
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36");
  page.setDefaultNavigationTimeout(60000);
  page.setDefaultTimeout(30000);

  await page.goto(DEJT_URL, { waitUntil: "networkidle2", timeout: 60000 });
  await sleep(2000);

  // Seleciona filtros, datas e órgão
  await prepararPesquisa(page, tribunais, dataPt);

  // Dispara pesquisa
  const beforeLen = await page.evaluate(() => document.body.innerText.length);
  await clickPesquisarReal(page);
  await waitJsfResult(page, beforeLen);

  // Se houver listagem de cadernos, abre
  const temCaderno = await page.evaluate(() => {
    const body = document.body.innerText || "";
    return /Edi[çc][ãa]o\s+\d+/i.test(body) || /Caderno.*Judici/i.test(body);
  });
  if (temCaderno) {
    await openFirstCaderno(page, browser);
    await waitCadernoLoaded(page);
  }

  // Coleta links de atos
  const linksAtos = await page.evaluate(() => {
    const links = new Set();
    document.querySelectorAll("a").forEach((a) => {
      const texto = (a.textContent || "").toLowerCase().trim();
      const href = a.href || a.getAttribute("href") || "";
      if (texto.includes("visualizar") || texto.includes("inteiro teor") ||
          texto.includes("conteúdo") || texto.includes("conteudo") ||
          texto.includes("exibir") || texto.includes("documento") ||
          texto.includes("ver")) {
        if (href && !href.startsWith("javascript:void")) {
          links.add(href.startsWith("http") ? href : (href.startsWith("/") ? "https://dejt.jt.jus.br" + href : href));
        }
      }
      if (href.includes("dejt.jt.jus.br") && !href.includes("diariocon")) links.add(href);
    });
    document.querySelectorAll("[onclick]").forEach((el) => {
      const onclick = el.getAttribute("onclick") || "";
      const m = onclick.match(/window\.open\(['"]([^'"]+)['"]/);
      if (m) {
        const url = m[1];
        links.add(url.startsWith("http") ? url : "https://dejt.jt.jus.br" + url);
      }
    });
    document.querySelectorAll("td a[href]").forEach((a) => {
      const href = a.href || a.getAttribute("href") || "";
      if (href && !href.startsWith("javascript:void") && !href.includes("diariocon")) {
        links.add(href.startsWith("http") ? href : "https://dejt.jt.jus.br" + href);
      }
    });
    return Array.from(links).slice(0, 120);
  });

  const registrosBrutos = [];
  const outItems = [];
  const discards = { sem_ato: 0, sem_processo: 0, sem_valor: 0, sem_pf: 0, erro_pagina: 0 };

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

      const procs = (conteudo.match(RX_PROC) || []).slice(0, 1);
      const processo = procs[0] || "";
      if (!processo) { discards.sem_processo++; continue; }

      let valorCents = NaN, m;
      while ((m = RX_MOEDA.exec(conteudo))) {
        const cents = brlToCents(m[1]);
        if (!Number.isFinite(valorCents) || cents > valorCents) valorCents = cents;
      }
      if (!Number.isFinite(valorCents)) { discards.sem_valor++; continue; }

      const pf_nome = pickProvavelPF(conteudo);
      if (!pf_nome) { discards.sem_pf++; continue; }

      outItems.push({
        tribunal: tribunais,
        vara: "",
        processo,
        data_ato: `${yyyy}-${mm}-${dd}`,
        pf_nome,
        valor_centavos: valorCents,
        tipo_ato: "e-Alvará",
        banco_pagador: /CEF|CAIXA/i.test(conteudo) ? "CEF" : "BB",
        id_ato: href,
        link_oficial: href,
      });
    } catch {
      discards.erro_pagina++;
    }
  }

  await browser.close();
  return { items: outItems, registrosBrutos, totalBruto: registrosBrutos.length, discards, logs };
}

// ===== /scan
app.get("/scan", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 60), 120);
    const tribunais = String(req.query.tribunais || SCAN_TRIBUNAIS || "TRT15");
    const data = req.query.data || null;
    const wantDebug = String(req.query.debug || "0") === "1";

    const { items: brutos, registrosBrutos, totalBruto, discards, logs } = await scanMiner({ limit, tribunais, data });

    const filtrados = brutos.filter((c) => {
      const cents = Number(c.valor_centavos);
      const isPF = _parecePF(c.pf_nome);
      const atoPronto = RX_ALVAR.test(String(c.tipo_ato || ""));
      return c.tribunal && c.processo && isPF && cents >= MIN_TICKET_CENTS && atoPronto;
    });

    if (wantDebug) {
      return res.json({
        ok: true,
        data, tribunais,
        total_bruto: totalBruto,
        total_filtrado: filtrados.length,
        amostras_brutas: registrosBrutos.slice(0, 10),
        contadores_descartes: discards,
        itens_filtrados_preview: filtrados.slice(0, 5),
        logs: logs?.slice(-30)
      });
    }

    res.json({ ok: true, items: filtrados.slice(0, limit) });
  } catch (e) {
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

    const { items: brutos, registrosBrutos, totalBruto, discards, logs } = await scanMiner({ limit: limit * 3, tribunais, data });

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
        ok: true,
        data, tribunais,
        total_bruto: totalBruto,
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
      </tr>`).join("");

    const dataLabel = data ? new Date(data).toLocaleDateString("pt-BR") : new Date().toLocaleDateString("pt-BR");
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

    const browser = await launchBrowser();
    const pg = await browser.newPage();
    await pg.setContent(html, { waitUntil: "networkidle0" });
    await pg.pdf({ path: filePath, format: "A4", margin: { top: "12mm", right: "12mm", bottom: "14mm", left: "12mm" }, printBackground: true });
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
      return res.status(400).json({ ok: false, error: "Regras TORRE: PF nominal, ticket ≥ R$ 20k e ato pronto." });
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
    await pg.pdf({ path: filePath, format: "A4", margin: { top: "14mm", bottom: "14mm", left: "14mm", right: "14mm" }, printBackground: true });
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
      const valor = Number.isFinite(c.valor_centavos) ? centavosToBRL(c.valor_centavos) : (c.valor_reais || "");
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
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ===== utils finais
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
