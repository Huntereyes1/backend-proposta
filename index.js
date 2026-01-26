// ===== TORRE B2B v12.0 — Sistema de Auditoria de Alvarás para Escritórios =====
// MODELO: Venda de dossiês para escritórios de advocacia trabalhista
// FONTE: DataJud (triagem gratuita) + Escavador V2 (detalhes pagos)

import express from "express";
import cors from "cors";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const EXPORTS_DIR = process.env.EXPORTS_DIR || "/tmp/exports";

// ===== API Keys =====
const DATAJUD_API_KEY = process.env.DATAJUD_API_KEY || "APIKey cDZHYzlZa0JadVREZDJCendQbXY6SkJlTzNjLV9TRENyQk1RdnFKZGRQdw==";
const ESCAVADOR_TOKEN = process.env.ESCAVADOR_TOKEN || "";

// ===== Configurações TORRE B2B =====
const CONFIG = {
  MIN_VALOR_CENTAVOS: Number(process.env.MIN_VALOR || 2000000), // R$ 20.000
  MAX_IDADE_DIAS: Number(process.env.MAX_IDADE_DIAS || 540), // 18 meses
  RATE_LIMIT_ESCAVADOR: 500, // 500 req/min (limite do Escavador)
  DELAY_ENTRE_REQUESTS_MS: 150 // ~400 req/min para ficar seguro
};

// ===== Setup =====
if (!fs.existsSync(EXPORTS_DIR)) fs.mkdirSync(EXPORTS_DIR, { recursive: true });
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "2mb" }));
app.use("/exports", express.static(EXPORTS_DIR));

// ===== DataJud Endpoints (TRTs) =====
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
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

// ===== ESCAVADOR API V2 =====
async function escavadorRequest(endpoint, method = 'GET') {
  if (!ESCAVADOR_TOKEN) {
    throw new Error('ESCAVADOR_TOKEN não configurado');
  }
  
  const url = `https://api.escavador.com/api/v2${endpoint}`;
  const response = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${ESCAVADOR_TOKEN}`,
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'application/json'
    }
  });
  
  // Captura custo no header
  const custoCreditos = response.headers.get('Creditos-Utilizados');
  
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Escavador ${response.status}: ${errorBody}`);
  }
  
  const data = await response.json();
  return { data, custoCreditos };
}

// Busca processo por número CNJ
async function buscarProcessoEscavador(numeroCnj) {
  return escavadorRequest(`/processos/numero_cnj/${encodeURIComponent(numeroCnj)}`);
}

// Busca movimentações do processo
async function buscarMovimentacoesEscavador(numeroCnj) {
  return escavadorRequest(`/processos/numero_cnj/${encodeURIComponent(numeroCnj)}/movimentacoes`);
}

// Busca processos por OAB (para achar escritórios)
async function buscarProcessosPorOAB(numeroOab, estado) {
  return escavadorRequest(`/advogado/processos?numero_oab=${numeroOab}&estado=${estado}`);
}

// ===== DETECTORES =====
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

function detectarAdvogado(texto) {
  if (!texto) return false;
  const lower = texto.toLowerCase();
  const termos = ['advogado', 'patrono', 'honorário', 'sucumbência', 'perito', 'curador', 'procurador'];
  return termos.some(t => lower.includes(t));
}

function detectarBanco(texto) {
  if (!texto) return null;
  const upper = texto.toUpperCase();
  if (/BANCO DO BRASIL|BB\s|\.BB\.|\/BB\/|AGÊNCIA BB|\bBB\b/i.test(upper)) return 'BB';
  if (/CAIXA ECON|CEF\s|\.CEF\.|\/CEF\/|CAIXA FEDERAL|\bCEF\b/i.test(upper)) return 'CEF';
  return null;
}

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

function extrairValor(texto) {
  if (!texto) return null;
  const match = texto.match(/R\$\s*([\d.,]+)/i);
  if (!match) return null;
  const valorStr = match[1].replace(/\./g, '').replace(',', '.');
  const valor = parseFloat(valorStr);
  if (isNaN(valor) || valor <= 0) return null;
  return Math.round(valor * 100);
}

