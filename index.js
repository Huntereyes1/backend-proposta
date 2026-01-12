app.post('/gerar-proposta', async (req, res) => {
  try {
    const {
      nome_empresa,
      nome_cliente,
      tipo_servico,
      comprimento_m,
      largura_m,
      altura_m,
      volume_aprovado_m3
    } = req.body;

    const comprimento = Number(comprimento_m);
    const largura = Number(largura_m);
    const altura = Number(altura_m);
    const volumeAprovado = Number(volume_aprovado_m3);

    if (
      !nome_empresa ||
      !nome_cliente ||
      !tipo_servico ||
      !Number.isFinite(comprimento) ||
      !Number.isFinite(largura) ||
      !Number.isFinite(altura) ||
      !Number.isFinite(volumeAprovado)
    ) {
      return res.status(400).send('❌ Dados inválidos.');
    }

    const area = (comprimento * largura).toFixed(2);
    const volume = (area * altura).toFixed(2);
    const diferenca = (volume - volumeAprovado).toFixed(2);

    let html = fs.readFileSync(
      path.join(__dirname, 'template.html'),
      'utf8'
    );

    html = html
      .replace('{{nome_empresa}}', nome_empresa)
      .replace('{{nome_cliente}}', nome_cliente)
      .replace('{{tipo_servico}}', tipo_servico)
      .replace('{{comprimento}}', comprimento)
      .replace('{{largura}}', largura)
      .replace('{{altura}}', altura)
      .replace('{{area}}', area)
      .replace('{{volume}}', volume)
      .replace('{{volume_aprovado}}', volumeAprovado)
      .replace('{{diferenca}}', diferenca);

    const fileName = `proposta-${Date.now()}.pdf`;
    const filePath = path.join(PDF_DIR, fileName);

    const browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.pdf({ path: filePath, format: 'A4' });
    await browser.close();

    lastPdfFile = fileName;

    res.send(`${BASE_URL}/pdf/${fileName}`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro interno');
  }
});
