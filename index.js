// ===== TORRE v11.0 — Sistema Completo de Leads Qualificados =====
// MELHORIAS: banco regex, falso-positivo PJ, idade máxima, score refinado, prova.trecho

import express from "express";
import cors from "cors";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import QRCode from "qrcode";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const PDF_DIR = process.env.PDF_DIR || "/tmp/pdf";

// ===== API Keys =====
const DATAJUD_API_KEY = process.env.DATAJUD_API_KEY || "APIKey cDZHYzlZa0JadVREZDJCendQbXY6SkJlTzNjLV9TRENyQk1RdnFKZGRQdw==";
const INFOSIMPLES_TOKEN = process.env.INFOSIMPLES_TOKEN || "";
const DIRECTDATA_TOKEN = process.env.DIRECTDATA_TOKEN || "";

// ===== Configurações TORRE =====
const CONFIG = {
  MIN_VALOR_CENTAVOS: Number(process.env.MIN_VALOR || 2000000), // R$ 20.000
  MIN_SCORE: Number(process.env.MIN_SCORE || 60),
  MAX_IDADE_DIAS: Number(process.env.MAX_IDADE_DIAS || 540), // 18 meses - descarta
  IDADE_GARIMPO_DIAS: 720, // > 720 dias vai pra lista garimpo
  IDADE_PENALIDADE_DIAS: 365 // > 365 dias perde pontos
};

// ===== Setup =====
if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "2mb" }));
app.use("/pdf", express.static(PDF_DIR));

// ===== DataJud Endpoints =====
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

// ===== Utils =====
const formatarProcessoCNJ = (num) => {
  const n = String(num).replace(/\D/g, '').padStart(20, '0');
  return `${n.slice(0,7)}-${n.slice(7,9)}.${n.slice(9,13)}.${n.slice(13,14)}.${n.slice(14,16)}.${n.slice(16,20)}`;
};

const centavosToBRL = (c) => (Math.round(c) / 100).toLocaleString("pt-BR", {
  style: "currency", currency: "BRL", minimumFractionDigits: 2
});

const calcularIdadeDias = (dataStr) => {
  if (!dataStr) return null;
  let data;
  if (typeof dataStr === 'string' && dataStr.includes('/')) {
    const partes = dataStr.split(' ')[0].split('/');
    if (partes.length === 3) {
      data = new Date(partes[2], partes[1] - 1, partes[0]);
    }
  } else {
    data = new Date(dataStr);
  }
  if (!data || isNaN(data.getTime())) return null;
  return Math.floor((new Date() - data) / (1000 * 60 * 60 * 24));
};

const safe = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ===== DETECTOR DE PJ (Pessoa Jurídica) =====
function detectarPJ(texto) {
  if (!texto) return false;
  const upper = texto.toUpperCase();
  const termosPJ = [
    'LTDA', 'S.A.', 'S/A', ' SA ', 'S.A', 
    ' ME ', ' ME.', ' EPP', 'EIRELI', 'MEI ',
    'EMPREENDIMENTOS', 'INCORPORADORA', 'CONSTRUTORA',
    'COMERCIO', 'COMÉRCIO', 'INDUSTRIA', 'INDÚSTRIA',
    'SERVICOS', 'SERVIÇOS', 'TRANSPORTES', 'LOGISTICA',
    'CNPJ', 'EMPRESA', 'COMPANHIA', 'CIA.', 'CIA ',
    'ASSOCIACAO', 'ASSOCIAÇÃO', 'FUNDACAO', 'FUNDAÇÃO',
    'INSTITUTO', 'COOPERATIVA', 'CONDOMINIO', 'CONDOMÍNIO'
  ];
  return termosPJ.some(t => upper.includes(t));
}

// ===== DETECTOR DE ADVOGADO/PATRONO =====
function detectarAdvogado(texto) {
  if (!texto) return false;
  const lower = texto.toLowerCase();
  const termos = ['advogado', 'patrono', 'honorário', 'sucumbência', 'perito', 'curador', 'procurador'];
  return termos.some(t => lower.includes(t));
}

