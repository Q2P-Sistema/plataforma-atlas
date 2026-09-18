# Phase 0 — Research: Recebimento Nacional a partir da NF do Fornecedor

**Feature**: `015-recebimento-nacional-nf` | **Jira**: ACXEGDP-328 | **Data**: 2026-09-17

Todas as consultas de evidência foram feitas no **PROD** (`pg-acxe`, banco `acxe_q2p`), leitura apenas.

---

## D1. O sinal `n_id_receb` é inútil como "já recebida" no fluxo nacional

**Decisão**: a checagem de "já recebida" da fila nacional usa **exclusivamente** o lado Atlas (`stockbridge.movimentacao` por NF + empresa + produto). O sinal `n_id_receb` do cabeçalho OMIE, usado no fluxo de importação, **não** entra.

**Evidência** (NFs de entrada Q2P, CFOP 1.101/1.102/2.101/2.102, não canceladas/deletadas):

| Ano | NFs | Com `n_id_receb` |
|---|---|---|
| 2026 | 1.423 | 1.423 |
| 2025 | 1.358 | 1.358 |
| 2024 | 1.028 | 1.027 |
| 2023 | 892 | 892 |
| 2022 | 769 | 769 |
| 2021 | 71 | 71 |

**Rationale**: 5.540 de 5.541 NFs (99,98%) têm o campo preenchido. Em NF de entrada nacional, `n_id_receb` é o registro de **recebimento fiscal** que o OMIE cria ao importar a NF do fornecedor — não tem relação com a entrada física no galpão que o StockBridge controla. Reaproveitar o critério da feature 014 aqui zeraria a fila permanentemente.

**Alternativas consideradas**: (a) usar `n_id_receb` como na importação — rejeitada pela evidência acima; (b) usar `n_id_pedido` como âncora (como a baixa de pedido Q2P faz) — rejeitada: **0 de 1.221** NFs do recorte têm `n_id_pedido` preenchido, o vínculo NF↔pedido não existe nesse caminho.

**Consequência para o design**: a fila nacional tem **uma única** fonte de verdade de "já recebida", contra três no fluxo de importação. Isso simplifica a query, mas torna obrigatório o corte temporal de D2.

---

## D2. A fila exige corte temporal, senão nasce com 3.241 NFs

**Decisão**: ~~janela configurável com default de 30 dias~~ — **substituída por D23**: corte **fixo** de 7 dias anteriores ao go-live. O raciocínio abaixo (por que um corte é necessário) permanece válido; só o valor e a natureza (fixo, não móvel) mudaram. NFs anteriores ao corte nunca aparecem; o caminho manual continua atendendo qualquer NF fora da janela.

**Evidência** (após as exclusões de fornecedor de D4, espelho consultado em 17/09/2026; NF mais recente no espelho: 15/09/2026 — sync saudável):

| Janela | NFs elegíveis |
|---|---|
| Últimos 30 dias | 41 |
| Últimos 60 dias | 96 |
| Últimos 90 dias | 127 |
| Histórico completo | 3.241 |

**Rationale**: como o Atlas nunca recebeu NF nacional por este caminho, no dia 1 **nenhuma** NF histórica consta como recebida no lado Atlas — sem corte, as 3.241 apareceriam como pendentes. Com 30 dias, a fila nasce com 41 itens (~1,4 NF/dia), tamanho operacionalmente legível.

**Alternativas consideradas**: (a) corte fixo na data de go-live — rejeitado por ser opaco e exigir migration para ajustar; (b) marcar as históricas como recebidas por backfill — rejeitado: inventaria movimentações que nunca existiram no Atlas, poluindo auditoria e estoque; (c) sem corte, confiando no operador para ignorar — rejeitado, 3.241 itens tornam a fila inútil.

---

## D3. Não existe valor total da NF no espelho — o total é derivado

**Decisão**: o "valor total da NF" exibido no cabeçalho é **calculado** como `SUM(v_tot_item)` dos itens. O valor de cada item é `v_tot_item` (não `v_prod`).

**Evidência**: `public."tbl_nf_header_Q2P"` tem 28 colunas e **nenhuma** de valor total (só `n_nf`, `d_emi`, `tp_nf`, `dest_*`, flags de cancelamento etc). Não há tabela auxiliar de totais — as únicas tabelas de NF no espelho são `tbl_nf_header_*`, `tbl_nf_itens_*` e as `tbl_staging_nf_header_*`.

Diferença entre os dois candidatos a "valor do item" (1.413 itens do recorte, jan–jul/2026):

| Campo | Soma | Itens em que difere do outro |
|---|---|---|
| `v_prod` | R$ 228.889.854,99 | — |
| `v_tot_item` | R$ 236.555.705,83 | 1.236 de 1.413 (87%) |

`v_tot_item` é 3,3% maior — carrega tributos/frete/acessórios que `v_prod` não tem.

**Rationale**: `v_tot_item` é o valor com que a mercadoria efetivamente entra, coerente com a decisão do card de usar o valor discriminado da NF em vez do rateio por peso. Nenhum item tem `v_tot_item` nulo no recorte.

**Consequência para a spec**: o critério **SC-001/SC-006** ("a soma dos itens confere com o total exibido") é, por construção, uma checagem de **consistência de exibição** (o total mostrado é a soma dos itens exibidos, incluindo os bloqueados), não uma conferência contra um total fiscal independente — que o espelho não guarda. Registrado aqui para não prometer uma validação que o dado não sustenta.

---

## D4. Exclusão de fornecedor: reusar `stockbridge.fornecedor_exclusao`, com escopo

**Decisão**: reaproveitar a tabela existente `stockbridge.fornecedor_exclusao` em vez de criar lista nova ou hard-code de PLASTFIX/ACXE — **acrescentando uma coluna de escopo**, para que uma exclusão feita para a fila nacional não afete silenciosamente outros consumidores futuros.

