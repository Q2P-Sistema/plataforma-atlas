# Phase 1 — Data Model: Recebimento Nacional a partir da NF do Fornecedor

**Feature**: `015-recebimento-nacional-nf` | **Migration**: `0052`

---

## 1. Tabela nova — `stockbridge.correlacao_produto_fornecedor`

Memória do De→Para entre a descrição livre do fornecedor e os produtos do catálogo. Sustenta as Histórias 3 e 4.

| Coluna | Tipo | Regra |
|---|---|---|
| `id` | `uuid` PK `defaultRandom()` | — |
| `fornecedor_cnpj` | `varchar(50) NOT NULL` | `dest_cnpj_cpf` da NF |
| `fornecedor_nome` | `varchar(255) NOT NULL` | `dest_razao` no momento da correlação |
| `descricao_nf` | `varchar(500) NOT NULL` | `x_prod` original, preservado |
| `descricao_normalizada` | `varchar(500) NOT NULL` | chave de match — ver §1.1 |
| `produto_codigo_q2p` | `bigint NOT NULL` | `tbl_produtos_Q2P.codigo_produto` |
| `produto_descricao` | `varchar(255) NOT NULL` | descrição do catálogo (mensagens usam isto — ACXEGDP-313) |
| `vezes_usada` | `integer NOT NULL DEFAULT 0` | incrementa quando a sugestão é aceita |
| `ultima_vez_usada_em` | `timestamptz` | — |
| `criado_por` | `uuid NOT NULL` → `atlas.users(id)` | — |
| `atualizado_por` | `uuid` → `atlas.users(id)` | — |
| `ativo` | `boolean NOT NULL DEFAULT true` | soft delete — nunca `DELETE` (Princípio IV) |
| `created_at` / `updated_at` | `timestamptz NOT NULL DEFAULT now()` | — |

**Índice único** — `UNIQUE (fornecedor_cnpj, descricao_normalizada, produto_codigo_q2p) WHERE ativo = true`.

> A chave inclui o **produto** porque a correlação é **1:N** (research D18): uma descrição de fornecedor pode legitimamente virar vários produtos. A NF 66461 da ISOFORMA tem 1 item de SUCATA que foi classificado em PS CRISTAL A, PS AI B e PS CRISTAL B. Um índice em `(fornecedor, descrição)` impediria exatamente a operação que o segundo fornecedor mais frequente faz todo dia.

**Consulta de sugestão**: dado (fornecedor, descrição normalizada), devolve **o conjunto** de produtos já usados, ordenado por `vezes_usada DESC`. Para uma descrição 1:1 o conjunto tem um elemento e a UI pré-seleciona; para uma descrição classificável, propõe o conjunto e o operador distribui as quantidades.

**Remoção de um produto do conjunto**: `ativo = false` na linha (auditado), não `DELETE`.

**Trigger de auditoria** (obrigatória, Princípio IV): `stockbridge.audit_correlacao_produto_fornecedor()` + `trg_audit_sb_correlacao_produto_fornecedor`, cobrindo INSERT/UPDATE/DELETE, no padrão das 8 triggers de `0008_stockbridge_core.sql`.

### 1.1 Normalização da descrição

Regra explícita e testável, aplicada antes de gravar e antes de consultar:

1. `trim`
2. colapso de espaços internos (`\s+` → um espaço)
3. caixa alta
4. remoção de acentuação

Ganho medido (research D8): 315 pares crus → 307 normalizados em 2025–2026, ou seja 8 pares (2,5%). **Sem match fuzzy** nesta fase — com variação puramente formatal tão baixa, fuzzy arriscaria sugerir o produto errado num fluxo que move estoque e dinheiro.

---

## 2. Colunas novas em `stockbridge.movimentacao`

