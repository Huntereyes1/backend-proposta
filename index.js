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
import { execSync } from "child_process";
import pdf from "pdf-parse";

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

// Helper: extrai URL de window.open() no onclick
function extractWindowOpenUrl(onclick) {
  if (!onclick) return null;
  const m = String(onclick).match(/window\.open\(['"]([^'"]+)['"]/i);
  if (!m) return null;
  return m[1].startsWith('http') ? m[1] : 'https://dejt.jt.jus.br' + m[1];
}

// Helper: abre o primeiro caderno do tribunal na listagem
async function openFirstCaderno(page, browser) {
  // O link de baixar usa submitForm via onclick
  // Isso pode abrir uma nova janela/aba com o PDF
  // Precisamos capturar essa nova página
  
  // Configura listener para nova página
  const newPagePromise = new Promise((resolve) => {
    browser.once('targetcreated', async (target) => {
      const newPage = await target.page();
      resolve(newPage);
    });
    // Timeout de 10 segundos
    setTimeout(() => resolve(null), 10000);
  });
  
  // Executa o clique no link de download
  const resultado = await page.evaluate(() => {
    function execOnclick(onclick) {
      if (!onclick) return false;
      const cleaned = onclick.replace(/;?\s*return\s+(false|true)\s*;?\s*$/i, '');
      try {
        eval(cleaned);
        return true;
      } catch (e) {
        console.log('eval error:', e);
        return false;
      }
    }
    
    // Busca o link com classe "link-download"
    const links = document.querySelectorAll('a.link-download, a[onclick*="plcLogicaItens"], [onclick*="j_id132"]');
    
    if (links.length > 0) {
      const link = links[0];
      const onclick = link.getAttribute('onclick') || '';
      
      if (onclick && execOnclick(onclick)) {
        return { ok: true, method: 'eval onclick', onclick: onclick.substring(0, 100) };
      }
      
      link.click();
      return { ok: true, method: 'click' };
    }
    
    // Fallback: submitForm direto
    if (typeof window.submitForm === 'function') {
      try {
        window.submitForm('corpo:formulario', 1, { source: 'corpo:formulario:plcLogicaItens:0:j_id132' });
        return { ok: true, method: 'submitForm direto' };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
    
    return { ok: false, error: 'nenhum link encontrado' };
  });
  
  if (!resultado.ok) {
    return 'caderno-não-encontrado: ' + (resultado.error || '');
  }
  
  // Espera a nova página abrir ou a página atual atualizar
  await page.waitForNetworkIdle({ idleTime: 2000, timeout: 15000 }).catch(() => {});
  
  // Verifica se abriu nova página
  const newPage = await newPagePromise;
  if (newPage) {
    // Navega a página principal para a URL da nova página
    const newUrl = newPage.url();
    await newPage.close();
    if (newUrl && newUrl !== 'about:blank') {
      await page.goto(newUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      return 'navegou para nova página: ' + newUrl.substring(0, 50);
    }
  }
  
  // Verifica se a página atual mudou (pode ter atualizado via Ajax)
  await sleep(2000);
  
  return resultado.method;
}

// Helper: espera o caderno carregar
async function waitCadernoLoaded(page) {
  await Promise.race([
    page.waitForSelector("table, .ui-datatable, .rich-table, a[href*='teor'], a[href*='visualizar']", { timeout: 15000 }),
    page.waitForNetworkIdle({ idleTime: 1500, timeout: 15000 }).catch(() => {})
  ]).catch(() => {});
  await sleep(1500);
}

// Helper: clique REAL no botão Pesquisar (varre main frame + iframes)
async function clickPesquisarReal(page) {
  const tryClickIn = async (ctx) => {
    try {
      // ID conhecido (escape de : para CSS)
      const selId = '[id="corpo:formulario:botaoAcaoPesquisar"]';
      const btn = await ctx.$(selId);
      if (btn) {
        await ctx.$eval(selId, el => el.scrollIntoView({ block: 'center' }));
        await ctx.click(selId, { delay: 30 });
        return 'page.click(corpo:formulario:botaoAcaoPesquisar)';
      }
      
      // Fallback por value "Pesquisar"
      const btnPesquisar = await ctx.$('input[value="Pesquisar"]');
      if (btnPesquisar) {
        await ctx.$eval('input[value="Pesquisar"]', el => el.scrollIntoView({ block: 'center' }));
        await ctx.click('input[value="Pesquisar"]', { delay: 30 });
        return 'page.click(input[value=Pesquisar])';
      }
      
      return null;
    } catch (e) {
      return null;
    }
  };

  // Tenta no main frame
  let how = await tryClickIn(page);
  if (how) return how;

  // Tenta nos iframes
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    how = await tryClickIn(f);
    if (how) return how + ' (in iframe)';
  }
  
  return 'no-button-found';
}

// Helper: espera resultado do JSF (POST + crescimento do body)
async function waitJsfResult(page, beforeLen) {
  // Espera um POST JSF
  await Promise.race([
    page.waitForResponse(r => r.request().method() === 'POST', { timeout: 15000 }),
    page.waitForNetworkIdle({ idleTime: 1500, timeout: 15000 }).catch(() => {})
  ]).catch(() => {});

  // Espera algum seletor típico de resultado
  await page.waitForSelector("table tbody tr, .ui-datatable, .rich-table, a[href*='visualizar']", { timeout: 12000 }).catch(() => {});

  // E o body crescer
  await page.waitForFunction(
    prev => (document.body.innerText || '').length > prev + 500,
    { timeout: 20000 }, 
    beforeLen
  ).catch(() => {});
  
  await sleep(1000);
}

// Helper: dispara pesquisa via JSF/Ajax - PRIORIZA onclick do botão
async function dispararPesquisaJSF(page) {
  return await page.evaluate(() => {
    // Encontra o botão Pesquisar de forma robusta
    const btn =
      document.getElementById("corpo:formulario:botaoAcaoPesquisar") ||
      Array.from(document.querySelectorAll('input[type="submit"],input[type="button"],button'))
        .find(b => /pesquis/i.test((b.value || b.textContent || "")));

    const form = document.getElementById("corpo:formulario") || btn?.form || document.querySelector("form");
    const bid = btn?.id || null;
    const fid = form?.id || null;

    // 1) PRIORITÁRIO: executar exatamente o onclick gerado pelo JSF
    if (btn) {
      const onclick = btn.getAttribute("onclick");
      if (onclick) {
        try { 
          eval(onclick); 
          return "eval onclick(" + (bid || "no-id") + ")"; 
        } catch(e) {
          console.log("eval onclick error:", e);
        }
      }
    }

    // 2) Se não houver onclick, tenta A4J → mojarra → PrimeFaces → submitForm
    try { 
      if (bid && fid && window.A4J?.AJAX?.Submit) { 
        window.A4J.AJAX.Submit(fid, bid, null, { similarityGroupingId: bid }); 
        return "A4J.AJAX.Submit(" + bid + ")"; 
      } 
    } catch(e) {}
    
    try { 
      if (bid && window.mojarra?.ab) { 
        window.mojarra.ab(bid, null, "click", fid, 0); 
        return "mojarra.ab(" + bid + ")"; 
      } 
    } catch(e) {}
    
    try { 
      if (bid && window.PrimeFaces?.ab) { 
        window.PrimeFaces.ab({ s: bid, f: fid }); 
        return "PrimeFaces.ab(" + bid + ")"; 
      } 
    } catch(e) {}
    
    try { 
      if (fid && typeof window.submitForm === "function") { 
        window.submitForm(fid, 1, { source: bid || "corpo:formulario:botaoAcaoPesquisar" }); 
        return "submitForm(" + fid + ")"; 
      } 
    } catch(e) {}

    // 3) Fallback: click nativo
    if (btn) {
      const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
      btn.dispatchEvent(ev);
      if (typeof btn.click === "function") btn.click();
      return "click(" + (bid || "no-id") + ")";
    }

    // 4) Último recurso
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

// ===== APIs de Consulta =====
const INFOSIMPLES_TOKEN = process.env.INFOSIMPLES_TOKEN || "LUdOqPRSc0SqVRAKf594tnE0nk7GBi0WSek10Wkh";
const DIRECTDATA_TOKEN = process.env.DIRECTDATA_TOKEN || ""; // Adicionar quando tiver

// Consulta processo no TRT via InfoSimples
app.get("/api/processo", async (req, res) => {
  const logs = [];
  const log = (msg) => { console.log(msg); logs.push(msg); };
  
  try {
    const processo = req.query.processo;
    if (!processo) {
      return res.status(400).json({ ok: false, error: "Parâmetro 'processo' é obrigatório" });
    }
    
    const numeroLimpo = processo.replace(/\D/g, '');
    const numeroCNJ = formatarProcessoCNJ(numeroLimpo);
    
    // Monta URL da API InfoSimples
    const url = `https://api.infosimples.com/api/v2/consultas/tribunal/trt/processo?numero_processo=${encodeURIComponent(numeroCNJ)}&token=${INFOSIMPLES_TOKEN}`;
    
    log(`[infosimples] Consultando processo ${numeroCNJ}...`);
    
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });
    
    const data = await response.json();
    
    log(`[infosimples] Status: ${data.code}`);
    
    if (data.code !== 200) {
      return res.json({ 
        ok: false, 
        error: data.code_message || "Erro na consulta",
        detalhes: data,
        logs 
      });
    }
    
    // Extrai dados do InfoSimples
    const resultado = data.data?.[0] || {};
    const detalhes = resultado.detalhes || {};
    const itens = resultado.itens || [];
    
    // Extrai partes do polo_ativo e polo_passivo
    const poloAtivo = detalhes.polo_ativo || [];
    const poloPassivo = detalhes.polo_passivo || [];
    
    // Formata reclamantes (polo ativo)
    const reclamantes = poloAtivo.map(p => ({
      nome: p.nome,
      tipo: p.tipo,
      advogados: (p.representantes || []).filter(r => r.tipo === "Advogado").map(r => r.nome)
    }));
    
    // Formata reclamados (polo passivo)
    const reclamados = poloPassivo.map(p => ({
      nome: p.nome,
      tipo: p.tipo,
      advogados: (p.representantes || []).filter(r => r.tipo === "Advogado").map(r => r.nome)
    }));
    
    // Busca movimentos de alvará nos itens
    const movimentosAlvara = itens.filter(item => {
      const titulo = (item.titulo || "").toLowerCase();
      return titulo.includes('alvará') || 
             titulo.includes('levantamento') || 
             titulo.includes('liberação de valores') ||
             titulo.includes('expedição de guia');
    }).map(item => ({
      data: item.data,
      titulo: item.titulo,
      id: item.id_documento
    }));
    
    // Extrai valores do texto
    const todosTextos = itens.map(i => i.titulo || "").join(" ");
    const valoresMatch = todosTextos.match(/R\$\s*([\d.,]+)/g) || [];
    const valores = valoresMatch.map(v => v.replace("R$", "").trim());
    
    // Valor da causa
    const valorCausa = detalhes.valor_causa || detalhes.normalizado_valor_causa;
    
    res.json({
      ok: true,
      processo: numeroCNJ,
      tribunal: resultado.trt || "TRT",
      vara: detalhes.orgao_julgador,
      classe: detalhes.processo?.split(" ")[0],
      assunto: detalhes.assuntos?.map(a => a.descricao).join(", "),
      dataDistribuicao: detalhes.data_distribuicao || detalhes.data_autuacao,
      valorCausa: valorCausa,
      
      // Partes - DADOS IMPORTANTES
      reclamantes,
      reclamados,
      
      // Movimentos de alvará
      movimentosAlvara: movimentosAlvara.slice(0, 10),
      
      // Valores encontrados nos movimentos
      valoresEncontrados: valores.slice(0, 5),
      
      // Total de movimentos
      totalMovimentos: itens.length,
      
      // Link do comprovante
      comprovanteUrl: resultado.site_receipt,
      
      // Expedientes recentes
      expedientesRecentes: (resultado.expedientes || []).slice(0, 5),
      
      logs
    });
    
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e), logs });
  }
});

// ===== Direct Data API - Consulta telefone por CPF =====
app.get("/api/telefone", async (req, res) => {
  const logs = [];
  const log = (msg) => { console.log(msg); logs.push(msg); };
  
  try {
    const cpf = req.query.cpf;
    const nome = req.query.nome;
    
    if (!cpf && !nome) {
      return res.status(400).json({ ok: false, error: "Informe 'cpf' ou 'nome'" });
    }
    
    // Verifica se tem token da Direct Data
    if (!DIRECTDATA_TOKEN) {
      return res.json({
        ok: false,
        error: "Token Direct Data não configurado. Aguardando aprovação da conta.",
        instrucoes: "Após receber o token, configure a variável DIRECTDATA_TOKEN no Railway",
        logs
      });
    }
    
    const cpfLimpo = cpf ? cpf.replace(/\D/g, '') : '';
    
    // URL da API Direct Data - Cadastro Pessoa Física
    const url = `https://apiv3.directd.com.br/api/CadastroPessoaFisica?CPF=${cpfLimpo}&TOKEN=${DIRECTDATA_TOKEN}`;
    
    log(`[directdata] Consultando CPF ${cpfLimpo}...`);
    
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });
    
    const data = await response.json();
    
    log(`[directdata] Resultado: ${data.metaDados?.resultado || 'erro'}`);
    
    if (data.metaDados?.resultado !== "Sucesso") {
      return res.json({ 
        ok: false, 
        error: data.metaDados?.mensagem || "Erro na consulta",
        detalhes: data.metaDados,
        logs 
      });
    }
    
    const retorno = data.retorno || {};
    
    // Extrai telefones com WhatsApp
    const telefones = (retorno.telefones || []).map(t => ({
      numero: t.telefoneComDDD,
      tipo: t.tipoTelefone,
      operadora: t.operadora,
      whatsapp: t.whatsApp,
      bloqueado: t.telemarketingBloqueado
    }));
    
    // Filtra só os que têm WhatsApp e não estão bloqueados
    const telefonesWhatsApp = telefones.filter(t => t.whatsapp && !t.bloqueado);
    
    res.json({
      ok: true,
      cpf: retorno.cpf,
      nome: retorno.nome,
      dataNascimento: retorno.dataNascimento,
      nomeMae: retorno.nomeMae,
      
      // Telefones - O QUE VOCÊ PRECISA
      telefones,
      telefonesWhatsApp,
      melhorTelefone: telefonesWhatsApp[0]?.numero || telefones[0]?.numero,
      
      // Endereço
      endereco: (retorno.enderecos || [])[0],
      
      // E-mails
      emails: (retorno.emails || []).map(e => e.enderecoEmail),
      
      // Renda (útil para filtrar)
      rendaEstimada: retorno.rendaEstimada,
      faixaSalarial: retorno.rendaFaixaSalarial,
      
      logs
    });
    
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e), logs });
  }
});

