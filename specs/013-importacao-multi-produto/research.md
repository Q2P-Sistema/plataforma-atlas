# Phase 0 — Research: Recebimento de NF de Importação com Múltiplos Produtos

**Feature**: 013-importacao-multi-produto | **Date**: 2026-07-15

Todas as decisões abaixo foram verificadas por leitura de código em 15/07 (fluxo de importação, fluxo nacional de referência, cliente OMIE, correlação, idempotência). O achado central: **a infraestrutura já é majoritariamente por-produto** — opId determinístico, correlação ACXE↔Q2P, ajuste dual OMIE e pendências operam por produto. O que assume item único são quatro pontos concentrados (bloqueio no `consultarNF`, leitura de `det[0]`, valoração por `vNF÷qtd`, índice de idempotência por NF+empresa) e a UI.

---

## D1 — Como `consultarNF` passa a expor N itens

**Decisão**: mudar o retorno de `consultarNF` de um objeto achatado (um produto) para **cabeçalho + lista de itens**, e **remover** o `throw NotaFiscalMultiItemError`.

- Hoje ([packages/integrations/omie/src/stockbridge/nf.ts](../../packages/integrations/omie/src/stockbridge/nf.ts)): `raw.det[]` já é um array; cada `det[i].prod` traz `codigo_local_estoque`, `qCom`, `uCom`, `xProd`, `vUnCom`, e `det[i].nfProdInt.nCodProd`. O `vNF` (com tributos) é do cabeçalho (`raw.total.ICMSTot.vNF`). Só `det[0]` é lido; `det.length>1` lança erro.
- Novo `ConsultarNFResponse`: `{ nNF, cChaveNFe, dEmi, vNF, nCodCli, cRazao, itens: ItemNF[] }`, onde `ItemNF = { nCodProd, codigoLocalEstoque, qCom, uCom, xProd, vUnCom }`.
- **Consumidor único**: `consultarNFComAlertaMultiItem` (em `recebimento.service.ts`), chamado por `getFilaOmie` e `processarRecebimento`. A validação fiscal (cancelada/emitente) lê do espelho `tbl_nf_header_*`, **não** de `consultarNF` — logo o blast radius da mudança de shape é contido a um wrapper.

**Alternativa rejeitada**: adicionar `consultarNFItens` paralelo mantendo `consultarNF` single-item. Rejeitada por duplicar parsing e deixar dois caminhos divergirem; o consumidor é único, então a mudança de shape é segura.

**Limpeza associada** (código que fica obsoleto): `NotaFiscalMultiItemError`, o mapeamento `NF_MULTI_ITEM`→422 em `fila.routes.ts`/`recebimento.routes.ts`, e `enviarAlertaNfMultiItem` em `notificacao.service.ts`. Removidos com os testes correspondentes atualizados.

---

## D2 — Valoração de cada item (rateio do total da NF)

**Decisão**: ratear o `vNF` (total, com tributos, do cabeçalho) entre os itens **proporcionalmente ao valor comercial de cada um** (`vUnCom_i × qCom_i`), preservando a base de custo atual.

Fórmula (em `Decimal`/decimal.js):
```
pesoValor_i   = vUnCom_i × qCom_i            (valor comercial da linha, do OMIE)
somaPesos     = Σ pesoValor_i
valorItem_i   = vNF × pesoValor_i / somaPesos  (fatia com tributos do item i)
```
Depois, por item, aplica-se **a mesma fórmula de hoje**, trocando `vNF`→`valorItem_i` e `qtdNfKg`→`qtdNfKg_i`:
- `valorUnitarioAcxe_i = round(valorItem_i / qtdNfKg_i, 2)`
- `valorUnitarioQ2p_i  = ceil(valorItem_i / qtdNfKg_i × 1,145, 2)` (markup interno 14,5%, `calcularValorUnitarioQ2p`).

**Redução ao caso atual**: para N=1, `pesoValor/somaPesos = 1` ⇒ `valorItem = vNF` ⇒ as fórmulas caem **exatamente** nas atuais (`calcularValorUnitarioAcxe/Q2p`). Isso torna o comportamento single-item invariante por construção — a suíte Vitest existente é a guarda de regressão.

**Reconciliação de resíduo**: soma de `valorItem_i` arredondados pode diferir de `vNF` por centavos. Para garantir `Σ valorItem_i = vNF` exato, o último item (ou o de maior peso) recebe o resíduo. Sem isso, o custo total lançado divergiria do total da NF (SC-003).

**Alternativa rejeitada**: usar `det[i].vUnCom` cru (sem tributos) por item. Rejeitada porque **reduziria a base de custo** vs. o praticado hoje (que embute tributos via `vNF`), criando inconsistência de CMC/custo médio entre NF single e multi-item. **Confirmada com o negócio em 15/07: base com tributos, como hoje** — decisão travada, não mais reversível sem novo aval.

---

## D3 — Granularidade: 1 lote por produto (N lotes por NF)