// ===== DETECTOR DE BANCO =====
function detectarBanco(texto) {
  if (!texto) return null;
  const upper = texto.toUpperCase();
  
  // Banco do Brasil
  if (/BANCO DO BRASIL|BB\s|\.BB\.|\/BB\/|AGÊNCIA BB|\bBB\b/i.test(upper)) {
    return 'BB';
  }
  
  // Caixa Econômica Federal
  if (/CAIXA ECON|CEF\s|\.CEF\.|\/CEF\/|CAIXA FEDERAL|\bCEF\b/i.test(upper)) {
    return 'CEF';
  }
  
  return null;
}

// ===== DETECTOR DE SAQUE JÁ REALIZADO =====
function detectarSaqueRealizado(texto) {
  if (!texto) return false;
  const lower = texto.toLowerCase();
  const termos = [
    'cumprido', 'levantado', 'levantamento efetuado', 
    'transferido ao beneficiário', 'pago', 'quitado',
    'baixado', 'devolução do alvará', 'alvará cumprido',
    'valor sacado', 'saque realizado', 'creditado'
  ];
  return termos.some(t => lower.includes(t));
}

// ===== EXTRATOR DE VALOR =====
function extrairValor(texto) {
  if (!texto) return null;
  const match = texto.match(/R\$\s*([\d.,]+)/i);
  if (!match) return null;
  const valorStr = match[1].replace(/\./g, '').replace(',', '.');
  const valor = parseFloat(valorStr);
  if (isNaN(valor) || valor <= 0) return null;
  return Math.round(valor * 100);
}

// ===== DETECTOR DE CÓDIGO DE ALVARÁ =====
function detectarCodigoAlvara(texto) {
  if (!texto) return { tem: false, codigo: null };
  
  // Padrões comuns de código de alvará
  const padroes = [
    /c[óo]digo[:\s]*(\d{5,})/i,
    /guia[:\s]*(\d{5,})/i,
    /id[:\s]*alvará[:\s]*(\d{5,})/i,
    /alvará[:\s]*n[º°]?\s*(\d{5,})/i,
    /protocolo[:\s]*(\d{5,})/i
  ];
  
  for (const p of padroes) {
    const match = texto.match(p);
    if (match) return { tem: true, codigo: match[1] };
  }
  
  return { tem: false, codigo: null };
}

// ===== CALCULAR SCORE REFINADO =====
function calcularScoreRefinado(params) {
  const { 
    pfNomeadaNoMovimento, 
    bancoDetectado, 
    valorDoAlvara,
    valorDaCausa,
    idadeDias,
    temCodigoAlvara,
    possivelPJ
  } = params;

  let score = 0;
  const detalhes = [];

  // +30 PF nome na mesma linha do movimento de alvará
  if (pfNomeadaNoMovimento) {
    score += 30;
    detalhes.push('+30 PF nomeada no movimento');
  }

  // +25 banco detectado (BB ou CEF)
  if (bancoDetectado) {
    score += 25;
    detalhes.push(`+25 banco ${bancoDetectado}`);
  }

  // +20 valor do alvará presente (não valor da causa)
  if (valorDoAlvara) {
    score += 20;
    detalhes.push('+20 valor do alvará');
  }

  // -25 se fonte for valor_causa (não é certo)
  if (!valorDoAlvara && valorDaCausa) {
    score -= 25;
    detalhes.push('-25 só tem valor_causa (incerto)');
  }

  // +15 idade ≤ 120 dias
  if (idadeDias !== null && idadeDias <= 120) {
    score += 15;
    detalhes.push('+15 recente (≤120 dias)');
  }

  // +10 código de alvará presente
  if (temCodigoAlvara) {
    score += 10;
    detalhes.push('+10 código alvará');
  }

  // -20 se idade > 365 dias
  if (idadeDias !== null && idadeDias > 365) {
    score -= 20;
    detalhes.push('-20 antigo (>365 dias)');
  }

  // -50 se possível PJ (descarta praticamente)
  if (possivelPJ) {
    score -= 50;
    detalhes.push('-50 possível PJ');
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    detalhes
  };
}

