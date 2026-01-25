// ===== TORRE v10.0 — Sistema Completo de Leads Confirmados =====
// Endpoints: /api/leads, /api/dossie, /api/telefone, /api/pdf, /health

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
const INFOSIMPLES_TOKEN = process.env.INFOSIMPLES_TOKEN || "LUdOqPRSc0SqVRAKf594tnE0nk7GBi0WSek10Wkh";
const DIRECTDATA_TOKEN = process.env.DIRECTDATA_TOKEN || "";

// ===== Configurações =====
const MIN_VALOR_CENTAVOS = Number(process.env.MIN_VALOR || 2000000); // R$ 20.000
const MIN_SCORE = Number(process.env.MIN_SCORE || 50);
const MAX_IDADE_DIAS = Number(process.env.MAX_IDADE_DIAS || 1095); // 3 anos

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
  if (!dataStr) return 9999;
  const data = new Date(dataStr);
  const agora = new Date();
  return Math.floor((agora - data) / (1000 * 60 * 60 * 24));
};

const safe = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ===== Health =====
app.get("/", (_req, res) => res.send("TORRE v10.0 — Sistema de Leads Confirmados"));
app.get("/health", (_req, res) => res.json({ 
  ok: true, 
  version: "10.0",
  directDataConfigured: !!DIRECTDATA_TOKEN,
  now: new Date().toISOString() 
}));

