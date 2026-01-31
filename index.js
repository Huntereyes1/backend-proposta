// ===== TORRE v13.0 — Sistema DataJud + PJe Manual =====
// MODELO: Mineração gratuita + enriquecimento manual no PJe
// ZERO dependência de APIs pagas (Escavador/InfoSimples)

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

// ===== DataJud API Key (pública do CNJ) =====
const DATAJUD_API_KEY = "APIKey cDZHYzlZa0JadVREZDJCendQbXY6SkJlTzNjLV9TRENyQk1RdnFKZGRQdw==";

// ===== Configurações =====
const CONFIG = {
  MAX_IDADE_DIAS: Number(process.env.MAX_IDADE_DIAS || 180), // 6 meses
  RESULTADOS_POR_PAGINA: 100
};

// ===== Setup =====
if (!fs.existsSync(EXPORTS_DIR)) fs.mkdirSync(EXPORTS_DIR, { recursive: true });
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "2mb" }));
app.use("/exports", express.static(EXPORTS_DIR));

// ===== DataJud Endpoints (TRTs) =====
const DATAJUD_ENDPOINTS = {
  TRT1:  { url: "https://api-publica.datajud.cnj.jus.br/api_publica_trt1/_search",  pje: "https://pje.trt1.jus.br/consultaprocessual/detalhe-processo/",  estado: "RJ" },
  TRT2:  { url: "https://api-publica.datajud.cnj.jus.br/api_publica_trt2/_search",  pje: "https://pje.trt2.jus.br/consultaprocessual/detalhe-processo/",  estado: "SP (Capital)" },
  TRT3:  { url: "https://api-publica.datajud.cnj.jus.br/api_publica_trt3/_search",  pje: "https://pje.trt3.jus.br/consultaprocessual/detalhe-processo/",  estado: "MG" },
  TRT4:  { url: "https://api-publica.datajud.cnj.jus.br/api_publica_trt4/_search",  pje: "https://pje.trt4.jus.br/consultaprocessual/detalhe-processo/",  estado: "RS" },
  TRT5:  { url: "https://api-publica.datajud.cnj.jus.br/api_publica_trt5/_search",  pje: "https://pje.trt5.jus.br/consultaprocessual/detalhe-processo/",  estado: "BA" },
  TRT6:  { url: "https://api-publica.datajud.cnj.jus.br/api_publica_trt6/_search",  pje: "https://pje.trt6.jus.br/consultaprocessual/detalhe-processo/",  estado: "PE" },
  TRT7:  { url: "https://api-publica.datajud.cnj.jus.br/api_publica_trt7/_search",  pje: "https://pje.trt7.jus.br/consultaprocessual/detalhe-processo/",  estado: "CE" },
  TRT8:  { url: "https://api-publica.datajud.cnj.jus.br/api_publica_trt8/_search",  pje: "https://pje.trt8.jus.br/consultaprocessual/detalhe-processo/",  estado: "PA/AP" },
  TRT9:  { url: "https://api-publica.datajud.cnj.jus.br/api_publica_trt9/_search",  pje: "https://pje.trt9.jus.br/consultaprocessual/detalhe-processo/",  estado: "PR" },
  TRT10: { url: "https://api-publica.datajud.cnj.jus.br/api_publica_trt10/_search", pje: "https://pje.trt10.jus.br/consultaprocessual/detalhe-processo/", estado: "DF/TO" },
  TRT11: { url: "https://api-publica.datajud.cnj.jus.br/api_publica_trt11/_search", pje: "https://pje.trt11.jus.br/consultaprocessual/detalhe-processo/", estado: "AM/RR" },
  TRT12: { url: "https://api-publica.datajud.cnj.jus.br/api_publica_trt12/_search", pje: "https://pje.trt12.jus.br/consultaprocessual/detalhe-processo/", estado: "SC" },
  TRT13: { url: "https://api-publica.datajud.cnj.jus.br/api_publica_trt13/_search", pje: "https://pje.trt13.jus.br/consultaprocessual/detalhe-processo/", estado: "PB" },
  TRT14: { url: "https://api-publica.datajud.cnj.jus.br/api_publica_trt14/_search", pje: "https://pje.trt14.jus.br/consultaprocessual/detalhe-processo/", estado: "RO/AC" },
  TRT15: { url: "https://api-publica.datajud.cnj.jus.br/api_publica_trt15/_search", pje: "https://pje.trt15.jus.br/consultaprocessual/detalhe-processo/", estado: "SP (Interior)" },
  TRT16: { url: "https://api-publica.datajud.cnj.jus.br/api_publica_trt16/_search", pje: "https://pje.trt16.jus.br/consultaprocessual/detalhe-processo/", estado: "MA" },
  TRT17: { url: "https://api-publica.datajud.cnj.jus.br/api_publica_trt17/_search", pje: "https://pje.trt17.jus.br/consultaprocessual/detalhe-processo/", estado: "ES" },
  TRT18: { url: "https://api-publica.datajud.cnj.jus.br/api_publica_trt18/_search", pje: "https://pje.trt18.jus.br/consultaprocessual/detalhe-processo/", estado: "GO" },
  TRT19: { url: "https://api-publica.datajud.cnj.jus.br/api_publica_trt19/_search", pje: "https://pje.trt19.jus.br/consultaprocessual/detalhe-processo/", estado: "AL" },
  TRT20: { url: "https://api-publica.datajud.cnj.jus.br/api_publica_trt20/_search", pje: "https://pje.trt20.jus.br/consultaprocessual/detalhe-processo/", estado: "SE" },
  TRT21: { url: "https://api-publica.datajud.cnj.jus.br/api_publica_trt21/_search", pje: "https://pje.trt21.jus.br/consultaprocessual/detalhe-processo/", estado: "RN" },
  TRT22: { url: "https://api-publica.datajud.cnj.jus.br/api_publica_trt22/_search", pje: "https://pje.trt22.jus.br/consultaprocessual/detalhe-processo/", estado: "PI" },
  TRT23: { url: "https://api-publica.datajud.cnj.jus.br/api_publica_trt23/_search", pje: "https://pje.trt23.jus.br/consultaprocessual/detalhe-processo/", estado: "MT" },
  TRT24: { url: "https://api-publica.datajud.cnj.jus.br/api_publica_trt24/_search", pje: "https://pje.trt24.jus.br/consultaprocessual/detalhe-processo/", estado: "MS" },
};

