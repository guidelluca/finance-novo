/**
 * Identifica o estabelecimento por trás de descritores de fatura/extrato
 * ("IFD*NAMASTE SALAD REST", "99*SAO PAULOBR", "EBN*TIKTOK SH", "PAYGO*ENCOUNTER", "UBER * PENDINGSAO PAULO").
 *
 * 100% local (dicionário + heurísticas): grátis e sem limite. Sem dependências — testável isoladamente.
 * Devolve nome legível, tipo, "via" (app/maquininha intermediária) e categorias candidatas
 * (nomes; o app escolhe a primeira que o usuário tiver).
 */

export type MerchantInfo = {
  /** Nome legível: "iFood · Namaste Salad", "99 (corrida)", "Supermercados Dalben" */
  name: string
  /** Tipo do gasto: "Delivery", "Mercado", "Transporte por app"… */
  kind: string | null
  /** Intermediário: iFood, Mercado Pago, PagSeguro, maquininha… */
  via: string | null
  /** Nomes de categoria, em ordem de preferência */
  categories: string[]
  /** Trecho estável da descrição original (minúsculo) para criar regra aprendida */
  ruleKey: string | null
}

type Cat = readonly string[]
const C = {
  delivery: ['Ifood', 'iFood', 'Delivery', 'Restaurantes', 'Alimentação'],
  restaurante: ['Restaurantes', 'Restaurante', 'Alimentação', 'Lanche'],
  lanche: ['Lanche', 'Lanche e café', 'Café', 'Restaurantes', 'Alimentação'],
  padaria: ['Padaria', 'Lanche', 'Lanche e café', 'Alimentação'],
  bar: ['Bar', 'Bares', 'Restaurantes', 'Lazer', 'Alimentação'],
  mercado: ['Mercado', 'Supermercado', 'Alimentação'],
  appTransporte: ['Uber', 'Transporte'],
  transportePublico: ['Transporte', 'Ônibus', 'Transporte público'],
  salario: ['Salário', 'Renda', 'Receitas'],
  rendimento: ['Rendimentos', 'Investimentos'],
  emprestimo: ['Empréstimos', 'Dívidas'],
  combustivel: ['Combustível', 'Carro', 'Transporte'],
  taxas: ['Taxas', 'Impostos', 'Tarifas'],
  estacionamento: ['Estacionamento', 'Carro', 'Transporte'],
  saude: ['Saúde', 'Farmácia'],
  assinatura: ['Assinaturas', 'Contas Mensais'],
  contas: ['Contas Mensais', 'Contas'],
  comprasOnline: ['Compras', 'Compras online'],
  roupas: ['Roupas', 'Vestuário', 'Compras'],
  viagem: ['Viagem', 'Lazer'],
  lazer: ['Lazer'],
  academia: ['Academia', 'Saúde'],
  cuidado: ['Auto cuidado', 'Beleza'],
  educacao: ['Educação', 'Estudos'],
  pet: ['Pet', 'Pets'],
} satisfies Record<string, Cat>