// ===== Endpoint completo: Gera dossiê de um processo =====
app.get("/api/dossie", async (req, res) => {
  const logs = [];
  const log = (msg) => { console.log(msg); logs.push(msg); };
  
  try {
    const processo = req.query.processo;
    if (!processo) {
      return res.status(400).json({ ok: false, error: "Parâmetro 'processo' é obrigatório" });
    }
    
    log(`[dossie] Iniciando dossiê para ${processo}...`);
    
    // 1. Busca dados do processo no InfoSimples
    const processoUrl = `${req.protocol}://${req.get('host')}/api/processo?processo=${processo}`;
    const processoRes = await fetch(processoUrl);
    const processoData = await processoRes.json();
    
    if (!processoData.ok) {
      return res.json({
        ok: false,
        error: "Erro ao buscar processo",
        detalhes: processoData,
        logs
      });
    }
    
    log(`[dossie] Processo encontrado: ${processoData.vara}`);
    log(`[dossie] Reclamantes: ${processoData.reclamantes?.length || 0}`);
    
    // 2. Analisa os movimentos para encontrar ALVARÁ CONFIRMADO
    const analiseAlvara = analisarAlvaraConfirmado(processoData);
    log(`[dossie] Análise alvará: ${analiseAlvara.status}`);
    
    // 3. Para cada reclamante, monta dados
    const reclamantesComTelefone = [];
    
    for (const reclamante of (processoData.reclamantes || [])) {
      const dadosReclamante = {
        ...reclamante,
        telefone: null,
        whatsapp: null,
        status: DIRECTDATA_TOKEN ? "pendente_telefone" : "aguardando_directdata"
      };
      
      reclamantesComTelefone.push(dadosReclamante);
    }
    
    // 4. Monta o dossiê
    const dossie = {
      processo: processoData.processo,
      tribunal: processoData.tribunal,
      vara: processoData.vara,
      valorCausa: processoData.valorCausa,
      
      // Reclamantes com status de telefone
      reclamantes: reclamantesComTelefone,
      
      // Reclamados (empresa/devedor)
      reclamados: processoData.reclamados,
      
      // ===== ANÁLISE DE ALVARÁ =====
      analiseAlvara: {
        temAlvaraConfirmado: analiseAlvara.confirmado,
        status: analiseAlvara.status,
        // "confirmado_pf" | "alvara_advogado" | "indicio" | "sem_alvara"
        
        alvarasEncontrados: analiseAlvara.alvaras,
        valorEstimado: analiseAlvara.valorEstimado,
        bancoIdentificado: analiseAlvara.banco,
        dataAlvara: analiseAlvara.dataAlvara,
        
        // Motivo se descartado
        motivoDescarte: analiseAlvara.motivoDescarte
      },
      
      // Links úteis
      links: {
        pje: `https://pje.trt15.jus.br/consultaprocessual/detalhe-processo/${processo.replace(/\D/g, '')}`,
        comprovante: processoData.comprovanteUrl
      },
      
      // Status geral do dossiê
      status: determinarStatusDossie(analiseAlvara, DIRECTDATA_TOKEN),
      
      // ===== MENSAGENS DE PITCH =====
      mensagens: gerarMensagensPitch(reclamantesComTelefone[0], processoData, analiseAlvara),
      
      geradoEm: new Date().toISOString()
    };
    
    log(`[dossie] Dossiê gerado - Status: ${dossie.status}`);
    
    res.json({
      ok: true,
      dossie,
      logs
    });
    
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e), logs });
  }
});

