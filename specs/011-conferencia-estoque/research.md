# Phase 0 — Research: Conferência de Estoque ACXE vs Q2P

Decisões técnicas tomadas a partir da inspeção do banco real (`acxe_q2p`), do código do StockBridge (módulos 008/009) e do frontend (badge de aprovações). Cada item: **Decisão / Razão / Alternativas rejeitadas**.

---

## D1. Fonte de dados: tabelas-base, NÃO a view unificada

**Decisão**: Ler diretamente `public."tbl_posicaoEstoque_ACXE"` e `public."tbl_posicaoEstoque_Q2P"` (colunas `ncodprod`, `codigo_local_estoque`, `ccodigo`, `cdescricao`, `fisico`, `ddataposicao`). São exatamente as fontes que a planilha consome (`tbl_posicaoEstoque_*`).

**Razão**: A view `vw_posicaoEstoqueUnificada` tem `WHERE posicao.fisico >= 0 AND ddataposicao = hoje`. O filtro `fisico >= 0` **elimina os saldos negativos** — que são o coração da regra `Saldo Negativo`/`Status Geral`. Usar a view tornaria impossível detectar negativos. Confirmado via `pg_get_viewdef`.

**Alternativas rejeitadas**:
- `vw_posicaoEstoqueUnificada` / `vw_posicaoEstoqueUnificadaFamilia`: filtram negativos e/ou agregam por família (perdem granularidade de produto/local).
- Recriar uma view nova em `public.*`: violaria Princípio I (tabela/objeto de domínio fora de `public` salvo OMIE). Se quisermos uma view, ela nasce em `stockbridge.*` — mas a agregação fica melhor parametrizada no service (data por empresa, blacklist), então fica em SQL no service.

---

## D2. Mapa De→Para de locais vira tabela de config nova

**Decisão**: Criar `stockbridge.conferencia_local_map` semeada com as **23 linhas** do mapa atual da planilha (`tbl_locaisEstoque`). Colunas: `codigo_local_estoque` (bigint, PK de relacionamento), `codigo` (textual, ex. `11.1`), `descricao`, `nome_comparativo`, `tipo` (`ESPELHADO`|`INDIVIDUAL`), `empresa` (`ACXE`|`Q2P`), `ativo`.

**Razão**: As tabelas OMIE `public."tbl_locaisEstoques_ACXE"/"_Q2P"` só têm `codigo_local_estoque`, `codigo`, `descricao` — **não têm `Tipo` nem a noção de espelhamento**. A classificação `ESPELHADO`/`INDIVIDUAL` é regra de negócio que o usuário mantém manualmente na planilha; não está no ERP. Logo é config própria do Atlas → `stockbridge.*` (Princípio I) com trigger de auditoria (Princípio IV).

**Alternativas rejeitadas**:
- Derivar `ESPELHADO` por heurística de prefixo (11.x/12.x/21.x/31.x): frágil; o usuário pode reclassificar; a planilha trata como dado editável.
- Hardcode em TS: viola "config é dado", dificulta manutenção e auditoria; 23 linhas merecem tabela.
- Reusar `stockbridge.localidade_correlacao` (existe, correlaciona localidade Atlas ↔ códigos OMIE): semântica diferente (transito/localidades virtuais), não carrega `ESPELHADO`/`INDIVIDUAL`. Não encaixa.

