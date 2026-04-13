# Feature Specification: Hedge Engine — Fechamento de Gaps Pendentes

**Feature Branch**: `004-hedge-gaps-closure`  
**Created**: 2026-04-13  
**Status**: Draft  
**Input**: Gaps pendentes documentados em `docs/gap-analysis-hedge-legacy-vs-atlas.md`

## Context

O motor de hedge cambial USD/BRL do Atlas esta funcional com 16 de 22 gaps resolvidos. Restam 7 pendencias (3 parciais + 2 pendentes + 2 nice-to-have) que afetam a fidelidade dos calculos, a performance e a paridade funcional com o sistema legado. Esta spec cobre o fechamento dessas pendencias.

## User Scenarios & Testing

### User Story 1 — Exposicao precisa por bucket (Priority: P1)

O gestor de hedge precisa que a exposicao cambial por mes (bucket) reflita o valor real incluindo estoque importado nao pago. Hoje o sistema mostra apenas contas a pagar em USD, mas a exposicao real inclui estoque que ja esta no armazem e ainda nao foi pago ao fornecedor.

**Why this priority**: Afeta diretamente a fidelidade do calculo de cobertura. Buckets subestimados geram recomendacoes de hedge menores do que deveriam, expondo a empresa a risco cambial nao coberto.

**Independent Test**: Comparar a exposicao por bucket no Atlas com o calculo do sistema legado. A diferenca deve ser inferior a 1% apos incluir estoque nao pago.

**Acceptance Scenarios**:

1. **Given** a view `vw_hedge_resumo` retorna `est_nao_pago_usd = $1.83M` e existem 6 buckets ativos, **When** o sistema recalcula os buckets, **Then** cada bucket recebe uma parcela proporcional do estoque nao pago somada ao `pagar_usd`.
2. **Given** a view retorna `est_nao_pago_usd = 0`, **When** o sistema recalcula os buckets, **Then** a exposicao por bucket permanece igual ao `pagar_usd` (sem alteracao).
3. **Given** a exposicao de um bucket aumenta apos incluir estoque nao pago, **When** o motor calcula recomendacoes, **Then** o gap e a quantidade sugerida de NDF refletem a exposicao total (pagar + estoque nao pago).

---

### User Story 2 — Dashboard responsivo com cache (Priority: P2)

O gestor de hedge abre o dashboard varias vezes ao dia para acompanhar a posicao. Hoje cada acesso executa queries pesadas ao banco de dados e chamada a API do BCB, tornando o carregamento lento. O sistema deve responder rapidamente em acessos subsequentes usando dados em cache.

**Why this priority**: Performance do dia-a-dia. A PTAX ja tem cache de 15 minutos, mas posicao e estoque nao. Acessos repetidos ao dashboard nao devem sobrecarregar o banco.

**Independent Test**: Acessar o dashboard 3 vezes em 2 minutos e verificar que a segunda e terceira chamadas retornam em menos de 500ms (vs. 2-5 segundos sem cache).

**Acceptance Scenarios**:

1. **Given** o gestor acessa o dashboard pela primeira vez no dia, **When** os dados sao calculados, **Then** o resultado e armazenado em cache com tempo de vida de 5 minutos.
2. **Given** o cache de posicao esta ativo, **When** o gestor acessa o dashboard novamente, **Then** os dados sao retornados do cache em menos de 500ms.
3. **Given** o cache expirou (apos 5 minutos), **When** o gestor acessa o dashboard, **Then** o sistema recalcula e atualiza o cache.
4. **Given** o gestor dispara uma acao que altera dados (ex: criar NDF), **When** a acao e concluida, **Then** o cache de posicao e invalidado para refletir a mudanca.

---

### User Story 3 — Parametros operacionais completos na Config (Priority: P3)

O gestor ou diretor precisa ajustar parametros operacionais do motor de hedge (custo de financiamento, desvio padrao, prazo de recebimento, tempo medio de transito, giro de estoque). Esses parametros sao exibidos na pagina de Config mas nao tem efeito nos calculos.

**Why this priority**: Completude funcional. Os parametros ja aparecem na UI, mas alterar seus valores nao afeta nada. Nao e critico pois os valores default sao adequados, mas gera confusao.

**Independent Test**: Alterar o parametro `custo_financiamento_pct` na Config e verificar que o novo valor e persistido e retornado corretamente na proxima leitura.

**Acceptance Scenarios**:

1. **Given** o diretor acessa a pagina de Config, **When** ele altera o valor de `custo_financiamento_pct` de 5.5 para 6.0, **Then** o valor e persistido e exibido como 6.0 na proxima visita.
2. **Given** um parametro nao existe no banco, **When** o sistema inicia, **Then** o valor default (seed) e usado e o parametro e criado automaticamente.