// ===== Função para analisar se tem ALVARÁ CONFIRMADO =====
function analisarAlvaraConfirmado(processoData) {
  const resultado = {
    confirmado: false,
    status: "sem_alvara",
    alvaras: [],
    valorEstimado: null,
    banco: null,
    dataAlvara: null,
    motivoDescarte: null
  };
  
  // Junta todos os textos dos movimentos e expedientes
  const movimentos = processoData.movimentosAlvara || [];
  const expedientes = processoData.expedientesRecentes || [];
  const itens = processoData._itens || [];
  
  // Termos que CONFIRMAM alvará
  const termosAlvara = [
    /alvará/i,
    /guia de (levantamento|liberação)/i,
    /expedido\s+alvará/i,
    /expedi[çr]ão de alvará/i,
    /mandado de levantamento/i,
    /liberação de valores/i
  ];
  
  // Termos que DESCARTAM (já foi sacado ou é do advogado)
  const termosDescarte = [
    /cumprido/i,
    /levantado/i,
    /pago/i,
    /devolvido/i,
    /cancelado/i
  ];
  
  // Termos que indicam ser do ADVOGADO (não do reclamante)
  const termosAdvogado = [
    /advogado/i,
    /patrono/i,
    /honorários/i,
    /procurador/i
  ];
  
  // Bancos válidos
  const termosBanco = [
    /banco do brasil/i,
    /caixa econômica/i,
    /cef/i,
    /bb/i
  ];
  
  // Analisa cada movimento
  for (const mov of movimentos) {
    const texto = `${mov.titulo || ''} ${mov.complemento || ''}`.toLowerCase();
    
    // Verifica se tem termo de alvará
    const temAlvara = termosAlvara.some(regex => regex.test(texto));
    if (!temAlvara) continue;
    
    // Verifica se já foi cumprido/levantado
    const jaCumprido = termosDescarte.some(regex => regex.test(texto));
    if (jaCumprido) {
      resultado.motivoDescarte = "Alvará já cumprido/levantado";
      continue;
    }
    
    // Verifica se é do advogado
    const eDoAdvogado = termosAdvogado.some(regex => regex.test(texto));
    if (eDoAdvogado) {
      resultado.status = "alvara_advogado";
      resultado.motivoDescarte = "Alvará em nome do advogado, não do reclamante";
      resultado.alvaras.push({
        texto: mov.titulo,
        data: mov.data,
        tipo: "advogado"
      });
      continue;
    }
    
    // Se chegou aqui, é alvará válido!
    resultado.alvaras.push({
      texto: mov.titulo,
      data: mov.data,
      tipo: "reclamante"
    });
    
    // Busca banco
    const temBanco = termosBanco.some(regex => regex.test(texto));
    if (temBanco) {
      resultado.banco = texto.includes('caixa') || texto.includes('cef') ? 'CEF' : 'BB';
    }
    
    // Busca valor
    const matchValor = texto.match(/r\$\s*([\d.,]+)/i);
    if (matchValor) {
      resultado.valorEstimado = matchValor[0].toUpperCase();
    }
    
    resultado.dataAlvara = mov.data;
  }
  
  // Define status final
  if (resultado.alvaras.some(a => a.tipo === "reclamante")) {
    resultado.confirmado = true;
    resultado.status = "confirmado_pf";
  } else if (resultado.alvaras.length > 0) {
    resultado.status = "alvara_advogado";
  } else if (movimentos.length > 0) {
    resultado.status = "indicio";
  }
  
  return resultado;
}

// ===== Determina status do dossiê =====
function determinarStatusDossie(analiseAlvara, temDirectData) {
  if (!analiseAlvara.confirmado) {
    if (analiseAlvara.status === "alvara_advogado") {
      return "descartado_alvara_advogado";
    }
    if (analiseAlvara.status === "indicio") {
      return "indicio_verificar_manualmente";
    }
    return "sem_alvara_confirmado";
  }
  
  if (!temDirectData) {
    return "alvara_confirmado_aguardando_telefone";
  }
  
  return "pronto_para_contato";
}

// ===== Gera mensagens de pitch =====
function gerarMensagensPitch(reclamante, processoData, analiseAlvara) {
  const primeiroNome = reclamante?.nome?.split(' ')[0] || 'Sr(a)';
  const processo = processoData.processo;
  const tribunal = processoData.tribunal || 'TRT';
  const valor = analiseAlvara.valorEstimado || processoData.valorCausa;
  const banco = analiseAlvara.banco || 'BB/CEF';
  
  // Se NÃO tem alvará confirmado, retorna mensagem de indício
  if (!analiseAlvara.confirmado) {
    return {
      tipo: "indicio",
      alerta: "⚠️ Alvará NÃO confirmado. Use abordagem cautelosa.",
      
      abertura: `Oi ${primeiroNome}, vi movimentações no seu processo ${processo} (${tribunal}) que podem indicar valor a liberar. Posso checar sem custo e te explicar em 2 min como funciona o saque?`,
      
      seResponderSim: `Perfeito. Confiro agora e já te retorno com o valor/etapa e o passo a passo. Se estiver liberado, cuidamos de tudo e você só paga após o crédito.`,
      
      sePedirProva: `Te mando o link oficial do tribunal e um PDF do dossiê com os prints. Aqui o link do processo: https://pje.trt15.jus.br/consultaprocessual/detalhe-processo/${processo.replace(/\D/g, '')}`
    };
  }
  
  // Se TEM alvará confirmado, retorna PITCH FINAL BOSS 🎯
  return {
    tipo: "confirmado",
    alerta: "✅ ALVARÁ CONFIRMADO! Pode usar pitch direto.",
    
    // PITCH FINAL BOSS
    abertura: `Oi ${primeiroNome}! Vi no seu processo ${processo} um alvará judicial emitido em seu nome no ${banco}${valor ? `, valor aproximado ${valor}` : ''}. Posso te ajudar a sacar com segurança e te enviar o passo a passo? Cobro 15% só após o crédito cair na sua conta.`,
    
    seResponderSim: `Ótimo! Vou te explicar rapidinho:\n\n1️⃣ Verifico seu processo e preparo a documentação\n2️⃣ Você vai na agência ${banco} com RG, CPF e comprovante de endereço\n3️⃣ O dinheiro cai em 3-7 dias úteis\n4️⃣ Só então você me paga os 15%\n\nPosso começar agora?`,
    
    sePedirProva: `Claro! Aqui está o link oficial do tribunal onde você pode ver o alvará: https://pje.trt15.jus.br/consultaprocessual/detalhe-processo/${processo.replace(/\D/g, '')}\n\nSe preferir, te mando um PDF com o dossiê completo.`,
    
    fechamento: `Combinado então! Me manda seu RG e CPF (foto) e um comprovante de endereço que eu já preparo tudo. Qualquer dúvida é só chamar! 🤝`
  };
}

// ===== Endpoint: Busca leads CONFIRMADOS (filtro TORRE) =====
app.get("/api/leads", async (req, res) => {
  const logs = [];
  const log = (msg) => { console.log(msg); logs.push(msg); };
  
  try {
    const tribunal = (req.query.tribunal || "TRT15").toUpperCase();
    const limite = Number(req.query.limite) || 20;
    const dias = Number(req.query.dias) || 180; // Últimos 180 dias
    
    log(`[leads] Buscando no ${tribunal} (últimos ${dias} dias)...`);
    
    // 1. Busca no DataJud processos com alvará
    const endpoint = DATAJUD_ENDPOINTS[tribunal];
    if (!endpoint) {
      return res.status(400).json({ ok: false, error: `Tribunal ${tribunal} não encontrado` });
    }
    
    // Data limite (X dias atrás)
    const dataLimite = new Date();
    dataLimite.setDate(dataLimite.getDate() - dias);
    const dataLimiteStr = dataLimite.toISOString().split('T')[0].replace(/-/g, '');
    
    // Query TORRE - termos específicos de alvará
    const query = {
      size: limite * 5, // Busca mais para compensar filtros
      query: {
        bool: {
          should: [
            // Termos de alvará confirmado
            { match_phrase: { "movimentos.nome": "Expedição de documento" } },
            { match: { "movimentos.complementosTabelados.nome": "Alvará" } },
            { match: { "movimentos.nome": "alvará" } },
            { match: { "movimentos.nome": "levantamento" } },
            { match_phrase: { "movimentos.nome": "Autorizo o levantamento" } },
            { match_phrase: { "movimentos.nome": "liberação de valores" } },
          ],
          minimum_should_match: 1
        }
      },
      sort: [{ "dataHoraUltimaAtualizacao": { order: "desc" } }]
    };
    
    const datajudResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `APIKey ${DATAJUD_API_KEY}`
      },
      body: JSON.stringify(query)
    });
    
    const datajudData = await datajudResponse.json();
    log(`[leads] DataJud retornou ${datajudData.hits?.hits?.length || 0} processos`);
    
    // 2. Aplica FILTRO TORRE em cada processo
    const leadsConfirmados = [];
    
    for (const hit of (datajudData.hits?.hits || [])) {
      const src = hit._source;
      const movimentos = src.movimentos || [];
      
      // Análise TORRE
      const analise = analisarMovimentosTORRE(movimentos);
      
      // Só adiciona se passou no filtro TORRE
      if (analise.confirmado) {
        leadsConfirmados.push({
          processo: formatarProcessoCNJ(src.numeroProcesso),
          tribunal: src.tribunal,
          grau: src.grau,
          vara: src.orgaoJulgador?.nome,
          classe: src.classe?.nome,
          ultimaAtualizacao: src.dataHoraUltimaAtualizacao,
          
          // Dados do alvará confirmado
          alvara: {
            confirmado: true,
            tipo: analise.tipo,
            data: analise.dataAlvara,
            banco: analise.banco,
            valor: analise.valor,
            movimento: analise.movimentoAlvara
          },
          
          // URLs
          urlPje: `https://pje.${tribunal.toLowerCase()}.jus.br/consultaprocessual/detalhe-processo/${src.numeroProcesso}`,
          urlDossie: `/api/dossie?processo=${src.numeroProcesso}`
        });
        
        // Para quando atingir o limite
        if (leadsConfirmados.length >= limite) break;
      }
    }
    
    log(`[leads] ${leadsConfirmados.length} leads CONFIRMADOS após filtro TORRE`);
    
    res.json({
      ok: true,
      tribunal,
      filtro: {
        dias,
        grau: "G1",
        tipo: "TORRE - Só confirmados"
      },
      totalEncontrados: leadsConfirmados.length,
      leads: leadsConfirmados,
      
      // Instrução clara
      proximoPasso: leadsConfirmados.length > 0 
        ? "Chame /api/dossie?processo=XXX para cada lead e depois busque telefone"
        : "Nenhum lead confirmado. Tente outro tribunal ou aumente os dias.",
      
      logs
    });
    
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e), logs });
  }
});

