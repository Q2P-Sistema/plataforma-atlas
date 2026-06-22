# Especificação Técnica: Módulo de Comparativo de Estoques (ACXE vs Q2P)

## 1. Contexto
Esta especificação detalha a lógica de negócios e as regras de transformação de dados para a funcionalidade de "Comparativo de Estoques" a ser implementada no módulo **Stockbridge** do aplicativo **Atlas**. O objetivo desta funcionalidade é reconciliar as posições de estoque entre duas empresas/sistemas (ACXE e Q2P), identificando divergências físicas, estoques negativos e falhas de espelhamento.

## 2. Fontes de Dados (Inputs)

O módulo deverá processar as seguintes estruturas de dados de origem. Idealmente, os bancos de dados do Atlas já terão essas entidades.

### 2.1. Posições de Estoque (Dados transacionais)
Espera-se receber um conjunto de dados unificado contendo as posições de estoque das duas origens (ACXE e Q2P).
**Campos Obrigatórios:**
- `cCodigo` (String): Código SKU do produto (utilizado para filtros de exclusão).
- `codigo_local_estoque` (Integer): ID de relacionamento do local de estoque.
- `dDataPosicao` (Date/Datetime): Data de referência do saldo reportado.
- `cDescricao` (String): Nome/Descrição do produto.
- `fisico` (Integer/Float): Saldo físico atual do estoque no sistema.

### 2.2. Locais de Estoque (Dados mestres)
Tabela de mapeamento ("De -> Para") que classifica e roteia os locais de estoque.
**Campos Obrigatórios:**
- `codigo_local_estoque` (Integer): Chave de relacionamento (PK) com a tabela de Posições.
- `codigo` (String): Código textual do armazém/local.
- `descricao` (String): Nome legível do armazém/local.
- `Tipo` (String): Classificação do local (Nota: `"ESPELHADO"` é uma *flag* de regra de negócio importante).
- `Empresa` (String): Origem do dado daquele local (ex: `"ACXE"`, `"Q2P"`).

---

## 3. Lógica de Processamento (Pipeline de Dados no Backend)

O serviço de processamento (ou agregação SQL do Backend) deverá executar as seguintes etapas:

### Etapa 1: Filtros de Exclusão (Blacklist de Produtos)
Ignorar e remover da base de cálculo qualquer registro cujo `cCodigo` inicie com os seguintes prefixos:
- `CONS_` (Itens de consumo)
- `PRD00001`
- `SUC-` (Sucata)
- `STRETCH`

### Etapa 2: Normalização e Enriquecimento (Joins)
1. **Normalização do Produto:** Criar uma chave textual padronizada do produto convertendo a descrição para maiúsculo e removendo espaços nas extremidades (ex: `Trim(Upper(cDescricao))`).
2. **Relacionamento:** Fazer um *Left Outer Join* da tabela de Posições de Estoque com a tabela de Locais de Estoque utilizando a chave `codigo_local_estoque`.
3. **Filtro de Integridade:** Descartar registros órfãos que não possuam mapeamento válido (onde `Empresa` ou o `codigo_local_estoque` na tabela de Locais sejam nulos).

### Etapa 3: Agrupamento e Transposição (Pivot)
Os dados enriquecidos devem ser agrupados pelas dimensões qualitativas:
- Data da Posição
- Código do Estoque
- Nome/Descrição do Estoque
- Tipo do Estoque
- Nome Normalizado do Produto

Para cada agrupamento, a métrica `fisico` deve ser **Pivotada (Transposta)** com base na coluna `Empresa`. 
O resultado deve criar duas novas colunas contendo a soma dos saldos: uma para `ACXE` e outra para `Q2P`.
*Regra de Tratamento:* Caso um produto exista no estoque Q2P mas não possua contrapartida no ACXE (ou vice-versa), o valor nulo gerado deve ser consolidado como `0`.

### Etapa 4: Engine de Regras de Negócio e Auditoria

Para cada registro processado na Etapa 3, o sistema deve computar os indicadores dinâmicos de auditoria:

**A. Diferença Matemática:**
`Diferença = Saldo ACXE - Saldo Q2P`

**B. Status de Saldo Negativo:**
Identifica quebras de estoque físico virtual:
- Se `ACXE < 0` e `Q2P < 0` $\rightarrow$ `"ACXE e Q2P negativos"`
- Se `ACXE < 0` $\rightarrow$ `"ACXE negativo"`
- Se `Q2P < 0` $\rightarrow$ `"Q2P negativo"`
- Caso contrário $\rightarrow$ `"OK"`

**C. Status Geral de Reconciliação:**
Determina o nível de alerta do item. A regra deve ser processada na **exata ordem de prioridade** abaixo:
1. Se `Tipo == "ESPELHADO"` E `Diferença != 0` E `Saldo Negativo != "OK"` $\rightarrow$ **`"Divergente e Negativo"`**
2. Se `Tipo == "ESPELHADO"` E `Diferença != 0` $\rightarrow$ **`"Divergente"`**
3. Se `Saldo Negativo != "OK"` $\rightarrow$ **`"Negativo"`**
4. Caso contrário $\rightarrow$ **`"OK"`**

---

## 4. Estrutura de Saída (API Response) e Ordenação

Os dados devem ser ordenados na API antes de serem paginados/entregues ao Frontend, garantindo que os problemas logísticos sejam vistos primeiro:
1. `Status Geral` (Descendente $\rightarrow$ Traz Divergentes e Negativos para o topo)
2. `Tipo do Estoque` (Ascendente)
3. `Descrição do Estoque` (Ascendente)
4. `Produto` (Ascendente)
5. `Data da Posição` (Ascendente)

**Schema JSON Sugerido para a Interface da API:**
```typescript
interface StockReconciliationRow {
  dataPosicao: string; // ISO-8601 Date
  codigoEstoque: string;
  nomeEstoque: string;
  tipoEstoque: string;
  produto: string;
  saldoQ2P: number; // Inteiro/Float tratado
  saldoACXE: number; // Inteiro/Float tratado
  diferenca: number;
  statusSaldoNegativo: "ACXE e Q2P negativos" | "ACXE negativo" | "Q2P negativo" | "OK";
  statusGeral: "Divergente e Negativo" | "Divergente" | "Negativo" | "OK";
}
```

## 5. UX/UI para o Frontend do Atlas (Stockbridge)

Para a construção da tela no módulo **Stockbridge**, recomende ao agente construtor as seguintes implementações visuais:

1. **Codificação por Cores (Data Grid):**
   - Linhas com `"Divergente e Negativo"` devem utilizar tons críticos (Ex: Background vermelho-claro, texto vermelho-escuro).
   - Linhas `"Divergente"` ou `"Negativo"` devem alertar visualmente (Ex: Tons de laranja ou amarelo).
   - Linhas com Status `"OK"` podem ser exibidas com visualização neutra ou minimizada.

2. **Filtros Rápidos e Ações (Chips):**
   - Adicionar botões no topo da tabela para filtros One-Click: `[ Apenas Divergentes ]`, `[ Estoque Negativo ]`, `[ Ignorar Status OK ]`.

3. **Dashboard de Resumo (KPI Cards):**
   - Exibir acima da tabela métricas operacionais sumarizadas desta visualização:
     - *Total de SKUs com Divergência*
     - *Total Financeiro/Quantitativo da Diferença*
     - *Total de Quebras (Negativos)*