/** Prefixos de intermediários (gateway/app) — o resto da descrição é o estabelecimento. */
const VIA_PREFIXES: { re: RegExp; via: string; categories?: Cat; kind?: string }[] = [
  { re: /^IFD\s?\*\s?/i, via: 'iFood', categories: C.delivery, kind: 'Delivery' },
  { re: /^IFOOD(?!\.COM)\s?\*?\s?/i, via: 'iFood', categories: C.delivery, kind: 'Delivery' },
  { re: /^RAPPI\s?\*?\s?/i, via: 'Rappi', categories: C.delivery, kind: 'Delivery' },
  { re: /^MP\s?\*\s?/i, via: 'Mercado Pago' },
  { re: /^MERCADOPAGO\s?\*\s?/i, via: 'Mercado Pago' },
  { re: /^PG\s?\*\s?/i, via: 'PagSeguro' },
  { re: /^PAG\s?\*\s?/i, via: 'PagSeguro' },
  { re: /^PAGSEGURO\s?\*?\s?/i, via: 'PagSeguro' },
  { re: /^PAYGO\s?\*\s?/i, via: 'maquininha PayGo' },
  { re: /^SUMUP\s?\*\s?|^SUM\s?\*\s?/i, via: 'maquininha SumUp' },
  { re: /^STONE\s?\*\s?/i, via: 'maquininha Stone' },
  { re: /^TON\s?\*\s?/i, via: 'maquininha Ton' },
  { re: /^CIELO\s?\*\s?/i, via: 'maquininha Cielo' },
  { re: /^GETNET\s?\*\s?/i, via: 'maquininha Getnet' },
  { re: /^PICPAY\s?\*\s?/i, via: 'PicPay' },
  { re: /^EBN\s?\*\s?|^EBANX\s?\*?\s?/i, via: 'Ebanx (compra internacional)' },
  { re: /^DL\s?\*\s?|^DLOCAL\s?\*?\s?/i, via: 'dLocal (compra internacional)' },
  { re: /^PAYPAL\s?\*\s?/i, via: 'PayPal' },
  { re: /^ZIG\s?\*\s?/i, via: 'ZIG (pagamento em evento/bar)', categories: C.bar, kind: 'Bar / evento' },
  { re: /^APOIASE\s?\*\s?/i, via: 'Apoia.se', categories: C.assinatura, kind: 'Apoio a criador' },
]