// ===== Função TORRE - Analisa movimentos do DataJud =====
function analisarMovimentosTORRE(movimentos) {
  const resultado = {
    confirmado: false,
    tipo: null,
    dataAlvara: null,
    banco: null,
    valor: null,
    movimentoAlvara: null,
    motivoDescarte: null
  };
  
  // Termos que CONFIRMAM alvará (precisa ter)
  const termosAlvaraConfirmado = [
    /alvará/i,
    /guia de (levantamento|liberação)/i,
    /autorizo o levantamento/i,
    /liberação de valores/i,
    /expe(ça-se|dido|dição).{0,20}alvará/i
  ];
  
  // Termos de BAIXA (descarta)
  const termosBaixa = [
    /cumprido/i,
    /levantado/i,
    /pago/i,
    /devolvido/i,
    /cancelado/i,
    /arquiv/i
  ];
  
  // Termos de ADVOGADO (descarta)
  const termosAdvogado = [
    /advogado/i,
    /patrono/i,
    /honorários/i,
    /sucumb/i
  ];
  
  // Bancos (precisa ter)
  const termosBanco = {
    bb: /banco do brasil|bb\b/i,
    cef: /caixa econ|cef\b|caixa federal/i
  };
  
  // Analisa cada movimento
  for (const mov of movimentos) {
    const nome = (mov.nome || "").toLowerCase();
    const complementos = (mov.complementosTabelados || [])
      .map(c => (c.nome || "").toLowerCase())
      .join(" ");
    const textoCompleto = `${nome} ${complementos}`;
    
    // Verifica se tem termo de alvará
    const temAlvara = termosAlvaraConfirmado.some(regex => regex.test(textoCompleto));
    
    // Verifica complemento específico "Alvará"
    const temComplementoAlvara = complementos.includes('alvará');
    
    if (!temAlvara && !temComplementoAlvara) continue;
    
    // Verifica se já foi cumprido/baixado
    const jaBaixado = termosBaixa.some(regex => regex.test(textoCompleto));
    if (jaBaixado) {
      resultado.motivoDescarte = "Já cumprido/levantado/pago";
      continue;
    }
    
    // Verifica se é do advogado
    const eDoAdvogado = termosAdvogado.some(regex => regex.test(textoCompleto));
    if (eDoAdvogado) {
      resultado.motivoDescarte = "Alvará do advogado, não do reclamante";
      continue;
    }
    
    // PASSOU NO FILTRO TORRE! ✅
    resultado.confirmado = true;
    resultado.tipo = temComplementoAlvara ? "alvara_expedido" : "liberacao_valores";
    resultado.dataAlvara = mov.dataHora;
    resultado.movimentoAlvara = {
      nome: mov.nome,
      complemento: complementos,
      data: mov.dataHora
    };
    
    // Identifica banco
    if (termosBanco.bb.test(textoCompleto)) resultado.banco = "BB";
    else if (termosBanco.cef.test(textoCompleto)) resultado.banco = "CEF";
    
    // Extrai valor se presente
    const matchValor = textoCompleto.match(/r\$\s*([\d.,]+)/i);
    if (matchValor) resultado.valor = `R$ ${matchValor[1]}`;
    
    // Encontrou um válido, pode parar
    break;
  }
  
  return resultado;
}

// ===== PJe Consulta Processual - Pegar partes do processo =====
app.get("/debug/pje", async (req, res) => {
  const logs = [];
  const log = (msg) => { console.log(msg); logs.push(msg); };
  
  try {
    const processo = req.query.processo;
    if (!processo) {
      return res.status(400).json({ ok: false, error: "Parâmetro 'processo' é obrigatório" });
    }
    
    // Extrai tribunal do número do processo
    const numeroLimpo = processo.replace(/\D/g, '');
    let tribunalNum = "";
    if (numeroLimpo.length === 20) {
      tribunalNum = numeroLimpo.slice(14, 16);
    }
    
    // URLs do PJe por tribunal
    const pjeUrls = {
      "15": "https://pje.trt15.jus.br",
      "02": "https://pje.trt2.jus.br",
      "01": "https://pje.trt1.jus.br",
    };
    
    const pjeBase = pjeUrls[tribunalNum] || pjeUrls["15"];
    const consultaUrl = `${pjeBase}/consultaprocessual/detalhe-processo/${numeroLimpo}`;
    
    log(`[pje] Consultando ${consultaUrl}...`);
    
    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    });
    
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });
    
    await page.goto(consultaUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(3000);
    
    // Tenta extrair dados da página
    const dados = await page.evaluate(() => {
      const getText = (sel) => {
        const el = document.querySelector(sel);
        return el ? el.innerText.trim() : null;
      };
      
      const body = document.body.innerText || "";
      
      // Busca partes por diferentes padrões
      const partes = [];
      
      // Padrão 1: Tabela de partes
      document.querySelectorAll('table tr, .parte, [class*="parte"], [class*="polo"]').forEach(el => {
        const texto = el.innerText || "";
        if (texto.length > 5 && texto.length < 200) {
          partes.push(texto.trim());
        }
      });
      
      // Busca reclamante/autor no texto
      const regexReclamante = /(?:RECLAMANTE|AUTOR|EXEQUENTE|REQUERENTE)[:\s]*([A-ZÁÀÂÃÉÈÊÍÌÎÓÒÔÕÚÙÛÇ][A-Za-záàâãéèêíìîóòôõúùûçÁÀÂÃÉÈÊÍÌÎÓÒÔÕÚÙÛÇ\s\.]+?)(?:\n|CPF|OAB|Advogado|RECLAMAD|$)/gi;
      const matchesReclamante = [...body.matchAll(regexReclamante)];
      
      // Busca valores
      const regexValor = /R\$\s*([\d.,]+)/g;
      const matchesValor = [...body.matchAll(regexValor)].map(m => m[1]);
      
      return {
        url: window.location.href,
        titulo: document.title,
        bodyLength: body.length,
        partes: partes.slice(0, 10),
        reclamantes: matchesReclamante.map(m => m[1]?.trim()).filter(Boolean),
        valores: matchesValor.slice(0, 5),
        preview: body.substring(0, 3000)
      };
    });
    
    log(`[pje] Página carregada: ${dados.titulo}`);
    log(`[pje] Partes encontradas: ${dados.partes.length}`);
    log(`[pje] Reclamantes encontrados: ${dados.reclamantes.length}`);
    
    await browser.close();
    
    res.json({
      ok: true,
      processo,
      processoCNJ: formatarProcessoCNJ(numeroLimpo),
      pjeUrl: consultaUrl,
      dados,
      logs
    });
    
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e), logs });
  }
});

// ===== DataJud API (CNJ) =====
// API oficial do CNJ para consulta de processos
// Docs: https://datajud-wiki.cnj.jus.br/api-publica/

// Endpoints por tribunal trabalhista
const DATAJUD_ENDPOINTS = {
  TRT1: "https://api-publica.datajud.cnj.jus.br/api_publica_trt1/_search",
  TRT2: "https://api-publica.datajud.cnj.jus.br/api_publica_trt2/_search",
  TRT3: "https://api-publica.datajud.cnj.jus.br/api_publica_trt3/_search",
  TRT4: "https://api-publica.datajud.cnj.jus.br/api_publica_trt4/_search",
  TRT5: "https://api-publica.datajud.cnj.jus.br/api_publica_trt5/_search",
  TRT6: "https://api-publica.datajud.cnj.jus.br/api_publica_trt6/_search",
  TRT7: "https://api-publica.datajud.cnj.jus.br/api_publica_trt7/_search",
  TRT8: "https://api-publica.datajud.cnj.jus.br/api_publica_trt8/_search",
  TRT9: "https://api-publica.datajud.cnj.jus.br/api_publica_trt9/_search",
  TRT10: "https://api-publica.datajud.cnj.jus.br/api_publica_trt10/_search",
  TRT11: "https://api-publica.datajud.cnj.jus.br/api_publica_trt11/_search",
  TRT12: "https://api-publica.datajud.cnj.jus.br/api_publica_trt12/_search",
  TRT13: "https://api-publica.datajud.cnj.jus.br/api_publica_trt13/_search",
  TRT14: "https://api-publica.datajud.cnj.jus.br/api_publica_trt14/_search",
  TRT15: "https://api-publica.datajud.cnj.jus.br/api_publica_trt15/_search",
  TRT16: "https://api-publica.datajud.cnj.jus.br/api_publica_trt16/_search",
  TRT17: "https://api-publica.datajud.cnj.jus.br/api_publica_trt17/_search",
  TRT18: "https://api-publica.datajud.cnj.jus.br/api_publica_trt18/_search",
  TRT19: "https://api-publica.datajud.cnj.jus.br/api_publica_trt19/_search",
  TRT20: "https://api-publica.datajud.cnj.jus.br/api_publica_trt20/_search",
  TRT21: "https://api-publica.datajud.cnj.jus.br/api_publica_trt21/_search",
  TRT22: "https://api-publica.datajud.cnj.jus.br/api_publica_trt22/_search",
  TRT23: "https://api-publica.datajud.cnj.jus.br/api_publica_trt23/_search",
  TRT24: "https://api-publica.datajud.cnj.jus.br/api_publica_trt24/_search",
};