// ===== ANALISAR MOVIMENTAÇÕES ESCAVADOR =====
function analisarMovimentosEscavador(movimentacoes) {
  const resultado = {
    temAlvara: false,
    alvaraExpedido: null,
    dataAlvara: null,
    valorAlvara: null,
    bancoDetectado: null,
    beneficiarioMovimento: null,
    saqueRealizado: false,
    movimentoProva: null
  };

  if (!movimentacoes || !Array.isArray(movimentacoes)) return resultado;

  // Procura por movimentos de alvará (do mais recente ao mais antigo)
  for (const mov of movimentacoes) {
    const conteudo = mov.conteudo || mov.tipo || '';
    const conteudoLower = conteudo.toLowerCase();

    // Verifica se é movimento de alvará
    const ehAlvara = conteudoLower.includes('alvará') || 
                     conteudoLower.includes('levantamento') ||
                     conteudoLower.includes('liberação') ||
                     conteudoLower.includes('expedição');

    if (!ehAlvara) continue;

    // Verifica saque já realizado
    if (detectarSaqueRealizado(conteudo)) {
      resultado.saqueRealizado = true;
      continue;
    }

    // ENCONTROU ALVARÁ!
    resultado.temAlvara = true;
    resultado.alvaraExpedido = conteudo.substring(0, 300);
    resultado.dataAlvara = mov.data;
    resultado.movimentoProva = mov;

    // Extrai valor
    resultado.valorAlvara = extrairValor(conteudo);

    // Detecta banco
    resultado.bancoDetectado = detectarBanco(conteudo);

    // Extrai beneficiário
    const matchBenef = conteudo.match(/(?:a\(o\)|ao?|em favor de)\s+([A-ZÀ-Ú][A-ZÀ-Ú\s.]+)/i);
    if (matchBenef) {
      resultado.beneficiarioMovimento = matchBenef[1].trim();
    }

    break; // Pega o primeiro (mais recente)
  }

  return resultado;
}

// ===== EXTRAIR ADVOGADOS DO PROCESSO =====
function extrairAdvogados(processo) {
  const advogados = [];
  
  if (!processo.fontes) return advogados;

  for (const fonte of processo.fontes) {
    if (!fonte.envolvidos) continue;
    
    for (const env of fonte.envolvidos) {
      const tipo = (env.tipo_normalizado || env.tipo || '').toLowerCase();
      if (tipo.includes('advogado') || tipo.includes('representante')) {
        advogados.push({
          nome: env.nome,
          tipo: env.tipo_normalizado || env.tipo,
          polo: env.polo,
          oab: env.oab || null
        });
      }
    }
  }

  return advogados;
}

// ===== EXTRAIR PARTES DO PROCESSO =====
function extrairPartes(processo) {
  const partes = { poloAtivo: [], poloPassivo: [] };
  
  if (!processo.fontes) return partes;

  for (const fonte of processo.fontes) {
    if (!fonte.envolvidos) continue;
    
    for (const env of fonte.envolvidos) {
      const tipo = (env.tipo_normalizado || env.tipo || '').toLowerCase();
      const polo = (env.polo || '').toLowerCase();
      
      // Ignora advogados
      if (tipo.includes('advogado') || tipo.includes('representante')) continue;
      
      const parte = {
        nome: env.nome,
        tipo: env.tipo_normalizado || env.tipo,
        documento: env.documento || null
      };
      
      if (polo.includes('ativo') || polo.includes('reclamante') || polo.includes('autor')) {
        partes.poloAtivo.push(parte);
      } else if (polo.includes('passivo') || polo.includes('reclamado') || polo.includes('réu')) {
        partes.poloPassivo.push(parte);
      }
    }
  }

  return partes;
}

// ===== Health & Info =====
app.get("/", (_req, res) => res.send("TORRE B2B v12.0 — Sistema de Auditoria de Alvarás para Escritórios"));

app.get("/health", (_req, res) => res.json({ 
  ok: true, 
  version: "12.0-B2B",
  modelo: "Venda de dossiês para escritórios",
  config: CONFIG,
  apis: {
    datajud: "✅ (gratuito)",
    escavador: ESCAVADOR_TOKEN ? "✅" : "❌ Falta ESCAVADOR_TOKEN"
  },
  now: new Date().toISOString() 
}));