// ===== Utils =====
const formatarProcessoCNJ = (num) => {
  const n = String(num).replace(/\D/g, '').padStart(20, '0');
  return `${n.slice(0,7)}-${n.slice(7,9)}.${n.slice(9,13)}.${n.slice(13,14)}.${n.slice(14,16)}.${n.slice(16,20)}`;
};

const processoSemFormatacao = (num) => String(num).replace(/\D/g, '');

const calcularIdadeDias = (dataStr) => {
  if (!dataStr) return null;
  const data = new Date(dataStr);
  if (isNaN(data.getTime())) return null;
  return Math.floor((new Date() - data) / (1000 * 60 * 60 * 24));
};

const formatarData = (dataStr) => {
  if (!dataStr) return null;
  const data = new Date(dataStr);
  if (isNaN(data.getTime())) return null;
  return data.toLocaleDateString('pt-BR');
};

const safe = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ===== DETECTAR MOVIMENTO DE ALVARÁ =====
function analisarMovimentosDataJud(movimentos) {
  if (!movimentos || !Array.isArray(movimentos)) {
    return { temAlvara: false, movimento: null };
  }

  // Palavras-chave de alvará (AMPLIADAS)
  const palavrasAlvara = [
    'alvará', 'alvara',
    'expedição', 'expedicao',
    'liberação', 'liberacao',
    'levantamento',
    'pagamento',
    'rpv', 'precatório', 'precatorio',
    'expedido', 
    'valor', 'valores',
    'crédito', 'credito',
    'depósito', 'deposito',
    'guia de levantamento',
    'ordem de pagamento'
  ];

  // Palavras que indicam saque já feito (descarta) - SÓ descarta se CERTEZA
  const palavrasSaqueConfirmado = [
    'alvará cumprido',
    'levantamento efetuado',
    'valor sacado',
    'quitação total',
    'pagamento realizado ao'
  ];

  // Procura movimento de alvará (mais recente primeiro)
  const movimentosOrdenados = [...movimentos].sort((a, b) => {
    const dataA = new Date(a.dataHora || 0);
    const dataB = new Date(b.dataHora || 0);
    return dataB - dataA;
  });

  for (const mov of movimentosOrdenados) {
    const nome = (mov.nome || '').toLowerCase();
    const complementos = mov.complementosTabelados || [];
    const complementoTexto = complementos.map(c => (c.nome || '').toLowerCase()).join(' ');
    const textoCompleto = `${nome} ${complementoTexto}`;

    // Verifica se já foi sacado COM CERTEZA
    const jaSacadoConfirmado = palavrasSaqueConfirmado.some(p => textoCompleto.includes(p));
    if (jaSacadoConfirmado) continue;

    // Verifica se é movimento de alvará/liberação (MAIS PERMISSIVO)
    const ehAlvara = palavrasAlvara.some(p => textoCompleto.includes(p));
    if (!ehAlvara) continue;

    // ENCONTROU POSSÍVEL ALVARÁ!
    return {
      temAlvara: true,
      movimento: {
        nome: mov.nome,
        data: mov.dataHora,
        dataFormatada: formatarData(mov.dataHora),
        complementos: complementos.map(c => c.nome)
      }
    };
  }

  return { temAlvara: false, movimento: null };
}

// ===== Health & Info =====
app.get("/", (_req, res) => res.send("TORRE v13.0 — DataJud + PJe Manual (100% Gratuito)"));

app.get("/health", (_req, res) => res.json({ 
  ok: true, 
  version: "13.0",
  modelo: "DataJud (grátis) + PJe (manual)",
  custoAPI: "R$ 0,00",
  tribunaisDisponiveis: Object.keys(DATAJUD_ENDPOINTS).length,
  now: new Date().toISOString() 
}));

app.get("/api/saude", (_req, res) => res.json({
  ok: true,
  version: "13.0",
  modelo: "Mineração gratuita + enriquecimento manual",
  fluxo: [
    "1. GET /api/minerar?tribunal=TRT1 → Lista processos com alvará",
    "2. Abra o link PJe de cada processo",
    "3. Copie: nome advogado, OAB, escritório",
    "4. POST /api/lead → Salve o lead enriquecido",
    "5. GET /api/leads → Exporte seus leads",
    "6. POST /api/pitch → Gere mensagem de pitch"
  ],
  endpoints: {
    mineracao: "GET /api/minerar?tribunal=TRT1&limite=50",
    tribunais: "GET /api/tribunais",
    salvarLead: "POST /api/lead",
    listarLeads: "GET /api/leads",
    exportarCSV: "GET /api/leads/csv",
    gerarPitch: "POST /api/pitch",
    gerarDossie: "POST /api/dossie"
  },
  tribunais: Object.entries(DATAJUD_ENDPOINTS).map(([k, v]) => ({ tribunal: k, estado: v.estado })),
  now: new Date().toISOString()
}));

// ===== GET /api/tribunais — Lista tribunais disponíveis =====
app.get("/api/tribunais", (_req, res) => {
  const tribunais = Object.entries(DATAJUD_ENDPOINTS).map(([codigo, info]) => ({
    codigo,
    estado: info.estado,
    urlPJe: info.pje
  }));
  res.json({ ok: true, tribunais });
});

