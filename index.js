// index.js — TORRE PF e-Alvará (TRT/TJ) — backend puro (v4.3, DEJT real + debug)
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
const SCAN_TRIBUNAIS = String(process.env.SCAN_TRIBUNAIS || "TRT15");
const DEMO = false; // SEMPRE DESLIGADO

if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });
if (!fs.existsSync(EXPORTS_DIR)) fs.mkdirSync(EXPORTS_DIR, { recursive: true });

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "2mb" }));
app.use(morgan("tiny"));

let lastPdfFile = null;

// Servir PDFs e exports
app.use(
  "/pdf",
  express.static(PDF_DIR, {
    setHeaders: (res) => {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    },
  })
);
app.use(
  "/exports",
  express.static(EXPORTS_DIR, {
    setHeaders: (res) =>
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate"),
  })
);

app.get("/", (_req, res) =>
  res.send(
    "Backend TORRE — Dossiê PF e-Alvará (TRT/TJ) v4.3 — DEJT real + debug"
  )
);
app.get("/health", (_req, res) =>
  res.json({ ok: true, now: new Date().toISOString() })
);

// ===== Utils =====
const toNumber = (v) =>
  typeof v === "number"
    ? v
    : Number(String(v ?? "").replace(/\./g, "").replace(",", "."));

const centavosToBRL = (c) =>
  (Math.round(c) / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: 2,
  });

const safe = (s = "") =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

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
  // QRCode
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