app.get("/api/saude", (_req, res) => res.json({
  ok: true,
  version: "12.0-B2B",
  modelo: "Auditoria B2B para escritórios",
  endpoints: [
    "GET /api/minerar?tribunal=TRT1&limite=20 - Mineração de alvarás",
    "GET /api/processo/:numero - Dossiê completo de um processo",
    "GET /api/escritorio?oab=12345&estado=SP - Processos de um advogado",
    "POST /api/dossie-premium - Gera dossiê HTML premium"
  ],
  custos: {
    datajud: "Gratuito",
    escavador_processo: "R$ 0,05",
    escavador_movimentacoes: "R$ 0,05",
    escavador_por_oab: "R$ 4,50 até 200 processos"
  },
  tribunaisDisponiveis: Object.keys(DATAJUD_ENDPOINTS),
  now: new Date().toISOString()
}));

// ===== GET /api/minerar — Mineração de Alvarás (DataJud GRATUITO) =====
app.get("/api/minerar", async (req, res) => {
  const logs = [];
  const log = (msg) => { console.log(msg); logs.push(msg); };

  try {
    const tribunal = (req.query.tribunal || "TRT1").toUpperCase();
    const limite = Math.min(Number(req.query.limite) || 50, 200);
    const pagina = Number(req.query.pagina) || 0;

    log(`[MINERAR] Buscando candidatos no ${tribunal}, limite ${limite}, página ${pagina}...`);

    const endpoint = DATAJUD_ENDPOINTS[tribunal];
    if (!endpoint) {
      return res.status(400).json({ ok: false, error: `Tribunal ${tribunal} não suportado` });
    }

    // Query DataJud para processos com movimento de alvará
    const query = {
      size: limite,
      from: pagina * limite,
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
      headers: { 
        'Content-Type': 'application/json', 
        'Authorization': DATAJUD_API_KEY 
      },
      body: JSON.stringify(query)
    });

    const datajudData = await datajudResponse.json();
    const hits = datajudData.hits?.hits || [];
    const total = datajudData.hits?.total?.value || 0;

    log(`[MINERAR] DataJud retornou ${hits.length} de ${total} total`);

    // Processa candidatos
    const candidatos = [];
    
    for (const hit of hits) {
      const src = hit._source;
      const processoNum = formatarProcessoCNJ(src.numeroProcesso);
      
      // Extrai partes do DataJud
      const movimentos = src.movimentos || [];
      const poloAtivo = [];
      const advogados = [];
      
      // Procura alvará nos movimentos
      let temAlvaraDataJud = false;
      let movimentoAlvara = null;
      
      for (const mov of movimentos) {
        const nome = (mov.nome || '').toLowerCase();
        if (nome.includes('alvará') || nome.includes('levantamento')) {
          temAlvaraDataJud = true;
          movimentoAlvara = mov;
          break;
        }
      }
      
      // Idade do último movimento
      const dataUltMov = src.dataHoraUltimaAtualizacao;
      const idadeDias = calcularIdadeDias(dataUltMov);

      candidatos.push({
        processo: processoNum,
        tribunal: src.tribunal || tribunal,
        grau: src.grau,
        vara: src.orgaoJulgador?.nome,
        classe: src.classe?.nome,
        assuntos: (src.assuntos || []).map(a => a.nome),
        dataUltimaAtualizacao: dataUltMov,
        idadeDias,
        temAlvaraDataJud,
        movimentoAlvara: movimentoAlvara ? {
          nome: movimentoAlvara.nome,
          data: movimentoAlvara.dataHora
        } : null,
        // Links para verificação manual
        links: {
          pje: `https://pje.trt${tribunal.replace('TRT', '')}.jus.br/consultaprocessual/detalhe-processo/${src.numeroProcesso}`,
          datajud: `https://datajud-wiki.cnj.jus.br/`
        }
      });
    }

    // Custo: ZERO (DataJud é gratuito)
    res.json({
      ok: true,
      tribunal,
      fonte: "DataJud (GRATUITO)",
      custoAPI: "R$ 0,00",
      paginacao: {
        pagina,
        limite,
        retornados: candidatos.length,
        totalDisponivel: total
      },
      candidatos,
      proximoEndpoint: candidatos.length > 0 
        ? `/api/processo/${candidatos[0].processo}` 
        : null,
      instrucao: "Use /api/processo/{numero} para obter dossiê completo (custo: R$ 0,10 no Escavador)",
      logs
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e), logs });
  }
});