| Coluna | Tipo | Por quê |
|---|---|---|
| `nf_chave_acesso` | `varchar(44)` | **Identidade do documento fiscal.** O número da NF colide entre fornecedores — 125 colisões nas 3.241 elegíveis (research D19). `c_chave_nfe` está em 100% delas, sem repetição. |
| `nf_item_descricao` | `varchar(500)` | Descrição do item da NF que originou esta movimentação, como veio (`x_prod`). |
| `nf_item_descricao_normalizada` | `varchar(500)` | A mesma, normalizada (§1.1) — **participa da chave de idempotência**. |
| `quantidade_nf_kg` | `numeric(12,3)` | Quantidade declarada na NF **atribuída a esta movimentação**. Em item 1:1 é a quantidade do item; em item distribuído entre N produtos, é a parcela proporcional ao peso deste produto — senão `quantidade_divergencia_kg` ficaria grosseiramente errada em todo item classificado. |
| `quantidade_divergencia_kg` | `numeric(12,3)` | `quantidade_kg − quantidade_nf_kg`. Positiva = recebemos mais que a NF. |

`quantidade_kg` (já existente) passa a significar, neste fluxo, a **quantidade conferida na balança**.

### 2.1 Por que a descrição do item precisa estar aqui

Duas razões, ambas estruturais (research D20):

**1. Sem ela, a pendência por item é incalculável.** A fila precisa saber quais itens da NF ainda faltam. Mas o item do espelho **não traz código de produto**: 1.596 de 1.637 itens elegíveis de 2026 (**97,5%**) têm `n_cod_prod` nulo. O único elo descrição→produto é a tabela de correlação, que só ganha conteúdo com o uso. Sem a descrição gravada na movimentação, a fila da Fase 3 dependeria da correlação da Fase 5 — e o primeiro recebimento de cada fornecedor continuaria sem resposta.

Com ela, pendência de item = *existe movimentação ativa para esta chave de NF e esta descrição normalizada?* — resolvido no próprio dado, sem intermediário.

**2. Sem ela, o índice único apaga quantidade.** A chave `(nf_chave_acesso, produto_codigo_q2p)` proíbe duas linhas distintas da mesma NF serem classificadas no **mesmo** produto — caso real quando as descrições diferem só por lote. Pelo contrato, a violação `23505` vira `ja_recebido`, ou seja, a segunda linha **desaparece sem erro**. Com a descrição na chave, as duas coexistem e cada uma soma seu peso.

## 3. Índice novo — idempotência do caminho nacional

```sql
CREATE UNIQUE INDEX movimentacao_nf_nacional_idempotencia_idx
    ON stockbridge.movimentacao
       (nf_chave_acesso, nf_item_descricao_normalizada, produto_codigo_q2p)
    WHERE subtipo = 'compra_nacional'
      AND ativo = true
      AND nf_chave_acesso IS NOT NULL
      AND produto_codigo_q2p IS NOT NULL;
```

Cada componente é forçado por um achado:

- **`nf_chave_acesso`** e não `nota_fiscal`: o número colide entre fornecedores. Chavear pelo número bloquearia a NF 85 da TRIPOLY porque a NF 85 da RESIN-WEB já foi recebida (research D19).
- **`nf_item_descricao_normalizada`**: sem ela, duas linhas distintas da NF classificadas no mesmo produto colidem e a segunda some silenciosamente (research D20).
- **`produto_codigo_q2p`** e não `produto_codigo_acxe`: as 144 movimentações nacionais ativas têm `produto_codigo_acxe` **nulo** — o fluxo é single-empresa (research D11).
- **`subtipo`** e não `tipo_movimento`: o nacional usa `entrada_manual`, que cobre outros subtipos também.

As 145 linhas históricas têm `nf_chave_acesso` nulo, logo ficam **fora** do índice. Consequência prática: a migration **não é bloqueada** pelas 3 NFs relançadas de research D13.

> ⚠️ As ~40,7 t de excesso daquelas NFs continuam no estoque e no OMIE. O índice impede repetição, não corrige o histórico.