// Chave pública do DataJud (verificar em https://datajud-wiki.cnj.jus.br/api-publica/acesso)
const DATAJUD_API_KEY = "cDZHYzlZa0JadVREZDJCendQbXY6SkJlTzNjLV9TRENyQk1RdnFKZGRQdw==";

// Debug: testa API DataJud
app.get("/debug/datajud", async (req, res) => {
  const logs = [];
  const log = (msg) => { console.log(msg); logs.push(msg); };
  
  try {
    const tribunal = (req.query.tribunal || "TRT15").toUpperCase();
    const processo = req.query.processo || null;
    const buscarAlvaras = req.query.alvaras === "1" || req.query.alvaras === "true";
    const limite = Number(req.query.limite) || 10;
    
    const endpoint = DATAJUD_ENDPOINTS[tribunal];
    if (!endpoint) {
      return res.status(400).json({ ok: false, error: `Tribunal ${tribunal} não encontrado`, tribunaisDisponiveis: Object.keys(DATAJUD_ENDPOINTS) });
    }
    
    log(`[datajud] Buscando no ${tribunal}...`);
    
    let query;
    
    if (processo) {
      // Busca por número de processo específico
      log(`[datajud] Processo: ${processo}`);
      query = {
        size: 1,
        query: {
          match: {
            "numeroProcesso": processo
          }
        }
      };
    } else if (buscarAlvaras) {
      // Busca por movimentos que contenham termos de alvará/levantamento
      log(`[datajud] Buscando movimentos de alvará/levantamento...`);
      query = {
        size: limite,
        query: {
          bool: {
            should: [
              { match: { "movimentos.nome": "alvará" } },
              { match: { "movimentos.nome": "levantamento" } },
              { match: { "movimentos.nome": "liberação" } },
              { match: { "movimentos.nome": "pagamento" } },
              { match: { "movimentos.nome": "expedição" } }
            ],
            minimum_should_match: 1
          }
        },
        sort: [
          { "dataHoraUltimaAtualizacao": { order: "desc" } }
        ]
      };
    } else {
      // Busca processos recentes
      log(`[datajud] Buscando processos recentes...`);
      query = {
        size: limite,
        query: {
          match_all: {}
        },
        sort: [
          { "dataAjuizamento": { order: "desc" } }
        ]
      };
    }
    
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `APIKey ${DATAJUD_API_KEY}`
      },
      body: JSON.stringify(query)
    });
    
    log(`[datajud] Status: ${response.status}`);
    
    if (!response.ok) {
      const errorText = await response.text();
      return res.json({ ok: false, error: `API retornou ${response.status}`, body: errorText.substring(0, 1000), logs });
    }
    
    const data = await response.json();
    
    log(`[datajud] Hits: ${data.hits?.total?.value || 0}`);
    
    // Extrai processos encontrados
    const processos = (data.hits?.hits || []).map(hit => {
      const src = hit._source || {};
      
      // Filtra movimentos relevantes (alvará, levantamento, etc)
      const movimentosRelevantes = (src.movimentos || []).filter(m => {
        const nome = (m.nome || "").toLowerCase();
        const complementos = (m.complementosTabelados || []).map(c => (c.nome || "").toLowerCase()).join(" ");
        
        // Verifica se é alvará real (não apenas "expedição de documento")
        const isAlvara = 
          nome.includes('alvará') || nome.includes('alvara') ||
          complementos.includes('alvará') || complementos.includes('alvara') ||
          nome.includes('levantamento') || complementos.includes('levantamento') ||
          (nome.includes('liberação') && !nome.includes('vista')) ||
          (complementos.includes('liberação') && !complementos.includes('vista')) ||
          nome.includes('pagamento ao credor') ||
          nome.includes('depósito judicial') ||
          complementos.includes('guia de levantamento');
        
        return isAlvara;
      });
      
      // Marca se tem alvará REAL (não só expedição genérica)
      const temAlvaraReal = movimentosRelevantes.some(m => {
        const nome = (m.nome || "").toLowerCase();
        const complementos = (m.complementosTabelados || []).map(c => (c.nome || "").toLowerCase()).join(" ");
        return nome.includes('alvará') || nome.includes('alvara') ||
               complementos.includes('alvará') || complementos.includes('alvara') ||
               nome.includes('levantamento') || complementos.includes('levantamento') ||
               complementos.includes('guia de levantamento');
      });

      return {
        processo: src.numeroProcesso,
        processoCNJ: formatarProcessoCNJ(src.numeroProcesso),
        classe: src.classe?.nome,
        assuntos: (src.assuntos || []).map(a => a.nome).slice(0, 3).join(", "),
        dataAjuizamento: src.dataAjuizamento,
        ultimaAtualizacao: src.dataHoraUltimaAtualizacao,
        tribunal: src.tribunal,
        grau: src.grau,
        orgaoJulgador: src.orgaoJulgador?.nome,
        totalMovimentos: (src.movimentos || []).length,
        movimentosRelevantes: movimentosRelevantes.slice(0, 5).map(m => ({
          nome: m.nome,
          data: m.dataHora,
          complementos: (m.complementosTabelados || []).map(c => c.nome).join(", ")
        })),
        temAlvara: movimentosRelevantes.length > 0,
        temAlvaraReal
      };
    });
    
    // Filtra só os que têm movimentos relevantes se buscarAlvaras
    const processosFinais = buscarAlvaras 
      ? processos.filter(p => p.temAlvaraReal || p.temAlvara)
      : processos;
    
    // Ordena: primeiro os com alvará real
    processosFinais.sort((a, b) => {
      if (a.temAlvaraReal && !b.temAlvaraReal) return -1;
      if (!a.temAlvaraReal && b.temAlvaraReal) return 1;
      return 0;
    });

    res.json({
      ok: true,
      tribunal,
      totalHits: data.hits?.total?.value || 0,
      processosComAlvaraReal: processosFinais.filter(p => p.temAlvaraReal).length,
      processosComMovimentoRelevante: processosFinais.filter(p => p.temAlvara).length,
      processos: processosFinais,
      logs
    });
    
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e), logs });
  }
});

// Busca detalhes completos de um processo específico
app.get("/debug/datajud/processo", async (req, res) => {
  const logs = [];
  const log = (msg) => { console.log(msg); logs.push(msg); };
  
  try {
    const processo = req.query.processo;
    if (!processo) {
      return res.status(400).json({ ok: false, error: "Parâmetro 'processo' é obrigatório" });
    }
    
    // Extrai tribunal do número do processo (posição 14-16 no formato CNJ)
    const numeroLimpo = processo.replace(/\D/g, '');
    let tribunalNum = "";
    if (numeroLimpo.length === 20) {
      tribunalNum = numeroLimpo.slice(14, 16);
    }
    
    const tribunalMap = {
      "01": "TRT1", "02": "TRT2", "03": "TRT3", "04": "TRT4", "05": "TRT5",
      "06": "TRT6", "07": "TRT7", "08": "TRT8", "09": "TRT9", "10": "TRT10",
      "11": "TRT11", "12": "TRT12", "13": "TRT13", "14": "TRT14", "15": "TRT15",
      "16": "TRT16", "17": "TRT17", "18": "TRT18", "19": "TRT19", "20": "TRT20",
      "21": "TRT21", "22": "TRT22", "23": "TRT23", "24": "TRT24"
    };
    
    const tribunal = req.query.tribunal?.toUpperCase() || tribunalMap[tribunalNum] || "TRT15";
    const endpoint = DATAJUD_ENDPOINTS[tribunal];
    
    if (!endpoint) {
      return res.status(400).json({ ok: false, error: `Tribunal ${tribunal} não encontrado` });
    }
    
    log(`[datajud] Buscando processo ${processo} no ${tribunal}...`);
    
    const query = {
      size: 1,
      query: {
        match: {
          "numeroProcesso": numeroLimpo
        }
      }
    };
    
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `APIKey ${DATAJUD_API_KEY}`
      },
      body: JSON.stringify(query)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      return res.json({ ok: false, error: `API retornou ${response.status}`, body: errorText.substring(0, 500), logs });
    }
    
    const data = await response.json();
    
    if (!data.hits?.hits?.length) {
      return res.json({ ok: false, error: "Processo não encontrado", logs });
    }
    
    const src = data.hits.hits[0]._source;
    
    // Retorna todos os dados disponíveis
    res.json({
      ok: true,
      processo: {
        numero: src.numeroProcesso,
        numeroCNJ: formatarProcessoCNJ(src.numeroProcesso),
        classe: src.classe,
        assuntos: src.assuntos,
        dataAjuizamento: src.dataAjuizamento,
        ultimaAtualizacao: src.dataHoraUltimaAtualizacao,
        tribunal: src.tribunal,
        grau: src.grau,
        orgaoJulgador: src.orgaoJulgador,
        formato: src.formato,
        nivelSigilo: src.nivelSigilo
      },
      partes: src.partes || [],
      movimentos: (src.movimentos || []).map(m => ({
        codigo: m.codigo,
        nome: m.nome,
        dataHora: m.dataHora,
        complementos: m.complementosTabelados
      })),
      todosOsCampos: Object.keys(src),
      logs
    });
    
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e), logs });
  }
});

// Formata número de processo para padrão CNJ (0000000-00.0000.0.00.0000)
function formatarProcessoCNJ(numero) {
  if (!numero) return null;
  const n = numero.replace(/\D/g, '');
  if (n.length !== 20) return numero;
  return `${n.slice(0,7)}-${n.slice(7,9)}.${n.slice(9,13)}.${n.slice(13,14)}.${n.slice(14,16)}.${n.slice(16,20)}`;
}