// ===== GET /api/processo/:numero — Dossiê Completo (Escavador PAGO) =====
app.get("/api/processo/:numero", async (req, res) => {
  const logs = [];
  const log = (msg) => { console.log(msg); logs.push(msg); };

  try {
    const numeroCnj = req.params.numero;
    log(`[DOSSIE] Buscando processo ${numeroCnj}...`);

    if (!ESCAVADOR_TOKEN) {
      return res.status(400).json({ 
        ok: false, 
        error: "ESCAVADOR_TOKEN não configurado. Adicione no Railway." 
      });
    }

    // 1. Busca dados do processo
    log(`[DOSSIE] Consultando Escavador - processo...`);
    const { data: processo, custoCreditos: custo1 } = await buscarProcessoEscavador(numeroCnj);
    await sleep(CONFIG.DELAY_ENTRE_REQUESTS_MS);

    // 2. Busca movimentações
    log(`[DOSSIE] Consultando Escavador - movimentações...`);
    const { data: movData, custoCreditos: custo2 } = await buscarMovimentacoesEscavador(numeroCnj);
    const movimentacoes = movData.items || movData.movimentacoes || movData || [];

    // 3. Analisa movimentos para achar alvará
    const analiseAlvara = analisarMovimentosEscavador(movimentacoes);

    // 4. Extrai advogados e partes
    const advogados = extrairAdvogados(processo);
    const partes = extrairPartes(processo);

    // 5. Filtra apenas PFs no polo ativo
    const beneficiariosPF = partes.poloAtivo.filter(p => !detectarPJ(p.nome));

    // 6. Monta dossiê
    const dossie = {
      processo: numeroCnj,
      tribunal: processo.tribunal,
      fonte: processo.fontes?.[0]?.nome || "Escavador",
      dataUltimaVerificacao: processo.data_ultima_verificacao,
      
      // Dados da capa
      capa: {
        classe: processo.classe,
        assuntos: processo.assuntos,
        valorCausa: processo.valor_causa,
        dataInicio: processo.data_inicio,
        dataUltimaMovimentacao: processo.data_ultima_movimentacao,
        situacao: processo.situacao
      },

      // Alvará
      alvara: {
        encontrado: analiseAlvara.temAlvara,
        expedido: analiseAlvara.alvaraExpedido,
        data: analiseAlvara.dataAlvara,
        valor: analiseAlvara.valorAlvara ? centavosToBRL(analiseAlvara.valorAlvara) : null,
        valorCentavos: analiseAlvara.valorAlvara,
        banco: analiseAlvara.bancoDetectado,
        beneficiarioNoMovimento: analiseAlvara.beneficiarioMovimento,
        saqueRealizado: analiseAlvara.saqueRealizado,
        movimentoProva: analiseAlvara.movimentoProva
      },

      // Partes
      poloAtivo: partes.poloAtivo,
      poloPassivo: partes.poloPassivo,
      beneficiariosPF,

      // Advogados (IMPORTANTE para B2B)
      advogados,
      advogadoResponsavel: advogados.find(a => a.polo?.toLowerCase().includes('ativo')) || advogados[0],

      // Métricas
      totalMovimentacoes: movimentacoes.length,
      custoConsulta: {
        processo: custo1 || "~5 centavos",
        movimentacoes: custo2 || "~5 centavos",
        total: "~R$ 0,10"
      },

      // Links
      links: {
        escavador: `https://www.escavador.com/processos/${numeroCnj}`,
        pje: processo.fontes?.[0]?.url || null
      },

      // Status para venda
      vendavel: analiseAlvara.temAlvara && !analiseAlvara.saqueRealizado && beneficiariosPF.length > 0,
      motivoNaoVendavel: !analiseAlvara.temAlvara 
        ? "Alvará não encontrado" 
        : analiseAlvara.saqueRealizado 
          ? "Saque já realizado" 
          : beneficiariosPF.length === 0 
            ? "Sem beneficiário PF" 
            : null
    };

    log(`[DOSSIE] ✅ Concluído. Alvará: ${dossie.alvara.encontrado}, Vendável: ${dossie.vendavel}`);

    res.json({
      ok: true,
      dossie,
      logs
    });

  } catch (e) {
    log(`[DOSSIE] ❌ Erro: ${e.message}`);
    res.status(500).json({ ok: false, error: String(e?.message || e), logs });
  }
});