**Decisão**: cada produto vira **seu próprio lote** (com sua movimentação e, se divergente, sua aprovação); os N lotes de uma NF compartilham a coluna `nota_fiscal` como chave de agrupamento. **Sem tabela de agrupamento nova.**

- A tabela `stockbridge.lote` já é **por-produto**: `produto_codigo_acxe` é `NOT NULL`, e há `quantidade_fisica_kg`, `quantidade_fiscal_kg`, `custo_brl_kg`, `valor_total_nf_brl`, `codigo_local_estoque_origem_acxe` — todos de um único produto. Um lote não comporta N produtos sem mudança de schema.
- Reusa **verbatim** a máquina single-item por item: caminho limpo → `lote` provisório + `movimentacao` dual; caminho divergente → `lote` aguardando_aprovacao + `aprovacao`, com OMIE diferido para a aprovação.
- **`valor_total_nf_brl` em lote multi-item** passa a carregar o **valor rateado do item** (`valorItem_i`), não o total da NF. Semântica coerente: a coluna sempre representa "o valor (com tributos) que respalda a quantidade fiscal deste lote"; para NF single-item isso continua igual ao `vNF`. A aprovação recomputa valor/kg a partir de `valor_total_nf_brl / quantidade_fiscal_kg` — com valor e quantidade **do item**, o valor/kg sai correto.

**Alternativa rejeitada**: 1 lote por NF com N movimentações. Rejeitada porque `lote` tem colunas de produto único; caberia só com migration de desnormalização (mover produto/qtd/valor para a movimentação e transformar lote em cabeçalho) — muito mais invasivo e arriscado que reusar o modelo por-produto já validado.

**Agrupamento na UI**: fila e aprovações agrupam por `nota_fiscal` (query), exibindo "NF X — 3 produtos". Nenhuma entidade nova.

---

## D4 — Idempotência por produto (a migration da feature)

**Decisão**: tornar a idempotência de `entrada_nf` **por (NF, empresa, produto)** em vez de (NF, empresa). É a **única migration** desta feature: [0046](../../packages/db/migrations/) (índice), sem tabela nova (logo sem trigger de audit nova).

- Índice atual (migration 0044): `UNIQUE (nota_fiscal, tipo_movimento, empresa) WHERE tipo_movimento IN ('entrada_nf','saida_automatica') AND ativo AND empresa IS NOT NULL`. Isso permite **uma** `entrada_nf` ativa por (NF, empresa) — N produtos da mesma NF **violariam** o índice a partir do 2º.
- **Split em dois índices** (o compartilhado hoje mistura entrada e saída):
  - `entrada_nf` → `UNIQUE (nota_fiscal, empresa, produto_codigo_acxe) WHERE tipo_movimento='entrada_nf' AND ativo AND empresa IS NOT NULL AND produto_codigo_acxe IS NOT NULL`.
  - `saida_automatica` → mantém `UNIQUE (nota_fiscal, empresa)` (inalterado; adicionar produto quebraria a idempotência de saída, cujo `produto_codigo_acxe` pode ser NULL — NULLs são distintos em índice único).
- `nfJaProcessada(nf, empresa)` → **`produtoDaNfJaRecebido(nf, empresa, produtoAcxe)`**: checa `entrada_nf` ativa e `lote` aberto **daquele produto**. A checagem de `movimentacao_legado` fica **por NF** (histórico PHP é single-item; guarda grossa contra reprocessar NF antiga).
- `contarTentativasAnteriores` → **por produto** (conta `entrada_nf` inativas daquele produto na NF), para o `tentativa` do opId ser independente por item.
- `opId` **já é por produto** (`recebimento:${nf}:${cnpj}:${codigoProdutoAcxe}:${tentativa}`) — **nenhuma mudança**.
- Tradução do backstop 23505 (`isViolacaoIdempotenciaNf`) atualizada para o(s) novo(s) nome(s) de constraint.

**Consequência importante (recebimento resumível)**: com idempotência por produto, **re-submeter uma NF parcialmente recebida completa só os produtos faltantes** — os já concluídos são pulados. Isso resolve o cenário "produto 2 falhou no OMIE, produtos 1 e 3 entraram" sem travar a NF inteira.

---

## D5 — Atomicidade OMIE: dois portões (tudo-ou-nada + best-effort por item)

**Decisão**: separar explicitamente dois momentos, porque o OMIE **não é transacional entre produtos**.

- **Portão 1 — pré-escrita, tudo-ou-nada** (decisão de negócio da spec): valida a NF (cancelada/emitente, como hoje) e **todos os itens** (correlação Q2P, produto válido, localidade, quantidade) **antes de tocar o OMIE**. Se **qualquer** item falha → bloqueia a NF inteira, **zero escrita** (HTTP 409/422 nomeando o produto). Espelha o loop de validação prévia do fluxo nacional.
- **Portão 2 — escrita, best-effort por item**: com todos validados, processa item a item (OMIE dual + persistência, ou rota de divergência). Falha de OMIE **em um item** não derruba o lote todo:
  - ACXE falha → aquele item não é persistido (limpo, como no single-item); demais itens seguem.
  - Q2P falha após ACXE → item persistido `pendente_q2p` (mecanismo atual), recuperável no painel de operações pendentes, por item.
