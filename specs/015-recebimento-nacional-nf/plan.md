# Implementation Plan: Recebimento Nacional a partir da NF do Fornecedor

**Branch**: `015-recebimento-nacional-nf` | **Date**: 2026-09-17 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/015-recebimento-nacional-nf/spec.md`
**Jira**: ACXEGDP-328 (subtarefa de ACXEGDP-114)

## Summary

O recebimento nacional é hoje 100% digitação: o operador digita número da NF (texto livre, nunca consultado), valor total, produto, quantidade, unidade e um "valor unitário de referência" que serve só de peso para o rateio. A feature inverte a origem do dado — a NF passa a preencher o formulário, como já acontece na importação. O operador escolhe a NF numa fila, confere os itens, correlaciona a descrição do fornecedor aos produtos do catálogo, informa o **peso conferido na balança** quando ele difere da NF, e dá entrada.

**Abordagem técnica**: cinco peças novas sobre estrutura existente.

1. **Fila nacional** — query nova sobre o espelho (`tbl_nf_header_Q2P` ⋈ `tbl_nf_itens_Q2P`), na forma de `getFilaPendente` (feature 014), com filtros próprios: CFOP do recorte, janela temporal, exclusão de fornecedor e pendência pelo lado Atlas. Renderiza na aba "Compra nacional" que já existe em `FilaOmiePage`.
2. **Correlação memorizada 1:N** — tabela nova `stockbridge.correlacao_produto_fornecedor` (De→Para por fornecedor + descrição normalizada → **conjunto** de produtos).
3. **Entrada guiada pela NF, com divergência** — caminho novo no service nacional: valor vem de `v_tot_item`, quantidade vem pré-preenchida mas é substituível pelo peso conferido; a diferença é gravada e vai para aprovação do gestor. Depois disso, reusa o que já existe: 1 movimentação + 1 aprovação por produto, ajuste OMIE na aprovação.
4. **Distribuição de um item entre N produtos** — sucata entra como uma linha fiscal e é classificada por grau; o valor do item é rateado por peso entre os produtos resultantes.
5. **Recebimento externo** — declaração, com aprovação de gestor, de que os itens já entraram fora do Atlas (tipicamente direto no OMIE). Retira o item da fila sem criar movimentação. Reusa `stockbridge.aprovacao`; atrás de flag.

**A pesquisa e a verificação adversarial mudaram sete premissas**, e o plano é construído sobre a versão corrigida (detalhe em [research.md](./research.md)):

- **`n_id_receb` não serve como "já recebida"** (D1): preenchido em 5.540 de 5.541 NFs de entrada. Sobra uma única fonte, o lado Atlas, o que **obriga** corte temporal (D2) — sem ele a fila nasce com 3.241 NFs em vez de 41.
- **A checagem de "recebida" da importação não funciona aqui** (D11): `recebidaViaMovimentacaoSql` fixa `subtipo = 'importacao'` e `produto_codigo_acxe`, e as 144 movimentações nacionais têm `produto_codigo_acxe` **nulo**. Precisa ser parametrizada nos dois eixos.
- **O número da NF não identifica o documento** (D19): 125 colisões entre fornecedores nas 3.241 NFs elegíveis. `c_chave_nfe` está em 100% delas, com 44 dígitos, sem repetição — é a identidade correta, e `movimentacao` não a guarda hoje.
- **A unidade declarada pode contradizer a quantidade** (D24): 14 itens rotulados `KG` estão em toneladas — convertidos pela tabela, entrariam com 1/1000 da quantidade. A unidade precisa sobreviver a uma conferência contra o preço implícito, e o item é bloqueado quando as duas informações se contradizem.
- **Divergência de peso é situação normal** (D17): em ~32% das comparações inequívocas o peso conferido difere do declarado, quase sempre para mais, e hoje **nada disso deixa rastro**. Diferente da importação, o nacional **aceita** receber acima da NF (decisão do usuário, 17/09/2026).
- **Um item da NF pode virar N produtos** (D18): a NF 66461 da ISOFORMA tem 1 item de SUCATA classificado em 3 produtos. Correlação 1:1 excluiria esse fornecedor inteiro da fila.
- **A pendência por item não é calculável pelo produto** (D20): 97,5% dos itens elegíveis não trazem `n_cod_prod`. A movimentação passa a gravar a **descrição do item da NF** que a originou — o que também impede que duas linhas distintas classificadas no mesmo produto colidam no índice único e percam quantidade silenciosamente.
- **A cegueira da chave de acesso é permanente** (D21): o formulário manual continua obrigatório (FR-014), atende NFs fora do espelho e nunca terá chave para gravar. A checagem de "já recebida" precisa de duas vias — por chave e, para as linhas sem chave, por número + empresa. Cobertura de ~90%; os 10% restantes são a razão de existir o recebimento externo (D22).

**Com migration** (`0052`): tabela de correlação; cinco colunas em `movimentacao` (chave de acesso, descrição do item crua e normalizada, quantidade da NF, divergência); três em `aprovacao` (chave, número, descrição do item) mais o novo `tipo_aprovacao`; o índice único de idempotência nacional; e o **seed das exclusões de fornecedor** decididas em 17/09/2026 — sem ele a fila sobe com 77% de NFs que o usuário tirou do escopo.

## Technical Context

**Language/Version**: TypeScript 5.5+ strict, Node.js 20 LTS
**Primary Dependencies**: Express 4 (rotas de fila/detalhe/recebimento nacional por NF), Drizzle ORM (tabela de correlação + migration) e raw SQL via `getPool()` (query da fila sobre o espelho), decimal.js (valor do item), Zod (validação), React 18 + TanStack Query + Tailwind (aba "Compra nacional" da `FilaOmiePage`). Sem dependência nova.
**Storage**: PostgreSQL 16 — **leitura** de `public."tbl_nf_header_Q2P"`, `public."tbl_nf_itens_Q2P"`, `public."tbl_produtos_Q2P"`, `stockbridge.localidade`, `stockbridge.localidade_correlacao`, `stockbridge.fornecedor_exclusao`; **escrita** em `stockbridge.movimentacao`, `stockbridge.aprovacao` (fluxo já existente) e na nova `stockbridge.correlacao_produto_fornecedor`.
**Testing**: Vitest — tabela de unidades (incluindo o caso de bloqueio, hoje inexistente), match/memória de correlação 1:N, cálculo de divergência e do rateio por peso dentro do item, checagem de "recebida" nacional, query da fila (inspeção do SQL gerado, como `fila-pendente.test.ts` faz) e idempotência por chave de acesso. Supertest nas rotas novas. É a **primeira** cobertura do caminho nacional (D16).
**Target Platform**: Linux server (Docker Swarm, `apps/api` + `apps/web`).
**Project Type**: Web — monorepo modular (`modules/stockbridge` + `apps/web` + `packages/db`).
**Performance Goals**: fila consultada na abertura da aba, baixa frequência. **Zero** chamada OMIE ao vivo no caminho de leitura (Princípio II) — diferente da importação, que consulta a NF no OMIE ao buscar.
**Constraints**: (a) nenhuma escrita em NF no OMIE — o Atlas só lê NF e escreve ajuste de estoque, na aprovação, como já faz; (b) unidade fora da tabela **bloqueia**, nunca converte (o oposto do `normalizarUnidade` da importação, que assume kg — D15); (c) mensagens por descrição de produto e nome de local, nunca código OMIE (ACXEGDP-313); (d) o formulário manual atual permanece funcionando sem alteração de comportamento; (e) locais espelhados continuam recusados; (f) identidade da NF é a chave de acesso, não o número (D19); (g) divergência aceita nos dois sentidos, ao contrário da importação — assimetria deliberada (D17); (h) num item distribuído, a soma das quantidades MUST fechar com o peso conferido.
**Scale/Scope**: fila de estreia com ~2 NFs pendentes (9 elegíveis no corte de 7 dias, 7 já recebidas pelo fluxo manual); ~117 pares de correlação distintos por ano; 29 fornecedores ativos. Mudança em ~7 arquivos backend, ~2 frontend, 1 migration.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Princípio | Avaliação | Status |
|---|---|---|
| **I. Monólito Modular com Fronteiras Inegociáveis** | Todo o código novo vive em `modules/stockbridge/*` e `apps/web`. A tabela nova nasce em `stockbridge.*` (nunca em `public`), conforme o gate. Nenhuma leitura de tabela privada de outro módulo; as tabelas `public."tbl_*"` são o espelho OMIE, exceção prevista no próprio princípio. Migration centralizada em `packages/db/migrations/`. | ✅ PASS |
| **II. OMIE é Fonte de Verdade, Atlas Lê do Postgres** | A fila e o detalhe da NF leem **exclusivamente** do espelho Postgres — zero chamada à API OMIE no caminho de leitura, inclusive mais estrito que a importação (que chama `consultarNF` ao buscar). A única escrita no OMIE continua sendo o ajuste de estoque na aprovação, caminho já existente e já documentado como exceção. Nenhum status de documento OMIE é setado pelo Atlas. | ✅ PASS |
| **III. Dinheiro Só em TypeScript** | Valor do item (`v_tot_item`), conversão de unidade e custo unitário são calculados em TS com decimal.js, cobertos por Vitest. Nada em n8n. A feature **reduz** exposição: substitui o rateio por peso digitado pelo valor discriminado na própria NF. | ✅ PASS |
| **IV. Audit Log Append-Only via Trigger** | A tabela nova `stockbridge.correlacao_produto_fornecedor` nasce na mesma migration com a trigger de auditoria padrão (`stockbridge.audit_<tabela>` + `trg_audit_sb_<tabela>`), cobrindo INSERT/UPDATE/DELETE, conforme a skill `stockbridge-migration`. Correção de correlação é UPDATE auditado, não DELETE. | ✅ PASS |
| **V. Validação Paralela, Zero Big-Bang** | O caminho manual atual **permanece intacto e disponível** (FR-014) — o fluxo por NF é adicionado ao lado, não no lugar. Isso é validação paralela dentro do próprio módulo: as duas origens convivem e podem ser comparadas antes de qualquer decisão de aposentar o formulário manual. O StockBridge segue sob o regime de validação paralela contra o legado PHP, que esta feature não altera. | ✅ PASS |

**Resultado do gate**: PASS. Nenhuma violação a justificar em Complexity Tracking.

**Re-check pós-Fase 1**: mantido PASS. O design da Fase 1 não introduziu tabela fora de `stockbridge.*`, não adicionou chamada OMIE, não moveu cálculo para fora do TS e mantém a trigger de auditoria na tabela nova. Ver nota em Complexity Tracking sobre a pendência de dado de D13, que é pré-requisito operacional e não violação de princípio.

## Project Structure

### Documentation (this feature)

```text
specs/015-recebimento-nacional-nf/
├── plan.md              # Este arquivo
├── spec.md              # Especificação (6 histórias, 31 FRs, 11 SCs)
├── research.md          # Phase 0 — 25 decisões com evidência de PROD/UAT
├── data-model.md        # Phase 1 — tabela nova + shapes da fila/detalhe
├── quickstart.md        # Phase 1 — como validar
├── contracts/
│   └── recebimento-nacional-nf.md   # Phase 1 — contrato dos endpoints
├── checklists/
│   └── requirements.md  # checklist de qualidade da spec (aprovado)
└── tasks.md             # Phase 2 (/speckit.tasks — NÃO criado aqui)
```

### Source Code (repository root)

```text
packages/db/
├── migrations/
│   └── 0052_stockbridge_recebimento_nacional_nf.sql   # NOVA: tabela De→Para (1:N) + trigger; 5 colunas
│                                                      #   em movimentacao e 3 em aprovacao; relaxamento
│                                                      #   de aprovacao_chk_lote_ou_sku; índice único de
│                                                      #   idempotência; seed das exclusões de fornecedor
└── src/schemas/stockbridge.ts                         # ESTENDER: tabela nova + 3 colunas

modules/stockbridge/src/
├── services/
│   ├── fiscal-recebida-sql.ts          # ESTENDER: parametrizar subtipo E coluna de produto
│   │                                   #   (hoje fixa 'importacao' + produto_codigo_acxe — D11).
│   │                                   #   Default preserva o comportamento atual.
│   ├── fila-nacional.service.ts        # NOVO: query da fila (CFOP, janela, exclusão, pendência)
│   │                                   #   + detalhe da NF com agregação por descrição
│   ├── correlacao-produto.service.ts   # NOVO: De→Para 1:N, normalização, desativação auditada
│   ├── unidade-nf.ts                   # NOVO: tabela explícita KG/TON/TL → Kg + conferência contra o
│   │                                   #   preço implícito; incoerência bloqueia (D24)
│   ├── recebimento-externo.service.ts  # NOVO: baixa de item já recebido fora do Atlas + reversão
│   └── recebimento-nacional.service.ts # ESTENDER: caminho por NF — valor de v_tot_item,
│                                       #   peso conferido + divergência, distribuição 1:N com
│                                       #   rateio por peso. Caminho manual intacto.
├── routes/
│   └── recebimento-nacional.routes.ts  # ESTENDER: GET /fila, GET /fila/:chaveAcesso,
│                                       #   POST /por-nf, PUT /correlacao
└── __tests__/                          # NOVO: unidade-nf, correlacao-1n, divergencia-nacional,
                                        #   fila-nacional, idempotencia-nacional + regressão de
                                        #   fiscal-recebida-sql (primeira cobertura do nacional)

apps/web/src/pages/stockbridge/operador/
├── FilaOmiePage.tsx                    # ESTENDER: aba "Compra nacional" ganha fila + detalhe,
│                                       #   alternando com o formulário manual
├── RecebimentoNacionalNfPanel.tsx      # NOVO: fila + detalhe da NF, com campo de peso conferido,
│                                       #   motivo de divergência, distribuição por produto e baixa externa
└── ../gestor/AprovacoesPage.tsx        # ESTENDER: painel NF × conferido × diferença; produto pelo
                                        #   catálogo Q2P; card e reversão de recebimento externo
```

**Structure Decision**: web monorepo modular. A peça reusável é `fiscal-recebida-sql.ts` — em vez de duplicar o `EXISTS`, a função ganha os dois parâmetros que faltam, preservando o comportamento atual por default e servindo os dois fluxos a partir de uma definição só. A UI não ganha rota nova: a aba "Compra nacional" de `/stockbridge/fila` já existe e passa a oferecer fila + entrada manual, espelhando o que a aba "Importação" já faz.

## Complexity Tracking

> Constitution Check passou sem violações — preenchimento não requerido.

Três notas de design, nenhuma delas violação de princípio:

**1. A migration deixou de ser bloqueada pelo passivo de dados.** A versão anterior deste plano chaveava a idempotência por `(nota_fiscal, empresa, produto)`, o que travava a criação do índice enquanto existissem as NFs relançadas. Com a chave de acesso (D19), o índice cobre só linhas com `nf_chave_acesso` preenchida — e as 144 movimentações nacionais históricas têm o campo nulo, porque a coluna nasce nesta feature. A migration sobe sem tocar no passado.

> As ~40,7 t de excesso das NFs 66529, 66530 e 66604 **continuam no estoque e no OMIE**. O índice impede a repetição, não corrige o histórico. A remediação segue sendo decisão de negócio — agora desacoplada da entrega, o que é melhor para as duas coisas.

**2. Escopo da parametrização de `fiscal-recebida-sql.ts`.** A função é consumida por 5 serviços no caminho de importação (`cockpit`, `cockpit-executivo`, `pendencias-fiscais`, `nf-pedido-mapa`, `recebimento`) e coberta por 3 arquivos de teste. A mudança é deliberadamente aditiva (parâmetros opcionais com default igual ao de hoje), para que nenhum dos 6 pontos corrigidos pela feature 014 mude de resultado. A guarda de regressão é requisito das tarefas de teste.

**3. Assimetria consciente com o recebimento de importação.** A importação recusa receber acima da NF (`QuantidadeExcedeNfError`, fiel ao legado PHP); o nacional aceita, com motivo e aprovação. A regra é diferente porque a operação é diferente: nas comparações inequívocas, as divergências genuínas são quase todas para cima (research D17). Manter a regra da importação recusaria a maioria dos recebimentos reais. Registrado aqui para que a divergência entre os dois fluxos seja lida como decisão, não como inconsistência.