### 3.1 O índice não basta — a checagem tem duas vias

O índice só alcança linhas **com** chave de acesso, ou seja, as que esta feature criar. O formulário manual permanece obrigatório (FR-014), atende NFs fora do espelho e por definição **nunca terá chave para gravar**. A cegueira é permanente, não transitória (research D21).

A checagem de "já recebida" usada pela fila combina, portanto:

```text
recebida(NF, item, produto) =
      EXISTS movimentação ativa com nf_chave_acesso = <chave>
             AND nf_item_descricao_normalizada = <descrição>      -- caminho novo
   OR EXISTS movimentação ativa com nf_chave_acesso IS NULL
             AND subtipo = 'compra_nacional'                        -- <<< obrigatório
             AND numero_sem_zeros(nota_fiscal) = numero_sem_zeros(<n_nf>)
             AND empresa = 'q2p'                                   -- linhas do fluxo manual
   OR EXISTS recebimento_externo APROVADO para (<chave>, <descrição>)
```

> O filtro por `subtipo = 'compra_nacional'` **não é opcional**. Sem ele, o ramo casaria também com as **saídas automáticas** da Q2P, que gravam `nota_fiscal` e `empresa = 'q2p'` e também nunca têm chave de acesso — uma NF de compra genuinamente pendente sumiria da fila porque existe uma saída com o mesmo número.

Confiabilidade medida do segundo ramo, sobre os 144 pares (NF, produto) do fluxo manual: **130 (90%)** casam com exatamente uma NF do espelho; 7 (5%) não casam com nenhuma; 7 (5%) casam com mais de uma. Os ~10% restantes são o motivo de existir o `recebimento_externo` (§5).

## 4. Entidades de leitura (sem persistência)

### 4.1 `FilaNacionalItem` — uma linha da fila

| Campo | Origem |
|---|---|
| `nfChaveAcesso` | `h.c_chave_nfe` — identidade |
| `notaFiscal` | `h.n_nf` sem zeros à esquerda — exibição |
| `fornecedorNome` / `fornecedorCnpj` | `h.dest_razao` / `h.dest_cnpj_cpf` (rotulado "Fornecedor" — research D7) |
| `dtEmissao` / `diasDesdeEmissao` | `h.d_emi` |
| `itensTotal` / `itensPendentes` | contagem; pendência pela checagem de duas vias (§3.1), por descrição de item |
| `valorTotalBrl` | `SUM(i.v_tot_item)` — o espelho não guarda total de cabeçalho (research D3) |

**Filtros obrigatórios**: `tp_nf = 0`; CFOP em `('1.101','1.102','2.101','2.102')` (com ponto — research D6); não cancelada/deletada (`nfValidaSql`); `d_emi >= data_corte`, o corte **fixo** de 7 dias anteriores ao go-live (research D23); fornecedor sem exclusão ativa (research D4); `HAVING` itens pendentes > 0.

### 4.2 `ItemNfNacional` — uma linha do detalhe

| Campo | Origem / regra |
|---|---|
| `indice` | posição do item na NF — amarra a submissão |
| `descricaoFornecedor` | `i.x_prod` |
| `quantidadeNf` / `unidadeOriginal` | `i.q_com` / `i.u_com` |
| `quantidadeNfKg` | convertida; `null` quando a unidade bloqueia |
| `valorUnitarioBrl` / `valorTotalItemBrl` | `i.v_un_com` / `i.v_tot_item` |
| `produtosSugeridos` | **lista** vinda do De→Para (pode ter 0, 1 ou N) |
| `bloqueio` | `null` \| `'unidade_nao_conversivel'` \| `'unidade_incoerente'` \| `'sem_correlacao'` |
| `jaRecebido` | pela checagem de duas vias (§3.1) |
| `quantidadeNfJaAtribuidaKg` | `Σ quantidade_nf_kg` das movimentações ativas do item — quanto da **quantidade da NF** já foi lançado |
| `quantidadeRestanteKg` | `quantidadeNfKg(item) − quantidadeNfJaAtribuidaKg`; o que falta lançar, medido **do lado da NF** |