function makeWaLink(text) {
  return "https://wa.me/?text=" + encodeURIComponent(text);
}
function makeEmailLink(subject, body) {
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(
    body
  )}`;
}

// ===== Heurísticas e RegEx para DEJT =====
const DEJT_URL =
  "https://dejt.jt.jus.br/dejt/f/n/diariocon?pesquisacaderno=J&evento=y";
const RX_PROC = /\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/g;
const RX_MOEDA = /R\$\s*([\d\.]+,\d{2})/g;
const RX_ALVAR = /(alvar[aá]|levantamento|libera[cç][aã]o)/i;

function _parecePF(nome) {
  if (!nome) return false;
  const s = nome.toUpperCase();
  if (
    s.includes(" LTDA") ||
    s.includes(" S.A") ||
    s.includes(" S/A") ||
    s.includes(" EPP") ||
    s.includes(" MEI ")
  )
    return false;
  return s.trim().split(/\s+/).length >= 2;
}
function brlToCents(brlStr) {
  const s = String(brlStr).replace(/\./g, "").replace(",", ".");
  const v = Number(s);
  return Number.isFinite(v) ? Math.round(v * 100) : NaN;
}
function pickProvavelPF(texto) {
  const linhas = (texto || "")
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const l of linhas) {
    if (/(benef|titular|credor|reclamante)/i.test(l)) {
      const campo = l.replace(/.*?:/, "").replace(/\(.*?\)/g, "").trim();
      if (_parecePF(campo)) return campo;
    }
  }
  for (const l of linhas) if (_parecePF(l)) return l;
  return "";
}

// ===== Miner real (DEJT) — retorna itens já no formato do /scan
async function scanMiner({ limit = 60, tribunais = "TRT15", data = null }) {
  if (DEMO) return [];

  // datas
  const d = data ? new Date(data) : new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  const dataPt = `${dd}/${mm}/${yyyy}`;

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  });
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36"
  );
  page.setDefaultNavigationTimeout(45000);
  page.setDefaultTimeout(45000);

  // 1) abre DEJT "Diários > Judiciário"
  await page.goto(DEJT_URL, { waitUntil: "domcontentloaded" });

  // 2) Preenche datas
  await page.evaluate((dataPt) => {
    const ini =
      document.querySelector('input[name="dataIni"], input#dataIni') || null;
    const fim =
      document.querySelector('input[name="dataFim"], input#dataFim') || null;
    if (ini) {
      ini.value = "";
      ini.dispatchEvent(new Event("input"));
    }
    if (fim) {
      fim.value = "";
      fim.dispatchEvent(new Event("input"));
    }
    if (ini) {
      ini.value = dataPt;
      ini.dispatchEvent(new Event("change"));
    }
    if (fim) {
      fim.value = dataPt;
      fim.dispatchEvent(new Event("change"));
    }
  }, dataPt);

  // ===== 2.1 Monta lista de órgãos =====
  // Suporta: "TRT15,TRT2", "ALL", "*", "TRT*"
  const tribunaisRaw = String(tribunais || SCAN_TRIBUNAIS || "TRT15").trim();

  // Descobre o select e todas as opções disponíveis na página
  const orgaosDisponiveis = await page.evaluate(() => {
    const sel =
      document.querySelector(
        'select[name="tribunal"], select#orgaos, select#tribunal, select[name="orgao"]'
      ) || null;
    if (!sel) return [];
    return Array.from(sel.options || []).map((o) => ({
      value: o.value,
      label: (o.textContent || "").trim(),
    }));
  });

  // Normalizador: "TRT 15ª Região" -> "TRT15"
  const norm = (s = "") =>
    s
      .toUpperCase()
      .replace(/\s+/g, " ")
      .replace(/TRT\s*(\d+).*/i, "TRT$1")
      .trim();

  const mapDisponiveis = orgaosDisponiveis.map((o) => ({
    value: o.value,
    code: norm(o.label),
    label: o.label,
  }));

  let lista;
  if (/^(ALL|\*|TRT\*)$/i.test(tribunaisRaw)) {
    // TODOS os TRT listados no select
    lista = mapDisponiveis
      .filter((o) => /^TRT\d+$/i.test(o.code))
      .map((o) => o.code);
  } else {
    // Lista explícita separada por vírgula
    const pedidos = tribunaisRaw.split(/\s*,\s*/).filter(Boolean).map(norm);
    const setDisponiveis = new Set(mapDisponiveis.map((o) => o.code));
    lista = pedidos.filter((p) => setDisponiveis.has(p));
  }
  if (!lista.length) lista = ["TRT15"];

  const registrosBrutos = [];
  const items = [];

  // ===== Loop por órgão =====
  for (const orgao of lista) {
    // Seleciona o órgão no <select>
    await page.evaluate((orgao) => {
      const sel =
        document.querySelector(
          'select[name="tribunal"], select#orgaos, select#tribunal, select[name="orgao"]'
        ) || null;
      if (!sel) return false;
      const opts = Array.from(sel.options || []);
      const norm = (s = "") =>
        s.toUpperCase().replace(/\s+/g, " ").replace(/TRT\s*(\d+).*/i, "TRT$1").trim();
      const alvo = opts.find(
        (o) => norm(o.textContent || "") === orgao.toUpperCase()
      );
      if (!alvo) return false;
      sel.value = alvo.value;
      sel.dispatchEvent(new Event("change"));
      return true;
    }, orgao);

    // 3) Clica "Pesquisar"
    try {
      await Promise.all([
        page.click(
          'input[type="submit"][value="Pesquisar"], input#btnPesquisar, button'
        ),
        page.waitForNetworkIdle({ idleTime: 800, timeout: 30000 }),
      ]);
    } catch {}

    // 4) Coleta “Visualizar Texto/Conteúdo” — pega href OU onclick javascript
    const linksTexto = await page.evaluate(() => {
      const out = [];
      const isViz = (el) => {
        const t = (el.textContent || el.value || "").trim();
        return /Visualizar\s*(Texto|Conte[uú]do)?/i.test(t);
      };
      const takeUrl = (el) => {
        let href =
          el.href || el.getAttribute("data-href") || el.getAttribute("onclick") || "";
        if (!href) return "";
        if (href.startsWith("javascript:")) {
          const m = href.match(/'(https?:[^']+)'/);
          if (m) href = m[1];
        }
        return href;
      };
      document
        .querySelectorAll("a,button,input[type=button],input[type=submit]")
        .forEach((el) => {
          if (!isViz(el)) return;
          const url = takeUrl(el);
          if (url) out.push(url);
        });
      return Array.from(new Set(out));
    });

    if (!linksTexto.length) {
      // debug de “nada encontrado” para este órgão
      registrosBrutos.push({
        href: `(nenhum link 'Visualizar' para ${orgao})`,
        tam: 0,
      });
      continue;
    }

    // varre páginas de texto
    for (let i = 0; i < linksTexto.length; i++) {
      if (items.length >= limit) break;
      try {
        const href = linksTexto[i];
        const pg = await browser.newPage();
        await pg.goto(href, { waitUntil: "domcontentloaded" });
        const conteudo = await pg.$eval("body", (el) => el.innerText || "");
        await pg.close();

        registrosBrutos.push({ href, tam: conteudo.length });

        // Heurística de presença de ato
        if (!RX_ALVAR.test(conteudo)) continue;

        // Processo
        const procs = (conteudo.match(RX_PROC) || []).slice(0, 1);
        const processo = procs[0] || "";
        if (!processo) continue;

        // Maior valor encontrado
        let valorCents = NaN;
        let m;
        while ((m = RX_MOEDA.exec(conteudo))) {
          const cents = brlToCents(m[1]);
          if (!Number.isFinite(valorCents) || cents > valorCents) valorCents = cents;
        }
        if (!Number.isFinite(valorCents)) continue;

        // Nome PF
        const pf_nome = pickProvavelPF(conteudo);
        if (!pf_nome) continue;

        items.push({
          tribunal: orgao,
          vara: "",
          processo,
          data_ato: `${yyyy}-${mm}-${dd}`,
          pf_nome,
          valor_centavos: valorCents,
          tipo_ato: "e-Alvará",
          banco_pagador: /CEF/i.test(conteudo) ? "CEF" : "BB",
          id_ato: href,
          link_oficial: href,
        });
      } catch {
        // ignora erro por item
      }
    }
    if (items.length >= limit) break;
  }

  await browser.close();

  // Mantém os brutos (para debug no endpoint)
  return { items, registrosBrutos, totalBruto: registrosBrutos.length };
}

// ===== /scan — JSON (agora com ?debug=1)
app.get("/scan", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 60), 120);
    const tribunais =
      String(req.query.tribunais || SCAN_TRIBUNAIS || "TRT15") || "TRT15";
    const data = req.query.data || null;
    const wantDebug = String(req.query.debug || "0") === "1";

    const { items: brutos, registrosBrutos, totalBruto } = await scanMiner({
      limit,
      tribunais,
      data,
    });

    // Filtro TORRE
    const filtrados = brutos.filter((c) => {
      const cents = Number(c.valor_centavos);
      const isPF = _parecePF(c.pf_nome);
      const atoPronto = RX_ALVAR.test(String(c.tipo_ato || ""));
      return (
        c.tribunal && c.processo && isPF && cents >= MIN_TICKET_CENTS && atoPronto
      );
    });

    if (wantDebug) {
      return res.json({
        ok: true,
        data,
        tribunais,
        total_bruto: totalBruto,
        total_filtrado: filtrados.length,
        amostras_brutas: registrosBrutos.slice(0, 10),
        itens_filtrados_preview: filtrados.slice(
          0,
          Math.min(5, filtrados.length)
        ),
      });
    }

    res.json({ ok: true, items: filtrados.slice(0, limit) });
  } catch (e) {
    console.error("Erro /scan:", e);
    res
      .status(500)
      .json({ ok: false, error: "Falha no scan", cause: String(e?.message || e) });
  }
});

// ===== /relatorio — PDF consolidado (top N) + ?debug=1
app.get("/relatorio", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 15), 50);
    const data = req.query.data || null;
    const tribunais =
      String(req.query.tribunais || SCAN_TRIBUNAIS || "TRT15") || "TRT15";
    const wantDebug = String(req.query.debug || "0") === "1";

    const { items: brutos, registrosBrutos, totalBruto } = await scanMiner({
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
      // sai em JSON pra inspeção
      return res.json({
        ok: true,
        data,
        tribunais,
        total_bruto: totalBruto,
        total_filtrado: filtrados.length,
        amostras_brutas: registrosBrutos.slice(0, 10),
        itens_filtrados_preview: filtrados.slice(
          0,
          Math.min(5, filtrados.length)
        ),
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

    // HTML da tabela
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
        <td><a href="${safe(c.link_oficial || c.id_ato || "#")}">ato</a></td>
      </tr>`
      )
      .join("");

    const dataLabel = data
      ? new Date(data).toLocaleDateString("pt-BR")
      : new Date().toLocaleDateString("pt-BR");

    const html = `<!doctype html><html lang="pt-br"><meta charset="utf-8">
<title>Dossiê Consolidado — ${filtrados.length} casos</title>
<style>
  body{font-family:system-ui,Segoe UI,Roboto,Arial;margin:24px;color:#111}
  h1{font-size:20px;margin:0 0 12px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{border:1px solid #ddd;padding:8px;vertical-align:top}
  th{background:#f4f6f8;text-align:left}
  .meta{opacity:.75;font-size:12px;margin-bottom:12px}
</style>
<h1>Dossiê Consolidado — ${filtrados.length} casos (${safe(
      tribunais
    )} / ${dataLabel})</h1>
<div class="meta">
  Regra TORRE: PF nominal • Ticket ≥ ${centavosToBRL(
    MIN_TICKET_CENTS
  )} • Ato pronto (alvará/levantamento)
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

    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.pdf({
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
      preview: `${BASE_URL}/pdf/${fileName}#view=fitH`,
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