**Seed (23 linhas)** — ver [data-model.md](./data-model.md#seed).

---

## D3. Chave de junção ACXE↔Q2P: `codigo` textual + descrição normalizada

**Decisão**: ACXE e Q2P se encontram na mesma linha do comparativo quando compartilham **o `codigo` textual do local** (ex. `11.1`) **e** a **descrição do produto normalizada** (`TRIM(UPPER(cdescricao))`). O `tipo` vem do mapa (igual para o par espelhado).

**Razão**: No mapa, os pares espelhados têm `codigo_local_estoque` diferente por empresa, mas **o mesmo `codigo` textual** (`11.1` → 8115873874 Q2P e 4498926337 ACXE, ambos `ESPELHADO`). É por esse `codigo` que a planilha agrupa. Produtos não têm código comum entre empresas — a correlação é **textual por descrição** (mesma decisão do StockBridge legado, CLAUDE.md Q6).

**Alternativas rejeitadas**:
- Juntar por `ncodprod`/`ccodigo` (código do produto): ACXE e Q2P têm códigos distintos para o mesmo produto → não casaria.
- Juntar por `codigo_local_estoque`: é diferente entre empresas → pares espelhados nunca se encontrariam.

---

## D4. Data de referência: `MAX(ddataposicao)` por empresa

**Decisão**: Para cada empresa, usar a posição da **última data disponível** (`MAX(ddataposicao)`), calculada independentemente para ACXE e Q2P. Expor as duas datas na resposta (frescor) e sinalizar se diferirem (FR-015).

**Razão**: A planilha controla isso em `tbl_controleAtualizacao` (uma `dDataPosicao` por empresa). Hoje ambas estão em `2026-06-22`, mas o sync pode atrasar uma das empresas. `MAX(...)` por empresa é robusto; fixar em `CURRENT_DATE` (como a view faz) quebraria nos dias de sync atrasado, mostrando vazio.

**Alternativas rejeitadas**:
- `ddataposicao = CURRENT_DATE`: frágil a atraso de sync e a fuso (ver memória de timezone). `MAX` evita ambos.

---

## D5. Onde cada regra roda: SQL faz pivot/soma, TS faz a engine

**Decisão**:
- **SQL** (`getPool()`): filtra por data/empresa, aplica blacklist via `NOT LIKE`, normaliza descrição, junta posição→mapa por `codigo_local_estoque`, descarta órfãos, e faz o **pivot** (FULL OUTER JOIN de duas agregações `SUM(fisico)` por `(codigo, descricao_local, tipo, produto_norm)`), entregando `saldo_acxe`/`saldo_q2p` (0 quando ausente).
- **TypeScript** (testável com Vitest): calcula `Diferenca = saldoAcxe - saldoQ2p`, `Saldo Negativo`, `Status Geral` (ordem de prioridade), ordenação final e KPIs.

**Razão**: Pivot/soma de ~13k linhas é trabalho de banco (eficiente, 1 query). Mas a **classificação `Status Geral`** é a regra de negócio cuja paridade com a planilha precisa ser garantida (SC-003) — colocá-la em TS puro permite testes unitários determinísticos com casos da planilha. Alinha com Princípio III (regra em TS coberta por teste) e com o padrão dos services 008/009 (SQL agrega, TS finaliza).

**Alternativas rejeitadas**:
- Tudo em SQL (CASE WHEN ...): difícil de testar isoladamente; a paridade viraria teste de integração caro.
- Tudo em TS (puxar 13k linhas e agregar em memória): desperdício; o banco pivota melhor.

---

## D6. Blacklist de produtos

**Decisão**: Excluir produtos cujo `ccodigo` começa com `CONS_`, `PRD00001`, `SUC-`, `STRETCH`. Aplicar no `WHERE` SQL (`ccodigo NOT LIKE 'CONS\_%' ESCAPE '\' AND ...`). Constante compartilhada exportada em TS para também documentar/testar.

**Razão**: Idêntico à planilha (Etapa 1 do spec técnico). Filtrar em SQL reduz volume antes do pivot. `CONS_` precisa de `ESCAPE` porque `_` é coringa no LIKE.

**Alternativas rejeitadas**: filtrar em TS pós-query — processa linhas que seriam descartadas.

---

## D7. Badge: contagem = todos os itens com `Status Geral ≠ OK`

**Decisão**: O endpoint de contagem retorna o número de linhas com `Status Geral ∈ {Negativo, Divergente, Divergente e Negativo}` na posição mais recente. (Clarificação do usuário, 2026-06-22.)

**Razão**: O usuário quer ser alertado de qualquer estoque "não OK", não só das divergências de espelhamento. Mesma engine da lista, só conta.

**Implementação**: endpoint dedicado `GET /conferencia/contagem` que roda a mesma agregação e retorna `{ contagem, porStatus, dataAcxe, dataQ2p }`. O frontend consome via `useQuery` com `refetchInterval: 30_000`, idêntico ao badge de aprovações (`App.tsx`), e injeta `badge` no `SidebarSubItem` (componente `Sidebar.tsx` já renderiza bolinha vermelha quando `badge > 0`).

**Alternativas rejeitadas**:
- Reaproveitar `GET /conferencia` e contar no client: transfere ~6k linhas só para o badge; o endpoint de contagem é barato.
- Badge contando só `Divergente*`: contraria a decisão do usuário.

---

## D8. Unidade: exibir `fisico` cru como Kg

**Decisão**: `fisico` (integer) já está em **Kg** (amostra real: ACXE até 832.425; Q2P min −257.525). Exibir como Kg, sem conversão, formatando com `fmtKg` (separador de milhar pt-BR). A `Diferença` é Kg − Kg.

**Razão**: A planilha pivota `fisico` direto, sem conversão. As tabelas `stockbridge.*` (lote etc.) é que ficam em toneladas; as tabelas OMIE de posição já estão em Kg (consistente com `meu-estoque.service` que trata `vw_posicaoEstoque...` como Kg). FR-016 satisfeito sem fator de conversão.

**Risco/validação**: confirmar 1 célula contra a planilha durante a paridade (quickstart) — se a magnitude bater, a unidade está correta.

---

## D9. Papel de acesso: gestor+ (alinhado às telas-irmãs de auditoria)

**Decisão**: Expor a tela e os endpoints a **gestor+** (`requireGestor`), como as telas análogas de supervisão (CMC 008, Divergências). Item de menu com `roles: ['gestor','diretor']`.

**Razão**: É ferramenta de conferência/auditoria, não de operação de chão. As telas equivalentes já são gestor+. Fácil rebaixar para operador+ depois se o usuário-planilha for operador (a spec assumiu operador+; decisão de implementação alinhada ao padrão atual — confirmar com o usuário no review se o responsável pela planilha é operador).

**Alternativas rejeitadas**: operador+ por padrão — possível, mas diverge das telas-irmãs; deixamos como ajuste de 1 linha.

---

## D10. Evitar colisão de nomenclatura com "Divergências" (009)

**Decisão**: Menu/rota/identificadores usam **"Conferência de Estoque"** / `sb-conferencia-estoque` / `/stockbridge/conferencia`. **Não** reutilizar `sb-divergencias` nem `DivergenciasPage`.

**Razão**: Já existe `sb-divergencias` (página `DivergenciasPage.tsx`, badge `divergenciasCount`) que trata **divergências recebimento provisório × OMIE** (feature 009) — conceito diferente desta conferência ACXE×Q2P. Reaproveitar confundiria usuário e código.

---

## Resumo de descobertas do banco (evidência)

| Item | Achado |
|---|---|
| `tbl_posicaoEstoque_ACXE` | 6.895 linhas; `MAX(ddataposicao)=2026-06-22`; 14 negativos; `fisico` ∈ [−12.925, 832.425] |
| `tbl_posicaoEstoque_Q2P` | 6.160 linhas; `MAX(ddataposicao)=2026-06-22`; 24 negativos; `fisico` ∈ [−257.525, 237.075] |
| `tbl_locaisEstoques_*` | só `codigo_local_estoque`, `codigo`, `descricao` — **sem** `Tipo`/espelhamento |
| `vw_posicaoEstoqueUnificada` | UNION ACXE+Q2P, mas `WHERE fisico>=0 AND ddataposicao=hoje` → **inadequada** |
| Mapa De→Para | 23 locais; pares `ESPELHADO` compartilham `codigo` textual; importados 11.x/12.x/21.1/31.1 |
| Planilha (saída) | 6.096 linhas; hoje 12 Divergente, 11 Negativo, 4 Divergente e Negativo (27 problemas) |

Todos os `[NEEDS CLARIFICATION]` da spec foram resolvidos (badge = todos ≠ OK; v1 read-only). Nenhuma incógnita técnica remanescente.