// ===== ANALISAR MOVIMENTO DE ALVARÁ (InfoSimples) =====
function analisarMovimentoAlvara(movimentos) {
  const resultado = {
    confirmado: false,
    tipo: null,
    data: null,
    banco: null,
    valorCentavos: null,
    beneficiarioNoMovimento: null,
    possivelPJ: false,
    saqueRealizado: false,
    temCodigoAlvara: false,
    codigoAlvara: null,
    prova: { trecho: null, movimento: null }
  };

  if (!movimentos || !Array.isArray(movimentos)) return resultado;

  // Ordena do mais recente pro mais antigo
  const ordenados = [...movimentos].sort((a, b) => {
    const dataA = a.data || '';
    const dataB = b.data || '';
    return dataB.localeCompare(dataA);
  });

  for (const mov of ordenados) {
    const titulo = mov.titulo || '';
    const tituloLower = titulo.toLowerCase();

    // Verifica se é movimento de alvará
    const ehAlvara = tituloLower.includes('alvará') || 
                     tituloLower.includes('levantamento') ||
                     tituloLower.includes('liberação');

    if (!ehAlvara) continue;

    // Verifica saque já realizado
    if (detectarSaqueRealizado(titulo)) {
      resultado.saqueRealizado = true;
      continue;
    }

    // Extrai beneficiário do movimento
    const matchBenef = titulo.match(/(?:a\(o\)|ao?)\s+([A-ZÀ-Ú][A-ZÀ-Ú\s.]+)/i);
    if (matchBenef) {
      const beneficiario = matchBenef[1].trim();
      resultado.beneficiarioNoMovimento = beneficiario;
      
      // Verifica se é PJ
      if (detectarPJ(beneficiario)) {
        resultado.possivelPJ = true;
        continue; // Pula PJ, procura outro movimento
      }
      
      // Verifica se é advogado
      if (detectarAdvogado(titulo)) {
        continue; // Pula advogado
      }
    }

    // CONFIRMADO!
    resultado.confirmado = true;
    resultado.tipo = 'alvara_expedido';
    resultado.data = mov.data;
    resultado.prova = {
      trecho: titulo.substring(0, 200),
      movimento: mov
    };

    // Detecta banco
    resultado.banco = detectarBanco(titulo);

    // Extrai valor
    resultado.valorCentavos = extrairValor(titulo);

    // Detecta código
    const codigo = detectarCodigoAlvara(titulo);
    resultado.temCodigoAlvara = codigo.tem;
    resultado.codigoAlvara = codigo.codigo;

    break;
  }

  return resultado;
}

// ===== Health & Info =====
app.get("/", (_req, res) => res.send("TORRE v11.0 — Sistema de Leads Qualificados"));

app.get("/health", (_req, res) => res.json({ 
  ok: true, 
  version: "11.0",
  config: CONFIG,
  apis: {
    directData: DIRECTDATA_TOKEN ? "✅" : "❌",
    infosimples: INFOSIMPLES_TOKEN ? "✅" : "❌"
  },
  now: new Date().toISOString() 
}));

app.get("/api/saude", (_req, res) => res.json({
  ok: true,
  version: "11.0",
  config: CONFIG,
  endpoints: [
    "GET /api/leads-qualificados?tribunal=TRT1&limite=10&minScore=60",
    "GET /api/dossie?processo=XXXXXXX",
    "GET /api/telefone?cpf=XXXXXXXXXXX",
    "POST /api/pdf"
  ],
  tribunaisDisponiveis: Object.keys(DATAJUD_ENDPOINTS),
  now: new Date().toISOString()
}));