**Evidência**: a tabela já existe ([packages/db/src/schemas/stockbridge.ts:296](../../packages/db/src/schemas/stockbridge.ts#L296)) com `fornecedor_cnpj`, `fornecedor_nome`, `motivo`, `excluido_por`, `excluido_em`, `reincluido_em`, `reincluido_por` — semântica exata do que a feature precisa, incluindo reversão auditável. Já tem trigger de auditoria (listada entre as 8 do `0008_stockbridge_core.sql`) e UI de gestão (`FornecedoresPage.tsx`, diretor) com rotas de excluir/reincluir ([modules/stockbridge/src/routes/fornecedor.routes.ts](../../modules/stockbridge/src/routes/fornecedor.routes.ts)).

**Ponto de atenção levantado na pesquisa**: hoje a tabela **não tem nenhum consumidor funcional** — `grep` mostra que só `fornecedor.service.ts` a lê, para alimentar a própria tela de gestão. Esta feature seria o **primeiro consumidor real**. Além disso, `listarFornecedores()` monta a lista a partir do cadastro **ACXE** (`tbl_cadastroFornecedoresClientes_ACXE`), enquanto a fila nacional lida com fornecedores **Q2P** (`dest_cnpj_cpf` de `tbl_nf_header_Q2P`) — a tela atual pode não listar os fornecedores que a fila precisa excluir.

**Alternativas consideradas**: (a) hard-code de PLASTFIX/ACXE no SQL da fila — rejeitado: decisão de negócio reversível não pertence ao código, e o card já sinaliza que PLASTFIX pode voltar ao escopo; (b) tabela nova só para a fila nacional — rejeitado: duplicaria conceito, trigger e tela já existentes; (c) reuso puro sem escopo — rejeitado pelo risco de vazamento semântico descrito acima.

**Nota de escopo**: PLASTFIX **não é ruído pequeno** — 507 NFs e R$ 129 mi no recorte de CFOP em jan–jul/2026, o maior fornecedor do período. A exclusão é decisão de negócio do usuário (registrada em 17/09/2026), não um filtro técnico; por isso precisa ser dado editável com motivo, não constante no código.

---

## D5. Unidades: tabela explícita de 3 entradas cobre 99,6% do recorte

**Decisão**: tabela de normalização explícita com `KG`, `TON` e `TL`; qualquer outra unidade **bloqueia o item** com mensagem nomeando a unidade. Sem heurística, sem fator default.

**Evidência** (itens do recorte de CFOP, jan–jul/2026):

| Unidade | Itens | Tratamento |
|---|---|---|
| `KG` | 1.230 | fator 1 |
| `TL` | 160 | fator 1.000 (tonelada) |
| `TON` | 22 | fator 1.000 |
| `UN` | 6 | **bloqueia** |

`TL` = tonelada, confirmado por `v_un_com`: itens Zaraplast a R$ 9.152,55/TL, equivalente a R$ 9,15/kg — coerente com resina, e incoerente com qualquer leitura de `TL` como unidade pequena.

**Rationale**: as 23 grafias citadas no card pertencem ao universo completo de CFOPs de entrada. Dentro do recorte decidido (D6), sobram 4 grafias, das quais 3 são conversíveis com fator conhecido. Cobertura: 1.412 de 1.418 itens (99,6%).

> **Emenda (2ª revisão)**: a tabela sozinha **não basta**. Esta decisão validou a coerência de preço para `TL` e nunca para `KG` — e há **14 itens rotulados `KG` cuja quantidade está em toneladas** (preço implícito ~R$ 14.800/unidade declarada, quando resina custa ~R$ 14/kg). Convertidos pela tabela, entrariam com 1/1000 da quantidade real. Ver D24: a unidade declarada precisa sobreviver a uma conferência contra o preço implícito, e o item é bloqueado quando as duas informações se contradizem.

**Alternativas consideradas**: (a) estender `converterParaKg` com heurística de prefixo (`TON*`, `T*`) — rejeitado: `TL` e `TON` já são casos conhecidos e explicitáveis; heurística abriria porta para converter errado uma unidade futura; (b) converter `UN` por peso médio do produto — rejeitado frontalmente: é exatamente a conversão silenciosa que a História 5 existe para impedir.

---

## D6. Recorte de CFOP: `1.101` não ocorre; `2.102` domina

**Decisão**: manter o recorte decidido (1.101, 1.102, 2.101, 2.102), com a observação de que `1.101` não tem ocorrência no período e `2.101` é marginal.

**Evidência** (itens de entrada Q2P, jan–jul/2026, por CFOP — armazenados **com ponto**, formato `N.NNN`):

| CFOP | Itens | No recorte? |
|---|---|---|
| `2.102` | 796 | ✅ |
| `1.102` | 615 | ✅ |
| `1.556` | 240 | ❌ (consumo) |
| `1.906` | 112 | ❌ (retorno de depósito) |
| `1.407` | 85 | ❌ |
| `1.202` | 32 | ❌ (devolução de venda) |
| `2.101` | 7 | ✅ |
| `1.101` | 0 | ✅ (sem ocorrência) |

**Rationale**: 1.418 itens no recorte contra 1.924 no universo de entrada — o recorte captura 74% dos itens e ~100% do caso de uso pedido (compra de resina para industrialização). O formato com ponto é obrigatório no filtro: comparar contra `'1102'` não casa nenhuma linha.

**Alternativas consideradas**: incluir `1.556`/`1.906`/`1.202` — adiado por decisão do usuário; são perfis operacionais distintos (consumo interno, retorno de depósito, devolução) que não passam pelo recebimento de mercadoria comprada.

---

## D7. `dest_razao` carrega o fornecedor, e `dest_cod_cli` é a chave estável

**Decisão**: rotular a contraparte como **"Fornecedor"** na UI; usar `dest_cnpj_cpf` como chave de correlação e exclusão, com `dest_cod_cli` disponível como chave OMIE interna.

**Evidência**: `tbl_nf_header_Q2P` **não tem colunas `emit_*`** — só `dest_razao` / `dest_cnpj_cpf` / `dest_cod_cli`. Em NFs de entrada (`tp_nf = 0`), as amostras trazem ECOPLAST, PLASTFIX, Zaraplast — todos fornecedores da Q2P, nunca a própria Q2P. O campo é a contraparte do documento, não o destinatário literal.

**Rationale**: a UI não pode repetir o nome do campo do espelho, sob pena de sugerir que a Q2P é quem emitiu. `dest_cod_cli` (ex.: `7777120450`) é código interno do OMIE e, por [ACXEGDP-313](../../CLAUDE.md), **não** pode aparecer para o usuário — serve só como chave interna.

---

## D8. A memorização da correlação se paga: 76,6% dos itens repetem par conhecido

**Decisão**: manter a correlação memorizada (História 3) como P3 e dimensionar a tabela De→Para para a ordem de centenas de linhas, não milhares.

**Evidência** (itens do recorte, 2026, após exclusões de fornecedor):

| Métrica | Valor |
|---|---|
| Itens | 499 |
| Pares distintos (fornecedor, descrição normalizada) | 117 |
| Itens que repetem um par já visto | 76,6% |
| Fornecedores distintos | 29 |

Ganho isolado da normalização (caixa + colapso de espaços), 2025–2026: 315 pares crus → 307 normalizados, ou seja **8 pares (2,5%)** são puras variações de formatação.

**Rationale**: o teto de pré-seleção é alto (a cada 100 itens, ~77 caem em par já correlacionado), o que sustenta o **SC-007** (80% pré-selecionados após 30 dias) como meta realista e não otimista. A normalização vale a pena, mas é ajuste fino — o ganho real vem da memória em si.

**Alternativas consideradas**: match fuzzy (distância de edição) entre descrições do fornecedor — rejeitado para esta fase: com só 2,5% de variação puramente formatal, fuzzy resolveria pouco e introduziria risco de sugerir o produto errado num fluxo que move dinheiro e estoque.

---

## D9. Escopo por empresa: Q2P matriz; a filial está inativa

**Decisão**: a fila cobre apenas a empresa **Q2P** (tabelas `tbl_nf_header_Q2P` / `tbl_nf_itens_Q2P`). ACXE fica para iteração futura, e a filial Q2P fica fora.

**Evidência**: o espelho tem um terceiro par de tabelas, `tbl_nf_header_Q2P_Filial` / `tbl_nf_itens_Q2P_Filial`, com 572 NFs de entrada no recorte de CFOP — mas a **NF mais recente é de 13/01/2026**, oito meses atrás. A empresa aparenta estar inativa para entrada de mercadoria.

**Rationale**: incluir uma fonte parada só adiciona superfície de query e de teste sem caso de uso ativo. Registrado aqui porque a descoberta não estava no card — se a filial voltar a operar, é adição de escopo consciente, não esquecimento.

---

## D10. Catálogo de produtos e chave do produto correlacionado

**Decisão**: o alvo da correlação é o produto do catálogo **Q2P** (`public."tbl_produtos_Q2P"`, chave `codigo_produto`), reaproveitando o endpoint de busca de produtos que o formulário nacional já usa.

**Evidência**: [modules/stockbridge/src/services/recebimento-nacional.service.ts:121-146](../../modules/stockbridge/src/services/recebimento-nacional.service.ts#L121-L146) — para `empresa=q2p` a busca lista direto de `tbl_produtos_Q2P` com código Q2P; para `empresa=acxe`, de `tbl_produtos_ACXE`.

**Rationale**: o fluxo nacional Q2P já resolve o catálogo por este caminho; a correlação memorizada apenas guarda a escolha que o operador já faz hoje no combobox, sem mudar a fonte do catálogo.

---

---

## D11. O fluxo nacional grava o produto em `produto_codigo_q2p` — a checagem de "recebida" da importação não serve

**Decisão**: a checagem de "já recebida" do caminho nacional precisa de fragmento SQL **próprio**, ou de `recebidaViaMovimentacaoSql` parametrizada em **dois** eixos: o `subtipo` e a **coluna de produto**.

**Evidência de código**: [fiscal-recebida-sql.ts:28-33](../../modules/stockbridge/src/services/fiscal-recebida-sql.ts#L28-L33) tem os dois valores fixos no corpo da função:

```sql
EXISTS (SELECT 1 FROM stockbridge.movimentacao m
    WHERE m.ativo = true AND m.subtipo = 'importacao' AND m.nota_fiscal = ${nfExpr}
      AND m.produto_codigo_acxe = ${produtoExpr})
```

**Evidência de dados** (UAT, que roda como produção para o StockBridge — movimentações ativas):

| subtipo | tipo_movimento | empresa | linhas | sem `produto_codigo_acxe` | sem `produto_codigo_q2p` |
|---|---|---|---|---|---|
| `importacao` | `entrada_nf` | acxe | 166 | 0 | 0 |
| `compra_nacional` | `entrada_manual` | q2p | 144 | **144** | 0 |

**Rationale**: as 144 movimentações nacionais têm `produto_codigo_acxe` **nulo** — o produto vive em `produto_codigo_q2p` ([recebimento-nacional.service.ts:329-331](../../modules/stockbridge/src/services/recebimento-nacional.service.ts#L329-L331) grava `tipoMovimento: 'entrada_manual'`, `subtipo: 'compra_nacional'`). Reusar a função como está erraria nos dois predicados e devolveria "nunca recebida" para 100% das NFs nacionais.

**Alternativas consideradas**: (a) passar a gravar `produto_codigo_acxe` também no nacional — rejeitado: o produto Q2P nacional pode não ter correlato ACXE, e forçar isso reintroduz o acoplamento cross-empresa que o fluxo nacional deliberadamente não tem ([recebimento-nacional.service.ts:121-122](../../modules/stockbridge/src/services/recebimento-nacional.service.ts#L121-L122): "estoques nacionais não são espelhados"); (b) duplicar o fragmento SQL — rejeitado: divergiria da versão da importação na primeira manutenção.

---

## D12. Não existe barreira de idempotência no caminho nacional hoje

**Decisão**: a feature precisa de **migration nova (0052)** criando índice único parcial para o caminho nacional. Sem ela, FR-013 não tem como ser cumprido no banco.

**Evidência**: o índice da feature 013 ([0046_stockbridge_idempotencia_entrada_por_produto.sql:42-48](../../packages/db/migrations/0046_stockbridge_idempotencia_entrada_por_produto.sql#L42-L48)) é:

```sql
CREATE UNIQUE INDEX movimentacao_nf_entrada_idempotencia_idx
    ON stockbridge.movimentacao (nota_fiscal, empresa, produto_codigo_acxe)
    WHERE tipo_movimento = 'entrada_nf'
      AND ativo = true AND empresa IS NOT NULL AND produto_codigo_acxe IS NOT NULL;
```

Os três predicados excluem o nacional simultaneamente: `tipo_movimento` é `entrada_manual`, e `produto_codigo_acxe` é sempre nulo (D11). O índice de saída cobre só `saida_automatica`. **Nenhum** índice cobre `subtipo = 'compra_nacional'`.

**Forma proposta do índice**: ~~`UNIQUE (nota_fiscal, empresa, produto_codigo_q2p)`~~ — **superada por D19 e D20**. A chave final é `(nf_chave_acesso, nf_item_descricao_normalizada, produto_codigo_q2p)`: o número da NF colide entre fornecedores (D19) e a descrição do item é necessária para não fundir duas linhas distintas da NF no mesmo produto (D20).

---

## D13. Três NFs da ISOFORMA com recebimento relançado — ~40,7 t de excesso

> **Correção (2ª revisão)**: a primeira versão descreveu isto como "erro de digitação de 4.442 kg numa NF"; a segunda, como duas NFs. A verificação definitiva mostra **três** NFs. As leituras anteriores estão substituídas.

**Decisão**: a criação do índice de idempotência continua bloqueada por dado preexistente; a remediação é decisão de negócio, fora da migration.

**Evidência**. Exatamente **3 NFs** têm lançamentos em dias distintos — todas ISOFORMA, todas somando exatamente 27.000 kg:

| NF | Qtd na NF real | Lançamentos no Atlas | Total Atlas | Excesso |
|---|---|---|---|---|
| 66529 | 13.385 kg | 28/07 + 29/07 (2 movs) | 27.000 kg | +13.615 kg |
| 66530 | 13.558 kg | 28/07 + 29/07 (4 movs) | 27.000 kg | +13.442 kg |
| 66604 | 13.385 kg | 31/07 + 03/08 (2 movs) | 27.000 kg | +13.615 kg |

**Excesso somado: ~40,7 toneladas**, todas com `status_omie = 'concluida'` — os ajustes já foram aplicados no OMIE.

O padrão é consistente: cada NF recebe ~13,5 t e depois **outra** ~13,5 t alguns dias depois. A leitura mais provável é que duas cargas foram lançadas sob o mesmo número de NF, ou que o recebimento foi relançado por inteiro. A checagem confirma que não há outro caso: nenhuma outra NF nacional tem lançamentos em mais de um dia.

**Consequência para a migration**: ~~o índice único não sobe enquanto as duplicatas existirem~~ — **superado por D19**. Como o índice passou a ser chaveado em `nf_chave_acesso`, coluna que nasce nesta feature e fica nula em todas as linhas históricas, a migration **não é bloqueada** por este passivo. As ~40,7 t continuam no estoque e no OMIE: o índice impede repetição, não corrige o histórico. A remediação é decisão de negócio, desacoplada da entrega.

---

## D14. Número de NF: formatos incompatíveis entre Atlas e espelho Q2P

**Decisão**: o casamento NF Atlas ↔ NF espelho é feito por **comparação sem zeros à esquerda** nos dois lados, não por `LPAD` de largura fixa.

**Evidência**:

- O espelho Q2P guarda a NF zero-padded em largura **variável**: das 1.676 NFs de entrada de 2026, **1.664 têm 9 dígitos** e **12 têm 8** (ex.: `000066530`).
- O fluxo de importação assume 8: `LPAD(f.nf_filhote, 8, '0')` ([recebimento.service.ts:538](../../modules/stockbridge/src/services/recebimento.service.ts#L538)), coerente com `normalizarNumeroNf`, que faz `padStart(8, '0')` ([motor.service.ts:80-86](../../modules/stockbridge/src/services/motor.service.ts#L80-L86)).
- O fluxo nacional **não normaliza nada**: `const nfNorm = input.notaFiscal.trim()` ([recebimento-nacional.service.ts:258](../../modules/stockbridge/src/services/recebimento-nacional.service.ts#L258)) — as 144 linhas existentes estão como o operador digitou (ex.: `66530`).

**Rationale**: `LPAD(8)` não casa `000066530` (9 dígitos); normalizar o Atlas para 8 quebraria as NFs de 9. Comparar os dois lados sem zeros à esquerda é a única regra que cobre 8, 9 e o texto cru já gravado.

**Nota**: quando a NF vem **da fila**, a identidade é a chave de acesso (D19) e o número vira só exibição. Mas esta regra **não foi descartada** — ela é exatamente o caminho de fallback de D21, usado para reconhecer os recebimentos feitos pelo formulário manual, que nunca gravam chave. Ver D21.

---

## D15. `converterParaKg` devolve `NaN` para unidade desconhecida — e o fluxo de importação assume kg

**Decisão**: a conversão do caminho nacional-por-NF usa uma tabela **nova e explícita** que mapeia a grafia do fornecedor (`KG`/`TON`/`TL`) e **bloqueia** o resto, sem reaproveitar `normalizarUnidade`.

**Evidência**:

- `FATOR_PARA_KG` ([types.ts:145-152](../../modules/stockbridge/src/types.ts#L145-L152)) cobre 4 unidades **do Atlas** (`t`, `kg`, `saco`, `bigbag`) — nenhuma delas é grafia de NF. `converterParaKg` ([motor.service.ts:7-9](../../modules/stockbridge/src/services/motor.service.ts#L7-L9)) é `quantidade * FATOR_PARA_KG[unidade]`, sem `default` e sem throw: unidade fora da tabela produz **`NaN`** silencioso. `motor.test.ts` cobre as 4 unidades, zero e negativos — **não há caso de unidade desconhecida**.
- O fluxo de importação tem `normalizarUnidade` ([recebimento.service.ts:1357-1368](../../modules/stockbridge/src/services/recebimento.service.ts#L1357-L1368)) que, no default, **assume `kg` e só loga** — com comentário admitindo "risco de erro de 1000×" (STK-20).

**Rationale**: os dois mecanismos existentes falham do jeito errado para esta feature — um em `NaN`, outro em conversão silenciosa. A História 5 exige exatamente o oposto: falha explícita e visível. Reaproveitar `normalizarUnidade` importaria o bug de 1000× para um fluxo novo.

**Nota de qualidade**: o front duplica a tabela de fatores à mão (`FATOR_KG` em [RecebimentoNacionalForm.tsx:52](../../apps/web/src/pages/stockbridge/operador/RecebimentoNacionalForm.tsx#L52)), sem import compartilhado — ao introduzir a tabela de grafias de NF, não repetir o padrão.

---

## D16. O nacional não tem teste algum hoje

**Decisão**: a feature traz a primeira cobertura Vitest do caminho nacional, e as tarefas de teste são requisito, não polimento.

**Evidência**: não existe `recebimento-nacional*.test.ts` em `modules/stockbridge/src/__tests__/`; o único arquivo que toca o assunto é `notificacao-digest.test.ts:54` (digest de e-mail, EML-09). O serviço de 500 linhas com o rateio financeiro de ACXEGDP-178 está **descoberto**.

**Rationale**: Princípio III exige Vitest em cálculo que toca dinheiro. A feature não pode piorar essa dívida, e os pontos que ela introduz (normalização de unidade, match de correlação, idempotência) são justamente os que a spec manda cobrir.

---

## D17. Divergência de peso é real, porém menos frequente do que a primeira medição sugeriu

> **Correção**: uma primeira medição indicou "63 de 100 NFs divergem". O número estava inflado por dois defeitos do **meu cruzamento**, não dos dados: (a) somei `q_com` sem converter unidade, de modo que toda NF da Zaraplast em `TL` aparecia com 1.000× de diferença; (b) comparei NFs multi-item recebidas apenas em parte, o que faz a NF inteira parecer "faltando". Os números abaixo são os corrigidos.

**Decisão**: o fluxo por NF pré-preenche a quantidade a partir da NF mas **permite substituir pelo peso conferido na balança**, gravando os dois valores e a diferença. Divergência exige motivo e aprovação do gestor — e, diferente da importação, **aceita peso maior que o da NF** (decisão do usuário, 17/09/2026).

**Método**. Só comparações inequívocas: NF de **item único** (evita o artefato de recebimento parcial), número **não ambíguo** no espelho (evita a colisão de D19) e quantidade **convertida** para kg. Restam 60 NFs.

| Situação | NFs |
|---|---|
| Bate (≤ 1 kg) | 31 |
| Bate após corrigir minha conversão `TL`→kg (Zaraplast) | +8 → **39** |
| **Divergência genuína ≤ 5%** | **17** |
| Excesso ~100% (as 3 NFs relançadas de D13) | 3 |
| Falta de 10% | 1 |

Divergência genuína: **~18 de 57 comparações válidas (≈32%)**, não 63%. A direção é quase toda para cima.

Exemplos do grupo genuíno (todos ISOFORMA, exceto o último):

| NF | NF real | Atlas lançou | Δ |
|---|---|---|---|
| 66724 | 13.160 kg | 13.500 | +340 |
| 66701 | 13.215 kg | 13.500 | +285 |
| 67058 | 13.323 kg | 13.500 | +177 |
| 66970 | 13.382 kg | 13.500 | +118 |
| 66814 | 13.384 kg | 13.483 | +99 |
| 90857 (CATA) | 24.700,005 kg | 24.750 | +50 |

**Confiabilidade do cruzamento**: `stockbridge.movimentacao` **não guarda o fornecedor** no caminho nacional — o vínculo com a NF do espelho só pode ser feito pelo número. Dos 100 números cruzados, **94 são inequívocos** (um único documento com aquele número no espelho) e 6 são ambíguos. No caso da NF 66724, a amarração é dupla: o número é único no espelho *e* o operador anotou "Fornecedor Isoforma" em observação livre. Essa fragilidade estrutural é, por si, um argumento para D19.

**Rationale**: pré-preencher sem permitir substituição trocaria um erro visível de digitação por um erro invisível de peso — o operador aceitaria 13.385 quando a balança marcou 13.500. O valor está em pré-preencher **e** registrar a diferença.

**Diferença deliberada em relação à importação**: [recebimento.service.ts:788-790](../../modules/stockbridge/src/services/recebimento.service.ts#L788-L790) lança `QuantidadeExcedeNfError` quando `deltaKg > 0` ("fiel ao legado, só aceita recebido < NF"). No nacional, 26 dos 29 casos divergentes são para cima; aplicar a regra da importação recusaria a maioria. A assimetria é intencional.

**Tolerância**: 1 kg, igual à importação, para que os dois fluxos usem o mesmo limiar.

**Achado colateral que valida D5**: as 8 NFs da Zaraplast batem **exatamente** quando `TL` é convertido a 1.000 kg. É confirmação independente, vinda do comportamento do operador, de que `TL` é tonelada.

---

## D18. Um item da NF pode virar N produtos de estoque (classificação de sucata)

**Decisão**: a correlação é **1:N** — uma descrição de fornecedor pode mapear para vários produtos do catálogo, e o operador distribui a quantidade conferida entre eles. O valor do item é rateado entre os produtos resultantes por peso.

**Evidência**. Os três padrões coexistem nos dados:

| NF | Fornecedor | Itens na NF | Produtos no Atlas | Padrão |
|---|---|---|---|---|
| 34277 | M.H.C PLASTICOS | 3 | 3 | 1:1 |
| 58396 | Zaraplast | 6 linhas / 4 descrições distintas | 4 | agregação por descrição |
| 66461 | ISOFORMA | **1** (SUCATA PSAI GROSSO, 13.541 kg) | **3** (PS CRISTAL A, PS AI B, PS CRISTAL B) | **1:N** |

A NF 58396 traz a mesma descrição repetida em linhas separadas (`MC PEBD EB-853/72+AZ` duas vezes, 8,250 TL cada) — agregar por descrição antes de exibir é necessário, como `agruparItensNf` já faz na importação.

**Rationale**: sucata entra como uma única linha fiscal e é classificada por grau na conferência física. É a operação real da ISOFORMA, o segundo fornecedor mais frequente do recorte. Um modelo 1:1 empurraria esse fornecedor inteiro de volta para o formulário manual, esvaziando boa parte do ganho.

**Impacto no modelo**: o índice único da tabela De→Para **não pode** ser `(fornecedor, descrição)` — precisa ser `(fornecedor, descrição, produto)`, permitindo N linhas por descrição. A sugestão automática passa a propor o **conjunto** de produtos já usado para aquela descrição, e o operador confirma ou ajusta a distribuição.

**Onde o rateio de ACXEGDP-178 sobrevive**: dentro de um item que se divide. O valor do item (`v_tot_item`) é distribuído entre os N produtos proporcionalmente ao peso atribuído a cada um. A lógica existente é reaproveitável nesse escopo reduzido.

---

## D19. Número de NF colide entre fornecedores — a chave é `c_chave_nfe`

**Decisão**: a identidade da NF neste fluxo é a **chave de acesso da NF-e** (`c_chave_nfe`, 44 dígitos), não o número. A idempotência passa a ser por (chave da NF, produto).

**Evidência** (3.241 NFs elegíveis, após exclusões):

| Métrica | Valor |
|---|---|
| NFs | 3.241 |
| Com `c_chave_nfe` de 44 dígitos | **3.241 (100%)** |
| Chaves distintas | 3.241 (sem colisão) |
| **Números de NF distintos** | **3.116** |
| Pares (fornecedor, número) distintos | 3.241 |

São **125 colisões** de número. Exemplos no conjunto elegível: NF `85`, `87`, `88` repetem entre RESIN-WEB, TRIPOLY e WORLD TERMOPLASTICOS; NF `1209` e `1300` entre D.K. POLIMEROS, ECOPLAST e outros. Cada fornecedor mantém sua própria série de numeração.

**Rationale**: a chave `(nota_fiscal, empresa, produto)` proposta antes desta descoberta bloquearia recebimento legítimo — receber a NF 85 da RESIN-WEB impediria para sempre a NF 85 da TRIPOLY do mesmo produto. `c_chave_nfe` é única por construção (inclui CNPJ do emitente, série, número e código aleatório) e está 100% preenchida no recorte.

**Alinhamento com o projeto**: coerente com a convenção já registrada de que o `nIdNF` do OMIE é instável e `c_chave_nfe` é a chave natural de NF.

**Consequência estrutural**: `stockbridge.movimentacao` não guarda a chave da NF hoje — só `nota_fiscal` (o número). A migration precisa acrescentar a coluna para que o índice de idempotência seja construível.


---

## D20. Pendência por item exige a descrição da NF na movimentação — o item não tem código de produto

**Decisão**: a movimentação passa a gravar **qual linha da NF a originou**, pela descrição normalizada do item (`nf_item_descricao_normalizada`). A pendência por item e a idempotência passam a usar essa coluna.

**Evidência**: itens elegíveis de 2026 (CFOP do recorte, não cancelados/deletados):

| Métrica | Valor |
|---|---|
| Itens elegíveis | 1.637 |
| **Sem `n_cod_prod`** | **1.596 (97,5%)** |

**O problema que isto resolve**. O desenho anterior calculava pendência "por (chave da NF, produto)". Mas o item da NF **não traz produto** em 97,5% dos casos — o único elo entre a descrição do fornecedor e o produto do catálogo é a tabela de correlação, que estava planejada para a Fase 5, enquanto a fila está na Fase 3. O MVP não conseguiria computar a própria pendência.

Com a descrição do item na movimentação, a pendência vira "existe movimentação ativa para esta chave de NF e esta descrição?" — sem depender de correlação. A Fase 3 volta a ser autossuficiente.

**Segundo problema resolvido, mais grave**. O índice `(nf_chave_acesso, produto_codigo_q2p)` **proibia** que duas linhas distintas da mesma NF fossem classificadas no mesmo produto do catálogo — caso real quando as descrições diferem apenas por lote. Pelo contrato, a violação `23505` era traduzida para `ja_recebido`, ou seja, a quantidade da segunda linha **desaparecia silenciosamente**. Incluindo a descrição na chave, as duas linhas coexistem e cada uma soma seu peso.

**Chave final do índice**: `(nf_chave_acesso, nf_item_descricao_normalizada, produto_codigo_q2p)`.

**Alternativas consideradas**: (a) gravar o índice posicional do item (`n_cod_item`) em vez da descrição — rejeitado: a posição não é estável entre sincronizações e não sobrevive à agregação de linhas de mesma descrição (D18); (b) antecipar a correlação para a Fase 3, tornando-a pré-requisito da fila — rejeitado: acopla o MVP a uma tabela que só ganha valor com histórico, e ainda deixaria o primeiro recebimento de cada fornecedor sem como calcular pendência.

---

## D21. A checagem de "já recebida" precisa de duas vias — a cegueira da chave é permanente

**Decisão**: a fila considera uma NF/item já recebida se houver movimentação ativa correspondente **por chave de acesso** (caminho novo) **ou por número de NF + empresa** (linhas sem chave). O fallback não é transitório.

**Evidência**. Das 9 NFs da janela de 7 dias, **7 já haviam sido recebidas** pelo formulário manual; apenas 2 estavam de fato pendentes. Nenhuma das 145 movimentações nacionais existentes tem `nf_chave_acesso` — a coluna nasce nesta feature.

Confiabilidade do fallback por número, medida sobre os 144 pares (NF, produto) do fluxo manual:

| Casamento contra o espelho | Pares | |
|---|---|---|
| Exatamente 1 NF | 130 | **90%** — fallback funciona |
| Nenhuma NF | 7 | 5% — número digitado não existe no espelho |
| Mais de uma NF | 7 | 5% — número ambíguo entre fornecedores |

Formato do número no Atlas: 145/145 só dígitos, sem zeros à esquerda, sem espaço — a normalização de D14 é limpa.

**Por que é permanente e não transitório**: o formulário manual **MUST** continuar existindo (FR-014) e atende justamente NFs fora do espelho — que por definição não têm chave para gravar. Toda linha que ele criar, hoje e no futuro, será cega para a checagem por chave. Tratar o fallback como "limpeza de migração" seria errado.

**Consequência**: a cobertura da checagem automática é de ~90%. Os 10% restantes (número inexistente ou ambíguo) exigem uma saída manual — ver D22.

**Alternativas consideradas**: backfill da chave nas 145 linhas históricas, casando pelo número — rejeitado por dois motivos: reintroduz a ambiguidade de 5% como dado gravado, e colocaria as 3 NFs relançadas de D13 dentro do índice único, fazendo a criação **falhar** e reacoplando a entrega ao passivo de estoque. Registrado como follow-up opcional, posterior à resolução do passivo.

---

## D22. `recebimento_externo`: válvula permanente para o que entrou fora do Atlas

**Decisão**: criar a ação **"recebimento externo"** — o operador declara que os itens de uma NF já entraram no estoque por fora do Atlas, o item sai da fila, **nenhuma movimentação de estoque é criada** e nenhum ajuste vai ao OMIE. Exige aprovação de **gestor**. Fica atrás da flag `STOCKBRIDGE_RECEBIMENTO_EXTERNO_ENABLED` (default `true`).

**Motivação (decisão do usuário, 17/09/2026)**: não é muleta de virada. Por necessidade operacional o recebimento às vezes é feito **direto no OMIE**, e o StockBridge precisa de uma forma de dar baixa desse item. Enquanto esse caminho existir, a válvula precisa existir. Ela permanece até o módulo estar validado e cobrindo os casos; depois pode ser desligada pela flag, sem migration — porque ela **é**, reconhecidamente, um risco permanente.

**Evidência de necessidade**: D21 mostra que ~10% dos recebimentos do fluxo manual não são reconhecíveis automaticamente (número inexistente ou ambíguo no espelho). Sem a válvula, essas NFs ficariam presas na fila para sempre ou seriam recebidas em duplicidade.

**Modelagem**: reusa `stockbridge.aprovacao` em vez de tabela nova. A tabela já tem cadeia de aprovação, trigger de auditoria, caixa de entrada (`AprovacoesPage`) e notificação por role; `movimentacao_id` e `lote_id` já são nuláveis, então uma aprovação sem movimentação cabe. Faltam apenas as colunas de identidade da NF.

**Nome**: `recebimento_externo`, **não** "dispensa" — `aprovacao.dispensada_em` já existe com outro significado (operador descarta rejeição da caixa de entrada, migration 0029). Além disso "recebimento externo" descreve o fato (a mercadoria entrou, fora daqui), enquanto "dispensa" sugere ignorar.

**Nível de aprovação**: **gestor** (decisão do usuário). Alinha com `NIVEL_APROVACAO_POR_SUBTIPO.entrada_manual = 'gestor'` e mantém todo o fluxo nacional no mesmo nível. Consequência a registrar: como o mesmo papel aprova o recebimento normal e a afirmação de que ele ocorreu fora, `shared.audit_log` é o rastro principal deste caminho.

**Granularidade**: por **item da NF** (identificado pela descrição), não por produto — o item que precisa de baixa externa é justamente aquele que nunca chegou a ter produto associado. Atalho de "todos os itens pendentes" na tela.

---

## D23. Corte de 7 dias, fixo no go-live — não janela móvel

**Decisão**: substituir a janela de 30 dias de D2 por um **corte fixo de 7 dias anteriores à data de virada**. NF emitida antes do corte nunca entra na fila; NF emitida depois permanece até ser recebida ou dispensada.

**Evidência** — prazo entre emissão da NF e recebimento no Atlas (94 NFs inequívocas):

| Prazo | NFs | Acumulado |
|---|---|---|
| ≤ 3 dias | 65 | 69% |
| 4–7 dias | 23 | **94%** |
| 8–30 dias | 6 | 100% |
| Máximo observado | 13 dias | |

**Rationale**: como 94% dos recebimentos ocorrem em até 7 dias, uma NF emitida há mais de 7 dias na virada quase certamente já foi recebida pelo fluxo manual. O corte pega o que ainda pode estar pendente e deixa fora o histórico já tratado.

**Por que fixo e não móvel**: numa janela móvel de 7 dias, os 6% de recebimentos que levam mais tempo (até 13 dias) **sumiriam da fila antes de serem recebidos**. Com corte fixo, toda NF emitida após a virada permanece até ser resolvida — a janela só governa quanto de história entra no dia 1.

**Volume medido em 17/09/2026**: 9 NFs elegíveis nos últimos 7 dias, das quais 7 já recebidas pelo fluxo manual (detectáveis por D21). Fila de estreia: **2 NFs**.


---

## D24. A unidade declarada é conferida comparando as duas leituras da mesma linha

**Decisão**: além de constar na tabela de conversão (D5), a unidade declarada **MUST** produzir um preço por quilo plausível. A conferência compara a leitura declarada com a leitura alternativa da **mesma linha** — não o preço contra uma tabela de valores absolutos. Contradição bloqueia o item; o sistema nunca escolhe qual campo está errado.

```text
rs_por_kg_declarado   = v_tot_item / (q_com × fator(u_com))
rs_por_kg_alternativo = v_tot_item / (q_com × fator_da_outra_leitura)
faixa plausível       = R$ 0,10 a R$ 100 por quilo

declarado plausível                           -> converte
declarado implausível + alternativo plausível -> CONTRADIÇÃO: bloqueia
nenhum plausível                              -> INCONCLUSIVO: bloqueia
```

**Resultado medido** (1.626 itens elegíveis de 2026 com unidade conversível): **1.612 liberados, 14 bloqueados por contradição, 0 inconclusivos.**

Os 14 seguem o mesmo padrão — NF 58067, Zaraplast: `q_com = 1,375`, `u_com = 'KG'`, `v_tot_item = 20.352,34`. Lido como KG, R$ 14.801/kg; lido como tonelada, R$ 14,80/kg, coerente com resina. A quantidade está em toneladas com a unidade rotulada KG, e pela tabela de D5 o sistema entraria **1,375 kg no lugar de 1.375 kg**.

> **Correção de um critério anterior errado.** A primeira formulação desta decisão bloqueava todo item cujo preço caísse "fora de ambas as faixas" de preço absoluto. Medindo, ela reprovaria **10 itens perfeitamente coerentes**: papelão e sucata de plástico a R$ 0,35–0,40/kg declarados em `KG`, e sucata rígida a R$ 300/tonelada declarada em `TON` — que é o mesmo R$ 0,30/kg. Material barato não é material com unidade errada. O erro estava em comparar o preço contra valores absolutos em vez de comparar as duas leituras possíveis da linha.

**Por que bloquear e não corrigir**: o sistema detecta a contradição mas não sabe **qual** campo está errado — a unidade ou a quantidade. Escolher seria adivinhar num fluxo que move estoque e dinheiro. Mesmo princípio de D15: falhar de forma visível em vez de converter em silêncio. Os 14 seguem pelo caminho manual, com conferência humana.

**Distinção de estado**: `unidade_incoerente` é valor próprio, separado de `unidade_nao_conversivel` — a causa e a mensagem ao operador são diferentes (uma diz "não sei converter esta unidade", a outra "a unidade e a quantidade desta linha se contradizem").

**Efeito colateral positivo**: a conferência valida a tabela de D5 por evidência independente — as 187 linhas em `TL` têm 100% de preço por quilo plausível convertidas a 1.000.

**Alternativas consideradas**: (a) confiar na unidade e ignorar o preço — deixaria passar os 14 com erro de 1000×; (b) confiar no preço e reescrever a unidade — inverte o problema e ainda adivinha; (c) faixa de preço absoluto — foi a primeira formulação, refutada acima pela medição.

---

## D25. Rateio e pendência ancorados na quantidade da NF, não na submissão

**Decisão**: tanto o rateio do valor quanto o cálculo do que falta receber usam a **quantidade da NF** como âncora. A soma da submissão não serve para nenhum dos dois.

**O defeito que isto corrige (rateio)**. A formulação anterior era `valor_produto = v_tot_item × (kg_produto / Σ kg_produtos)`, com `Σ` sobre os produtos **da submissão**. Combinada com a regra de recebimento retomado — que fecha pela quantidade ainda não distribuída — cada submissão parcial teria `Σ` igual à própria parcela, e receberia o valor **integral** do item. Um item de R$ 156.604 recebido em duas levas de 6.580 kg gravaria R$ 156.604 em cada uma: **o dobro do valor da NF entrando no estoque**.

Forma correta:

```text
quantidade_nf_kg(produto) = quantidade_nf_do_item × (kg_produto / quantidade_conferida_do_item)
valor_produto             = v_tot_item          × (quantidade_nf_kg / quantidade_nf_do_item)
```

A soma fecha em `v_tot_item` independentemente de quantas submissões houver.

**O defeito que isto corrige (pendência)**. `quantidadeRestanteKg` estava definida como `conferida − já recebida`. A conferida **não é conhecida** antes de o operador digitá-la e nenhuma tabela a persiste para um item nunca submetido. Além disso ela quebra nas duas pontas da divergência: item de 13.160 kg conferido em 12.900 deixaria resto de 260 kg e ficaria preso na fila para sempre, apesar de integralmente tratado; conferido em 13.500, o resto seria −340 e a regra escrita como "chega a zero" também nunca fecharia.

Forma correta: `restante = quantidade_nf_do_item − Σ quantidade_nf_kg das movimentações ativas`, mantendo o item na fila enquanto `restante > 1` (mesma tolerância de FR-018). Fecha em zero por construção nas duas pontas.

**Origem**: os dois defeitos foram **introduzidos por revisões anteriores desta própria especificação** — a regra de retomada foi acrescentada numa passada sem revisitar a fórmula do rateio escrita noutra. Registrado aqui porque é o tipo de erro que só aparece na combinação (item 1:N + recebimento retomado) e não em teste de caminho feliz.

## Resumo das decisões

| # | Decisão | Impacto |
|---|---|---|
| D1 | "Já recebida" só pelo lado Atlas; `n_id_receb` descartado | Query da fila mais simples, mas exige D2 |
| D2 | Janela temporal configurável, default 30 dias | Fila nasce com 41 itens em vez de 3.241 |
| D3 | Total da NF é derivado (`SUM(v_tot_item)`); item usa `v_tot_item` | O total exibido é consistência de exibição, não conferência fiscal |
| D4 | Reusar `fornecedor_exclusao` com coluna de escopo | Sem hard-code; primeira consumidora real da tabela |
| D5 | Tabela de unidades KG/TON/TL; resto bloqueia | 99,6% de cobertura sem heurística |
| D6 | CFOP com ponto; `1.101` inexistente no período | Filtro precisa do formato `'1.102'` |
| D7 | `dest_razao` = fornecedor; `dest_cod_cli` só interno | Rótulo correto na UI, sem código OMIE exposto |
| D8 | Memorização se paga (76,6% de repetição) | SC-007 (80%) é meta realista |
| D9 | Só Q2P matriz; filial inativa desde 13/01/2026 | Escopo consciente, não omissão |
| D10 | Correlação aponta para `tbl_produtos_Q2P.codigo_produto` | Reusa catálogo do fluxo atual |
| D11 | Nacional usa `produto_codigo_q2p` + subtipo `compra_nacional` | Checagem de "recebida" precisa de 2 parâmetros novos |
| D12 | Nenhum índice cobre o nacional — migration 0052 necessária | FR-013 depende dela |
| D13 | 3 NFs relançadas (66529/66530/66604), ~40,7 t de excesso | Pré-requisito com decisão do usuário |
| D14 | NF do espelho tem 8 **e** 9 dígitos; nacional grava sem padding | Casar sem zeros à esquerda, não com `LPAD(8)` |
| D15 | `converterParaKg` → `NaN`; `normalizarUnidade` → assume kg | Tabela nova, falha explícita |
| D16 | Zero teste no caminho nacional hoje | Cobertura é requisito da feature |
| D17 | Divergência genuína em ~32% (não 63%); aceita para mais e para menos | Quantidade editável + motivo + aprovação |
| D18 | 1 item da NF pode virar N produtos (sucata classificada) | Correlação 1:N; rateio sobrevive dentro do item |
| D19 | Número de NF colide (125x); `c_chave_nfe` é única e 100% preenchida | Idempotência por chave, não por número |
| D20 | Gravar descrição do item da NF na movimentação | Pendência por item sem depender de correlação; fecha perda silenciosa no índice |
| D21 | Checagem de recebida em duas vias (chave OU número) | Cobre ~90%; cegueira da chave é permanente, não transitória |
| D22 | `recebimento_externo` com aprovação de gestor e flag | Válvula para os ~10% e para recebimento feito direto no OMIE |
| D23 | Corte fixo de 7 dias no go-live (substitui os 30 de D2) | Fila de estreia com 2 NFs; 94% de cobertura do prazo real |
| D24 | Unidade conferida comparando as duas leituras da linha | 14 bloqueados, 1.612 liberados; critério de preço absoluto refutado |
| D25 | Rateio e pendência ancorados na quantidade da NF | Evita dobrar o valor no estoque e prender item na fila |