// ===== DJEN (Diário de Justiça Eletrônico Nacional) =====
const DJEN_URL = "https://comunica.pje.jus.br/";
const DJEN_API_URL = "https://comunica.pje.jus.br/api/";

// Debug: explora o DJEN
app.get("/debug/djen", async (req, res) => {
  const logs = [];
  const log = (msg) => { console.log(msg); logs.push(msg); };
  
  try {
    const tribunal = req.query.tribunal || "TRT15";
    
    // Testa vários endpoints
    const endpoints = [
      { name: "DJEN principal", url: "https://comunica.pje.jus.br/" },
      { name: "DJEN consulta", url: "https://comunica.pje.jus.br/consulta" },
      { name: "CNJ portal", url: "https://www.cnj.jus.br/pjecnj/ConsultaPublica/listView.seam" },
      { name: "PJe consulta TRT15", url: "https://pje.trt15.jus.br/consultaprocessual/" },
      { name: "DataJud API", url: "https://datajud-wiki.cnj.jus.br/" }
    ];
    
    const results = [];
    
    for (const ep of endpoints) {
      log(`[djen] Testando ${ep.name}...`);
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        
        const response = await fetch(ep.url, {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'pt-BR,pt;q=0.9'
          },
          signal: controller.signal
        });
        
        clearTimeout(timeout);
        
        const html = await response.text();
        
        results.push({
          name: ep.name,
          url: ep.url,
          status: response.status,
          contentType: response.headers.get('content-type'),
          htmlLength: html.length,
          hasCloudflare: html.includes('cloudflare') || html.includes('cf-'),
          hasCaptcha: html.includes('captcha') || html.includes('challenge'),
          preview: html.substring(0, 500)
        });
        
        log(`[djen] ${ep.name}: ${response.status}, ${html.length} bytes`);
        
      } catch (e) {
        results.push({
          name: ep.name,
          url: ep.url,
          error: e.message
        });
        log(`[djen] ${ep.name}: ERRO - ${e.message}`);
      }
    }
    
    // Encontra o melhor endpoint que funcionou
    const working = results.filter(r => r.status === 200 && r.htmlLength > 500 && !r.hasCaptcha);
    
    res.json({
      ok: working.length > 0,
      workingEndpoints: working.map(w => w.name),
      results,
      logs,
      sugestao: working.length > 0 
        ? `Use o endpoint: ${working[0].name}` 
        : "Nenhum endpoint acessível. Considere usar API DataJud ou proxy."
    });
    
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e), logs });
  }
});

// Debug: baixa o PDF do caderno e extrai texto
app.get("/debug/pdf", async (req, res) => {
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

    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--lang=pt-BR"],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    });
    
    const page = await browser.newPage();
    
    // Usa CDP para interceptar requisições
    const client = await page.target().createCDPSession();
    await client.send('Fetch.enable', {
      patterns: [{ requestStage: 'Response', resourceType: 'Document' }]
    });
    
    let pdfBuffer = null;
    
    client.on('Fetch.requestPaused', async (event) => {
      const { requestId, responseHeaders } = event;
      const contentType = responseHeaders?.find(h => h.name.toLowerCase() === 'content-type')?.value || '';
      
      if (contentType.includes('application/pdf')) {
        log(`[pdf] PDF interceptado via CDP!`);
        try {
          const response = await client.send('Fetch.getResponseBody', { requestId });
          pdfBuffer = Buffer.from(response.body, response.base64Encoded ? 'base64' : 'utf-8');
          log(`[pdf] PDF capturado: ${pdfBuffer.length} bytes`);
        } catch (e) {
          log(`[pdf] Erro ao capturar body: ${e.message}`);
        }
      }
      
      await client.send('Fetch.continueRequest', { requestId }).catch(() => {});
    });
    
    await page.setExtraHTTPHeaders({ "Accept-Language": "pt-BR,pt;q=0.9" });
    
    log(`[pdf] Navegando para DEJT...`);
    await page.goto(DEJT_URL, { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(2000);
    
    // Configura formulário
    await page.evaluate((dataPt) => {
      const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
      for (const r of radios) {
        if (r.value === "J" || /judici/i.test(r.id || "")) {
          r.checked = true; r.click();
        }
      }
      const all = Array.from(document.querySelectorAll("input"));
      const ini = all.find(i => /data.?ini/i.test((i.id || "") + (i.name || "")));
      const fim = all.find(i => /data.?fim/i.test((i.id || "") + (i.name || "")));
      if (ini) { ini.value = dataPt; ini.dispatchEvent(new Event("change", { bubbles: true })); }
      if (fim) { fim.value = dataPt; fim.dispatchEvent(new Event("change", { bubbles: true })); }
    }, dataPt);
    
    const numTribunal = tribunais.replace(/\D/g, "");
    await page.evaluate((num) => {
      const selects = document.querySelectorAll('select');
      for (const sel of selects) {
        for (const opt of sel.options) {
          const numOpt = (opt.textContent || "").replace(/\D/g, "");
          if (numOpt === num) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event("change", { bubbles: true }));
            return;
          }
        }
      }
    }, numTribunal);
    
    await sleep(1000);
    log(`[pdf] Pesquisando...`);
    await clickPesquisarReal(page);
    await waitJsfResult(page, 900);
    
    // Clica no download
    log(`[pdf] Clicando no download...`);
    
    // Executa o onclick do link de download
    await page.evaluate(() => {
      const link = document.querySelector('a.link-download');
      if (link) {
        const onclick = link.getAttribute('onclick') || '';
        const cleaned = onclick.replace(/;?\s*return\s+(false|true)\s*;?\s*$/i, '');
        if (cleaned) {
          try { eval(cleaned); } catch(e) { console.log(e); }
        }
      }
    });
    
    // Espera o PDF ser interceptado
    await sleep(8000);
    await page.waitForNetworkIdle({ idleTime: 2000, timeout: 15000 }).catch(() => {});
    
    let resultado = { pdfCapturado: false };
    
    if (pdfBuffer && pdfBuffer.length > 1000) {
      log(`[pdf] Processando PDF de ${pdfBuffer.length} bytes...`);
      
      try {
        // Usa pdf-parse para extrair texto
        const pdfData = await pdf(pdfBuffer);
        const texto = pdfData.text || '';
        log(`[pdf] Texto extraído: ${texto.length} chars, ${pdfData.numpages} páginas`);
        
        // Busca termos relacionados a pagamentos judiciais
        const alvaras = [];
        const linhas = texto.split('\n');
        
        // Debug: verificar existência de termos
        const textoLower = texto.toLowerCase();
        const temAlvara = textoLower.includes('alvará') || textoLower.includes('alvara');
        const temLevantamento = textoLower.includes('levantamento');
        const temExpeca = textoLower.includes('expeça') || textoLower.includes('expeca');
        const temDefiro = textoLower.includes('defiro');
        const temPaguese = textoLower.includes('pague-se') || textoLower.includes('paguese');
        const temGuia = textoLower.includes('guia de depósito') || textoLower.includes('guia de deposito');
        const temCredito = textoLower.includes('crédito do exequente') || textoLower.includes('credito do exequente');
        const temValorLiberado = textoLower.includes('valor liberado') || textoLower.includes('liberação do valor');
        const temSaque = textoLower.includes('autorizo o saque') || textoLower.includes('saque autorizado');
        const temDeposito = textoLower.includes('depósito judicial') || textoLower.includes('deposito judicial');
        const temHomologacao = textoLower.includes('homolog') && textoLower.includes('acordo');
        
        for (let i = 0; i < linhas.length; i++) {
          const linha = linhas[i].toLowerCase();
          
          // Termos que indicam pagamento/alvará
          if (
            linha.includes('alvara') || linha.includes('alvará') ||
            linha.includes('levantamento') ||
            (linha.includes('expe') && linha.includes('a-se')) ||
            linha.includes('pague-se') ||
            (linha.includes('defiro') && (linha.includes('saque') || linha.includes('levant'))) ||
            (linha.includes('autorizo') && (linha.includes('saque') || linha.includes('levant'))) ||
            linha.includes('guia de levantamento') ||
            linha.includes('valor liberado') ||
            (linha.includes('libera') && linha.includes('depósito')) ||
            (linha.includes('libera') && linha.includes('deposito'))
          ) {
            const inicio = Math.max(0, i - 15);
            const fim = Math.min(linhas.length, i + 15);
            const contexto = linhas.slice(inicio, fim).join('\n');
            
            const processoMatch = contexto.match(/\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/);
            const valorMatch = contexto.match(/R\$\s*([\d.,]+)/);
            
            alvaras.push({
              linha: i,
              termoEncontrado: linhas[i].substring(0, 100),
              processo: processoMatch?.[0] || null,
              valor: valorMatch?.[1] || null,
              contexto: contexto.substring(0, 800)
            });
          }
        }
        
        // Remove duplicatas
        const alvarasUnicos = [];
        const processosVistos = new Set();
        for (const a of alvaras) {
          const chave = a.processo || a.linha;
          if (!processosVistos.has(chave)) {
            processosVistos.add(chave);
            alvarasUnicos.push(a);
          }
        }
        
        // Amostra do texto
        const amostraTexto = texto.substring(50000, 55000);
        
        const processos = [...new Set(texto.match(/\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/g) || [])];
        const valores = texto.match(/R\$\s*[\d.,]+/g) || [];
        
        resultado = {
          pdfCapturado: true,
          pdfBytes: pdfBuffer.length,
          pdfPaginas: pdfData.numpages,
          textoChars: texto.length,
          debug: {
            temAlvara,
            temLevantamento, 
            temExpeca,
            temDefiro,
            temPaguese,
            temGuia,
            temCredito,
            temValorLiberado,
            temSaque,
            temDeposito,
            temHomologacao
          },
          alvarasEncontrados: alvarasUnicos.length,
          alvaras: alvarasUnicos.slice(0, 10),
          processosUnicos: processos.length,
          processos: processos.slice(0, 10),
          valores: [...new Set(valores)].slice(0, 15),
          amostraTexto,
          trechoTexto: texto.substring(0, 2000)
        };
        
      } catch (e) {
        log(`[pdf] Erro pdftotext: ${e.message}`);
        resultado = { pdfCapturado: true, pdfBytes: pdfBuffer.length, erro: e.message };
      }
    } else {
      log(`[pdf] PDF não capturado ou muito pequeno`);
    }
    
    await browser.close();
    
    res.json({ ok: true, data: dataPt, tribunais, resultado, logs });
    
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e), logs });
  }
});