// ===== GET /api/escritorio — Busca processos por OAB =====
app.get("/api/escritorio", async (req, res) => {
  const logs = [];
  const log = (msg) => { console.log(msg); logs.push(msg); };

  try {
    const { oab, estado } = req.query;
    
    if (!oab || !estado) {
      return res.status(400).json({ 
        ok: false, 
        error: "Parâmetros obrigatórios: oab, estado (ex: ?oab=12345&estado=SP)" 
      });
    }

    if (!ESCAVADOR_TOKEN) {
      return res.status(400).json({ 
        ok: false, 
        error: "ESCAVADOR_TOKEN não configurado" 
      });
    }

    log(`[ESCRITORIO] Buscando processos do advogado OAB ${estado} ${oab}...`);

    const { data, custoCreditos } = await buscarProcessosPorOAB(oab, estado.toUpperCase());

    // Processa resposta
    const advogado = data.advogado || {};
    const processos = data.items || data.processos || [];

    log(`[ESCRITORIO] Encontrados ${processos.length} processos`);

    res.json({
      ok: true,
      advogado: {
        nome: advogado.nome,
        oab: `${estado.toUpperCase()} ${oab}`,
        quantidadeProcessos: advogado.quantidade_processos || processos.length
      },
      processos: processos.slice(0, 50).map(p => ({
        numeroCnj: p.numero_cnj,
        titulo: p.titulo_polo_ativo ? `${p.titulo_polo_ativo} x ${p.titulo_polo_passivo}` : null,
        tribunal: p.tribunal,
        dataInicio: p.data_inicio,
        dataUltimaMovimentacao: p.data_ultima_movimentacao
      })),
      totalProcessos: processos.length,
      custoConsulta: custoCreditos || "~R$ 4,50",
      proximoPasso: "Use /api/processo/{numero} para verificar alvará em cada processo",
      logs
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e), logs });
  }
});