/** Marcas e padrões conhecidos (testados na descrição já sem prefixo e sem cidade). */
const KNOWN: { re: RegExp; name: string | ((m: RegExpMatchArray) => string); kind: string; categories: Cat }[] = [
  // Linhas de extrato de conta (Itaú e outros bancos)
  { re: /^FATURA PAGA|^PAG(TO|AMENTO)?\.? (DE |DA )?FATURA/i, name: 'Pagamento de fatura', kind: 'Pagamento de fatura', categories: [] },
  { re: /REMUNERA[CÇ][AÃ]O\s?\/?\s?SAL[AÁ]RIO|CR[EÉ]DITO (DE )?SAL[AÁ]RIO|^SAL[AÁ]RIO\b|^PAGTO\.? SAL[AÁ]RIO/i, name: 'Salário', kind: 'Salário', categories: C.salario },
  { re: /^TED\s+[\d.]+\.(.+)$/i, name: (m) => `TED · ${titleCase(m[1]!)}`, kind: 'Transferência (TED)', categories: [] },
  { re: /^REND(IMENTO)?S?\.?\s+(PAGO|APLIC)|^RENDIMENTO/i, name: 'Rendimento da aplicação', kind: 'Rendimento', categories: C.rendimento },
  { re: /CREDI[AÁ]RIO|CONSIGNADO|EMPR[EÉ]STIMO|CR[EÉ]DITO LIBERAD/i, name: (m) => titleCase(m.input ?? m[0]!), kind: 'Empréstimo / crediário', categories: C.emprestimo },
  { re: /^EST(ORNO)?\s+/i, name: (m) => `Estorno · ${titleCase((m.input ?? '').replace(/^EST(ORNO)?\s+/i, ''))}`, kind: 'Estorno', categories: [] },
  { re: /^MERCADO\s?PAG(O)?\b/i, name: 'Mercado Pago (pagamento)', kind: 'Pagamento via Mercado Pago', categories: [] },
  { re: /^IFOOD\.COM/i, name: 'iFood', kind: 'Delivery', categories: C.delivery },
  { re: /^VIA[CÇ][AÃ]O\b/i, name: (m) => `Ônibus · ${titleCase(m.input ?? m[0]!)}`, kind: 'Transporte público', categories: C.transportePublico },
  { re: /AUTOPASS|^PAY AUTOP|^AUTOP\b/i, name: 'Autopass (ônibus/metrô)', kind: 'Transporte público', categories: C.transportePublico },
  { re: /^IOF\b/i, name: 'IOF', kind: 'Imposto', categories: C.taxas },
  { re: /ANUIDADE|TARIFA|JUROS|ENCARGOS|MULTA/i, name: (m) => titleCase(m.input ?? m[0]!), kind: 'Tarifa / juros', categories: C.taxas },
  // Transporte por app
  { re: /^UBER\s*\*?\s*EATS/i, name: 'Uber Eats', kind: 'Delivery', categories: C.delivery },
  { re: /^UBER\b/i, name: 'Uber (corrida)', kind: 'Transporte por app', categories: C.appTransporte },
  { re: /^99\s?FOOD|^99\s?\*?\s?FOOD/i, name: '99Food', kind: 'Delivery', categories: C.delivery },
  { re: /^99\s?(\*|POP|APP|TAXI|$)/i, name: '99 (corrida)', kind: 'Transporte por app', categories: C.appTransporte },
  { re: /^CABIFY/i, name: 'Cabify', kind: 'Transporte por app', categories: C.appTransporte },
  { re: /^INDRIVE/i, name: 'inDrive', kind: 'Transporte por app', categories: C.appTransporte },
  // Assinaturas / digitais
  { re: /^APPLE\.?COM|^APPLE\s/i, name: 'Apple (App Store/iCloud)', kind: 'Assinatura digital', categories: C.assinatura },
  { re: /^GOOGLE\s?\*?\s?(YOUTUBE|YT)/i, name: 'YouTube Premium', kind: 'Assinatura digital', categories: C.assinatura },
  { re: /^GOOGLE/i, name: 'Google (Play/One)', kind: 'Assinatura digital', categories: C.assinatura },
  { re: /NETFLIX/i, name: 'Netflix', kind: 'Streaming', categories: C.assinatura },
  { re: /SPOTIFY/i, name: 'Spotify', kind: 'Streaming', categories: C.assinatura },
  { re: /DISNEY/i, name: 'Disney+', kind: 'Streaming', categories: C.assinatura },
  { re: /\bHBO|^MAX\b/i, name: 'Max (HBO)', kind: 'Streaming', categories: C.assinatura },
  { re: /GLOBOPLAY/i, name: 'Globoplay', kind: 'Streaming', categories: C.assinatura },
  { re: /PRIME\s?VIDEO|AMAZON\s?PRIME|AMZN\s?PRIME/i, name: 'Amazon Prime', kind: 'Streaming', categories: C.assinatura },
  { re: /DEEZER/i, name: 'Deezer', kind: 'Streaming', categories: C.assinatura },
  { re: /ANTHROPIC|CLAUDE\.AI/i, name: 'Claude (Anthropic)', kind: 'Assinatura digital', categories: C.assinatura },
  { re: /OPENAI|CHATGPT/i, name: 'ChatGPT (OpenAI)', kind: 'Assinatura digital', categories: C.assinatura },
  { re: /MICROSOFT|XBOX/i, name: 'Microsoft / Xbox', kind: 'Assinatura digital', categories: C.assinatura },
  { re: /PLAYSTATION|SONY\s?INTERACTIVE|PSN/i, name: 'PlayStation', kind: 'Jogos', categories: C.lazer },
  { re: /STEAM/i, name: 'Steam', kind: 'Jogos', categories: C.lazer },
  { re: /^CANVA/i, name: 'Canva', kind: 'Assinatura digital', categories: C.assinatura },
  { re: /TIKTOK/i, name: 'TikTok Shop', kind: 'Compra online', categories: C.comprasOnline },
  // Lojas online
  { re: /^AMAZON|^AMZN/i, name: 'Amazon', kind: 'Compra online', categories: C.comprasOnline },
  { re: /MERCADO\s?LIVRE|MERCADOLIV|^MERCADOLIVRE/i, name: 'Mercado Livre', kind: 'Compra online', categories: C.comprasOnline },
  { re: /SHOPEE/i, name: 'Shopee', kind: 'Compra online', categories: C.comprasOnline },
  { re: /SHEIN/i, name: 'Shein', kind: 'Compra online', categories: C.roupas },
  { re: /ALIEXPRESS|ALIPAY/i, name: 'AliExpress', kind: 'Compra online', categories: C.comprasOnline },
  { re: /MAGALU|MAGAZINE\s?LUIZA/i, name: 'Magalu', kind: 'Compra online', categories: C.comprasOnline },
  { re: /KABUM/i, name: 'KaBuM!', kind: 'Compra online', categories: C.comprasOnline },
  // Viagem
  { re: /AIRBNB/i, name: 'Airbnb', kind: 'Hospedagem', categories: C.viagem },
  { re: /BOOKING/i, name: 'Booking', kind: 'Hospedagem', categories: C.viagem },
  { re: /LATAM|GOL\s?LINHAS|\bAZUL\b|VOEGOL/i, name: (m) => (/LATAM/i.test(m[0]) ? 'LATAM' : /AZUL/i.test(m[0]) ? 'Azul' : 'GOL'), kind: 'Passagem aérea', categories: C.viagem },
  { re: /BUSER|CLICKBUS|RODOVIARIA/i, name: 'Passagem de ônibus', kind: 'Passagem', categories: C.viagem },
  // Contas
  { re: /CONTA\s?VIVO|^VIVO\b|TELEFONICA/i, name: 'Vivo', kind: 'Celular / internet', categories: C.contas },
  { re: /^CLARO\b|^NET\s?SERV/i, name: 'Claro', kind: 'Celular / internet', categories: C.contas },
  { re: /^TIM\b/i, name: 'TIM', kind: 'Celular / internet', categories: C.contas },
  { re: /\bENEL\b|\bCPFL\b|ELEKTRO|EDP\b/i, name: (m) => m[0]!.toUpperCase(), kind: 'Energia', categories: C.contas },
  { re: /SABESP|SANASA/i, name: (m) => m[0]!.toUpperCase(), kind: 'Água', categories: C.contas },
  // Saúde
  { re: /DROGA\s?RAIA|DROGASIL|DROGAL|DROGARIA|PACHECO|PAGUE\s?MENOS|FARMAIS|FARM[AÁ]CIA|PANVEL|ULTRAFARMA/i, name: (m) => titleCase(m.input ?? m[0]!), kind: 'Farmácia', categories: C.saude },
  // Mercado
  { re: /SUPERMERC|SUPER\s?MERCA|HIPERMERC|MERCADO\b|MERCEARIA|HORTIFRUT|SACOL[AÃ]O|ATACAD|ASSAI|CARREFOUR|P[AÃ]O\s?DE\s?A[CÇ]UCAR|DALBEN|OXXO|SAMS\s?CLUB|EMP[OÓ]RIO\s?DA\s?FRUTA|MINUTO\s?P[AÃ]O/i, name: (m) => titleCase(m.input ?? m[0]!), kind: 'Mercado', categories: C.mercado },
  // Combustível / carro
  { re: /POSTO|SHELL|IPIRANGA|PETROBRAS|\bBR\s?MANIA|COMBUST/i, name: (m) => titleCase(m.input ?? m[0]!), kind: 'Combustível', categories: C.combustivel },
  { re: /ESTACION|ESTAPAR|ZONA\s?AZUL|SEM\s?PARAR|CONECTCAR|VELOE|PEDAGIO|PED[AÁ]GIO/i, name: (m) => titleCase(m.input ?? m[0]!), kind: 'Estacionamento / pedágio', categories: C.estacionamento },
  // Comida
  // Comer fora, separado: bar → padaria → café/lanche → restaurante (a ordem importa: "BAR E CAFE" é bar)
  { re: /\bBAR\b|BOTECO|CHOPP|CERVEJ|\bPUB\b|ADEGA|TABACARIA|ESPETO|BOTEQUIM|\bBEER\b|BREWING|DRINKS?\b/i, name: (m) => titleCase(m.input ?? m[0]!), kind: 'Bar', categories: C.bar },
  { re: /PADARIA|PANIFIC|PADOCA|\bP[AÃ]ES\b/i, name: (m) => titleCase(m.input ?? m[0]!), kind: 'Padaria', categories: C.padaria },
  { re: /CAF[EÉ]\b|CAFETERIA|COFFEE|KOFFIE|STARBUCKS|SUCOS?\b|AÇA[IÍ]|ACAI|SORVET|GELAT|DOCERIA|CONFEITAR|BRIGADEIR|PASTEL|LANCHONET|LANCHES?\b|SALGAD|COXINHA|CHURROS|DONUTS?/i, name: (m) => titleCase(m.input ?? m[0]!), kind: 'Café / lanche', categories: C.lanche },
  { re: /PIZZ|BURG|HAMBURG|SUSHI|TEMAKI|JAPONES|CHURRASC|RESTAUR|EMP[OÓ]RIO|SALAD|BISTR[OÔ]|CANTINA|GRILL|STEAK|TAQUERIA|RANGO|ALIMENT|COZINHA|TRATTORIA|OSTERIA|PARRILLA|POKE|RAMEN|ESFIH|MASSAS|\bREST(A|AU)?\b|COMIDA/i, name: (m) => titleCase(m.input ?? m[0]!), kind: 'Restaurante', categories: C.restaurante },
  { re: /MCDONALD|MC\s?DONALDS|BURGER\s?KING|\bBK\b|SUBWAY|HABIB|GIRAFFAS|OUTBACK|SPOLETO|CHINA\s?IN\s?BOX|KFC|POPEYES|COCO\s?BAMBU|MADERO/i, name: (m) => titleCase(m[0]!), kind: 'Restaurante', categories: C.restaurante },
  // Roupas
  { re: /RENNER|RIACHUELO|\bC\s?&\s?A\b|\bCEA\b|ZARA|HERING|ADIDAS|NIKE|CENTAURO|NETSHOES|DECATHLON|YOUCOM|MARISA|PERNAMBUC/i, name: (m) => titleCase(m.input ?? m[0]!), kind: 'Roupas / calçados', categories: C.roupas },
  // Lazer
  { re: /CINEMARK|CINEMA|CINEPOLIS|KINOPLEX|INGRESSO|SYMPLA|EVENTIM|TICKET\s?360|BILHETERIA/i, name: (m) => titleCase(m.input ?? m[0]!), kind: 'Cinema / evento', categories: C.lazer },
  // Academia / cuidado
  { re: /SMART\s?FIT|BLUEFIT|BODYTECH|ACADEMIA|GYMPASS|WELLHUB|TOTALPASS|CROSSFIT/i, name: (m) => titleCase(m.input ?? m[0]!), kind: 'Academia', categories: C.academia },
  { re: /BARBEAR|BARBER|SAL[AÃ]O|ESTETIC|MANICURE|BOTIC[AÁ]RIO|NATURA|SEPHORA/i, name: (m) => titleCase(m.input ?? m[0]!), kind: 'Cuidados pessoais', categories: C.cuidado },
  // Educação / pet
  { re: /UDEMY|ALURA|COURSERA|DUOLINGO|LIVRARIA|SARAIVA|ESCOLA|FACULDADE|UNIVERSIDADE|CURSO/i, name: (m) => titleCase(m.input ?? m[0]!), kind: 'Educação', categories: C.educacao },
  { re: /PETZ|COBASI|PET\s?SHOP|VETERIN/i, name: (m) => titleCase(m.input ?? m[0]!), kind: 'Pet', categories: C.pet },
]