- **Resposta**: `201` com **outcomes por item** (`concluida | aguardando_aprovacao | pendente_q2p | falha_acxe`) + resumo. **Não** há 502 de lote — a falha parcial de OMIE é estado conhecido e recuperável, não erro terminal do batch. (Contrasta com o single-item, que devolve 502 porque a operação inteira ficou incompleta; no multi-item, "incompleto" é por item.)

**Alternativa rejeitada**: fail-fast no 1º erro de ACXE (aborta o restante). Rejeitada porque um erro de OMIE costuma ser sistêmico e a idempotência por produto (D4) já torna tudo resumível; best-effort dá o outcome completo numa passada. Registrada como opção caso o volume de ruído em OMIE-down se mostre problema.

---

## D6 — Divergência por item (reuso da máquina single-item)

**Decisão**: cada item divergente (físico < fiscal, além da tolerância de 1 kg) segue **o mesmo caminho do single-item**, aplicado por item: cria `lote` aguardando_aprovacao + `aprovacao` (`recebimento_divergencia`, `tipo_divergencia` faltando/varredura), **sem tocar OMIE no recebimento**; o OMIE (dual + transferência da diferença para estoque especial) acontece **na aprovação do gestor**, por item.

- Itens que conferem entram direto (Portão 2, caminho limpo); itens divergentes viram pendência de aprovação — **na mesma NF, itens seguem rotas diferentes**.
- Regra de excedente (recebido > NF) mantém o **bloqueio por item** já existente.
- **Notificação consolidada**: quando ≥1 item de uma NF fica aguardando aprovação, **um** e-mail ao gestor lista os itens (padrão `enviarAlertaRecebimentoNacionalLote` do fluxo nacional), evitando N e-mails por NF.

Reusa `processarRecebimentoComDivergencia` e o ramo `recebimento_divergencia` de `aprovacao.service.ts` (que já ancora o opId em `aprovacao.id` e resolve estoque especial faltando/varredura) — **inalterados**, apenas invocados por item.

---

## D7 — UX: lista de itens pré-preenchida da NF

**Decisão**: a tela de recebimento de importação passa a exibir os N itens da NF (modelo visual do `RecebimentoNacionalForm`, mas **pré-preenchido** pela consulta OMIE — não digitado).

- Por item (linha): produto e valor **read-only** (vêm da NF); **editáveis**: quantidade física recebida (default = qtd da NF, sempre em kg — mantém o fix ACXEGDP-176) e localidade de destino (cada item pode ir a um galpão diferente). Divergência calculada por linha, em tempo real, com a mesma tolerância de 1 kg.
- **Não há** "+ Adicionar item" (diferente do nacional): os itens são os da NF, fixos. Não há remover item (a NF é tudo-ou-nada).
- N=1 renderiza a experiência atual (`ConferenciaModal`) — a unificação preserva o fluxo de item único como caso particular.
- **Contrato de submit unificado**: `POST /recebimento` passa a aceitar `itens[]` (1+). Para N=1, o front envia um array de um. StockBridge TS ainda não está em produção (o legado PHP é o sistema vivo — Princípio V), então mudar o contrato TS é seguro; a paridade é contra o PHP e a suíte single-item é a guarda de regressão do caso N=1.

---

## Resumo das mudanças de código (orientação para `/speckit.tasks`)

| Área | Arquivo | Mudança |
|---|---|---|
| OMIE | `packages/integrations/omie/src/stockbridge/nf.ts` | `ConsultarNFResponse` → cabeçalho + `itens[]`; remove throw multi-item; `mock.ts` fixtures multi-item |
| Idempotência | `packages/db/migrations/0046_*.sql` | split do índice; `entrada_nf` por (NF, empresa, produto) |
| Serviço | `modules/stockbridge/src/services/recebimento.service.ts` | extrair `processarItemRecebimento`; loop multi-item; rateio; `produtoDaNfJaRecebido`/`contarTentativas` por produto; Portão 1 valida todos antes de escrever |
| Correlação | `correlacao.service.ts` | inalterada (já por produto); chamada N vezes no Portão 1 |
| Aprovação/divergência | `aprovacao.service.ts`, `recebimento.service.ts` | ramo divergência inalterado; invocado por item |
| Notificação | `notificacao.service.ts` | consolidação por NF (itens pendentes de aprovação); remover `enviarAlertaNfMultiItem` |
| Rotas | `recebimento.routes.ts`, `fila.routes.ts` | `POST /recebimento` aceita `itens[]`; remove mapeamento `NF_MULTI_ITEM`; `GET /fila` devolve N itens |
| UI | `apps/web/src/pages/stockbridge/operador/` (`FilaOmiePage`, `ConferenciaModal`/novo form) | lista de itens pré-preenchida; submit `itens[]` |
| Testes | `modules/stockbridge/src/__tests__/*` | multi-item (happy, divergência por item, tudo-ou-nada, resumível); N=1 preservado |