// ===== POST /api/dossie-premium — Gera HTML premium para venda =====
app.post("/api/dossie-premium", async (req, res) => {
  try {
    const { 
      processo, 
      tribunal, 
      vara, 
      dataAlvara,
      valorBRL, 
      beneficiario, 
      advogado,
      banco,
      movimentoProva,
      linkPJE
    } = req.body || {};

    if (!processo) {
      return res.status(400).json({ ok: false, error: "Campo obrigatório: processo" });
    }

    const dataGeracao = new Date().toLocaleDateString('pt-BR');

    const html = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Dossiê Premium — TORRE Data</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Inter', sans-serif;
      background: #f8fafc;
      color: #1e293b;
      line-height: 1.6;
    }
    .container {
      max-width: 800px;
      margin: 40px auto;
      background: white;
      border-radius: 16px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.08);
      overflow: hidden;
    }
    .header {
      background: linear-gradient(135deg, #1e40af 0%, #3b82f6 100%);
      color: white;
      padding: 32px;
    }
    .header h1 {
      font-size: 28px;
      font-weight: 700;
      margin-bottom: 8px;
    }
    .header .subtitle {
      opacity: 0.9;
      font-size: 14px;
    }
    .badge {
      display: inline-block;
      background: #22c55e;
      color: white;
      padding: 8px 16px;
      border-radius: 24px;
      font-weight: 600;
      font-size: 14px;
      margin-top: 16px;
    }
    .badge.warning { background: #f59e0b; }
    .content { padding: 32px; }
    .section {
      margin-bottom: 32px;
    }
    .section-title {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #64748b;
      margin-bottom: 12px;
    }
    .info-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }
    .info-item {
      background: #f8fafc;
      padding: 16px;
      border-radius: 8px;
    }
    .info-label {
      font-size: 12px;
      color: #64748b;
      margin-bottom: 4px;
    }
    .info-value {
      font-size: 16px;
      font-weight: 600;
      color: #1e293b;
    }
    .info-value.large {
      font-size: 24px;
      color: #22c55e;
    }
    .proof-box {
      background: #fffbeb;
      border: 1px solid #fbbf24;
      border-radius: 8px;
      padding: 16px;
    }
    .proof-box .label {
      font-size: 12px;
      font-weight: 600;
      color: #92400e;
      margin-bottom: 8px;
    }
    .proof-box .text {
      font-family: monospace;
      font-size: 13px;
      color: #78350f;
      word-break: break-word;
    }
    .cta {
      background: #f0f9ff;
      border: 1px solid #bae6fd;
      border-radius: 8px;
      padding: 24px;
      text-align: center;
    }
    .cta h3 {
      color: #0369a1;
      margin-bottom: 8px;
    }
    .cta p {
      color: #64748b;
      font-size: 14px;
    }
    .footer {
      background: #f8fafc;
      padding: 24px 32px;
      font-size: 12px;
      color: #94a3b8;
      text-align: center;
    }
    .link {
      color: #3b82f6;
      text-decoration: none;
    }
    .link:hover { text-decoration: underline; }
    @media (max-width: 600px) {
      .info-grid { grid-template-columns: 1fr; }
      .container { margin: 16px; border-radius: 12px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>ALVARÁ IDENTIFICADO</h1>
      <div class="subtitle">Dossiê Premium — Auditoria TORRE Data</div>
      <div class="badge">✓ CRÉDITO DISPONÍVEL PARA SAQUE</div>
    </div>
    
    <div class="content">
      <div class="section">
        <div class="section-title">Valor Liberado</div>
        <div class="info-item" style="background: #f0fdf4; text-align: center; padding: 24px;">
          <div class="info-value large">${safe(valorBRL) || "Valor a confirmar"}</div>
          <div class="info-label" style="margin-top: 8px;">Crédito expedido pelo tribunal</div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">Dados do Processo</div>
        <div class="info-grid">
          <div class="info-item">
            <div class="info-label">Processo</div>
            <div class="info-value">${safe(processo)}</div>
          </div>
          <div class="info-item">
            <div class="info-label">Tribunal / Vara</div>
            <div class="info-value">${safe(tribunal)} — ${safe(vara) || "Ver detalhes"}</div>
          </div>
          <div class="info-item">
            <div class="info-label">Beneficiário</div>
            <div class="info-value">${safe(beneficiario) || "Ver autos"}</div>
          </div>
          <div class="info-item">
            <div class="info-label">Data do Alvará</div>
            <div class="info-value">${safe(dataAlvara) || "Recente"}</div>
          </div>
          <div class="info-item">
            <div class="info-label">Advogado Responsável</div>
            <div class="info-value">${safe(advogado) || "Verificar processo"}</div>
          </div>
          <div class="info-item">
            <div class="info-label">Banco Pagador</div>
            <div class="info-value">${safe(banco) || "BB / CEF"}</div>
          </div>
        </div>
      </div>

      ${movimentoProva ? `
      <div class="section">
        <div class="section-title">Prova Documental</div>
        <div class="proof-box">
          <div class="label">Movimento oficial extraído do tribunal:</div>
          <div class="text">${safe(movimentoProva)}</div>
        </div>
      </div>
      ` : ''}

      <div class="section">
        <div class="section-title">Links de Verificação</div>
        ${linkPJE ? `<p><a href="${safe(linkPJE)}" target="_blank" class="link">🔗 Abrir no PJe do Tribunal</a></p>` : ''}
        <p><a href="https://www.escavador.com/processos/${safe(processo)}" target="_blank" class="link">🔗 Ver no Escavador</a></p>
      </div>

      <div class="cta">
        <h3>💼 Este crédito pertence ao seu cliente</h3>
        <p>O alvará foi expedido e aguarda saque. Entre em contato com o beneficiário para regularizar o levantamento.</p>
      </div>
    </div>

    <div class="footer">
      Dossiê gerado em ${dataGeracao} por TORRE Data — Sistema de Auditoria de Créditos Trabalhistas<br>
      Dados extraídos de fontes públicas oficiais (DataJud / PJe / Escavador)
    </div>
  </div>
</body>
</html>`;

    const fileName = `dossie-${processo.replace(/\D/g, '')}-${Date.now()}.html`;
    const filePath = path.join(EXPORTS_DIR, fileName);
    await fsp.writeFile(filePath, html, 'utf8');

    res.json({ 
      ok: true, 
      url: `${BASE_URL}/exports/${fileName}`,
      arquivo: fileName
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ===== GET /api/pipeline — Pipeline completo: minerar + validar =====
app.get("/api/pipeline", async (req, res) => {
  const logs = [];
  const log = (msg) => { console.log(msg); logs.push(msg); };

  try {
    const tribunal = (req.query.tribunal || "TRT1").toUpperCase();
    const limite = Math.min(Number(req.query.limite) || 10, 30);
    const validar = req.query.validar !== 'false'; // Por padrão valida no Escavador

    log(`[PIPELINE] Iniciando para ${tribunal}, limite ${limite}, validar=${validar}`);

    if (validar && !ESCAVADOR_TOKEN) {
      return res.status(400).json({ 
        ok: false, 
        error: "ESCAVADOR_TOKEN necessário para validação. Use validar=false para só minerar." 
      });
    }

    // 1. Minera candidatos no DataJud (gratuito)
    const endpoint = DATAJUD_ENDPOINTS[tribunal];
    const query = {
      size: limite * 3, // Pega mais para compensar descartes
      query: {
        bool: {
          should: [
            { match: { "movimentos.nome": "alvará" } },
            { match: { "movimentos.nome": "levantamento" } },
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
    const candidatos = (datajudData.hits?.hits || []).map(h => formatarProcessoCNJ(h._source.numeroProcesso));
    
    log(`[PIPELINE] DataJud: ${candidatos.length} candidatos`);

    if (!validar) {
      return res.json({
        ok: true,
        etapa: "mineracao",
        tribunal,
        candidatos,
        custoTotal: "R$ 0,00 (só DataJud)"
      });
    }

    // 2. Valida cada candidato no Escavador
    const leadsValidos = [];
    const descartados = [];
    let custoEscavador = 0;

    for (const processo of candidatos.slice(0, limite)) {
      try {
        log(`[PIPELINE] Validando ${processo}...`);
        
        // Busca movimentações
        const { data: movData } = await buscarMovimentacoesEscavador(processo);
        custoEscavador += 0.05;
        
        const movimentacoes = movData.items || movData.movimentacoes || movData || [];
        const analise = analisarMovimentosEscavador(movimentacoes);
        
        await sleep(CONFIG.DELAY_ENTRE_REQUESTS_MS);

        if (!analise.temAlvara) {
          descartados.push({ processo, motivo: "Sem alvará" });
          continue;
        }

        if (analise.saqueRealizado) {
          descartados.push({ processo, motivo: "Saque já realizado" });
          continue;
        }

        // Busca dados completos
        const { data: processoData } = await buscarProcessoEscavador(processo);
        custoEscavador += 0.05;
        
        const advogados = extrairAdvogados(processoData);
        const partes = extrairPartes(processoData);
        
        await sleep(CONFIG.DELAY_ENTRE_REQUESTS_MS);

        leadsValidos.push({
          processo,
          alvara: {
            valor: analise.valorAlvara ? centavosToBRL(analise.valorAlvara) : "A confirmar",
            data: analise.dataAlvara,
            banco: analise.bancoDetectado
          },
          advogadoResponsavel: advogados[0] || null,
          beneficiariosPF: partes.poloAtivo.filter(p => !detectarPJ(p.nome)),
          linkEscavador: `https://www.escavador.com/processos/${processo}`
        });

        log(`[PIPELINE] ✅ ${processo}: alvará ${analise.valorAlvara ? centavosToBRL(analise.valorAlvara) : 'valor a confirmar'}`);

      } catch (e) {
        descartados.push({ processo, motivo: `Erro: ${e.message}` });
      }
    }

    res.json({
      ok: true,
      tribunal,
      leadsValidos,
      quantidadeValidos: leadsValidos.length,
      descartados,
      quantidadeDescartados: descartados.length,
      custos: {
        datajud: "R$ 0,00",
        escavador: `R$ ${custoEscavador.toFixed(2)}`,
        total: `R$ ${custoEscavador.toFixed(2)}`
      },
      logs
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e), logs });
  }
});

// ===== Start =====
app.listen(PORT, () => {
  console.log(`TORRE B2B v12.0 rodando na porta ${PORT}`);
  console.log(`APIs configuradas: DataJud ✅ | Escavador ${ESCAVADOR_TOKEN ? '✅' : '❌'}`);
});