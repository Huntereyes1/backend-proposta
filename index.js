// index.js — TORRE PF e-Alvará (TRT) — v5.0 CORRIGIDO
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

app.get("/", (_req, res) => res.send("Backend TORRE v5.0 — DEJT Corrigido"));
app.get("/health", (_req, res) => res.json({ ok: true, now: new Date().toISOString() }));

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

// ===== Regex
const DEJT_URL = "https://dejt.jt.jus.br/dejt/f/n/diariocon";
const RX_PROC = /\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/g;
const RX_MOEDA = /R\$\s*([\d\.]+,\d{2})/g;
const RX_ALVAR = /(alvar[aá]|levantamento|libera[cç][aã]o)/i;

// Helper para esperar (substitui waitForTimeout que foi removido do Puppeteer)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper: dispara pesquisa via JSF/Ajax com detecção dinâmica de ID
async function dispararPesquisaJSF(page) {
  return await page.evaluate(() => {
    // Acha o botão "Pesquisar" de forma robusta
    const btn =
      document.getElementById("corpo:formulario:botaoAcaoPesquisar") ||
      Array.from(document.querySelectorAll('input[type="submit"],input[type="button"],button'))
        .find(b => /pesquis/i.test((b.value || b.textContent || "")));
    
    const form = document.getElementById("corpo:formulario") || btn?.form || document.querySelector("form");
    const bid = btn?.id || null;
    const fid = form?.id || null;

    // Tenta A4J primeiro (que está disponível no DEJT)
    try {
      if (bid && fid && window.A4J?.AJAX?.Submit) {
        window.A4J.AJAX.Submit(fid, bid, null, { similarityGroupingId: bid });
        return "A4J.AJAX.Submit(" + bid + ")";
      }
    } catch(e) { console.log("A4J error:", e); }

    // Tenta mojarra.ab
    try {
      if (bid && window.mojarra?.ab) {
        window.mojarra.ab(bid, null, "click", fid, 0);
        return "mojarra.ab(" + bid + ")";
      }
    } catch(e) { console.log("mojarra error:", e); }

    // Tenta PrimeFaces.ab
    try {
      if (bid && window.PrimeFaces?.ab) {
        window.PrimeFaces.ab({ s: bid, f: fid });
        return "PrimeFaces.ab(" + bid + ")";
      }
    } catch(e) { console.log("PrimeFaces error:", e); }

    // Tenta submitForm
    try {
      if (fid && typeof window.submitForm === "function") {
        window.submitForm(fid, 1, { source: bid || "corpo:formulario:botaoAcaoPesquisar" });
        return "submitForm(" + fid + ")";
      }
    } catch(e) { console.log("submitForm error:", e); }

    // Fallback: dispara onclick real do botão
    if (btn) {
      // Tenta executar o onclick diretamente
      const onclickAttr = btn.getAttribute("onclick");
      if (onclickAttr) {
        try { 
          eval(onclickAttr); 
          return "eval onclick(" + (bid || "no-id") + ")";
        } catch(e) {}
      }
      
      // MouseEvent
      const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
      btn.dispatchEvent(ev);
      if (typeof btn.click === "function") btn.click();
      return "click(" + (bid || "no-id") + ")";
    }

    // Último recurso: submit do form
    if (form) {
      form.submit();
      return "form.submit";
    }

    return "no-dispatch";
  });
}

// ===== Debug endpoints
app.get("/debug/env", (_req, res) => {
  res.json({
    BASE_URL, DEMO, MIN_TICKET_CENTS, SCAN_TRIBUNAIS, CONCURRENCY,
    PDF_DIR, EXPORTS_DIR, TZ: process.env.TZ || null,
    PUPPETEER_EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH ? "(set)" : "(unset)",
  });
});