**Item parcialmente recebido.** Num item distribuído entre N produtos (US4), um `EXISTS` puro marcaria o item como recebido assim que **uma** movimentação existisse — mesmo que os outros produtos tenham falhado, tenham sido rejeitados pelo gestor ou nunca tenham sido enviados (operador fechou a tela). O peso restante nunca entraria no estoque e não haveria caminho de volta. Por isso o item permanece na fila enquanto `quantidadeRestanteKg > 1` (a mesma tolerância de 1 kg de FR-018), mostrando o que já entrou e o que falta.

**A âncora é a quantidade da NF, não a conferida** — e isto é o que faz a conta fechar. A conferida não serve de base: ela não é conhecida antes de o operador digitá-la, e nenhuma tabela a persiste para um item nunca submetido. Pior, ela quebra nas duas pontas da divergência: um item de 13.160 kg conferido em 12.900 deixaria resto de 260 kg e ficaria preso na fila para sempre, apesar de integralmente tratado; conferido em 13.500, o resto seria −340 e a regra escrita como "chega a zero" também nunca fecharia. Como `quantidade_nf_kg` é a parcela **da NF** atribuída a cada movimentação, a soma fecha em zero por construção nos dois casos.

Itens com a **mesma descrição** na mesma NF são agregados antes de exibir — a NF 58396 da Zaraplast tem 6 linhas para 4 descrições distintas (research D18), com a mesma descrição repetida em linhas separadas.

### 4.3 Unidade: tabela explícita **mais** conferência de coerência

| Grafia na NF | Fator → Kg |
|---|---|
| `KG` | 1 |
| `TON` | 1.000 |
| `TL` | 1.000 |
| qualquer outra | **bloqueia o item** |

**A tabela sozinha não basta.** O espelho contém itens cuja unidade declarada contradiz a quantidade. A conferência compara o **preço por quilo resultante da unidade declarada** com uma faixa plausível para plástico e sucata (**R$ 0,10 a R$ 100/kg**):

```text
rs_por_kg_declarado  = v_tot_item / (q_com × fator(u_com))
rs_por_kg_alternativo = v_tot_item / (q_com × fator_da_outra_leitura)

declarado plausível                         -> converte normalmente
declarado implausível, alternativo plausível -> CONTRADIÇÃO: bloqueia
nenhum dos dois plausível                    -> INCONCLUSIVO: bloqueia
```

Resultado medido nos 1.626 itens elegíveis de 2026 com unidade conversível: **1.612 liberados, 14 bloqueados por contradição, 0 inconclusivos**.

Os 14 são todos do mesmo padrão — NF 58067, Zaraplast: `q_com = 1,375`, `u_com = 'KG'`, `v_tot_item = 20.352,34`. Lido como KG dá **R$ 14.801/kg**; lido como tonelada dá **R$ 14,80/kg**, coerente com resina. A quantidade está em toneladas com a unidade rotulada KG, e pela tabela de conversão o sistema entraria **1,375 kg no lugar de 1.375 kg**.

> **O critério anterior estava errado.** Uma versão anterior bloqueava todo item cujo preço caísse "fora de ambas as faixas" de preço absoluto. Isso reprovaria **10 itens perfeitamente coerentes**: papelão e sucata de plástico a R$ 0,35–0,40/kg declarados em KG, e sucata rígida a R$ 300/tonelada declarada em TON — que é o mesmo R$ 0,30/kg. Material barato não é material com unidade errada. O critério correto compara as duas **leituras possíveis da mesma linha**, não o preço contra uma tabela de valores.