// ===== FILTRO TORRE - Análise de Movimentos =====
function analisarMovimentosTORRE(movimentos) {
  const resultado = {
    confirmado: false,
    tipo: null,
    dataAlvara: null,
    banco: null,
    valor: null,
    valorCentavos: null,
    movimentoAlvara: null,
    motivoDescarte: null,
    temCodigoAlvara: false
  };

  // Termos que CONFIRMAM alvará
  const termosConfirmados = [
    /alvará/i,
    /guia de (levantamento|liberação)/i,
    /autorizo o levantamento/i,
    /liberação de valores/i,
    /expe(ça-se|dido|dição).{0,20}alvará/i,
    /mandado de levantamento/i
  ];

  // Termos de BAIXA (descarta - já foi sacado)
  const termosBaixa = [
    /cumprido/i,
    /levantado/i,
    /levantamento efetuado/i,
    /pago/i,
    /devolvido/i,
    /cancelado/i,
    /arquiv/i,
    /baixado/i,
    /transferido ao beneficiário/i,
    /alvará cumprido/i,
    /devolução do alvará/i
  ];

  // Termos de ADVOGADO (descarta)
  const termosAdvogado = [
    /advogado/i,
    /patrono/i,
    /honorários/i,
    /sucumb/i,
    /perito/i,
    /procurador/i
  ];

  // Termos de RUÍDO (ignorar)
  const termosRuido = [
    /alvará para expedição de ofício/i,
    /alvará de publicação/i,
    /alvará de traslado/i
  ];

  // Bancos
  const termosBanco = {
    bb: /banco do brasil|bb\b/i,
    cef: /caixa econ|cef\b|caixa federal/i
  };

  // Analisa cada movimento (do mais recente pro mais antigo)
  const movimentosOrdenados = [...movimentos].sort((a, b) => 
    new Date(b.dataHora || 0) - new Date(a.dataHora || 0)
  );

  for (const mov of movimentosOrdenados) {
    const nome = (mov.nome || "").toLowerCase();
    const complementos = (mov.complementosTabelados || [])
      .map(c => (c.nome || "").toLowerCase())
      .join(" ");
    const textoCompleto = `${nome} ${complementos}`;

    // Ignora ruído
    if (termosRuido.some(regex => regex.test(textoCompleto))) continue;

    // Verifica se tem termo de alvará
    const temAlvara = termosConfirmados.some(regex => regex.test(textoCompleto));
    const temComplementoAlvara = complementos.includes('alvará');

    if (!temAlvara && !temComplementoAlvara) continue;

    // Verifica se já foi cumprido/baixado
    const jaBaixado = termosBaixa.some(regex => regex.test(textoCompleto));
    if (jaBaixado) {
      resultado.motivoDescarte = "Alvará já cumprido/levantado/pago";
      continue;
    }

    // Verifica se é do advogado
    const eDoAdvogado = termosAdvogado.some(regex => regex.test(textoCompleto));
    if (eDoAdvogado) {
      resultado.motivoDescarte = "Alvará do advogado/patrono, não do reclamante PF";
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

    // Extrai valor
    const matchValor = textoCompleto.match(/r\$\s*([\d.,]+)/i);
    if (matchValor) {
      resultado.valor = `R$ ${matchValor[1]}`;
      const valorNum = parseFloat(matchValor[1].replace(/\./g, '').replace(',', '.'));
      if (!isNaN(valorNum)) resultado.valorCentavos = Math.round(valorNum * 100);
    }

    // Verifica código do alvará
    if (/código|id.*alvará|alvará.*\d{5,}/i.test(textoCompleto)) {
      resultado.temCodigoAlvara = true;
    }

    break; // Encontrou um válido
  }

  return resultado;
}

// ===== Calcular Score do Lead =====
function calcularScore(analise, idadeDias, temPFNomeada) {
  let score = 0;

  // +40 se PF nomeada
  if (temPFNomeada) score += 40;

  // +30 se banco identificado
  if (analise.banco) score += 30;

  // +20 se valor extraído
  if (analise.valorCentavos) score += 20;

  // +10 se tem código do alvará
  if (analise.temCodigoAlvara) score += 10;

  // -20 se alvará muito antigo (> 2 anos)
  if (idadeDias > 730) score -= 20;

  // -10 se muito antigo (> 1 ano)
  else if (idadeDias > 365) score -= 10;

  // +10 se recente (< 90 dias)
  if (idadeDias < 90) score += 10;

  return Math.max(0, Math.min(100, score));
}

// ===== GET /api/leads - Busca leads CONFIRMADOS =====
app.get("/api/leads", async (req, res) => {
  const logs = [];
  const log = (msg) => { console.log(msg); logs.push(msg); };

  try {
    const tribunal = (req.query.tribunal || "TRT15").toUpperCase();
    const limite = Math.min(Number(req.query.limite) || 20, 100);
    const dias = Number(req.query.dias) || 180;
    const minScore = Number(req.query.minScore) || MIN_SCORE;
    const minValor = Number(req.query.minValor) || 0;

    log(`[leads] Buscando no ${tribunal} (últimos ${dias} dias, minScore=${minScore})...`);

    const endpoint = DATAJUD_ENDPOINTS[tribunal];
    if (!endpoint) {
      return res.status(400).json({ ok: false, error: `Tribunal ${tribunal} não suportado` });
    }

    // Query DataJud
    const query = {
      size: limite * 5,
      query: {
        bool: {
          should: [
            { match_phrase: { "movimentos.nome": "Expedição de documento" } },
            { match: { "movimentos.complementosTabelados.nome": "Alvará" } },
            { match: { "movimentos.nome": "alvará" } },
            { match: { "movimentos.nome": "levantamento" } },
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

    // Aplica FILTRO TORRE
    const leadsConfirmados = [];
    const descartados = { baixado: 0, advogado: 0, ruido: 0, antigo: 0, scoreBaixo: 0 };

    for (const hit of (datajudData.hits?.hits || [])) {
      const src = hit._source;
      const movimentos = src.movimentos || [];

      const analise = analisarMovimentosTORRE(movimentos);

      if (!analise.confirmado) {
        if (analise.motivoDescarte?.includes('cumprido')) descartados.baixado++;
        else if (analise.motivoDescarte?.includes('advogado')) descartados.advogado++;
        else descartados.ruido++;
        continue;
      }

      const idadeDias = calcularIdadeDias(analise.dataAlvara);

      // Filtro de idade
      if (idadeDias > MAX_IDADE_DIAS) {
        descartados.antigo++;
        continue;
      }

      const score = calcularScore(analise, idadeDias, true);

      // Filtro de score
      if (score < minScore) {
        descartados.scoreBaixo++;
        continue;
      }

      // Filtro de valor mínimo
      if (minValor > 0 && analise.valorCentavos && analise.valorCentavos < minValor) {
        continue;
      }

      leadsConfirmados.push({
        processo: formatarProcessoCNJ(src.numeroProcesso),
        tribunal: src.tribunal || tribunal,
        grau: src.grau,
        vara: src.orgaoJulgador?.nome,
        classe: src.classe?.nome,
        ultimaAtualizacao: src.dataHoraUltimaAtualizacao,

        // Dados do alvará
        alvara: {
          confirmado: true,
          tipo: analise.tipo,
          data: analise.dataAlvara,
          banco: analise.banco,
          valor: analise.valor,
          valorCentavos: analise.valorCentavos,
          temCodigoAlvara: analise.temCodigoAlvara,
          movimento: analise.movimentoAlvara
        },

        // Métricas
        idadeAlvaraDias: idadeDias,
        score,

        // URLs
        urlPje: `https://pje.${tribunal.toLowerCase()}.jus.br/consultaprocessual/detalhe-processo/${src.numeroProcesso}`,
        urlDossie: `/api/dossie?processo=${src.numeroProcesso}`
      });

      if (leadsConfirmados.length >= limite) break;
    }

    // Ordena por score DESC, depois por data DESC
    leadsConfirmados.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.alvara.data || 0) - new Date(a.alvara.data || 0);
    });

    log(`[leads] ${leadsConfirmados.length} leads CONFIRMADOS após filtro TORRE`);

    res.json({
      ok: true,
      tribunal,
      filtro: {
        dias,
        minScore,
        minValor: minValor > 0 ? centavosToBRL(minValor) : "sem filtro",
        tipo: "TORRE — Só Confirmados"
      },
      estatisticas: {
        totalDataJud: datajudData.hits?.hits?.length || 0,
        confirmados: leadsConfirmados.length,
        descartados
      },
      leads: leadsConfirmados,
      proximoPasso: leadsConfirmados.length > 0
        ? "Chame /api/dossie?processo=XXX para cada lead"
        : "Nenhum lead confirmado. Tente outro tribunal ou reduza minScore.",
      logs
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e), logs });
  }
});

// ===== GET /api/dossie - Gera dossiê completo =====
app.get("/api/dossie", async (req, res) => {
  const logs = [];
  const log = (msg) => { console.log(msg); logs.push(msg); };

  try {
    const processo = req.query.processo;
    if (!processo) {
      return res.status(400).json({ ok: false, error: "Parâmetro 'processo' é obrigatório" });
    }

    const numeroLimpo = processo.replace(/\D/g, '');
    const numeroCNJ = formatarProcessoCNJ(numeroLimpo);

    log(`[dossie] Consultando InfoSimples para ${numeroCNJ}...`);

    // Consulta InfoSimples
    const url = `https://api.infosimples.com/api/v2/consultas/tribunal/trt/processo?numero_processo=${encodeURIComponent(numeroCNJ)}&token=${INFOSIMPLES_TOKEN}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.code !== 200) {
      return res.json({
        ok: false,
        error: data.code_message || "Erro na consulta InfoSimples",
        logs
      });
    }

    const resultado = data.data?.[0] || {};
    const detalhes = resultado.detalhes || {};
    const itens = resultado.itens || [];

    // Extrai partes
    const poloAtivo = detalhes.polo_ativo || [];
    const poloPassivo = detalhes.polo_passivo || [];

    // Filtra só PF (não advogado, não CNPJ)
    const beneficiariosPF = poloAtivo.filter(p => {
      const nome = (p.nome || "").toUpperCase();
      const tipo = (p.tipo || "").toLowerCase();
      // Exclui empresas
      if (nome.includes("LTDA") || nome.includes("S.A") || nome.includes("S/A") || 
          nome.includes("EPP") || nome.includes("EIRELI") || nome.includes("MEI")) return false;
      // Exclui advogados
      if (tipo.includes("advogado") || tipo.includes("patrono")) return false;
      return true;
    }).map(p => ({
      nome: p.nome,
      tipo: p.tipo,
      advogados: (p.representantes || []).filter(r => r.tipo === "Advogado").map(r => r.nome)
    }));

    // Analisa movimentos para alvará
    const movimentosAlvara = itens.filter(item => {
      const titulo = (item.titulo || "").toLowerCase();
      return titulo.includes('alvará') ||
             titulo.includes('levantamento') ||
             titulo.includes('liberação de valores');
    }).map(item => ({
      data: item.data,
      titulo: item.titulo,
      id: item.id_documento
    }));

    // Analisa se tem alvará confirmado
    const analise = {
      confirmado: movimentosAlvara.length > 0,
      tipo: movimentosAlvara.length > 0 ? "alvara_expedido" : null,
      dataAlvara: movimentosAlvara[0]?.data,
      banco: null,
      valor: null,
      valorCentavos: null
    };

    // Extrai valor
    const todosTextos = itens.map(i => i.titulo || "").join(" ");
    const matchValor = todosTextos.match(/r\$\s*([\d.,]+)/i);
    if (matchValor) {
      analise.valor = `R$ ${matchValor[1]}`;
      const valorNum = parseFloat(matchValor[1].replace(/\./g, '').replace(',', '.'));
      if (!isNaN(valorNum)) analise.valorCentavos = Math.round(valorNum * 100);
    }

    // Identifica banco
    if (/banco do brasil|bb\b/i.test(todosTextos)) analise.banco = "BB";
    else if (/caixa econ|cef\b/i.test(todosTextos)) analise.banco = "CEF";

    const idadeDias = calcularIdadeDias(analise.dataAlvara);
    const score = calcularScore(analise, idadeDias, beneficiariosPF.length > 0);

    // Monta dossiê
    const dossie = {
      processo: numeroCNJ,
      tribunal: resultado.trt || "TRT",
      vara: detalhes.orgao_julgador,
      classe: detalhes.processo?.split(" ")[0],
      valorCausa: detalhes.valor_causa || detalhes.normalizado_valor_causa,

      // Beneficiários PF
      beneficiariosPF,
      pfNomeada: beneficiariosPF.length > 0,

      // Reclamados
      reclamados: poloPassivo.map(p => ({ nome: p.nome, tipo: p.tipo })),

      // Análise do Alvará
      alvara: {
        confirmado: analise.confirmado,
        tipo: analise.tipo,
        data: analise.dataAlvara,
        banco: analise.banco || "BB/CEF",
        valor: analise.valor,
        valorCentavos: analise.valorCentavos,
        movimentos: movimentosAlvara.slice(0, 5)
      },

      // Métricas
      idadeAlvaraDias: idadeDias,
      score,

      // Status
      status: !analise.confirmado ? "sem_alvara_confirmado"
            : !DIRECTDATA_TOKEN ? "alvara_confirmado_aguardando_telefone"
            : "pronto_para_contato",

      // Links
      links: {
        pje: `https://pje.trt15.jus.br/consultaprocessual/detalhe-processo/${numeroLimpo}`,
        comprovante: resultado.site_receipt
      },

      // Mensagens de Pitch
      mensagens: gerarMensagensPitch(beneficiariosPF[0], numeroCNJ, analise),

      // Contato (a ser preenchido)
      contato: {
        status: DIRECTDATA_TOKEN ? "pendente" : "aguardando_directdata",
        telefone: null,
        whatsapp: null,
        email: null
      },

      geradoEm: new Date().toISOString()
    };

    log(`[dossie] Score: ${score}, Confirmado: ${analise.confirmado}`);

    res.json({ ok: true, dossie, logs });

  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e), logs });
  }
});