// Debug: mostra o onclick do botão Pesquisar
app.get("/debug/botao", async (req, res) => {
  try {
    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--lang=pt-BR"],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    });
    
    const page = await browser.newPage();
    await page.goto(DEJT_URL, { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(2000);
    
    const info = await page.evaluate(() => {
      const btn = document.getElementById("corpo:formulario:botaoAcaoPesquisar") ||
                  document.querySelector('input[value="Pesquisar"]');
      
      if (!btn) return { encontrado: false };
      
      return {
        encontrado: true,
        id: btn.id,
        name: btn.name,
        type: btn.type,
        value: btn.value,
        onclick: btn.getAttribute("onclick"),
        className: btn.className,
        // Verifica funções disponíveis
        temSubmitForm: typeof window.submitForm === "function",
        temMojarra: !!window.mojarra?.ab,
        temPrimeFaces: !!window.PrimeFaces?.ab,
        temA4J: !!window.A4J?.AJAX?.Submit,
        // Busca outros botões
        todosBotoes: Array.from(document.querySelectorAll('input[type="submit"], input[type="button"], button'))
          .slice(0, 10)
          .map(b => ({
            id: b.id,
            value: b.value || b.textContent,
            onclick: b.getAttribute("onclick")?.substring(0, 200)
          }))
      };
    });
    
    await browser.close();
    res.json({ ok: true, info });
    
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Debug: testa o fluxo de pesquisa e mostra o HTML resultante
app.get("/debug/pesquisa", async (req, res) => {
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
    
    log(`[debug] Iniciando pesquisa para ${tribunais} em ${dataPt}`);

    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--lang=pt-BR"],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    });
    
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ "Accept-Language": "pt-BR,pt;q=0.9" });
    
    log("[debug] Navegando para DEJT...");
    await page.goto(DEJT_URL, { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(2000);
    
    // 1. Seleciona tipo de caderno (Judiciário = J) e Disponibilização
    log("[debug] Selecionando caderno Judiciário e Disponibilização...");
    await page.evaluate(() => {
      const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
      
      // Marca Judiciário
      for (const r of radios) {
        if (r.value === "J" || /judici/i.test(r.id || "") || /judici/i.test(r.name || "")) {
          r.checked = true;
          r.click();
          r.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
      
      // Marca Disponibilização se existir
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
    await sleep(500);
    
    // 2. Preenche datas com eventos completos (focus, input, blur)
    log("[debug] Preenchendo datas...");
    await page.evaluate((dataPt) => {
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
      const ini = all.find(i => /data.?ini|dt.?ini/i.test((i.id || "") + (i.name || "")));
      const fim = all.find(i => /data.?fim|dt.?fim/i.test((i.id || "") + (i.name || "")));
      setDate(ini, dataPt);
      setDate(fim, dataPt);
    }, dataPt);
    await sleep(500);
    
    // 3. Seleciona tribunal
    log("[debug] Selecionando tribunal...");
    const numTribunal = tribunais.replace(/\D/g, "");
    const selecionouTribunal = await page.evaluate((numTribunal) => {
      const selects = document.querySelectorAll('select');
      for (const sel of selects) {
        if (sel.options && sel.options.length > 5) {
          for (const opt of sel.options) {
            const texto = opt.textContent || "";
            const numOpt = texto.replace(/\D/g, "");
            if (numOpt === numTribunal) {
              sel.value = opt.value;
              sel.dispatchEvent(new Event("change", { bubbles: true }));
              return texto;
            }
          }
        }
      }
      return null;
    }, numTribunal);
    log(`[debug] Tribunal selecionado: ${selecionouTribunal}`);
    await sleep(1000);
    
    // 4. Dispara pesquisa via JSF/Ajax
    log("[debug] Disparando pesquisa via JSF...");
    
    // Captura tamanho antes
    const beforeLen = await page.evaluate(() => document.body.innerText.length);
    log(`[debug] Body antes: ${beforeLen} chars`);
    
    // Verifica quais funções JSF existem
    const jsfInfo = await page.evaluate(() => {
      return {
        submitForm: typeof window.submitForm === "function",
        mojarra: !!window.mojarra?.ab,
        PrimeFaces: !!window.PrimeFaces?.ab,
        A4J: !!window.A4J?.AJAX?.Submit
      };
    });
    log(`[debug] Funções JSF disponíveis: ${JSON.stringify(jsfInfo)}`);
    
    // Dispara
    const how = await dispararPesquisaJSF(page);
    log(`[debug] Método de disparo: ${how}`);
    
    // Espera Ajax + mudança real de conteúdo
    await page.waitForNetworkIdle({ idleTime: 2000, timeout: 30000 }).catch(() => {});
    
    // Espera aparecer algum seletor de resultados
    await page.waitForSelector("table tbody tr, .ui-datatable, .rich-table, a[href*='visualizar'], a[onclick*='visualizar']", { timeout: 15000 }).catch(() => {});
    
    // Espera o body crescer (indica que carregou resultados)
    await page.waitForFunction(
      (prev) => (document.body.innerText || "").length > prev + 500,
      { timeout: 20000 },
      beforeLen
    ).catch(() => {});
    
    await sleep(2000);
    
    // Verifica tamanho após
    let afterLen = await page.evaluate(() => document.body.innerText.length);
    log(`[debug] Body após primeiro disparo: ${afterLen} chars`);
    
    // Se ainda pequeno, tenta novamente
    if (afterLen < 3000) {
      log("[debug] Body ainda pequeno, tentando novamente...");
      await dispararPesquisaJSF(page);
      await page.waitForNetworkIdle({ idleTime: 2000, timeout: 20000 }).catch(() => {});
      await page.waitForFunction(
        (prev) => (document.body.innerText || "").length > prev + 500,
        { timeout: 15000 },
        afterLen
      ).catch(() => {});
      await sleep(2000);
      afterLen = await page.evaluate(() => document.body.innerText.length);
      log(`[debug] Body após segundo disparo: ${afterLen} chars`);
    }
    
    // Captura resultado
    const resultado = await page.evaluate(() => {
      const body = document.body.innerText || "";
      const links = [];
      document.querySelectorAll("a").forEach(a => {
        const texto = (a.textContent || "").trim().substring(0, 50);
        const href = (a.href || "").substring(0, 100);
        if (texto || href) links.push({ texto, href });
      });
      
      // Busca especificamente por links de "visualizar" ou similares
      const linksVisualizacao = [];
      document.querySelectorAll("a").forEach(a => {
        const texto = (a.textContent || "").toLowerCase();
        if (texto.includes("visualizar") || texto.includes("inteiro") || texto.includes("conteúdo")) {
          linksVisualizacao.push({ texto: a.textContent, href: a.href });
        }
      });
      
      return {
        tamanhoBody: body.length,
        temAlvara: /alvar[aá]/i.test(body),
        temProcesso: /\d{7}-\d{2}\.\d{4}/.test(body),
        trechoBody: body.substring(0, 3000),
        totalLinks: links.length,
        primeirosLinks: links.slice(0, 15),
        linksVisualizacao
      };
    });
    
    log(`[debug] Body final: ${resultado.tamanhoBody} chars, alvará: ${resultado.temAlvara}, processo: ${resultado.temProcesso}`);
    log(`[debug] Links de visualização: ${resultado.linksVisualizacao.length}`);
    
    await browser.close();
    
    res.json({
      ok: true,
      data: dataPt,
      tribunais,
      resultado,
      logs
    });
    
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e), logs });
  }
});

// Probe melhorado para diagnóstico
app.get("/debug/probe", async (req, res) => {
  const logs = [];
  const log = (msg) => { console.log(msg); logs.push(msg); };
  
  try {
    const tribunais = String(req.query.tribunais || SCAN_TRIBUNAIS || "TRT15");
    const dataParam = req.query.data || null;
    
    const d = dataParam ? new Date(dataParam) : new Date();
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    const dataPt = `${dd}/${mm}/${yyyy}`;
    
    log(`[probe] Iniciando para ${tribunais} em ${dataPt}`);

    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--lang=pt-BR"],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    });
    
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ "Accept-Language": "pt-BR,pt;q=0.9" });
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36");
    
    log("[probe] Navegando para DEJT...");
    await page.goto(DEJT_URL, { waitUntil: "networkidle2", timeout: 60000 });
    
    // Espera extra para JSF carregar
    await sleep(3000);
    
    log("[probe] Página carregada, buscando select...");
    
    // Busca todos os selects na página
    const selectInfo = await page.evaluate(() => {
      const selects = document.querySelectorAll("select");
      const info = [];
      selects.forEach((sel, i) => {
        const opts = Array.from(sel.options || []).slice(0, 10).map(o => ({
          value: o.value,
          text: (o.textContent || "").trim().substring(0, 50)
        }));
        info.push({
          index: i,
          id: sel.id || "(sem id)",
          name: sel.name || "(sem name)",
          optionsCount: sel.options?.length || 0,
          firstOptions: opts
        });
      });
      return info;
    });
    
    log(`[probe] Encontrados ${selectInfo.length} selects`);
    
    // Busca também em iframes
    const framesInfo = [];
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      try {
        const frameSelects = await frame.evaluate(() => {
          const selects = document.querySelectorAll("select");
          return Array.from(selects).map(sel => ({
            id: sel.id || "(sem id)",
            name: sel.name || "(sem name)",
            optionsCount: sel.options?.length || 0
          }));
        });
        if (frameSelects.length > 0) {
          framesInfo.push({ url: frame.url(), selects: frameSelects });
        }
      } catch {}
    }
    
    // Busca inputs de data
    const inputs = await page.evaluate(() => {
      const ins = document.querySelectorAll("input");
      return Array.from(ins).slice(0, 20).map(i => ({
        id: i.id || "(sem id)",
        name: i.name || "(sem name)",
        type: i.type,
        value: i.value
      }));
    });
    
    // Busca botões
    const buttons = await page.evaluate(() => {
      const btns = document.querySelectorAll("input[type=submit], button, input[type=button]");
      return Array.from(btns).slice(0, 10).map(b => ({
        type: b.tagName,
        id: b.id || "(sem id)",
        value: b.value || b.textContent?.trim() || "(sem texto)"
      }));
    });
    
    await browser.close();
    
    res.json({
      ok: true,
      data: dataPt,
      tribunais,
      selects: selectInfo,
      framesWithSelects: framesInfo,
      inputs: inputs,
      buttons: buttons,
      logs
    });
    
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e), logs });
  }
});