**Por que bloquear e não corrigir**: o sistema detecta a contradição mas não sabe **qual** campo está errado — a unidade ou a quantidade. Escolher seria adivinhar num fluxo que move estoque e dinheiro. Mesmo princípio de D15: falhar de forma visível em vez de converter em silêncio. Os itens bloqueados seguem pelo caminho manual, onde há conferência humana.

> A conferência valida a própria tabela por evidência independente: as 187 linhas em `TL` têm 100% de preço por quilo plausível quando convertidas a 1.000 (research D5 e D17).

Tabela **separada** de `FATOR_PARA_KG` (`types.ts`), que mapeia unidades do Atlas (`t`/`kg`/`saco`/`bigbag`), não grafias de NF. **Não reusa** `normalizarUnidade` da importação, que assume `kg` no default e carrega risco documentado de erro de 1000× (research D15) — exatamente o erro que esta conferência existe para pegar.

## 5. `recebimento_externo` — a válvula para o que entrou fora do Atlas

Reusa `stockbridge.aprovacao`, **sem tabela nova**. A tabela já traz cadeia de aprovação, trigger de auditoria, caixa de entrada (`AprovacoesPage`) e notificação por role.

> ⚠️ **A constraint atual impede este uso.** `aprovacao_chk_lote_ou_sku` exige `lote_id IS NOT NULL` **OU** (`produto_codigo_acxe` + `galpao` + `empresa`) **OU** (`produto_codigo_q2p` + `galpao` + `empresa`). Uma baixa externa não tem lote, não tem produto (o item da fila só tem descrição) e não tem galpão — o INSERT falharia com `23514`. A migration `0052` **MUST** relaxar a constraint para admitir o caso novo:
>
> ```sql
> ALTER TABLE stockbridge.aprovacao DROP CONSTRAINT aprovacao_chk_lote_ou_sku;
> ALTER TABLE stockbridge.aprovacao ADD CONSTRAINT aprovacao_chk_lote_ou_sku CHECK (
>     lote_id IS NOT NULL
>  OR (produto_codigo_acxe IS NOT NULL AND galpao IS NOT NULL AND empresa IS NOT NULL)
>  OR (produto_codigo_q2p  IS NOT NULL AND galpao IS NOT NULL AND empresa IS NOT NULL)
>  OR (tipo_aprovacao = 'recebimento_externo' AND nf_chave_acesso IS NOT NULL)
> );
> ```
>
> O ramo novo não afrouxa a regra: troca "identifica um item de estoque" por "identifica um documento fiscal", que é a identidade que esta aprovação de fato carrega.

**Colunas novas em `stockbridge.aprovacao`** (ela não tem nenhuma de NF hoje):

| Coluna | Tipo | Por quê |
|---|---|---|
| `nf_chave_acesso` | `varchar(44)` | identidade do documento dispensado |
| `nota_fiscal` | `varchar(50)` | exibição na caixa de entrada do gestor |
| `nf_item_descricao` | `varchar(500)` | qual item da NF está sendo baixado |

**Novo valor de `tipo_aprovacao`**: `recebimento_externo`.
**Nível**: `gestor` (decisão do usuário, 17/09/2026) — alinhado com `NIVEL_APROVACAO_POR_SUBTIPO.entrada_manual`.

**Semântica**: aprovada, a linha **não cria movimentação, não altera estoque e não chama o OMIE**. O único efeito é o item sair da fila. Por isso o par (chave, descrição) fica registrado na própria aprovação — é ele que a fila consulta para não reexibir o item.

**Nome**: `recebimento_externo`, não "dispensa" — `aprovacao.dispensada_em` já existe com outro significado (operador descarta rejeição da caixa de entrada, migration 0029).

**Flag**: `STOCKBRIDGE_RECEBIMENTO_EXTERNO_ENABLED`, default `true`. Desligada, a ação some da UI e a rota recusa — sem migration (research D22).