// ===== GET /api/minerar — Mineração de Alvarás (GRATUITO) =====
app.get("/api/minerar", async (req, res) => {
  const logs = [];
  const log = (msg) => { console.log(msg); logs.push(msg); };

  try {
    const tribunal = (req.query.tribunal || "TRT1").toUpperCase();
    const limite = Math.min(Number(req.query.limite) || 50, 200);
    const maxIdade = Number(req.query.maxIdade) || CONFIG.MAX_IDADE_DIAS;
    const pagina = Number(req.query.pagina) || 0;

    log(`[MINERAR] ${tribunal} | limite ${limite} | maxIdade ${maxIdade} dias | página ${pagina}`);

    const tribunalInfo = DATAJUD_ENDPOINTS[tribunal];
    if (!tribunalInfo) {
      return res.status(400).json({ 
        ok: false, 
        error: `Tribunal ${tribunal} não suportado`,
        tribunaisDisponiveis: Object.keys(DATAJUD_ENDPOINTS)
      });
    }

    // Query DataJud - busca processos com movimento de alvará
    const query = {
      size: limite,
      from: pagina * limite,
      query: {
        bool: {
          should: [
            { match_phrase: { "movimentos.nome": "alvará" } },
            { match_phrase: { "movimentos.nome": "expedição de alvará" } },
            { match_phrase: { "movimentos.nome": "levantamento" } },
            { match_phrase: { "movimentos.nome": "liberação de valores" } },
            { match: { "movimentos.complementosTabelados.nome": "Alvará" } },
          ],
          minimum_should_match: 1
        }
      },
      sort: [{ "dataHoraUltimaAtualizacao": { order: "desc" } }]
    };

    const response = await fetch(tribunalInfo.url, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json', 
        'Authorization': DATAJUD_API_KEY 
      },
      body: JSON.stringify(query)
    });

    if (!response.ok) {
      throw new Error(`DataJud retornou ${response.status}`);
    }

    const data = await response.json();
    const hits = data.hits?.hits || [];
    const total = data.hits?.total?.value || 0;

    log(`[MINERAR] DataJud retornou ${hits.length} de ${total} total`);

    // Processa resultados
    const leads = [];
    let descartadosIdade = 0;
    let descartadosSemAlvara = 0;

    for (const hit of hits) {
      const src = hit._source;
      const processoNum = formatarProcessoCNJ(src.numeroProcesso);
      const processoLimpo = processoSemFormatacao(src.numeroProcesso);

      // Analisa movimentos
      const analise = analisarMovimentosDataJud(src.movimentos);

      // Filtra por idade
      const idadeDias = calcularIdadeDias(src.dataHoraUltimaAtualizacao);
      if (idadeDias !== null && idadeDias > maxIdade) {
        descartadosIdade++;
        continue;
      }

      // Filtra só com alvará confirmado
      if (!analise.temAlvara) {
        descartadosSemAlvara++;
        continue;
      }

      leads.push({
        // Identificação
        processo: processoNum,
        processoLimpo,
        tribunal,
        estado: tribunalInfo.estado,
        
        // Vara/Órgão
        vara: src.orgaoJulgador?.nome || null,
        codigoVara: src.orgaoJulgador?.codigo || null,
        grau: src.grau,
        
        // Classe/Assunto
        classe: src.classe?.nome || null,
        assuntos: (src.assuntos || []).slice(0, 3).map(a => a.nome),
        
        // Datas
        dataAjuizamento: formatarData(src.dataAjuizamento),
        dataUltimaAtualizacao: formatarData(src.dataHoraUltimaAtualizacao),
        idadeDias,
        
        // Alvará
        alvara: {
          confirmado: true,
          movimento: analise.movimento?.nome,
          data: analise.movimento?.dataFormatada,
          complementos: analise.movimento?.complementos
        },
        
        // Links (IMPORTANTE!)
        links: {
          pje: `${tribunalInfo.pje}${processoLimpo}`,
          pjeAlternativo: `https://pje.trt${tribunal.replace('TRT', '')}.jus.br/primeirograu/Processo/ConsultaProcesso/listView.seam?numeroProcesso=${processoNum}`
        },
        
        // Campos para preencher manualmente
        enriquecimento: {
          advogadoNome: null,
          advogadoOAB: null,
          escritorio: null,
          beneficiarioNome: null,
          valorAlvara: null,
          telefone: null,
          email: null,
          observacoes: null
        },
        
        // Status
        status: "pendente_enriquecimento"
      });
    }

    // Ordena por mais recente
    leads.sort((a, b) => (a.idadeDias || 999) - (b.idadeDias || 999));

    log(`[MINERAR] ✅ ${leads.length} leads válidos | ${descartadosIdade} muito antigos | ${descartadosSemAlvara} sem alvará confirmado`);

    res.json({
      ok: true,
      tribunal,
      estado: tribunalInfo.estado,
      custoAPI: "R$ 0,00 (GRÁTIS)",
      
      estatisticas: {
        totalDataJud: total,
        retornados: hits.length,
        leadsValidos: leads.length,
        descartadosIdade,
        descartadosSemAlvara
      },
      
      paginacao: {
        pagina,
        limite,
        temMais: (pagina + 1) * limite < total
      },
      
      instrucoes: {
        passo1: "Abra o link PJe de cada lead",
        passo2: "Copie: nome do advogado, OAB, nome do beneficiário",
        passo3: "Use POST /api/lead para salvar o lead enriquecido",
        passo4: "Use POST /api/pitch para gerar mensagem de abordagem"
      },
      
      leads,
      logs
    });

  } catch (e) {
    log(`[MINERAR] ❌ Erro: ${e.message}`);
    res.status(500).json({ ok: false, error: String(e?.message || e), logs });
  }
});

// ===== Armazenamento de leads (em memória - para MVP) =====
const leadsDB = new Map();