// ===== MINERADOR PRINCIPAL (corrigido)
async function scanMiner({ limit = 60, tribunais = "TRT15", data = null }) {
  if (DEMO) return { items: [], registrosBrutos: [], totalBruto: 0, discards: {} };

  const logs = [];
  const log = (msg) => { console.log(msg); logs.push(msg); };

  const d = data ? new Date(data) : new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  const dataPt = `${dd}/${mm}/${yyyy}`;

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
  await sleep(3000);

  log("[miner] Página DEJT carregada");

  // Seleciona caderno Judiciário e Disponibilização
  await page.evaluate(() => {
    const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
    
    // Marca Judiciário
    for (const r of radios) {
      if (r.value === "J" || /judici/i.test(r.id || "") || /judici/i.test(r.name || "")) {
        r.checked = true;
        r.click();
        r.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    
    // Marca Disponibilização se existir
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
  await sleep(500);

  // Preenche datas com eventos completos
  const preencheuDatas = await page.evaluate((dataPt) => {
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
    
    return { ini: setDate(ini, dataPt), fim: setDate(fim, dataPt) };
  }, dataPt);
  await sleep(500);

  log(`[miner] Datas preenchidas: ${JSON.stringify(preencheuDatas)}`);

  // Normaliza código do tribunal
  const norm = (s) => String(s || "").toUpperCase().replace(/\s+/g, " ").replace(/TRT\s*(\d+).*/i, "TRT$1").trim();
  
  // Lista tribunais disponíveis
  const orgaosDisponiveis = await page.evaluate(() => {
    // Busca select por vários seletores
    const seletores = [
      'select[name*="tribunal"]', 'select[id*="tribunal"]',
      'select[name*="orgao"]', 'select[id*="orgao"]',
      'select[name*="Tribunal"]', 'select[id*="Tribunal"]'
    ];
    
    let sel = null;
    for (const seletor of seletores) {
      sel = document.querySelector(seletor);
      if (sel && sel.options && sel.options.length > 1) break;
    }
    
    // Se não encontrou, pega o primeiro select com muitas opções
    if (!sel || !sel.options || sel.options.length <= 1) {
      const allSelects = document.querySelectorAll("select");
      for (const s of allSelects) {
        if (s.options && s.options.length > 5) {
          sel = s;
          break;
        }
      }
    }
    
    if (!sel) return [];
    
    return Array.from(sel.options || []).map((o) => ({
      value: o.value,
      label: (o.textContent || "").trim(),
    }));
  });

  log(`[miner] Órgãos disponíveis: ${orgaosDisponiveis.length}`);

  const mapDisp = orgaosDisponiveis.map((o) => ({
    value: o.value,
    code: norm(o.label),
    label: o.label,
  }));

  // Determina lista de tribunais a varrer
  const tribunaisRaw = String(tribunais || SCAN_TRIBUNAIS || "TRT15").trim();
  let lista;
  if (/^(ALL|\*|TRT\*)$/i.test(tribunaisRaw)) {
    lista = mapDisp.filter((o) => /^TRT\d+$/i.test(o.code)).map((o) => o.code);
  } else {
    const pedidos = tribunaisRaw.split(/\s*,\s*/).filter(Boolean).map(norm);
    const setDisp = new Set(mapDisp.map((o) => o.code));
    lista = pedidos.filter((p) => setDisp.has(p));
  }
  if (!lista.length && mapDisp.length > 0) {
    // Pega o primeiro TRT disponível
    const primeiro = mapDisp.find(o => /^TRT\d+$/i.test(o.code));
    if (primeiro) lista = [primeiro.code];
  }
  if (!lista.length) lista = ["TRT15"];

  log(`[miner] Tribunais a varrer: ${lista.join(", ")}`);

  const registrosBrutos = [];
  const outItems = [];
  const discards = { sem_ato: 0, sem_processo: 0, sem_valor: 0, sem_pf: 0, erro_pagina: 0 };

  for (const orgao of lista) {
    if (outItems.length >= limit) break;

    log(`[miner] Processando ${orgao}...`);

    // Seleciona o órgão
    const selecionou = await page.evaluate((orgao) => {
      const seletores = [
        'select[name*="tribunal"]', 'select[id*="tribunal"]',
        'select[name*="orgao"]', 'select[id*="orgao"]'
      ];
      
      let sel = null;
      for (const seletor of seletores) {
        sel = document.querySelector(seletor);
        if (sel && sel.options && sel.options.length > 1) break;
      }
      
      if (!sel) {
        const allSelects = document.querySelectorAll("select");
        for (const s of allSelects) {
          if (s.options && s.options.length > 5) { sel = s; break; }
        }
      }
      
      if (!sel) return { ok: false, reason: "select não encontrado" };
      
      // Extrai o número do tribunal pedido (ex: "TRT15" -> "15", "TRT2" -> "2")
      const numPedido = String(orgao).replace(/\D/g, "");
      
      // Busca opção que contenha esse número
      const alvo = Array.from(sel.options || []).find((o) => {
        const texto = String(o.textContent || "");
        const numOpcao = texto.replace(/\D/g, ""); // extrai só números
        return numOpcao === numPedido;
      });
      
      if (!alvo) return { ok: false, reason: `opção com número ${numPedido} não encontrada` };
      
      sel.value = alvo.value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, selecionado: alvo.textContent };
    }, orgao);

    if (!selecionou.ok) {
      log(`[miner] Não conseguiu selecionar ${orgao}: ${selecionou.reason}`);
      continue;
    }
    
    log(`[miner] Selecionado: ${selecionou.selecionado}`);

    await sleep(1000);

    // Clica em Pesquisar usando JSF/Ajax
    try {
      log(`[miner] Disparando pesquisa via JSF...`);
      
      // Captura tamanho antes
      const beforeLen = await page.evaluate(() => document.body.innerText.length);
      
      // Dispara via JSF
      const how = await dispararPesquisaJSF(page);
      log(`[miner] Método de disparo: ${how}`);
      
      // Espera Ajax + mudança real de conteúdo
      await page.waitForNetworkIdle({ idleTime: 2000, timeout: 30000 }).catch(() => {});
      
      // Espera aparecer algum seletor de resultados
      await page.waitForSelector("table tbody tr, .ui-datatable, .rich-table, a[href*='visualizar'], a[onclick*='visualizar']", { timeout: 15000 }).catch(() => {});
      
      // Espera o body crescer
      await page.waitForFunction(
        (prev) => (document.body.innerText || "").length > prev + 500,
        { timeout: 20000 },
        beforeLen
      ).catch(() => {});
      
      await sleep(2000);
      
      // Verifica tamanho após
      let afterLen = await page.evaluate(() => document.body.innerText.length);
      log(`[miner] Body: antes=${beforeLen}, depois=${afterLen}`);
      
      // Se ainda pequeno, tenta novamente
      if (afterLen < 3000) {
        log(`[miner] Body pequeno, tentando novamente...`);
        await dispararPesquisaJSF(page);
        await page.waitForNetworkIdle({ idleTime: 2000, timeout: 20000 }).catch(() => {});
        await sleep(2000);
      }
      
    } catch (e) {
      log(`[miner] Erro ao pesquisar: ${e.message}`);
    }

    // Verifica se há conteúdo na página após pesquisa
    const temResultados = await page.evaluate(() => {
      const body = document.body.innerText || "";
      return {
        temAlvara: /alvar[aá]/i.test(body),
        temProcesso: /\d{7}-\d{2}\.\d{4}/.test(body),
        tamanhoBody: body.length
      };
    });
    log(`[miner] Resultados: alvará=${temResultados.temAlvara}, processo=${temResultados.temProcesso}, tam=${temResultados.tamanhoBody}`);

    // Coleta links de atos (Visualizar, Inteiro Teor, etc)
    const linksAtos = await page.evaluate(() => {
      const links = new Set();
      const body = document.body.innerText || "";
      
      // Debug: verifica se há conteúdo relevante
      console.log("Body length:", body.length);
      console.log("Tem alvará:", /alvar[aá]/i.test(body));
      
      // Busca todos os links
      document.querySelectorAll("a").forEach((a) => {
        const texto = (a.textContent || "").toLowerCase().trim();
        const href = a.href || a.getAttribute("href") || "";
        
        // Links com texto relevante
        if (texto.includes("visualizar") || texto.includes("inteiro teor") || 
            texto.includes("conteúdo") || texto.includes("conteudo") ||
            texto.includes("exibir") || texto.includes("abrir") ||
            texto.includes("ver") || texto.includes("documento")) {
          if (href && !href.startsWith("javascript:void")) {
            links.add(href.startsWith("http") ? href : (href.startsWith("/") ? "https://dejt.jt.jus.br" + href : href));
          }
        }
        
        // Links do domínio DEJT
        if (href.includes("dejt.jt.jus.br") && !href.includes("diariocon")) {
          links.add(href);
        }
      });
      
      // Busca onclick com window.open
      document.querySelectorAll("[onclick]").forEach((el) => {
        const onclick = el.getAttribute("onclick") || "";
        const match = onclick.match(/window\.open\(['"]([^'"]+)['"]/);
        if (match) {
          const url = match[1];
          links.add(url.startsWith("http") ? url : "https://dejt.jt.jus.br" + url);
        }
      });
      
      // Busca hrefs em células de tabela (padrão comum no DEJT)
      document.querySelectorAll("td a[href]").forEach((a) => {
        const href = a.href || a.getAttribute("href") || "";
        if (href && !href.startsWith("javascript:void") && !href.includes("diariocon")) {
          links.add(href.startsWith("http") ? href : "https://dejt.jt.jus.br" + href);
        }
      });
      
      return Array.from(links).slice(0, 100);
    });

    log(`[miner] ${orgao}: encontrados ${linksAtos.length} links de atos`);

    if (linksAtos.length === 0) {
      // Tenta abordagem alternativa: busca em iframes
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        try {
          const frameLinks = await frame.evaluate(() => {
            const links = [];
            document.querySelectorAll("a").forEach((a) => {
              if (a.href && !a.href.startsWith("javascript:void")) {
                links.push(a.href);
              }
            });
            return links;
          });
          linksAtos.push(...frameLinks);
        } catch {}
      }
      log(`[miner] ${orgao}: após iframes, ${linksAtos.length} links`);
    }

    // Processa cada link
    for (const href of linksAtos) {
      if (outItems.length >= limit) break;

      try {
        log(`[miner] Abrindo: ${href.substring(0, 80)}...`);
        
        const pg = await browser.newPage();
        pg.setDefaultTimeout(15000);
        
        await pg.goto(href, { waitUntil: "domcontentloaded", timeout: 15000 });
        const conteudo = await pg.$eval("body", (el) => el.innerText || "").catch(() => "");
        await pg.close();

        registrosBrutos.push({ href, tam: conteudo.length });

        if (!conteudo || conteudo.length < 100) {
          discards.erro_pagina++;
          continue;
        }

        if (!RX_ALVAR.test(conteudo)) {
          discards.sem_ato++;
          continue;
        }

        const procs = (conteudo.match(RX_PROC) || []).slice(0, 1);
        const processo = procs[0] || "";
        if (!processo) {
          discards.sem_processo++;
          continue;
        }

        let valorCents = NaN;
        let m;
        while ((m = RX_MOEDA.exec(conteudo))) {
          const cents = brlToCents(m[1]);
          if (!Number.isFinite(valorCents) || cents > valorCents) valorCents = cents;
        }
        if (!Number.isFinite(valorCents)) {
          discards.sem_valor++;
          continue;
        }

        const pf_nome = pickProvavelPF(conteudo);
        if (!pf_nome) {
          discards.sem_pf++;
          continue;
        }

        log(`[miner] ✓ Encontrado: ${pf_nome} - ${centavosToBRL(valorCents)}`);

        outItems.push({
          tribunal: orgao,
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

      } catch (e) {
        log(`[miner] Erro ao processar link: ${e.message}`);
        discards.erro_pagina++;
      }
    }
  }

  await browser.close();

  log(`[miner] Finalizado: ${outItems.length} itens encontrados`);

  return {
    items: outItems,
    registrosBrutos,
    totalBruto: registrosBrutos.length,
    discards,
    logs
  };
}

// ===== /scan
app.get("/scan", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 60), 120);
    const tribunais = String(req.query.tribunais || SCAN_TRIBUNAIS || "TRT15");
    const data = req.query.data || null;
    const wantDebug = String(req.query.debug || "0") === "1";

    const { items: brutos, registrosBrutos, totalBruto, discards, logs } = await scanMiner({
      limit,
      tribunais,
      data,
    });

    const filtrados = brutos.filter((c) => {
      const cents = Number(c.valor_centavos);
      const isPF = _parecePF(c.pf_nome);
      const atoPronto = RX_ALVAR.test(String(c.tipo_ato || ""));
      return c.tribunal && c.processo && isPF && cents >= MIN_TICKET_CENTS && atoPronto;
    });

    if (wantDebug) {
      return res.json({
        ok: true,
        data,
        tribunais,
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
      limit: limit * 3,
      tribunais,
      data,
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
        ok: true,
        data,
        tribunais,
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

// ===== Utils
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
app.listen(PORT, () => console.log(`TORRE v5.0 rodando na porta ${PORT}`));

process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));