---

### User Story 4 — Graficos do Motor com dados reais (Priority: P4)

Os graficos "Custo vs Protecao" e "Simulacao Margem" no Motor MV usam calculos aproximativos no navegador do usuario. Idealmente deveriam usar os dados reais do calculo do motor no servidor.

**Why this priority**: Nice-to-have. Os valores atuais sao aproximativos mas uteis. Nao bloqueia decisoes.

**Independent Test**: Comparar os valores dos graficos com os dados retornados pelo calculo do motor e verificar que sao consistentes.

**Acceptance Scenarios**:

1. **Given** o gestor ajusta o slider lambda no Motor MV, **When** o sistema recalcula, **Then** os graficos refletem os dados reais retornados pelo calculo do motor (nao calculos locais).

---

### Edge Cases

- O que acontece se `est_nao_pago_usd` e negativo (credito a favor)? O sistema deve tratar como zero — nao existe exposicao negativa.
- O que acontece se nao ha buckets ativos quando o estoque nao pago precisa ser distribuido? O sistema nao distribui (skip silencioso).
- O que acontece se o Redis estiver indisponivel? O sistema deve funcionar sem cache (fallback para queries diretas) e logar um warning.
- O que acontece se o gestor altera um parametro para um valor fora do range aceitavel? O sistema deve rejeitar com mensagem clara.

## Requirements

### Functional Requirements

- **FR-001**: O sistema DEVE incluir o valor de `est_nao_pago_usd` na exposicao de cada bucket, distribuindo proporcionalmente ao `pagar_usd` de cada bucket.
- **FR-002**: O sistema DEVE armazenar em cache os resultados de posicao, estoque e localidades com tempo de vida configuravel (default 5 minutos).
- **FR-003**: O sistema DEVE invalidar o cache de posicao quando uma acao altera dados relevantes (criar/ativar/liquidar/cancelar NDF, recalcular buckets).
- **FR-004**: O sistema DEVE funcionar normalmente se o cache estiver indisponivel (fallback gracioso).
- **FR-005**: O sistema DEVE persistir todos os parametros operacionais com valores default (seeds): `desvio_padrao_brl` (3.76), `custo_financiamento_pct` (5.5), `prazo_recebimento` (38), `transit_medio_dias` (80), `giro_estoque_dias` (30).
- **FR-006**: O sistema DEVE validar que parametros numericos estejam dentro de ranges aceitaveis ao ser atualizados.
- **FR-007**: Os graficos do Motor MV DEVEM usar dados retornados pelo calculo do motor em vez de calculos locais no navegador.

### Key Entities

- **Bucket Mensal**: Agrupamento de exposicao por mes. Atributos: mes referencia, empresa, pagar USD, NDF USD, cobertura %, status, estoque nao pago USD (novo).
- **Config Motor**: Parametros do motor de hedge. Atributos: chave, valor, descricao. Novas chaves: desvio_padrao_brl, custo_financiamento_pct, prazo_recebimento, transit_medio_dias, giro_estoque_dias.
- **Cache**: Armazenamento temporario de resultados de posicao, estoque e localidades. Atributos: chave, dados serializados, tempo de expiracao.

## Success Criteria

### Measurable Outcomes

- **SC-001**: A exposicao por bucket diverge menos de 1% do calculo do sistema legado quando comparados com os mesmos dados de entrada.
- **SC-002**: O tempo de resposta do dashboard na segunda visita (cache hit) e inferior a 500ms, comparado com 2-5 segundos na primeira visita.
- **SC-003**: 100% dos parametros exibidos na pagina de Config sao persistidos e recuperados corretamente.
- **SC-004**: O sistema continua funcional se o cache estiver indisponivel, com degradacao apenas de performance.

## Assumptions

- O valor de `est_nao_pago_usd` vem da view `vw_hedge_resumo` que ja esta validada e retorna dados corretos.
- A infraestrutura Redis ja esta disponivel no ambiente Docker do Atlas (usada pelo modulo integration-bcb para cache de PTAX).
- Os parametros operacionais extras (desvio_padrao, custo_financiamento, etc.) sao informativos nesta fase — seu uso em calculos backend sera avaliado caso a caso.
- O pipeline de sync (GAP-05) sera implementado via n8n e esta fora do escopo desta feature.
- Stubs para servicos internos (CRM, Forecast, Comex, Breaking Point) estao fora do escopo — serao integrados quando os respectivos modulos migrarem.