// Debug: testa pesquisa avançada com filtro por palavra-chave
app.get("/debug/avancada", async (req, res) => {
  const logs = [];
  const log = (msg) => { console.log(msg); logs.push(msg); };
  
  try {
    const tribunais = String(req.query.tribunais || "TRT15");
    const palavra = req.query.palavra || "alvará";
    const dataParam = req.query.data || null;
    
    const d = dataParam ? new Date(dataParam) : new Date();
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    const dataPt = `${dd}/${mm}/${yyyy}`;

    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--lang=pt-BR"],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    });
    
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ "Accept-Language": "pt-BR,pt;q=0.9" });
    
    log(`[avancada] Navegando para DEJT...`);
    await page.goto(DEJT_URL, { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(2000);
    
    // Configura formulário básico
    await page.evaluate((dataPt) => {
      const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
      for (const r of radios) {
        if (r.value === "J" || /judici/i.test(r.id || "")) {
          r.checked = true; r.click();
        }
      }
      const all = Array.from(document.querySelectorAll("input"));
      const ini = all.find(i => /data.?ini/i.test((i.id || "") + (i.name || "")));
      const fim = all.find(i => /data.?fim/i.test((i.id || "") + (i.name || "")));
      if (ini) { ini.value = dataPt; ini.dispatchEvent(new Event("change", { bubbles: true })); }
      if (fim) { fim.value = dataPt; fim.dispatchEvent(new Event("change", { bubbles: true })); }
    }, dataPt);
    
    const numTribunal = tribunais.replace(/\D/g, "");
    await page.evaluate((num) => {
      const selects = document.querySelectorAll('select');
      for (const sel of selects) {
        for (const opt of sel.options) {
          const numOpt = (opt.textContent || "").replace(/\D/g, "");
          if (numOpt === num) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event("change", { bubbles: true }));
            return;
          }
        }
      }
    }, numTribunal);
    
    await sleep(1000);
    
    // Clica em "Pesquisa avançada"
    log(`[avancada] Clicando em Pesquisa avançada...`);
    const clicouAvancada = await page.evaluate(() => {
      const btn = document.querySelector('[id*="botaoPesquisaAvancada"]') ||
                  document.querySelector('button[onclick*="PesquisaAvancada"]');
      if (btn) {
        const onclick = btn.getAttribute('onclick') || '';
        if (onclick) {
          const cleaned = onclick.replace(/;?\s*return\s+(false|true)\s*;?\s*$/i, '');
          try { eval(cleaned); return 'eval onclick'; } catch(e) {}
        }
        btn.click();
        return 'click';
      }
      return null;
    });
    log(`[avancada] Clicou: ${clicouAvancada}`);
    
    await page.waitForNetworkIdle({ idleTime: 2000, timeout: 15000 }).catch(() => {});
    await sleep(2000);
    
    // Verifica campos disponíveis na pesquisa avançada
    const camposAvancada = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input[type="text"], textarea'));
      const selects = Array.from(document.querySelectorAll('select'));
      const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"]'));
      
      return {
        inputs: inputs.map(i => ({ id: i.id, name: i.name, placeholder: i.placeholder })).slice(0, 20),
        selects: selects.map(s => ({ id: s.id, name: s.name, options: s.options.length })).slice(0, 10),
        buttons: buttons.map(b => ({ id: b.id, value: b.value || b.textContent, onclick: (b.getAttribute('onclick') || '').substring(0, 100) })).slice(0, 10),
        bodyLength: document.body.innerText.length,
        trechoBody: document.body.innerText.substring(0, 1500)
      };
    });
    
    log(`[avancada] Body: ${camposAvancada.bodyLength} chars`);
    log(`[avancada] Inputs: ${camposAvancada.inputs.length}, Selects: ${camposAvancada.selects.length}`);
    
    // Se tiver campo de palavra-chave, preenche
    const campoTexto = camposAvancada.inputs.find(i => 
      /texto|palavra|conteudo|busca|search/i.test((i.id || '') + (i.name || '') + (i.placeholder || ''))
    );
    
    if (campoTexto) {
      log(`[avancada] Preenchendo campo de texto: ${campoTexto.id || campoTexto.name}`);
      await page.evaluate((id, name, palavra) => {
        const input = document.getElementById(id) || document.querySelector(`[name="${name}"]`);
        if (input) {
          input.value = palavra;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, campoTexto.id, campoTexto.name, palavra);
    }
    
    await browser.close();
    
    res.json({
      ok: true,
      data: dataPt,
      tribunais,
      palavra,
      camposAvancada,
      logs
    });
    
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e), logs });
  }
});

// Debug: testa especificamente o download do caderno
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

    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--lang=pt-BR"],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    });
    
    const page = await browser.newPage();
    
    // Intercepta todas as respostas
    const responses = [];
    page.on('response', response => {
      const url = response.url();
      const status = response.status();
      const contentType = response.headers()['content-type'] || '';
      if (url.includes('dejt') || url.includes('diario')) {
        responses.push({ url: url.substring(0, 150), status, contentType: contentType.substring(0, 50) });
      }
    });
    
    // Intercepta novas páginas/popups
    const newPages = [];
    browser.on('targetcreated', async (target) => {
      const type = target.type();
      const url = target.url();
      newPages.push({ type, url: url.substring(0, 150) });
    });
    
    await page.setExtraHTTPHeaders({ "Accept-Language": "pt-BR,pt;q=0.9" });
    await page.goto(DEJT_URL, { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(2000);
    
    // Configura formulário
    await page.evaluate((dataPt) => {
      const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
      for (const r of radios) {
        if (r.value === "J" || /judici/i.test(r.id || "")) {
          r.checked = true; r.click();
        }
      }
      const all = Array.from(document.querySelectorAll("input"));
      const ini = all.find(i => /data.?ini/i.test((i.id || "") + (i.name || "")));
      const fim = all.find(i => /data.?fim/i.test((i.id || "") + (i.name || "")));
      if (ini) { ini.value = dataPt; ini.dispatchEvent(new Event("change", { bubbles: true })); }
      if (fim) { fim.value = dataPt; fim.dispatchEvent(new Event("change", { bubbles: true })); }
    }, dataPt);
    
    const numTribunal = tribunais.replace(/\D/g, "");
    await page.evaluate((num) => {
      const selects = document.querySelectorAll('select');
      for (const sel of selects) {
        for (const opt of sel.options) {
          const numOpt = (opt.textContent || "").replace(/\D/g, "");
          if (numOpt === num) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event("change", { bubbles: true }));
            return;
          }
        }
      }
    }, numTribunal);
    
    await sleep(1000);
    log("[download] Pesquisando...");
    await clickPesquisarReal(page);
    await waitJsfResult(page, 900);
    
    // Verifica se tem o link de download
    const linkInfo = await page.evaluate(() => {
      const link = document.querySelector('a.link-download, a[onclick*="plcLogicaItens"]');
      if (!link) return null;
      return {
        href: link.getAttribute('href'),
        onclick: link.getAttribute('onclick'),
        classe: link.className,
        html: link.outerHTML.substring(0, 300)
      };
    });
    log(`[download] Link encontrado: ${JSON.stringify(linkInfo)}`);
    
    if (linkInfo) {
      log("[download] Clicando no link de download...");
      
      // Limpa respostas anteriores
      responses.length = 0;
      
      // Usa page.click real em vez de eval
      await page.click('a.link-download');
      
      // Espera respostas
      await sleep(5000);
      await page.waitForNetworkIdle({ idleTime: 2000, timeout: 15000 }).catch(() => {});
      
      log(`[download] Respostas capturadas: ${responses.length}`);
      log(`[download] Novas páginas: ${newPages.length}`);
      
      // Verifica todas as páginas abertas
      const pages = await browser.pages();
      log(`[download] Total de páginas abertas: ${pages.length}`);
      
      const pagesInfo = [];
      for (const p of pages) {
        const url = p.url();
        const title = await p.title().catch(() => '');
        const bodyLen = await p.evaluate(() => document.body?.innerText?.length || 0).catch(() => 0);
        pagesInfo.push({ url: url.substring(0, 150), title, bodyLen });
      }
      
      // Verifica se a página atual mudou
      const currentUrl = page.url();
      const currentBody = await page.evaluate(() => document.body.innerText.length);
      log(`[download] Página atual: ${currentUrl}, body: ${currentBody}`);
    }
    
    await browser.close();
    
    res.json({
      ok: true,
      data: dataPt,
      linkInfo,
      responses: responses.slice(-20),
      newPages,
      logs
    });
    
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e), logs });
  }
});

