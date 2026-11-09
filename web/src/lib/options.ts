// Listas das caixas de seleção. São sugestões: dá pra digitar qualquer outra coisa.

export const SERVICES = [
  'eletricista', 'encanador', 'chaveiro', 'pintor', 'pedreiro', 'marceneiro', 'montador de móveis',
  'técnico em ar-condicionado', 'técnico em máquina de lavar', 'técnico de eletrodomésticos', 'vidraceiro', 'jardineiro', 'diarista',
];

export const CITIES = [
  'Porto Alegre', 'Canoas', 'Novo Hamburgo', 'São Leopoldo', 'Gravataí', 'Viamão', 'Alvorada', 'Cachoeirinha', 'Guaíba', 'Esteio', 'Sapucaia do Sul',
];

const PORTO_ALEGRE = [
  'Agronomia', 'Anchieta', 'Arquipélago', 'Auxiliadora', 'Azenha', 'Bela Vista', 'Belém Novo', 'Belém Velho', 'Boa Vista', 'Boa Vista do Sul',
  'Bom Fim', 'Bom Jesus', 'Camaquã', 'Campo Novo', 'Cascata', 'Cavalhada', 'Cel. Aparício Borges', 'Centro Histórico', 'Chácara das Pedras',
  'Chapéu do Sol', 'Cidade Baixa', 'Costa e Silva', 'Cristal', 'Cristo Redentor', 'Espírito Santo', 'Extrema', 'Farrapos', 'Farroupilha',
  'Floresta', 'Glória', 'Guarujá', 'Higienópolis', 'Hípica', 'Humaitá', 'Independência', 'Ipanema', 'Jardim Botânico', 'Jardim Carvalho',
  'Jardim do Salso', 'Jardim Europa', 'Jardim Floresta', 'Jardim Isabel', 'Jardim Itu', 'Jardim Leopoldina', 'Jardim Lindóia', 'Jardim Sabará',
  'Jardim São Pedro', 'Lageado', 'Lami', 'Lomba do Pinheiro', 'Medianeira', 'Menino Deus', 'Moinhos de Vento', 'Mont\'Serrat', 'Morro Santana',
  'Navegantes', 'Nonoai', 'Parque Santa Fé', 'Partenon', 'Passo da Areia', 'Passo das Pedras', 'Pedra Redonda', 'Petrópolis', 'Ponta Grossa',
  'Praia de Belas', 'Restinga', 'Rio Branco', 'Rubem Berta', 'Santa Cecília', 'Santa Maria Goretti', 'Santa Rosa de Lima', 'Santa Tereza',
  'Santana', 'Santo Antônio', 'São Geraldo', 'São João', 'São José', 'São Sebastião', 'Sarandi', 'Serraria', 'Teresópolis', 'Três Figueiras',
  'Tristeza', 'Vila Assunção', 'Vila Conceição', 'Vila Ipiranga', 'Vila Jardim', 'Vila João Pessoa', 'Vila Nova',
];

/** Bairros conhecidos da cidade. Fora de Porto Alegre, por enquanto, é digitação livre. */
export const neighborhoodsOf = (city: string) => (fold(city) === 'porto alegre' ? PORTO_ALEGRE : []);

/** Compara sem acento nem maiúscula. */
export function fold(s: string) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}