// ===== Gerar Mensagens de Pitch =====
function gerarMensagensPitch(beneficiario, processo, analise) {
  const nome = beneficiario?.nome || "Sr(a)";
  const primeiroNome = nome.split(' ')[0];
  const banco = analise.banco || "BB/CEF";
  const valor = analise.valor;

  if (!analise.confirmado) {
    return {
      tipo: "sem_alvara",
      alerta: "⚠️ Sem alvará confirmado. NÃO ABORDAR."
    };
  }

  return {
    tipo: "confirmado",
    alerta: "✅ ALVARÁ CONFIRMADO — Pode usar pitch direto!",

    // Pitch principal
    abertura: `Oi ${primeiroNome}, identifiquei no TRT um alvará já expedido no proc. ${processo}${valor ? ` (${valor})` : ''} em seu nome. Posso te explicar em 2 min como sacar? Cobro só no êxito.`,

    // Se responder sim
    seResponderSim: `Ótimo! O processo é rápido:\n\n1️⃣ Verifico seu processo e preparo a documentação\n2️⃣ Você vai na agência ${banco} com RG, CPF e comprovante de endereço\n3️⃣ O dinheiro cai em 3-7 dias úteis\n4️⃣ Só então você me paga 15%\n\nPosso começar agora?`,

    // Se pedir prova
    sePedirProva: `Segue link oficial do tribunal: https://pje.trt15.jus.br/consultaprocessual/detalhe-processo/${processo.replace(/\D/g, '')}\n\nPosso gerar PDF com QR code pra você verificar.`,

    // Follow-up
    followUp: `Sem custo pra conferir valor e banco. Se estiver liberado, você só paga após o crédito na sua conta.`,

    // Fechamento
    fechamento: `Combinado! Me manda foto do RG e CPF + comprovante de endereço que eu preparo tudo. Qualquer dúvida é só chamar! 🤝`
  };
}