// ===== POST /api/lead — Salvar lead enriquecido =====
app.post("/api/lead", (req, res) => {
  try {
    const { 
      processo, 
      tribunal,
      advogadoNome,
      advogadoOAB,
      escritorio,
      beneficiarioNome,
      valorAlvara,
      telefone,
      email,
      observacoes
    } = req.body;

    if (!processo) {
      return res.status(400).json({ ok: false, error: "Campo obrigatório: processo" });
    }

    const lead = leadsDB.get(processo) || { processo, tribunal, criadoEm: new Date().toISOString() };
    
    // Atualiza campos
    if (advogadoNome) lead.advogadoNome = advogadoNome;
    if (advogadoOAB) lead.advogadoOAB = advogadoOAB;
    if (escritorio) lead.escritorio = escritorio;
    if (beneficiarioNome) lead.beneficiarioNome = beneficiarioNome;
    if (valorAlvara) lead.valorAlvara = valorAlvara;
    if (telefone) lead.telefone = telefone;
    if (email) lead.email = email;
    if (observacoes) lead.observacoes = observacoes;
    if (tribunal) lead.tribunal = tribunal;
    
    lead.atualizadoEm = new Date().toISOString();
    lead.status = "enriquecido";

    leadsDB.set(processo, lead);

    res.json({ 
      ok: true, 
      mensagem: "Lead salvo com sucesso",
      lead,
      totalLeads: leadsDB.size
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ===== GET /api/leads — Listar leads salvos =====
app.get("/api/leads", (req, res) => {
  const leads = Array.from(leadsDB.values());
  const status = req.query.status;
  
  const filtrados = status 
    ? leads.filter(l => l.status === status)
    : leads;

  res.json({
    ok: true,
    total: filtrados.length,
    leads: filtrados
  });
});

// ===== GET /api/leads/csv — Exportar leads em CSV =====
app.get("/api/leads/csv", async (req, res) => {
  try {
    const leads = Array.from(leadsDB.values());
    
    if (leads.length === 0) {
      return res.status(400).json({ ok: false, error: "Nenhum lead salvo ainda" });
    }

    const headers = [
      'Processo', 'Tribunal', 'Advogado', 'OAB', 'Escritório', 
      'Beneficiário', 'Valor', 'Telefone', 'Email', 'Status', 'Observações'
    ];

    const rows = leads.map(l => [
      l.processo || '',
      l.tribunal || '',
      l.advogadoNome || '',
      l.advogadoOAB || '',
      l.escritorio || '',
      l.beneficiarioNome || '',
      l.valorAlvara || '',
      l.telefone || '',
      l.email || '',
      l.status || '',
      (l.observacoes || '').replace(/[\n\r]/g, ' ')
    ]);

    const csv = [
      headers.join(';'),
      ...rows.map(r => r.map(c => `"${c}"`).join(';'))
    ].join('\n');

    const fileName = `leads-torre-${Date.now()}.csv`;
    const filePath = path.join(EXPORTS_DIR, fileName);
    await fsp.writeFile(filePath, '\ufeff' + csv, 'utf8'); // BOM para Excel

    res.json({
      ok: true,
      arquivo: fileName,
      url: `${BASE_URL}/exports/${fileName}`,
      totalLeads: leads.length
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ===== POST /api/pitch — Gerar mensagem de pitch =====
app.post("/api/pitch", (req, res) => {
  try {
    const {
      advogadoNome,
      processo,
      tribunal,
      beneficiarioNome,
      valorAlvara,
      dataAlvara,
      tipo // "whatsapp" | "email" | "linkedin"
    } = req.body;

    if (!advogadoNome || !processo) {
      return res.status(400).json({ ok: false, error: "Campos obrigatórios: advogadoNome, processo" });
    }

    const primeiroNome = advogadoNome.split(' ')[0];
    const valorTexto = valorAlvara ? ` no valor de ${valorAlvara}` : '';
    const benefTexto = beneficiarioNome ? ` em favor de ${beneficiarioNome}` : '';
    const dataTexto = dataAlvara ? ` desde ${dataAlvara}` : '';

    const pitches = {
      whatsapp: `Bom dia, Dr(a). ${primeiroNome}! 

Em uma auditoria automática de processos trabalhistas, identifiquei um alvará já expedido${valorTexto} no processo ${processo} (${tribunal || 'TRT'})${benefTexto}.

O crédito consta liberado${dataTexto} e não há registro de levantamento no sistema.

Gostaria de enviar o dossiê completo para análise? Sem custo para verificação inicial.

Att,
TORRE Data`,

      email: `Prezado(a) Dr(a). ${advogadoNome},

Espero que esteja bem.

Em uma auditoria automática de processos trabalhistas, identifiquei um alvará já expedido${valorTexto} no processo ${processo} (${tribunal || 'TRT'})${benefTexto}.

O crédito consta liberado${dataTexto} e, até a presente data, não há registro de levantamento no sistema do tribunal.

Caso tenha interesse, posso enviar o dossiê completo com a prova documental para análise, sem custo para a verificação inicial.

Fico à disposição.

Atenciosamente,
TORRE Data
Auditoria de Créditos Trabalhistas`,

      linkedin: `Olá Dr(a). ${primeiroNome}, tudo bem?

Trabalho com auditoria de créditos trabalhistas e identifiquei um alvará expedido no processo ${processo} que pode ser de interesse do seu escritório.

Posso compartilhar mais detalhes?`
    };

    const tipoFinal = tipo || 'whatsapp';
    
    res.json({
      ok: true,
      tipo: tipoFinal,
      pitch: pitches[tipoFinal] || pitches.whatsapp,
      todosFormatos: pitches
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ===== POST /api/dossie — Gerar dossiê HTML =====
app.post("/api/dossie", async (req, res) => {
  try {
    const {
      processo,
      tribunal,
      vara,
      advogadoNome,
      advogadoOAB,
      beneficiarioNome,
      valorAlvara,
      dataAlvara,
      movimentoProva,
      linkPJe
    } = req.body;

    if (!processo) {
      return res.status(400).json({ ok: false, error: "Campo obrigatório: processo" });
    }

    const dataGeracao = new Date().toLocaleDateString('pt-BR');

    const html = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Dossiê — Alvará Identificado</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', system-ui, sans-serif; background: #f5f5f5; color: #333; line-height: 1.5; }
    .container { max-width: 700px; margin: 30px auto; background: white; border-radius: 12px; box-shadow: 0 2px 20px rgba(0,0,0,0.1); overflow: hidden; }
    .header { background: linear-gradient(135deg, #1e3a5f 0%, #2d5a87 100%); color: white; padding: 30px; text-align: center; }
    .header h1 { font-size: 22px; margin-bottom: 5px; }
    .header .subtitle { opacity: 0.9; font-size: 14px; }
    .badge { display: inline-block; background: #27ae60; color: white; padding: 8px 20px; border-radius: 20px; font-weight: 600; margin-top: 15px; }
    .content { padding: 30px; }
    .section { margin-bottom: 25px; }
    .section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #888; margin-bottom: 10px; border-bottom: 1px solid #eee; padding-bottom: 5px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; }
    .item { background: #f9f9f9; padding: 12px; border-radius: 8px; }
    .item-label { font-size: 11px; color: #888; margin-bottom: 3px; }
    .item-value { font-size: 15px; font-weight: 600; color: #333; word-break: break-word; }
    .highlight { background: #e8f5e9; text-align: center; padding: 20px; border-radius: 8px; }
    .highlight .valor { font-size: 28px; font-weight: 700; color: #27ae60; }
    .proof { background: #fff8e1; border: 1px solid #ffca28; border-radius: 8px; padding: 15px; }
    .proof-label { font-size: 11px; font-weight: 700; color: #f57c00; margin-bottom: 8px; }
    .proof-text { font-family: monospace; font-size: 13px; color: #5d4037; }
    .link { color: #1976d2; text-decoration: none; }
    .link:hover { text-decoration: underline; }
    .footer { background: #f5f5f5; padding: 20px 30px; font-size: 11px; color: #888; text-align: center; }
    @media (max-width: 600px) { .grid { grid-template-columns: 1fr; } .container { margin: 15px; } }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>ALVARÁ IDENTIFICADO</h1>
      <div class="subtitle">Dossiê de Auditoria — TORRE Data</div>
      <div class="badge">✓ CRÉDITO DISPONÍVEL</div>
    </div>
    
    <div class="content">
      ${valorAlvara ? `
      <div class="section">
        <div class="highlight">
          <div class="item-label">VALOR LIBERADO</div>
          <div class="valor">${safe(valorAlvara)}</div>
        </div>
      </div>
      ` : ''}

      <div class="section">
        <div class="section-title">Dados do Processo</div>
        <div class="grid">
          <div class="item">
            <div class="item-label">PROCESSO</div>
            <div class="item-value">${safe(processo)}</div>
          </div>
          <div class="item">
            <div class="item-label">TRIBUNAL</div>
            <div class="item-value">${safe(tribunal || 'TRT')}</div>
          </div>
          ${vara ? `
          <div class="item">
            <div class="item-label">VARA</div>
            <div class="item-value">${safe(vara)}</div>
          </div>
          ` : ''}
          ${dataAlvara ? `
          <div class="item">
            <div class="item-label">DATA DO ALVARÁ</div>
            <div class="item-value">${safe(dataAlvara)}</div>
          </div>
          ` : ''}
        </div>
      </div>

      ${advogadoNome || beneficiarioNome ? `
      <div class="section">
        <div class="section-title">Partes</div>
        <div class="grid">
          ${beneficiarioNome ? `
          <div class="item">
            <div class="item-label">BENEFICIÁRIO</div>
            <div class="item-value">${safe(beneficiarioNome)}</div>
          </div>
          ` : ''}
          ${advogadoNome ? `
          <div class="item">
            <div class="item-label">ADVOGADO</div>
            <div class="item-value">${safe(advogadoNome)}${advogadoOAB ? ` (OAB ${safe(advogadoOAB)})` : ''}</div>
          </div>
          ` : ''}
        </div>
      </div>
      ` : ''}

      ${movimentoProva ? `
      <div class="section">
        <div class="section-title">Prova Documental</div>
        <div class="proof">
          <div class="proof-label">MOVIMENTO OFICIAL DO TRIBUNAL</div>
          <div class="proof-text">${safe(movimentoProva)}</div>
        </div>
      </div>
      ` : ''}

      ${linkPJe ? `
      <div class="section">
        <div class="section-title">Verificação</div>
        <p><a href="${safe(linkPJe)}" target="_blank" class="link">🔗 Abrir processo no PJe do Tribunal</a></p>
      </div>
      ` : ''}
    </div>

    <div class="footer">
      Dossiê gerado em ${dataGeracao} por TORRE Data<br>
      Dados extraídos de fontes públicas oficiais (DataJud/CNJ)
    </div>
  </div>
</body>
</html>`;

    const fileName = `dossie-${processo.replace(/\D/g, '').slice(0, 15)}-${Date.now()}.html`;
    const filePath = path.join(EXPORTS_DIR, fileName);
    await fsp.writeFile(filePath, html, 'utf8');

    res.json({
      ok: true,
      arquivo: fileName,
      url: `${BASE_URL}/exports/${fileName}`
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ===== POST /api/teaser — Gera preview SEM link (anti-calote) =====
app.post("/api/teaser", (req, res) => {
  try {
    const {
      processo,
      tribunal,
      vara,
      beneficiarioNome,
      dataAlvara,
      movimentoTrecho
    } = req.body;

    if (!processo) {
      return res.status(400).json({ ok: false, error: "Campo obrigatório: processo" });
    }

    // Oculta parte do processo (segurança)
    const processoOculto = processo.replace(/(\d{7})-(\d{2})\.(\d{4})\.(\d)\.(\d{2})\.(\d{4})/, '$1-XX.XXXX.$4.$5.$6');
    
    // Oculta parte do nome do beneficiário
    const benefOculto = beneficiarioNome 
      ? beneficiarioNome.split(' ').map((p, i) => i === 0 ? p : p[0] + '***').join(' ')
      : null;

    const teaser = {
      tipo: "TEASER - Preview de Verificação",
      aviso: "⚠️ Dados parciais. Dossiê completo liberado após confirmação de pagamento.",
      
      dados: {
        processo: processoOculto,
        tribunal: tribunal || "TRT",
        vara: vara || null,
        beneficiario: benefOculto,
        dataAlvara: dataAlvara || "Recente",
        movimento: movimentoTrecho 
          ? movimentoTrecho.substring(0, 100) + "..."
          : "Expedição de alvará ao reclamante"
      },

      // Mensagem pronta pra WhatsApp
      mensagemWhatsApp: `📋 *PRÉVIA DE VERIFICAÇÃO*

Processo: ${processoOculto}
Tribunal: ${tribunal || 'TRT'}
${vara ? `Vara: ${vara}` : ''}
${benefOculto ? `Beneficiário: ${benefOculto}` : ''}
Data do alvará: ${dataAlvara || 'Recente'}

Movimento identificado:
"${movimentoTrecho ? movimentoTrecho.substring(0, 80) + '...' : 'Expedição de alvará ao reclamante...'}"

⚠️ _Dados parciais para conferência._
_Dossiê completo com link oficial e prova documental: R$ 400_`,

      instrucao: "Envie essa prévia. Só libere o dossiê completo APÓS receber o PIX."
    };

    res.json({ ok: true, teaser });

  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ===== GET /api/minerar-honorarios — Mineração de Honorários de Sucumbência =====
app.get("/api/minerar-honorarios", async (req, res) => {
  const logs = [];
  const log = (msg) => { console.log(msg); logs.push(msg); };

  try {
    const tribunal = (req.query.tribunal || "TRT1").toUpperCase();
    const limite = Math.min(Number(req.query.limite) || 50, 200);
    const maxIdade = Number(req.query.maxIdade) || CONFIG.MAX_IDADE_DIAS;
    const pagina = Number(req.query.pagina) || 0;

    log(`[HONORÁRIOS] ${tribunal} | limite ${limite} | maxIdade ${maxIdade} dias | página ${pagina}`);

    const tribunalInfo = DATAJUD_ENDPOINTS[tribunal];
    if (!tribunalInfo) {
      return res.status(400).json({ 
        ok: false, 
        error: `Tribunal ${tribunal} não suportado`,
        tribunaisDisponiveis: Object.keys(DATAJUD_ENDPOINTS)
      });
    }

    // Query DataJud - busca ESPECIFICAMENTE processos de HONORÁRIOS DO ADVOGADO
    const query = {
      size: limite,
      from: pagina * limite,
      query: {
        bool: {
          should: [
            // Assuntos relacionados a honorários
            { match_phrase: { "assuntos.nome": "Honorários" } },
            { match_phrase: { "assuntos.nome": "Honorários Advocatícios" } },
            { match_phrase: { "assuntos.nome": "Honorários de Sucumbência" } },
            { match_phrase: { "assuntos.nome": "Honorários na Justiça do Trabalho" } },
            // Movimentos de honorários
            { match_phrase: { "movimentos.nome": "honorários" } },
            { match_phrase: { "movimentos.nome": "sucumbência" } },
            { match: { "movimentos.complementosTabelados.nome": "Honorários" } },
          ],
          minimum_should_match: 1
        }
      },
      sort: [{ "dataHoraUltimaAtualizacao": { order: "desc" } }]
    };

    const response = await fetch(tribunalInfo.url, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json', 
        'Authorization': DATAJUD_API_KEY 
      },
      body: JSON.stringify(query)
    });

    if (!response.ok) {
      throw new Error(`DataJud retornou ${response.status}`);
    }

    const data = await response.json();
    const hits = data.hits?.hits || [];
    const total = data.hits?.total?.value || 0;

    log(`[HONORÁRIOS] DataJud retornou ${hits.length} de ${total} total`);

    // Processa resultados
    const leads = [];
    let descartadosIdade = 0;
    let descartadosSemHonorarios = 0;

    for (const hit of hits) {
      const src = hit._source;
      const processoNum = formatarProcessoCNJ(src.numeroProcesso);
      const processoLimpo = processoSemFormatacao(src.numeroProcesso);

      // Filtra por idade
      const idadeDias = calcularIdadeDias(src.dataHoraUltimaAtualizacao);
      if (idadeDias !== null && idadeDias > maxIdade) {
        descartadosIdade++;
        continue;
      }

      // Verifica se menciona HONORÁRIOS nos assuntos ou movimentos
      const assuntosTexto = (src.assuntos || []).map(a => (a.nome || '').toLowerCase()).join(' ');
      const movimentosTexto = (src.movimentos || []).map(m => {
        const nome = (m.nome || '').toLowerCase();
        const compl = (m.complementosTabelados || []).map(c => (c.nome || '').toLowerCase()).join(' ');
        return `${nome} ${compl}`;
      }).join(' ');
      
      const textoCompleto = `${assuntosTexto} ${movimentosTexto}`;
      const mencionaHonorarios = textoCompleto.includes('honorário') || 
                                  textoCompleto.includes('honorario') ||
                                  textoCompleto.includes('sucumbência') ||
                                  textoCompleto.includes('sucumbencia');

      if (!mencionaHonorarios) {
        descartadosSemHonorarios++;
        continue;
      }

      // Verifica se tem alvará (bônus, não obrigatório)
      const analiseAlvara = analisarMovimentosDataJud(src.movimentos);

      leads.push({
        // Identificação
        processo: processoNum,
        processoLimpo,
        tribunal,
        estado: tribunalInfo.estado,
        
        // Vara/Órgão
        vara: src.orgaoJulgador?.nome || null,
        grau: src.grau,
        
        // Classe/Assunto
        classe: src.classe?.nome || null,
        assuntos: (src.assuntos || []).slice(0, 5).map(a => a.nome),
        
        // Datas
        dataUltimaAtualizacao: formatarData(src.dataHoraUltimaAtualizacao),
        idadeDias,
        
        // Tem alvará? (bônus)
        temAlvara: analiseAlvara.temAlvara,
        alvara: analiseAlvara.movimento,
        
        // Links
        links: {
          pje: `${tribunalInfo.pje}${processoLimpo}`,
          pjeAlternativo: `https://pje.trt${tribunal.replace('TRT', '')}.jus.br/primeirograu/Processo/ConsultaProcesso/listView.seam?numeroProcesso=${processoNum}`
        },
        
        // Campos para preencher
        enriquecimento: {
          advogadoNome: null,
          advogadoOAB: null,
          valorHonorarios: null,
          telefone: null,
          email: null
        },
        
        status: "pendente_enriquecimento",
        tipoLead: "HONORARIOS_ADVOGADO"
      });
    }

    // Ordena: primeiro os que TÊM alvará (dinheiro pronto), depois por data
    leads.sort((a, b) => {
      if (a.temAlvara && !b.temAlvara) return -1;
      if (!a.temAlvara && b.temAlvara) return 1;
      return (a.idadeDias || 999) - (b.idadeDias || 999);
    });

    log(`[HONORÁRIOS] ✅ ${leads.length} leads de honorários | ${leads.filter(l => l.temAlvara).length} com alvará | ${descartadosSemHonorarios} sem menção a honorários`);

    res.json({
      ok: true,
      tribunal,
      estado: tribunalInfo.estado,
      custoAPI: "R$ 0,00 (GRÁTIS)",
      tipoMineracao: "🎯 HONORÁRIOS DO ADVOGADO",
      
      estatisticas: {
        totalDataJud: total,
        retornados: hits.length,
        leadsValidos: leads.length,
        comAlvara: leads.filter(l => l.temAlvara).length,
        descartadosIdade,
        descartadosSemHonorarios
      },
      
      paginacao: {
        pagina,
        limite,
        temMais: (pagina + 1) * limite < total
      },
      
      instrucoes: {
        passo1: "Leads com ⭐ temAlvara=true são PRIORIDADE (dinheiro liberado!)",
        passo2: "Abra o link PJe e confirme que é honorário DO ADVOGADO",
        passo3: "Copie: nome do advogado, OAB, valor",
        passo4: "Busque contato no Google/LinkedIn",
        passo5: "Mande o pitch - dinheiro é DELE!"
      },
      
      pitch_modelo: `Bom dia, Dr(a). [NOME]!

Identifiquei que você tem honorários de sucumbência no processo [X] no ${tribunal}.

Esse valor é SEU por direito. Posso enviar o dossiê completo?`,
      
      leads,
      logs
    });

  } catch (e) {
    log(`[HONORÁRIOS] ❌ Erro: ${e.message}`);
    res.status(500).json({ ok: false, error: String(e?.message || e), logs });
  }
});

// ===== Função para analisar movimentos de honorários COM ALVARÁ =====
function analisarMovimentosHonorarios(movimentos) {
  if (!movimentos || !Array.isArray(movimentos)) {
    return { temHonorarios: false, temAlvara: false, movimento: null, tipo: null };
  }

  // Palavras-chave de honorários
  const palavrasHonorarios = [
    'honorários', 'honorarios',
    'sucumbência', 'sucumbencia',
    'honorários advocatícios', 'honorarios advocaticios'
  ];

  // Palavras-chave de alvará/liberação
  const palavrasAlvara = [
    'alvará', 'alvara',
    'expedição de alvará', 'expedicao de alvara',
    'liberação de valores', 'liberacao de valores',
    'levantamento de valores', 'levantamento de depósito'
  ];

  // Palavras que indicam que já foi sacado (descarta)
  const palavrasJaSacado = [
    'cumprido', 'levantado', 'sacado', 'quitado',
    'transferido', 'creditado', 'pago'
  ];

  // Procura movimentos (mais recente primeiro)
  const movimentosOrdenados = [...movimentos].sort((a, b) => {
    const dataA = new Date(a.dataHora || 0);
    const dataB = new Date(b.dataHora || 0);
    return dataB - dataA;
  });

  let temHonorarios = false;
  let temAlvara = false;
  let movimentoAlvara = null;
  let movimentoHonorarios = null;

  for (const mov of movimentosOrdenados) {
    const nome = (mov.nome || '').toLowerCase();
    const complementos = mov.complementosTabelados || [];
    const complementoTexto = complementos.map(c => (c.nome || '').toLowerCase()).join(' ');
    const textoCompleto = `${nome} ${complementoTexto}`;

    // Verifica se já foi sacado
    const jaSacado = palavrasJaSacado.some(p => textoCompleto.includes(p));
    if (jaSacado) continue;

    // Verifica honorários
    if (!temHonorarios) {
      const ehHonorarios = palavrasHonorarios.some(p => textoCompleto.includes(p));
      if (ehHonorarios) {
        temHonorarios = true;
        movimentoHonorarios = {
          nome: mov.nome,
          data: mov.dataHora,
          dataFormatada: formatarData(mov.dataHora),
          complementos: complementos.map(c => c.nome)
        };
      }
    }

    // Verifica alvará
    if (!temAlvara) {
      const ehAlvara = palavrasAlvara.some(p => textoCompleto.includes(p));
      if (ehAlvara) {
        temAlvara = true;
        movimentoAlvara = {
          nome: mov.nome,
          data: mov.dataHora,
          dataFormatada: formatarData(mov.dataHora),
          complementos: complementos.map(c => c.nome)
        };
      }
    }
  }

  // SÓ RETORNA VÁLIDO SE TIVER ALVARÁ (dinheiro pronto pra sacar)
  return {
    temHonorarios,
    temAlvara,
    prontoParaSacar: temAlvara, // O que importa é ter alvará!
    tipo: temHonorarios && temAlvara ? "HONORARIOS_COM_ALVARA" : 
          temAlvara ? "ALVARA_GERAL" : 
          temHonorarios ? "HONORARIOS_SEM_ALVARA" : null,
    movimentoAlvara,
    movimentoHonorarios,
    movimento: movimentoAlvara || movimentoHonorarios
  };
}

// ===== POST /api/pitch-honorarios — Gerar pitch específico para honorários =====
app.post("/api/pitch-honorarios", (req, res) => {
  try {
    const {
      advogadoNome,
      processo,
      tribunal,
      valorHonorarios,
      dataFixacao,
      tipo // "whatsapp" | "email" | "linkedin"
    } = req.body;

    if (!advogadoNome || !processo) {
      return res.status(400).json({ ok: false, error: "Campos obrigatórios: advogadoNome, processo" });
    }

    const primeiroNome = advogadoNome.split(' ')[0];
    const valorTexto = valorHonorarios ? ` no valor de ${valorHonorarios}` : '';
    const dataTexto = dataFixacao ? ` desde ${dataFixacao}` : '';

    const pitches = {
      whatsapp: `Bom dia, Dr(a). ${primeiroNome}!

Fazendo uma auditoria em processos do ${tribunal || 'TRT'}, identifiquei que você tem honorários de sucumbência fixados${valorTexto} no processo ${processo}.

Pelo que vi, ainda não houve execução desses honorários${dataTexto}.

Esse valor é SEU por direito. Gostaria de receber o dossiê completo para análise?

Att,
TORRE Data`,

      email: `Prezado(a) Dr(a). ${advogadoNome},

Espero que esteja bem.

Em uma auditoria de processos trabalhistas, identifiquei que V.Sa. possui honorários de sucumbência fixados${valorTexto} no processo ${processo} (${tribunal || 'TRT'}).

Até a presente data, não identifiquei execução desses honorários no sistema${dataTexto}.

Como esse valor é de direito próprio de V.Sa., gostaria de oferecer o dossiê completo com toda documentação necessária para dar início à execução.

Fico à disposição para enviar sem compromisso.

Atenciosamente,
TORRE Data
Auditoria de Créditos Trabalhistas`,

      linkedin: `Olá Dr(a). ${primeiroNome}!

Vi que você tem honorários de sucumbência pendentes no processo ${processo}. 

Esse valor é seu e pode estar esquecido. Posso te mandar os detalhes?`
    };

    const tipoFinal = tipo || 'whatsapp';
    
    res.json({
      ok: true,
      tipo: tipoFinal,
      pitch: pitches[tipoFinal] || pitches.whatsapp,
      todosFormatos: pitches,
      dica: "Honorários de sucumbência são do ADVOGADO. Ele decide sozinho, sem precisar consultar cliente."
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ===== GET /api/abordagem — Fluxo completo de venda =====
app.get("/api/abordagem", (req, res) => {
  res.json({
    ok: true,
    titulo: "🎯 FLUXO DE VENDA ANTI-CALOTE",
    
    etapa1_pitch: {
      nome: "Primeiro contato",
      objetivo: "Despertar interesse SEM revelar dados",
      exemplo: `Bom dia, Dr(a). [NOME]!

Em uma auditoria automática de processos trabalhistas, identifiquei um alvará já expedido em um processo do seu escritório no [TRIBUNAL].

O crédito consta liberado e não há registro de levantamento no sistema.

Posso te enviar os detalhes para conferência?`,
      regra: "❌ NÃO mande: número do processo, link, valor, nome do cliente"
    },

    etapa2_teaser: {
      nome: "Preview de verificação",
      objetivo: "Provar que é real SEM dar acesso direto",
      como: "Use POST /api/teaser para gerar",
      exemplo: "Processo parcial + tribunal + trecho do movimento",
      regra: "❌ NÃO mande: link do PJe, PDF, print completo"
    },

    etapa3_cobranca: {
      nome: "Fechamento",
      objetivo: "Converter em pagamento",
      exemplo: `Posso liberar o dossiê completo com:
✅ Link oficial do processo
✅ Prova documental do movimento
✅ Dados do beneficiário
✅ Data e detalhes do alvará

Valor: R$ 400
PIX: seupix@torredata.com.br

Envio imediatamente após a confirmação.`,
      regra: "✅ PIX ANTES, entrega DEPOIS"
    },

    etapa4_entrega: {
      nome: "Dossiê completo",
      objetivo: "Entregar valor máximo",
      como: "Use POST /api/dossie para gerar HTML completo",
      conteudo: ["Link PJe direto", "Nome completo do beneficiário", "Nome do advogado", "Data do alvará", "Trecho do movimento oficial"],
      regra: "✅ Só após PIX confirmado"
    },

    etapa5_upsell: {
      nome: "Proposta de recorrência",
      objetivo: "Transformar em cliente fixo",
      quando: "Após ele confirmar que deu certo",
      exemplo: `Fico feliz que ajudou, doutor!

Esse tipo de crédito esquecido acontece com frequência.

Se quiser, posso monitorar automaticamente os processos do seu escritório e te avisar sempre que sair dinheiro.

Assinatura mensal: R$ 1.200
Inclui: alertas ilimitados + dossiês prioritários`,
      meta: "30-50% aceitam após primeiro sucesso"
    },

    precos_sugeridos: {
      dossie_avulso: "R$ 300 a R$ 500",
      assinatura_mensal: "R$ 1.000 a R$ 1.500",
      percentual_exito: "5% a 10% (após confiança)"
    },

    meta_faturamento: {
      conservador: "5 dossiês/mês × R$ 400 = R$ 2.000",
      moderado: "10 dossiês + 3 assinantes = R$ 7.600",
      agressivo: "20 dossiês + 10 assinantes = R$ 20.000"
    }
  });
});

// ===== Start =====
app.listen(PORT, () => {
  console.log(`\n🚀 TORRE v13.0 rodando na porta ${PORT}`);
  console.log(`📊 DataJud: GRÁTIS | ${Object.keys(DATAJUD_ENDPOINTS).length} tribunais`);
  console.log(`💰 Custo operacional: R$ 0,00\n`);
});