// ===== /gerar-dossie (individual)
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
      : Math.round(toNumber(valor_reais || 0) * 100);

    const hasTicket = Number.isFinite(cents) && cents >= MIN_TICKET_CENTS;
    const atoPronto = RX_ALVAR.test(String(tipo_ato || ""));

    if (!tribunal || !processo || !isPF || !hasTicket || !atoPronto) {
      return res.status(400).json({
        ok: false,
        error: "Regras TORRE: PF nominal, ticket ≥ R$ 20k e ato pronto.",
        debug: {
          tribunal,
          processo,
          pf_nome,
          valor_centavos,
          tipo_ato,
          hasTicket,
          atoPronto,
        },
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
      link_oficial: safe(link_oficial || ""),
    });

    const fileName = `dossie-${Date.now()}.pdf`;
    const filePath = path.join(PDF_DIR, fileName);

    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
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

    const pitch1 = `${pf_nome}, no ${tribunal} proc. ${processo} há ${
      tipo_ato || "e-Alvará"
    } de ${valorBRL} em seu nome.\nTe guio BB/CEF em 3–7 dias; você só me paga 10–20% após cair. Dossiê: ${BASE_URL}/pdf/${fileName}`;
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
      file: fileName,
    });
  } catch (e) {
    console.error("Erro /gerar-dossie:", e);
    return res
      .status(500)
      .json({ ok: false, error: "Erro ao gerar PDF", cause: String(e?.message || e) });
  }
});