// ===== GET /api/telefone - Consulta Direct Data =====
app.get("/api/telefone", async (req, res) => {
  const logs = [];
  const log = (msg) => { console.log(msg); logs.push(msg); };

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
        error: "Token Direct Data não configurado. Aguardando aprovação da conta.",
        instrucoes: "Após receber o token, configure DIRECTDATA_TOKEN no Railway",
        logs
      });
    }

    const cpfLimpo = cpf ? cpf.replace(/\D/g, '') : '';

    log(`[directdata] Consultando CPF ${cpfLimpo}...`);

    const url = `https://apiv3.directd.com.br/api/CadastroPessoaFisicaPlus?CPF=${cpfLimpo}&TOKEN=${DIRECTDATA_TOKEN}`;
    const response = await fetch(url, { headers: { 'Accept': 'application/json' } });
    const data = await response.json();

    if (data.metaDados?.resultado !== "Sucesso") {
      return res.json({
        ok: false,
        error: data.metaDados?.mensagem || "Erro na consulta",
        logs
      });
    }

    const retorno = data.retorno || {};

    // Extrai telefones
    const telefones = (retorno.telefones || []).map(t => ({
      numero: t.telefoneComDDD,
      tipo: t.tipoTelefone,
      operadora: t.operadora,
      whatsapp: t.whatsApp,
      bloqueado: t.telemarketingBloqueado
    }));

    // Filtra WhatsApp não bloqueado
    const telefonesWhatsApp = telefones.filter(t => t.whatsapp && !t.bloqueado);

    res.json({
      ok: true,
      cpf: retorno.cpf,
      nome: retorno.nome,
      dataNascimento: retorno.dataNascimento,
      nomeMae: retorno.nomeMae,

      telefones,
      telefonesWhatsApp,
      melhorTelefone: telefonesWhatsApp[0]?.numero || telefones[0]?.numero,

      endereco: (retorno.enderecos || [])[0],
      emails: (retorno.emails || []).map(e => e.enderecoEmail),

      rendaEstimada: retorno.rendaEstimada,
      faixaSalarial: retorno.rendaFaixaSalarial,

      logs
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e), logs });
  }
});