const KEEP_UPPER = new Set(['BR', 'SP', 'RJ', 'MG', 'SA', 'LTDA', 'ME', 'EIRELI', 'CPFL', 'ENEL', 'TIM', 'BK', 'KFC', 'C&A'])
const SMALL = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'a', 'o'])

export function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) => {
      if (KEEP_UPPER.has(w.toUpperCase())) return w.toUpperCase()
      if (i > 0 && SMALL.has(w)) return w
      return w.charAt(0).toUpperCase() + w.slice(1)
    })
    .join(' ')
}

const CITIES =
  /(S[AÃ]O\s?PAULO|CAMPINAS|GUARULHOS|OSASCO|JACARE[IÍ]|PIRACICABA|ITAPEVI|SANTOS|BARUERI|SOROCABA|JUNDIA[IÍ]|S[AÃ]O\s?JOS[EÉ]|RIO\s?DE\s?JANEIRO|BELO\s?HORIZONTE|CURITIBA|SALVADOR|BRAS[IÍ]LIA)/i

/**
 * Tira cidade grudada no fim (fatura Itaú: "SUPERMERCADOS DALBENCAM", "UBER * PENDINGSAO PAULO"),
 * sufixos "BR", parcela e ruído de gateway.
 */
export function cleanDescriptor(raw: string, cityHint?: string | null): string {
  let s = raw.replace(/\s*\(parcela \d+\/\d+\)\s*$/i, '').replace(/\s+/g, ' ').trim()
  const city = cityHint?.trim().toUpperCase()
  if (city && city.length >= 3) {
    // corta o maior prefixo da cidade que esteja colado no fim (mín. 2 letras)
    const flat = city.replace(/\s+/g, ' ')
    for (let n = flat.length; n >= 2; n--) {
      const pref = flat.slice(0, n)
      if (s.toUpperCase().endsWith(pref) || s.toUpperCase().endsWith(pref + 'B') || s.toUpperCase().endsWith(pref + 'BR')) {
        const cut = s.toUpperCase().lastIndexOf(pref)
        if (cut > 2) {
          s = s.slice(0, cut).trim()
          break
        }
      }
    }
  }
  s = s.replace(new RegExp(`${CITIES.source}\\s?(BR?)?$`, 'i'), '').trim()
  s = s
    .replace(/\s*\*\s*(TRIP|PENDING|HELP\.?U?|EATS)?\s*(HELP\.U)?$/i, (m) => (/EATS/i.test(m) ? ' EATS' : ''))
    .replace(/\s+BR$/i, '')
    .replace(/[-_*.\s]+$/, '')
    .trim()
  return s || raw.trim()
}