// ===== /batch — { items: [...] } → PDFs + CSV
app.post("/batch", async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length)
      return res.status(400).json({ ok: false, error: "Envie items: []" });

    const limit = pLimit(CONCURRENCY);
    const results = [];
    for (let i = 0; i < items.length; i++) {
      const body = items[i];
      const run = () =>
        fetch(`${BASE_URL}/gerar-dossie`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
          .then((r) => r.json())
          .catch((e) => ({ ok: false, error: String(e) }));
      results.push(limit(run));
    }
    const out = await Promise.all(results);

    // CSV
    const now = new Date();
    const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const csvName = `lote-${stamp}.csv`;
    const csvPath = path.join(EXPORTS_DIR, csvName);

    const lines = [
      'tribunal,processo,pf_nome,valor,link_oficial,pdf_url,whatsapp_link,status',
    ];
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
          (c.pf_nome || "").replaceAll(",", " "),
          valor,
          c.link_oficial || c.id_ato || "",
          r.url || "",
          r.whatsapp || "",
          r.ok ? "OK" : "ERRO",
        ]
          .map((x) => `"${String(x ?? "").replaceAll('"', '""')}"`)
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
    res
      .status(500)
      .json({ ok: false, error: "Erro no batch", cause: String(e?.message || e) });
  }
});

// ===== /pack — { files: [...] } → zip
app.post("/pack", async (req, res) => {
  try {
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    if (!files.length)
      return res.status(400).json({ ok: false, error: "Envie files: []" });

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
    res
      .status(500)
      .json({ ok: false, error: "Erro no pack", cause: String(e?.message || e) });
  }
});

// ===== Debug util
app.get("/pdf/proposta.pdf", (_req, res) => {
  if (!lastPdfFile) return res.status(404).send("PDF ainda não gerado.");
  return res.redirect(`${BASE_URL}/pdf/${lastPdfFile}`);
});
app.get("/debug/last", (_req, res) => {
  const exists = lastPdfFile
    ? fs.existsSync(path.join(PDF_DIR, lastPdfFile))
    : false;
  res.json({
    lastPdfFile,
    exists,
    open: lastPdfFile ? `${BASE_URL}/pdf/${lastPdfFile}` : null,
  });
});

// ===== Start
app.listen(PORT, () => console.log("Servidor rodando na porta", PORT));