// ===== POST /api/pdf - Gera PDF do Dossiê =====
app.post("/api/pdf", async (req, res) => {
  try {
    const {
      tribunal, vara, processo, data_ato, pf_nome,
      valor_brl, tipo_ato, banco_pagador, id_ato,
      fee_percent, link_pje
    } = req.body || {};

    if (!processo || !pf_nome) {
      return res.status(400).json({ ok: false, error: "Campos obrigatórios: processo, pf_nome" });
    }

    // Gera QR Code
    let qrcodeDataUrl = "";
    const link = link_pje || id_ato || "";
    if (link) {
      try { qrcodeDataUrl = await QRCode.toDataURL(link, { margin: 0 }); } catch {}
    }

    // Template HTML
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
    <div class="badge">${safe(valor_brl || "VALOR A CONFIRMAR")} &nbsp;|&nbsp; ${safe(tipo_ato || "ALVARÁ")} EXPEDIDO EM NOME DA PF</div>

    <h2>PROVA (VERIFICAÇÃO OFICIAL)</h2>
    <div class="box">
      <div class="row" style="align-items:center;">
        <div style="flex:1;">
          <div class="muted">ID/URL DO ATO</div>
          <div class="mono">${safe(id_ato || link_pje)}</div>
          <div class="hr"></div>
          <div class="muted">Como verificar:</div>
          <ul>
            <li>Acesse o portal do Tribunal (ou pesquise pelo nº do processo).</li>
            <li>Confirme a <b>expedição de e-Alvará/levantamento</b> e o <b>nome da PF</b>.</li>
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
        <li>Levar <b>RG/CPF</b>, <b>nº do processo</b> e <b>código/ID do e-Alvará</b>.</li>
        <li>Agência com <b>tesouraria/gerência</b> agiliza o atendimento.</li>
        <li>Prazo prático: <b>3–7 dias</b> (casos pontuais até 15).</li>
      </ul>
    </div>

    <h2>REMUNERAÇÃO (PÓS-CRÉDITO)</h2>
    <div class="box">
      <ul>
        <li>Sem adiantamento. Sem senha. Sem procuração.</li>
        <li>Você só me paga <b>${safe(fee_percent || "15")}%</b> após o crédito cair na sua conta.</li>
        <li>Emitimos recibo no ato do pagamento do fee.</li>
      </ul>
    </div>

    <div class="hr"></div>
    <div class="foot">
      Operação TORRE — Dossiê PF e-Alvará (TRT/TJ). Documento informativo; não há prestação de serviços jurídicos.
      <br/>Reforço anti-golpe: nunca solicitamos adiantamento. Verifique o ato pelo QR/URL acima.
    </div>
  </div>
</body>
</html>`;

    // Salva HTML
    const fileName = `dossie-${Date.now()}.html`;
    const filePath = path.join(PDF_DIR, fileName);
    await fsp.writeFile(filePath, html, 'utf8');

    res.json({
      ok: true,
      html: `${BASE_URL}/pdf/${fileName}`,
      mensagem: "HTML gerado com sucesso."
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ===== Start =====
app.listen(PORT, () => console.log(`TORRE v10.0 rodando na porta ${PORT}`));