**Rastro**: como o mesmo papel (gestor) aprova tanto o recebimento normal quanto a afirmação de que ele ocorreu fora, `shared.audit_log` é a trilha principal deste caminho. A trigger de `aprovacao` já cobre INSERT/UPDATE/DELETE.

**Reversão**: `status` volta a `pendente` por ação de gestor, devolvendo o item à fila. Auditado pela mesma trigger.

---

## 6. Escrita: o que a entrada por NF grava

Por **produto** recebido (não por item da NF — um item pode gerar N produtos), o mesmo par que o fluxo manual já cria:

- **`stockbridge.movimentacao`** — `tipo_movimento='entrada_manual'`, `subtipo='compra_nacional'`, `empresa='q2p'`, `produto_codigo_q2p`, `nota_fiscal` (número **sem zeros à esquerda**, como as 145 linhas históricas), **`nf_chave_acesso`**, **`nf_item_descricao`** e **`nf_item_descricao_normalizada`**, `quantidade_kg` (conferida), **`quantidade_nf_kg`**, **`quantidade_divergencia_kg`**, `custo_unitario_brl`, `galpao`.
- **`stockbridge.aprovacao`** — `tipo_aprovacao='entrada_manual'`, `precisa_nivel='gestor'`, ligada à movimentação, com **`quantidade_prevista_kg` = quantidade da NF** e **`quantidade_recebida_kg` = quantidade conferida**. Sem esses dois campos a tela de aprovação não consegue exibir o painel NF × conferido × diferença, e o gestor aprovaria a divergência sem ver a divergência.

**Cálculo do valor**, em duas etapas:

1. O valor do item é `v_tot_item` da NF (FR-010).
2. Quando o item se divide entre N produtos, esse valor é rateado **por peso** entre eles (FR-022), com o denominador sendo a **quantidade conferida do item inteiro** — nunca a soma da submissão:

   ```text
   quantidade_nf_kg(produto) = quantidade_nf_do_item × (kg_produto / quantidade_conferida_do_item)
   valor_produto             = v_tot_item          × (quantidade_nf_kg(produto) / quantidade_nf_do_item)
   custo_unitario_brl        = valor_produto / kg_produto
   ```

   > ⚠️ **O denominador não pode ser `Σ kg_produtos` da submissão.** Com recebimento retomado, uma submissão parcial teria `Σ` igual à própria parcela, e cada leva receberia o valor **integral** do item: um item de R$ 156.604 recebido em duas levas de 6.580 kg gravaria R$ 156.604 em cada uma — o dobro do valor da NF entrando no estoque. Ancorando na quantidade do item, a soma fecha em `v_tot_item` independentemente de quantas submissões houver.

O rateio de ACXEGDP-178 não morre — muda de escopo. Antes distribuía o total da NF entre itens digitados; agora distribui o valor de **um item** entre os produtos em que ele foi classificado.

**Divergência**: `|quantidade_kg − quantidade_nf_kg| > 1` marca divergência, exige motivo e gera a aprovação de gestor. Aceita nos dois sentidos (FR-019) — a regra da importação, que recusa receber acima da NF, **não** se aplica aqui.

O ajuste no OMIE continua acontecendo **na aprovação**, por `aprovarEntradaNacional` — inalterado.

---

## 7. Relacionamentos

```text
tbl_nf_header_Q2P ──1:N── tbl_nf_itens_Q2P               (espelho, leitura)
   │ c_chave_nfe (identidade)      │ x_prod
   │ dest_cnpj_cpf                 │
   ▼                               ▼
fornecedor_exclusao      correlacao_produto_fornecedor ──N:1── tbl_produtos_Q2P
   (filtro da fila)         (De→Para 1:N por descrição)          (catálogo)
                                   │
                                   ▼
                        movimentacao ──1:1── aprovacao
                     (1 par por PRODUTO recebido;
                      1 item da NF pode gerar N pares)
```