// Debug: mostra estrutura HTML da área de cadernos após pesquisa
app.get("/debug/caderno", async (req, res) => {
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

    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--lang=pt-BR"],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    });
    
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ "Accept-Language": "pt-BR,pt;q=0.9" });
    
    await page.goto(DEJT_URL, { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(2000);
    
    // Seleciona caderno e preenche datas
    await page.evaluate((dataPt) => {
      const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
      for (const r of radios) {
        if (r.value === "J" || /judici/i.test(r.id || "")) {
          r.checked = true; r.click();
        }
      }
      const all = Array.from(document.querySelectorAll("input"));
      const ini = all.find(i => /data.?ini/i.test((i.id || "") + (i.name || "")));
      const fim = all.find(i => /data.?fim/i.test((i.id || "") + (i.name || "")));
      if (ini) { ini.value = dataPt; ini.dispatchEvent(new Event("change", { bubbles: true })); }
      if (fim) { fim.value = dataPt; fim.dispatchEvent(new Event("change", { bubbles: true })); }
    }, dataPt);
    
    const numTribunal = tribunais.replace(/\D/g, "");
    await page.evaluate((num) => {
      const selects = document.querySelectorAll('select');
      for (const sel of selects) {
        if (sel.options && sel.options.length > 5) {
          for (const opt of sel.options) {
            const numOpt = (opt.textContent || "").replace(/\D/g, "");
            if (numOpt === num) {
              sel.value = opt.value;
              sel.dispatchEvent(new Event("change", { bubbles: true }));
              return;
            }
          }
        }
      }
    }, numTribunal);
    
    await sleep(1000);
    await clickPesquisarReal(page);
    await waitJsfResult(page, 900);
    
    // Captura HTML e elementos clicáveis na área de resultados
    const htmlInfo = await page.evaluate(() => {
      // Busca TODOS os elementos clicáveis com onclick ou href
      const clicaveis = [];
      document.querySelectorAll("a, button, input, img, span, td, tr").forEach(el => {
        const onclick = el.getAttribute("onclick") || "";
        const href = el.getAttribute("href") || "";
        if (!onclick && !href) return;
        
        const texto = (el.textContent || el.value || el.alt || el.title || "").trim().substring(0, 100);
        const tag = el.tagName;
        const id = el.id || "";
        const classe = el.className || "";
        
        clicaveis.push({ 
          tag, id, classe: classe.substring(0, 50),
          texto: texto.substring(0, 80), 
          href: href.substring(0, 200), 
          onclick: onclick.substring(0, 300)
        });
      });
      
      // Filtra só os que parecem ser de download/visualização
      const downloads = clicaveis.filter(c => 
        /download|baixar|visualizar|abrir|window\.open/i.test(c.onclick + c.href + c.texto)
      );
      
      // Pega HTML da tabela de resultados
      let tableHtml = "";
      document.querySelectorAll("table, div").forEach(el => {
        if (/Edi[çc][ãa]o.*\d+.*Caderno/i.test(el.textContent || "")) {
          if (!tableHtml || el.outerHTML.length < tableHtml.length) {
            tableHtml = el.outerHTML;
          }
        }
      });
      
      return {
        totalClicaveis: clicaveis.length,
        downloads,
        todosClicaveis: clicaveis.slice(0, 30),
        tableHtml: tableHtml.substring(0, 8000)
      };
    });
    
    await browser.close();
    
    res.json({
      ok: true,
      data: dataPt,
      tribunais,
      downloads: htmlInfo.downloads,
      todosClicaveis: htmlInfo.todosClicaveis,
      tableHtml: htmlInfo.tableHtml,
      logs
    });
    
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e), logs });
  }
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
    
    // 4. Dispara pesquisa - usa clique REAL do Puppeteer
    log("[debug] Disparando pesquisa com clique real...");
    
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
    
    // Clique real no botão
    const how = await clickPesquisarReal(page);
    log(`[debug] Método de disparo real: ${how}`);
    
    // Espera resultado JSF
    await waitJsfResult(page, beforeLen);
    
    // Verifica tamanho após
    let afterLen = await page.evaluate(() => document.body.innerText.length);
    log(`[debug] Body após primeiro disparo: ${afterLen} chars`);
    
    // Verifica se apareceu resultado da pesquisa (listagem de cadernos)
    const temCaderno = await page.evaluate(() => {
      const body = document.body.innerText || "";
      return /Edi[çc][ãa]o\s+\d+/i.test(body) || /Caderno.*Judici/i.test(body);
    });
    
    if (temCaderno) {
      log("[debug] Caderno encontrado na listagem! Abrindo...");
      
      // Abre o caderno do TRT solicitado
      const numTribunal = tribunais.replace(/\D/g, '') || '15';
      const howCaderno = await openFirstCaderno(page, browser);
      log(`[debug] Abrindo caderno: ${howCaderno}`);
      
      await waitCadernoLoaded(page);
      
      afterLen = await page.evaluate(() => document.body.innerText.length);
      log(`[debug] Body após abrir caderno: ${afterLen} chars`);
    }
    
    // Se ainda pequeno e não tem caderno, tenta novamente
    if (afterLen < 3000 && !temCaderno) {
      log("[debug] Body ainda pequeno, tentando novamente com clique real...");
      
      // Tenta também pressionar Enter como fallback
      try {
        await page.keyboard.press('Enter');
        await sleep(500);
      } catch (e) {}
      
      const before2 = afterLen;
      await clickPesquisarReal(page);
      await waitJsfResult(page, before2);
      
      afterLen = await page.evaluate(() => document.body.innerText.length);
      log(`[debug] Body após segundo disparo: ${afterLen} chars`);
    }
    
    // Captura resultado com links de atos
    const resultado = await page.evaluate(() => {
      const body = document.body.innerText || "";
      const links = [];
      document.querySelectorAll("a").forEach(a => {
        const texto = (a.textContent || "").trim();
        const href = a.getAttribute("href") || "";
        if (texto || href) links.push({ texto: texto.substring(0, 80), href: href.substring(0, 300) });
      });

      // Links mais prováveis de abrir ato
      const linksAto = [];
      document.querySelectorAll("a").forEach(a => {
        const t = (a.textContent || "").toLowerCase();
        const h = (a.getAttribute("href") || "").toLowerCase();
        const oc = (a.getAttribute("onclick") || "").toLowerCase();
        if (
          t.includes("visualizar") || t.includes("inteiro") || t.includes("conteúdo") || t.includes("conteudo") ||
          h.includes("visualizar") || h.includes("inteiro") || h.includes("conteudo") || h.includes("conteúdo") ||
          h.includes("teor") || oc.includes("window.open")
        ) {
          linksAto.push({ 
            texto: (a.textContent || "").substring(0, 50), 
            href: a.getAttribute("href") || "", 
            onclick: (a.getAttribute("onclick") || "").substring(0, 100) 
          });
        }
      });

      return {
        tamanhoBody: body.length,
        temAlvara: /alvar[aá]/i.test(body),
        temProcesso: /\d{7}-\d{2}\.\d{4}/.test(body),
        trechoBody: body.substring(0, 3000),
        totalLinks: links.length,
        primeirosLinks: links.slice(0, 15),
        linksAto: linksAto.slice(0, 20)
      };
    });
    
    log(`[debug] Body final: ${resultado.tamanhoBody} chars, alvará: ${resultado.temAlvara}, processo: ${resultado.temProcesso}`);
    log(`[debug] Links de ato: ${resultado.linksAto.length}`);
    
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

    // Clica em Pesquisar usando clique REAL do Puppeteer
    try {
      log(`[miner] Disparando pesquisa com clique real...`);
      
      // Captura tamanho antes
      const beforeLen = await page.evaluate(() => document.body.innerText.length);
      
      // Clique real no botão
      const how = await clickPesquisarReal(page);
      log(`[miner] Método de disparo: ${how}`);
      
      // Espera resultado JSF
      await waitJsfResult(page, beforeLen);
      
      // Verifica tamanho após
      let afterLen = await page.evaluate(() => document.body.innerText.length);
      log(`[miner] Body: antes=${beforeLen}, depois=${afterLen}`);
      
      // Se ainda pequeno, tenta novamente
      if (afterLen < 3000) {
        log(`[miner] Body pequeno, tentando novamente...`);
        
        // Tenta Enter como fallback
        try { await page.keyboard.press('Enter'); await sleep(500); } catch (e) {}
        
        const before2 = afterLen;
        await clickPesquisarReal(page);
        await waitJsfResult(page, before2);
        
        afterLen = await page.evaluate(() => document.body.innerText.length);
        log(`[miner] Body após segundo disparo: ${afterLen}`);
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
        tamanhoBody: body.length,
        temCaderno: /Edi[çc][ãa]o\s+\d+/i.test(body) || /Caderno.*Judici/i.test(body)
      };
    });
    log(`[miner] Resultados: alvará=${temResultados.temAlvara}, processo=${temResultados.temProcesso}, tam=${temResultados.tamanhoBody}, caderno=${temResultados.temCaderno}`);

    // Se encontrou listagem de cadernos, abre o caderno
    if (temResultados.temCaderno) {
      log(`[miner] Caderno encontrado, abrindo...`);
      const num = String(orgao).replace(/\D/g, '') || '15';
      const howCad = await openFirstCaderno(page, browser);
      log(`[miner] Abriu caderno: ${howCad}`);
      await waitCadernoLoaded(page);
      
      // Atualiza verificação
      const afterCaderno = await page.evaluate(() => {
        const body = document.body.innerText || "";
        return {
          temAlvara: /alvar[aá]/i.test(body),
          temProcesso: /\d{7}-\d{2}\.\d{4}/.test(body),
          tamanhoBody: body.length
        };
      });
      log(`[miner] Após abrir caderno: alvará=${afterCaderno.temAlvara}, processo=${afterCaderno.temProcesso}, tam=${afterCaderno.tamanhoBody}`);
    }

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