// ===== GET /api/leads-qualificados - Leads com valor CONFIRMADO =====
app.get("/api/leads-qualificados", async (req, res) => {
  const logs = [];
  const log = (msg) => { console.log(msg); logs.push(msg); };

  try {
    const tribunal = (req.query.tribunal || "TRT1").toUpperCase();
    const limite = Math.min(Number(req.query.limite) || 10, 30);
    const minValor = Number(req.query.minValor) || CONFIG.MIN_VALOR_CENTAVOS;
    const minScore = Number(req.query.minScore) || CONFIG.MIN_SCORE;
    const maxIdade = Number(req.query.maxIdade) || CONFIG.MAX_IDADE_DIAS;
    const modo = req.query.modo || "pf_core"; // pf_core | garimpo

    log(`[TORRE] Buscando ${limite} leads ≥ ${centavosToBRL(minValor)}, score ≥ ${minScore}, tribunal ${tribunal}...`);

    if (!INFOSIMPLES_TOKEN) {
      return res.status(400).json({ ok: false, error: "INFOSIMPLES_TOKEN não configurado" });
    }

    const endpoint = DATAJUD_ENDPOINTS[tribunal];
    if (!endpoint) {
      return res.status(400).json({ ok: false, error: `Tribunal ${tribunal} não suportado` });
    }

    // 1. Busca candidatos no DataJud
    const query = {
      size: limite * 20,
      query: {
        bool: {
          should: [
            { match: { "movimentos.nome": "alvará" } },
            { match: { "movimentos.nome": "levantamento" } },
            { match: { "movimentos.complementosTabelados.nome": "Alvará" } },
            { match_phrase: { "movimentos.nome": "Expedição de documento" } },
          ],
          minimum_should_match: 1
        }
      },
      sort: [{ "dataHoraUltimaAtualizacao": { order: "desc" } }]
    };

    const datajudResponse = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': DATAJUD_API_KEY },
      body: JSON.stringify(query)
    });

    const datajudData = await datajudResponse.json();
    const candidatos = datajudData.hits?.hits || [];
    log(`[TORRE] DataJud: ${candidatos.length} candidatos`);

    // 2. Filtro TORRE básico (DataJud)
    const processosVistos = new Set();
    const candidatosFiltrados = [];

    for (const hit of candidatos) {
      const src = hit._source;
      const processoNum = src.numeroProcesso;
      if (processosVistos.has(processoNum)) continue;
      processosVistos.add(processoNum);

      candidatosFiltrados.push({
        processo: formatarProcessoCNJ(processoNum),
        tribunal: src.tribunal || tribunal,
        grau: src.grau,
        vara: src.orgaoJulgador?.nome,
        classe: src.classe?.nome
      });
    }

    log(`[TORRE] Após dedup: ${candidatosFiltrados.length} candidatos`);

    // 3. Consulta InfoSimples e aplica filtros rigorosos
    const leadsQualificados = [];
    const leadsGarimpo = []; // Velhos mas válidos
    let consultasInfoSimples = 0;
    const descartados = {
      valorBaixo: 0,
      semValor: 0,
      erroConsulta: 0,
      possivelPJ: 0,
      saqueRealizado: 0,
      scoreBaixo: 0,
      muitoAntigo: 0
    };

    for (const candidato of candidatosFiltrados) {
      if (leadsQualificados.length >= limite) break;

      try {
        consultasInfoSimples++;
        const url = `https://api.infosimples.com/api/v2/consultas/tribunal/trt/processo?numero_processo=${encodeURIComponent(candidato.processo)}&token=${INFOSIMPLES_TOKEN}`;
        const response = await fetch(url);
        const data = await response.json();

        if (data.code !== 200) {
          descartados.erroConsulta++;
          log(`[TORRE] ❌ ${candidato.processo}: erro InfoSimples`);
          continue;
        }

        const resultado = data.data?.[0] || {};
        const detalhes = resultado.detalhes || {};
        const itens = resultado.itens || [];

        // Analisa movimentos
        const analise = analisarMovimentoAlvara(itens);

        // Descarta se saque já realizado
        if (analise.saqueRealizado) {
          descartados.saqueRealizado++;
          log(`[TORRE] ❌ ${candidato.processo}: saque já realizado`);
          continue;
        }

        // Descarta se PJ no movimento
        if (analise.possivelPJ) {
          descartados.possivelPJ++;
          log(`[TORRE] ❌ ${candidato.processo}: possível PJ (${analise.beneficiarioNoMovimento})`);
          continue;
        }

        // Extrai beneficiários PF do polo ativo
        const poloAtivo = detalhes.polo_ativo || [];
        const beneficiariosPF = poloAtivo.filter(p => {
          const nome = p.nome || '';
          const tipo = (p.tipo || '').toLowerCase();
          if (detectarPJ(nome)) return false;
          if (tipo.includes('advogado') || tipo.includes('patrono')) return false;
          return true;
        }).map(p => ({
          nome: p.nome,
          tipo: p.tipo,
          advogados: (p.representantes || []).filter(r => r.tipo === "Advogado").map(r => r.nome)
        }));

        // Extrai valores
        let valorAlvaraCentavos = analise.valorCentavos;
        let valorCausaCentavos = null;
        let fonteValor = null;

        // Valor da causa como fallback
        if (detalhes.valor_causa) {
          valorCausaCentavos = extrairValor(detalhes.valor_causa);
        }

        // Define fonte do valor
        if (valorAlvaraCentavos) {
          fonteValor = "alvara";
        } else if (valorCausaCentavos) {
          fonteValor = "valor_causa";
        }

        const valorFinal = valorAlvaraCentavos || valorCausaCentavos;

        // Filtra por valor mínimo
        if (!valorFinal) {
          descartados.semValor++;
          log(`[TORRE] ❌ ${candidato.processo}: sem valor`);
          continue;
        }

        if (valorFinal < minValor) {
          descartados.valorBaixo++;
          log(`[TORRE] ❌ ${candidato.processo}: ${centavosToBRL(valorFinal)} < ${centavosToBRL(minValor)}`);
          continue;
        }

        // Calcula idade
        const idadeDias = calcularIdadeDias(analise.data);

        // Muito antigo? Vai pro garimpo
        if (idadeDias !== null && idadeDias > CONFIG.IDADE_GARIMPO_DIAS && modo !== 'garimpo') {
          descartados.muitoAntigo++;
          leadsGarimpo.push({ processo: candidato.processo, idadeDias, valor: centavosToBRL(valorFinal) });
          log(`[TORRE] ⏳ ${candidato.processo}: muito antigo (${idadeDias} dias) → garimpo`);
          continue;
        }

        // Descarta se acima do maxIdade (modo normal)
        if (modo !== 'garimpo' && idadeDias !== null && idadeDias > maxIdade) {
          descartados.muitoAntigo++;
          log(`[TORRE] ❌ ${candidato.processo}: ${idadeDias} dias > ${maxIdade}`);
          continue;
        }

        // Detecta banco em todos os textos
        let bancoDetectado = analise.banco;
        if (!bancoDetectado) {
          const todosTextos = itens.map(i => i.titulo || '').join(' ');
          bancoDetectado = detectarBanco(todosTextos);
        }

        // Calcula score refinado
        const scoreResult = calcularScoreRefinado({
          pfNomeadaNoMovimento: !!analise.beneficiarioNoMovimento && !detectarPJ(analise.beneficiarioNoMovimento),
          bancoDetectado,
          valorDoAlvara: !!valorAlvaraCentavos,
          valorDaCausa: !!valorCausaCentavos && !valorAlvaraCentavos,
          idadeDias,
          temCodigoAlvara: analise.temCodigoAlvara,
          possivelPJ: false
        });

        // Filtra por score mínimo
        if (scoreResult.score < minScore) {
          descartados.scoreBaixo++;
          log(`[TORRE] ❌ ${candidato.processo}: score ${scoreResult.score} < ${minScore}`);
          continue;
        }

        // ✅ LEAD QUALIFICADO!
        log(`[TORRE] ✅ ${candidato.processo}: ${centavosToBRL(valorFinal)} | score ${scoreResult.score} | ${idadeDias || '?'} dias`);

        const primeiroNome = beneficiariosPF[0]?.nome?.split(' ')[0] || 'Sr(a)';

        leadsQualificados.push({
          processo: candidato.processo,
          tribunal: candidato.tribunal,
          grau: candidato.grau,
          vara: candidato.vara,
          classe: candidato.classe,

          // Valor
          valor: {
            centavos: valorFinal,
            formatado: centavosToBRL(valorFinal),
            fonte: fonteValor,
            alvaraCentavos: valorAlvaraCentavos,
            causaCentavos: valorCausaCentavos
          },

          // Alvará
          alvara: {
            confirmado: analise.confirmado,
            tipo: analise.tipo,
            data: analise.data,
            banco: bancoDetectado,
            temCodigoAlvara: analise.temCodigoAlvara,
            codigoAlvara: analise.codigoAlvara
          },

          // Prova (para auditoria)
          prova: analise.prova,

          // Beneficiários
          beneficiariosPF,
          beneficiarioNoMovimento: analise.beneficiarioNoMovimento,
          pfNomeada: beneficiariosPF.length > 0,

          // Métricas
          idadeAlvaraDias: idadeDias,
          score: scoreResult.score,
          scoreDetalhes: scoreResult.detalhes,

          // Links
          links: {
            pje: `https://pje.${tribunal.toLowerCase()}.jus.br/consultaprocessual/detalhe-processo/${candidato.processo.replace(/\D/g, '')}`,
            comprovante: resultado.site_receipt
          },

          // Mensagem de pitch
          mensagem: fonteValor === 'alvara' 
            ? `Oi ${primeiroNome}, identifiquei no ${tribunal} um alvará de ${centavosToBRL(valorFinal)} no proc. ${candidato.processo} em seu nome. Posso te explicar em 2 min como sacar? Cobro só no êxito.`
            : `Oi ${primeiroNome}, vi no ${tribunal} movimentação de alvará no proc. ${candidato.processo}. O valor da causa é ${centavosToBRL(valorFinal)}, mas preciso verificar o valor exato liberado. Posso checar sem custo?`,

          // Contato
          contato: {
            status: DIRECTDATA_TOKEN ? "aguardando_enriquecimento" : "aguardando_directdata",
            telefone: null,
            whatsapp: null,
            email: null
          }
        });

      } catch (e) {
        descartados.erroConsulta++;
        log(`[TORRE] ❌ ${candidato.processo}: erro ${e.message}`);
      }
    }

    // Ordena por score DESC, depois valor DESC
    leadsQualificados.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.valor.centavos - a.valor.centavos;
    });

    const custoInfoSimples = consultasInfoSimples * 0.20;

    res.json({
      ok: true,
      tribunal,
      modo,
      filtros: {
        minValor: centavosToBRL(minValor),
        minScore,
        maxIdade: `${maxIdade} dias`
      },
      estatisticas: {
        candidatosDataJud: candidatos.length,
        consultasInfoSimples,
        custoInfoSimples: `R$ ${custoInfoSimples.toFixed(2)}`,
        qualificados: leadsQualificados.length,
        descartados
      },
      leads: leadsQualificados,
      garimpo: leadsGarimpo.length > 0 ? {
        total: leadsGarimpo.length,
        amostra: leadsGarimpo.slice(0, 5),
        mensagem: "Leads antigos (>720 dias). Use modo=garimpo para buscar."
      } : null,
      logs
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e), logs });
  }
});