/** Parece nome de pessoa (Pix/maquininha de autônomo)? */
function looksLikePerson(s: string): boolean {
  const words = s.trim().split(/\s+/)
  if (words.length < 2 || words.length > 6) return false
  if (/\d|\*|\.|\//.test(s)) return false
  return /\b(DA|DE|DO|DOS|DAS)\b/i.test(s) && words.every((w) => /^[A-Za-zÀ-ÿ]+$/.test(w))
}

function ruleKeyFrom(core: string, raw: string): string | null {
  const lowerRaw = raw.toLowerCase()
  const words = core
    .toLowerCase()
    .replace(/[^a-z0-9à-ÿ&\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2)
  for (let n = Math.min(3, words.length); n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const cand = words.slice(i, i + n).join(' ')
      if (cand.length >= 4 && lowerRaw.includes(cand)) return cand
    }
  }
  return null
}

/** Tipo de operação no começo da descrição (extratos/prints): "Pix enviado · Maria", "Compra no débito · PADARIA". */
const OPERATION_PREFIX =
  /^(pix qrs?|pix cart[aã]o|pag boleto|pix (enviado|recebido|agendado)|pix transf(?:er[eê]ncia)?(?: para)?|transf(?:er[eê]ncia)? pix|transfer[eê]ncia (enviada|recebida)|ted (enviada|recebida)|doc (enviado|recebido)|compra no (d[eé]bito|cr[eé]dito)|compra com cart[aã]o|pagamento de boleto|pagamento (efetuado|realizado)|boleto pago|d[eé]bito autom[aá]tico)\b\s*[·:\-–]?\s*/i

export function identifyMerchant(raw: string, cityHint?: string | null): MerchantInfo {
  // Nubank / Inter escrevem a operação antes do nome e o CPF/banco depois:
  // "Transferência enviada pelo Pix - FULANO - •••.123.578-•• - BANCO INTER (0077) ..."
  // "Pagamento de boleto efetuado - LANZA IMOVEIS LTDA" · "Pix recebido: Cp :18236120-Fulano de Tal"
  const nuOp = raw.match(
    /^(transfer[eê]ncia (enviada|recebida)( pelo pix)?|pagamento de boleto efetuado|pagamento de fatura|compra no d[eé]bito( via nupay)?|pix (enviado|recebido)|pagamento efetuado|estorno)\s*[-:–]\s*(.+)$/i,
  )
  if (nuOp && !/·\s*conta pr[oó]pria$/i.test(raw)) {
    const rest = nuOp[6]!
      .replace(/^"|"$/g, '')
      .replace(/^cp\s*:\s*\d+\s*-\s*/i, '')
      .split(/\s+-\s+(?=[•*\d]|cpf|cnpj|ag[eê]ncia|banco|bco|nu pagamentos|caixa|ita[uú]|picpay|mercado pago|inter\b)/i)[0]!
      .trim()
    if (rest.length >= 2) {
      const inner = identifyMerchant(rest, cityHint)
      const op = nuOp[1]!.toLowerCase()
      const kind = /boleto/.test(op) ? 'Boleto' : /pix|transfer/.test(op) ? (/recebid/.test(op) ? 'Pix recebido' : 'Pix enviado') : /d[eé]bito/.test(op) ? 'Débito' : inner.kind
      return { ...inner, kind: inner.categories.length ? inner.kind : kind }
    }
  }
  if (/·\s*conta pr[oó]pria$/i.test(raw)) {
    return {
      name: 'Você · outra conta',
      kind: 'Transferência entre suas contas',
      via: null,
      categories: ['Transferências', 'Pix'],
      ruleKey: null,
    } as MerchantInfo
  }
  let core = cleanDescriptor(raw, cityHint)
  let operation: string | null = null
  const op = core.match(OPERATION_PREFIX)
  if (op && core.length > op[0].length + 1) {
    operation = op[1]!.charAt(0).toUpperCase() + op[1]!.slice(1).toLowerCase()
    core = core.slice(op[0].length).trim()
  }
  // Pix por QR code é compra (paga um estabelecimento), não transferência para pessoa
  const opCats: string[] =
    operation && /^pix|transfer|ted|doc/i.test(operation) && !/qr|boleto/i.test(operation) ? ['Pix', 'Transferências'] : []
  const info = identifyCore(core, raw, operation)
  // Pix/transferência para pessoa: categoria "Pix" só se nada mais específico foi achado
  if (opCats.length && info.categories.length === 0) info.categories = opCats
  return info
}

function identifyCore(coreIn: string, raw: string, operation: string | null): MerchantInfo {
  let core = coreIn
  let via: string | null = null
  let viaCats: Cat | undefined
  let viaKind: string | undefined

  for (const p of VIA_PREFIXES) {
    if (p.re.test(core)) {
      via = p.via
      viaCats = p.categories
      viaKind = p.kind
      core = core.replace(p.re, '').trim()
      break
    }
  }
  // "UBER UBER *TRIP" (PicPay repete a marca); CNPJ antes do nome ("43.653.398 ENZO")
  core = core.replace(/^(\w+)\s+\1\b/i, '$1').replace(/^[\d./-]{6,}\s+/, '')

  for (const k of KNOWN) {
    const m = core.match(k.re) ?? (via ? null : raw.match(k.re))
    if (!m) continue
    const base = typeof k.name === 'function' ? k.name(Object.assign(m, { input: core })) : k.name
    const name = via && viaKind === 'Delivery' && !/food|eats/i.test(base) ? `${via} · ${base}` : base
    const brandKey = m[0]!.toLowerCase().trim()
    return {
      name,
      kind: viaKind ?? k.kind ?? operation,
      via: via && !name.startsWith(via) ? via : null,
      categories: [...(viaCats ?? []), ...k.categories],
      ruleKey: ruleKeyFrom(core, raw) ?? (brandKey.length >= 3 && raw.toLowerCase().includes(brandKey) ? brandKey : null),
    }
  }

  const pretty = titleCase(core)
  if (via) {
    return {
      name: viaKind === 'Delivery' ? `${via} · ${pretty}` : pretty || via,
      kind: viaKind ?? null,
      via: viaKind === 'Delivery' ? null : via,
      categories: [...(viaCats ?? [])],
      ruleKey: ruleKeyFrom(core, raw),
    }
  }
  if (looksLikePerson(core)) {
    return { name: pretty, kind: operation ?? 'Pessoa / autônomo', via: null, categories: [], ruleKey: ruleKeyFrom(core, raw) }
  }
  return { name: pretty, kind: operation, via: null, categories: [], ruleKey: ruleKeyFrom(core, raw) }
}

/** Escolhe a primeira categoria candidata que o usuário tenha (ignora maiúsculas/acentos). */
export function pickCategoryId(candidates: readonly string[], categories: { id: string; name: string }[]): string | null {
  const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase()
  for (const c of candidates) {
    const hit = categories.find((x) => norm(x.name) === norm(c))
    if (hit) return hit.id
  }
  return null
}