// ===== GET /api/telefone - Consulta Direct Data =====
app.get("/api/telefone", async (req, res) => {
  try {
    const cpf = req.query.cpf;
    const nome = req.query.nome;

    if (!cpf && !nome) {
      return res.status(400).json({ ok: false, error: "Informe 'cpf' ou 'nome'" });
    }

    if (!DIRECTDATA_TOKEN) {
      return res.json({
        ok: false,
        status: "aguardando_directdata",
        error: "Token Direct Data não configurado"
      });
    }

    const cpfLimpo = cpf ? cpf.replace(/\D/g, '') : '';
    const url = `https://apiv3.directd.com.br/api/CadastroPessoaFisicaPlus?CPF=${cpfLimpo}&TOKEN=${DIRECTDATA_TOKEN}`;
    const response = await fetch(url, { headers: { 'Accept': 'application/json' } });
    const data = await response.json();

    if (data.metaDados?.resultado !== "Sucesso") {
      return res.json({ ok: false, error: data.metaDados?.mensagem || "Erro" });
    }

    const retorno = data.retorno || {};
    const telefones = (retorno.telefones || []).map(t => ({
      numero: t.telefoneComDDD,
      tipo: t.tipoTelefone,
      operadora: t.operadora,
      whatsapp: t.whatsApp,
      bloqueado: t.telemarketingBloqueado
    }));

    const telefonesWhatsApp = telefones.filter(t => t.whatsapp && !t.bloqueado);

    res.json({
      ok: true,
      cpf: retorno.cpf,
      nome: retorno.nome,
      telefones,
      telefonesWhatsApp,
      melhorTelefone: telefonesWhatsApp[0]?.numero || telefones[0]?.numero,
      endereco: (retorno.enderecos || [])[0],
      emails: (retorno.emails || []).map(e => e.enderecoEmail)
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ===== POST /api/pdf - Gera dossiê PDF =====
app.post("/api/pdf", async (req, res) => {
  try {
    const { tribunal, vara, processo, data_ato, pf_nome, valor_brl, tipo_ato, banco_pagador, id_ato, fee_percent, link_pje } = req.body || {};

    if (!processo || !pf_nome) {
      return res.status(400).json({ ok: false, error: "Campos obrigatórios: processo, pf_nome" });
    }

    let qrcodeDataUrl = "";
    const link = link_pje || id_ato || "";
    if (link) {
      try { qrcodeDataUrl = await QRCode.toDataURL(link, { margin: 0 }); } catch {}
    }

    const html = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <title>Dossiê — e-Alvará PF</title>
  <style>
    *{box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Inter,Arial;margin:0;color:#111}
    .wrap{width:760px;margin:40px auto;padding:28px;border:1px solid #111}
    .row{display:flex;justify-content:space-between;gap:16px}
    .muted{color:#444;font-size:12px;letter-spacing:.2px}
    h1{margin:0 0 8px 0;font-size:20px;font-weight:700}
    h2{margin:16px 0 6px;font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:.8px}
    .badge{font-size:28px;font-weight:800;padding:6px 10px;border:1px solid #111;display:inline-block;margin-top:4px}
    .box{border:1px solid #111;padding:12px;margin-top:10px}
    .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
    ul{margin:6px 0 0 18px;padding:0}
    li{margin:4px 0}
    .hr{height:1px;background:#111;margin:16px 0}
    .foot{font-size:11px;line-height:1.45}
    .qr{width:96px;height:96px;border:1px solid #111;display:block}
    .right{text-align:right}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="row">
      <div>
        <div class="muted">TRIBUNAL / VARA</div>
        <h1>${safe(tribunal)} — ${safe(vara)}</h1>
      </div>
      <div class="right">
        <div class="muted">DATA DO ATO</div>
        <div class="mono">${safe(data_ato)}</div>
      </div>
    </div>
    <div class="row" style="margin-top:10px;">
      <div>
        <div class="muted">PROCESSO</div>
        <div class="mono">${safe(processo)}</div>
      </div>
      <div class="right">
        <div class="muted">BENEFICIÁRIO (PF)</div>
        <div class="mono">${safe(pf_nome)}</div>
      </div>
    </div>
    <h2>STATUS</h2>
    <div class="badge">${safe(valor_brl || "VALOR A CONFIRMAR")} | ${safe(tipo_ato || "ALVARÁ")} EXPEDIDO</div>
    <h2>PROVA (VERIFICAÇÃO OFICIAL)</h2>
    <div class="box">
      <div class="row" style="align-items:center;">
        <div style="flex:1;">
          <div class="muted">ID/URL DO ATO</div>
          <div class="mono">${safe(id_ato || link_pje)}</div>
          <div class="hr"></div>
          <div class="muted">Como verificar:</div>
          <ul>
            <li>Acesse o portal do Tribunal</li>
            <li>Confirme a expedição e o nome da PF</li>
          </ul>
        </div>
        <div>
          <img class="qr" src="${qrcodeDataUrl}" alt="QR"/>
          <div class="muted" style="text-align:center;margin-top:4px;">QR do ato</div>
        </div>
      </div>
    </div>
    <h2>LEVANTAMENTO (BB/CEF)</h2>
    <div class="box">
      <div class="muted">Banco pagador</div>
      <div class="mono">${safe(banco_pagador || "BB/CEF")}</div>
      <div class="hr"></div>
      <ul>
        <li>Levar RG/CPF, nº do processo e código do alvará</li>
        <li>Agência com tesouraria/gerência agiliza</li>
        <li>Prazo: 3-7 dias úteis</li>
      </ul>
    </div>
    <h2>REMUNERAÇÃO</h2>
    <div class="box">
      <ul>
        <li>Sem adiantamento. Sem senha. Sem procuração.</li>
        <li>Você só paga <b>${safe(fee_percent || "15")}%</b> após o crédito cair.</li>
      </ul>
    </div>
    <div class="hr"></div>
    <div class="foot">
      TORRE v11.0 — Dossiê PF e-Alvará. Documento informativo.<br/>
      Nunca solicitamos adiantamento. Verifique pelo QR/URL acima.
    </div>
  </div>
</body>
</html>`;

    const fileName = `dossie-${Date.now()}.html`;
    const filePath = path.join(PDF_DIR, fileName);
    await fsp.writeFile(filePath, html, 'utf8');

    res.json({ ok: true, html: `${BASE_URL}/pdf/${fileName}` });

  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ===== Start =====
app.listen(PORT, () => console.log(`TORRE v11.0 rodando na porta ${PORT}`));