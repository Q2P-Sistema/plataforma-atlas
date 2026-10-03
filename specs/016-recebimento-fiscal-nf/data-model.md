# Phase 1 — Data Model: Recebimento Fiscal da NF Nacional pelo Atlas

**Feature**: `016-recebimento-fiscal-nf` | **Migration**: `0053_stockbridge_recebimento_fiscal_nf.sql`

Quatro estruturas: duas tabelas-espelho em `public.*` (escritas pelo n8n, DDL canônica aqui — research D4), e duas tabelas de estado do Atlas em `stockbridge.*` (ledger do fiscal e dispensa de NF), ambas com trigger de auditoria (Princípio IV). Nenhuma coluna nova em `movimentacao`/`aprovacao`.

---

## 1. Espelho — `public."tbl_recebimentoNFe_Q2P"` (cabeçalho)

Cópia local da caixa "Recebimento de NF-e" do OMIE Q2P (`ListarRecebimentos`, research D5). Fonte da fila para "fiscal pendente".

| Coluna | Tipo | Origem OMIE | Regra |
|---|---|---|---|
| `n_id_receb` | `bigint` **PK** | `cabec.nIdReceb` | identidade do recebimento no OMIE |
| `c_chave_nfe` | `varchar(44)` **UNIQUE** | `cabec.cChaveNFe` | identidade do documento; liga ao espelho de NF (`tbl_nf_header_Q2P.c_chave_nfe`) e ao Atlas (`nf_chave_acesso`) |
| `c_numero_nfe` | `varchar(20)` | `cabec.cNumeroNFe` | zero-padded (`000006842`); exibir com `ltrim(…, '0')` |
| `c_serie_nfe` | `varchar(5)` | `cabec.cSerieNFe` | — |
| `c_modelo_nfe` | `varchar(3)` | `cabec.cModeloNFe` | — |
| `d_emissao` | `date` | `cabec.dEmissaoNFe` (dd/mm/aaaa → ISO) | filtro de corte |
| `n_id_fornecedor` | `bigint` | `cabec.nIdFornecedor` | pode ser nulo (fornecedor não cadastrado — D8) |
| `c_cnpj_cpf` | `varchar(20)` | `cabec.cCNPJ_CPF` | mesmo formato de `dest_cnpj_cpf`; casa com `fornecedor_exclusao` |
| `c_razao_social` | `varchar(255)` | `cabec.cRazaoSocial` | entidades HTML decodificadas no Achata (ACXEGDP-330) |
| `c_nome` | `varchar(255)` | `cabec.cNome` | — |
| `c_natureza_operacao` | `varchar(60)` | `cabec.cNaturezaOperacao` | — |
| `n_valor_nfe` | `numeric(14,2)` | `cabec.nValorNFe` | total da NF |
| `c_etapa` | `varchar(2)` | `cabec.cEtapa` | `40` = faturado pelo fornecedor; `60` recebido; `80` conferido |
| `c_recebido` | `char(1)` | `infoCadastro.cRecebido` | **critério de "fiscal pendente"** = `'N'` |
| `c_cancelada` | `char(1)` | `infoCadastro.cCancelada` | `'S'` sai da fila |
| `c_faturado` | `char(1)` | `infoCadastro.cFaturado` | — |
| `c_bloqueado` | `char(1)` | `infoCadastro.cBloqueado` | — |
| `c_devolvido` | `char(1)` | `infoCadastro.cDevolvido` | — |
| `d_inc`, `h_inc` | `date`, `varchar(8)` | `infoCadastro.dInc/hInc` | — |
| `d_alt`, `h_alt` | `date`, `varchar(8)` | `infoCadastro.dAlt/hAlt` | nulos em recebimento recém-criado |
| `d_rec`, `h_rec`, `c_usuario_rec` | `date`, `varchar(8)`, `varchar(30)` | `infoCadastro.dRec/hRec/cUsuarioRec` | `WEBSERVICE` quando concluído pelo Atlas |
| `synced_at` | `timestamptz NOT NULL DEFAULT now()` | — | atualizado em todo upsert |

Índices: `(c_recebido, c_cancelada)` para a fila; `(d_emissao)`.

Upsert por `n_id_receb`; antes, `DELETE … WHERE c_chave_nfe = v.c_chave_nfe AND n_id_receb <> v.n_id_receb` (reconciliação, ACXEGDP-329). `ON DELETE CASCADE` remove os itens, regravados em seguida.

## 2. Espelho — `public."tbl_recebimentoNFe_itens_Q2P"`

| Coluna | Tipo | Origem OMIE | Regra |
|---|---|---|---|
| `n_id_receb` | `bigint` FK → cabeçalho `ON DELETE CASCADE` | — | — |
| `n_sequencia` | `integer` | `itensCabec.nSequencia` | **PK (n_id_receb, n_sequencia)**; é o `nSequencia` usado no `AlterarRecebimento` |
| `c_descricao_produto` | `varchar(500)` | `itensCabec.cDescricaoProduto` | descrição original da NF (= `x_prod`), entidades decodificadas |
| `c_codigo_produto` | `varchar(60)` | `itensCabec.cCodigoProduto` | código do fornecedor |
| `c_ncm` | `varchar(10)` | `itensCabec.cNCM` | — |
| `c_cfop` | `varchar(10)` | `itensCabec.cCFOP` | CFOP **do fornecedor** (5.102/6.101) — não usar no recorte |
| `c_cfop_entrada` | `varchar(10)` | `itensAjustes.cCFOPEntrada` | **CFOP de entrada** (1.102/2.102) — este é o do recorte da fila |
| `n_qtde_nfe` | `numeric(14,4)` | `itensCabec.nQtdeNFe` | quantidade da NF |
| `c_unidade_nfe` | `varchar(10)` | `itensCabec.cUnidadeNfe` | `KG`/`TON`/`TL` — `converterItemNfParaKg` |
| `n_preco_unit` | `numeric(18,6)` | `itensCabec.nPrecoUnit` | — |
| `v_total_item` | `numeric(14,2)` | `itensCabec.vTotalItem` | **= `v_prod`** (com IPI uma vez; research D7) |
| `v_desconto` | `numeric(14,2)` | `itensCabec.vDesconto` | — |
| `c_ignorar_item` | `char(1)` | `itensCabec.cIgnorarItem` | `'S'` após o fiscal via Atlas |
| `c_associar_existente` | `char(1)` | `itensCabec.cAssociarExistente` | `'S'` é o sintoma da NF 6495 |
| `c_adicionar_novo` | `char(1)` | `itensCabec.cAdicionarNovo` | — |
| `n_id_item` | `bigint` | `itensCabec.nIdItem` | 0 antes da conclusão |
| `n_id_produto` | `bigint` | `itensCabec.nIdProduto` | 0 = sem vínculo |
| `c_nao_gerar_mov_estoque` | `char(1)` | `itensAjustes.cNaoGerarMovEstoque` | `'S'` após o fiscal via Atlas |
| `c_nao_gerar_financeiro` | `char(1)` | `itensAjustes.cNaoGerarFinanceiro` | `'N'` (conta a pagar gerada) |
| `n_qtde_recebida` | `numeric(14,4)` | `itensAjustes.nQtdeRecebida` | — |
| `codigo_local_estoque` | `bigint` | `itensAjustes.codigo_local_estoque` | — |
| `synced_at` | `timestamptz NOT NULL DEFAULT now()` | — | — |

Upsert por `(n_id_receb, n_sequencia)`.

---

## 3. Atlas — `stockbridge.recebimento_fiscal` (ledger do fiscal)

Uma linha por tentativa de concluir o fiscal pelo Atlas; **uma linha viva por NF** (research D6). Lock, idempotência e rastro (FR-011, FR-017, FR-018).

| Coluna | Tipo | Regra |
|---|---|---|
| `id` | `uuid` PK | — |
| `nf_chave_acesso` | `varchar(44) NOT NULL` | identidade da NF |
| `n_id_receb` | `bigint` | do espelho ou da `ConsultarRecebimento` |
| `nota_fiscal` | `varchar(50) NOT NULL` | sem zeros à esquerda — para mensagens e listagens |
| `fornecedor_nome` | `varchar(255)` | idem |
| `status` | `varchar(20) NOT NULL` | `em_andamento` → `concluido` \| `ja_concluido` \| `falha` (CHECK) |
| `etapa_antes` | `varchar(2)` | `cEtapa` lido antes de agir |
| `recebido_antes` | `char(1)` | `cRecebido` lido antes de agir |
| `passo_falha` | `varchar(20)` | `consultar` \| `editar` \| `ignorar` \| `concluir` \| `reconsultar` (nulo em sucesso) |
| `erro_omie_codigo` | `varchar(60)` | `faultcode` |
| `erro_omie_mensagem` | `text` | `faultstring` (técnico; nunca vai à UI) |
| `itens_total` | `integer` | itens enviados em EDITAR/IGNORAR |
| `confirmado_por` | `uuid NOT NULL` → `atlas.users(id)` | operador que clicou |
| `iniciado_em` | `timestamptz NOT NULL DEFAULT now()` | — |
| `finalizado_em` | `timestamptz` | — |
| `created_at`, `updated_at` | `timestamptz NOT NULL DEFAULT now()` | — |

**Índice único parcial**: `(nf_chave_acesso) WHERE status IN ('em_andamento','concluido','ja_concluido')`.

**Máquina de estados**:

```
(sem linha) ──INSERT──▶ em_andamento ──▶ concluido      (3 passos OK)
                             │──────────▶ ja_concluido   (consulta disse cRecebido='S', nada escrito)
                             └──────────▶ falha          (qualquer passo falhou; nada gravado no Atlas)
em_andamento há > 5 min  ──(novo clique)──▶ retomada: UPDATE para o novo confirmado_por/iniciado_em
falha                    ──(novo clique)──▶ nova linha em_andamento (a antiga fica como histórico)
```

**Trigger**: `stockbridge.audit_recebimento_fiscal()` + `trg_audit_sb_recebimento_fiscal` (INSERT/UPDATE/DELETE).

**Uso pela fila**: chave com linha `concluido`/`ja_concluido` → `fiscal: 'concluido'` mesmo que o espelho ainda diga `c_recebido = 'N'` (D8).

---

## 4. Atlas — `stockbridge.nf_dispensa`

Decisão do gestor de tirar da fila uma NF que não será recebida fisicamente, com fiscal pendente **ou** já feito (FR-021..025, research D9 — escopo ampliado em 02/10/2026).

| Coluna | Tipo | Regra |
|---|---|---|
| `id` | `uuid` PK | — |
| `nf_chave_acesso` | `varchar(44) NOT NULL` | — |
| `nota_fiscal` | `varchar(50) NOT NULL` | exibição |
| `fornecedor_nome` | `varchar(255)` | exibição |
| `fornecedor_cnpj` | `varchar(20)` | — |
| `situacao_fiscal_na_dispensa` | `varchar(10) NOT NULL` | `pendente` \| `concluido` (CHECK) — situação fiscal no momento da dispensa; `concluido` sinaliza ao gestor que há conta a pagar no OMIE a tratar |
| `motivo` | `text NOT NULL` | obrigatório (FR-021) |
| `dispensado_por` | `uuid NOT NULL` → `atlas.users(id)` | gestor/diretor |
| `dispensado_em` | `timestamptz NOT NULL DEFAULT now()` | — |
| `revertido_por` | `uuid` → `atlas.users(id)` | — |
| `revertido_em` | `timestamptz` | nulo = dispensa ativa |
| `motivo_reversao` | `text` | — |

**Índice único parcial**: `(nf_chave_acesso) WHERE revertido_em IS NULL` — uma dispensa ativa por NF. **Índice** `(revertido_em, dispensado_em)` para a listagem.

**Trigger**: `stockbridge.audit_nf_dispensa()` + `trg_audit_sb_nf_dispensa`.

**Uso pela fila**: chave com dispensa ativa é excluída das **duas** fontes. Reversão = `UPDATE revertido_*` (soft), nunca `DELETE`.

---

## 5. Schema Drizzle (`packages/db/src/schemas/stockbridge.ts`)

- `recebimentoFiscal` e `nfDispensa` em `stockbridgeSchema`, com os tipos acima (`status` tipado via `$type<…>()`).
- As tabelas-espelho **não** entram no Drizzle (padrão do módulo: `public."tbl_*"` é lido por raw SQL via `getPool()`).

## 6. Shapes de leitura (fila e detalhe)

Extensões aos shapes da feature 015 (`fila-nacional.service.ts`):

```ts
type SituacaoFiscal = 'pendente' | 'concluido';

interface FilaNacionalItem {
  // …campos atuais…
  fiscal: SituacaoFiscal;
  /** quando o fiscal foi concluído pelo Atlas (ledger) — null se foi no OMIE/portal */
  fiscalConcluidoPeloAtlasEm: string | null;
  /** fornecedor pode faltar na fonte "fiscal pendente" (não cadastrado no OMIE) */
  fornecedorNome: string;          // 'Fornecedor não identificado no OMIE' quando nulo
  fornecedorCnpj: string | null;
}

interface DetalheNfNacional {
  // …campos atuais…
  fiscal: SituacaoFiscal;
  nIdReceb: number | null;
  recebimentoFiscalHabilitado: boolean;
  dispensavel: boolean;            // flag && sem dispensa ativa && ao menos um item pendente (qualquer situação fiscal)
}
```

Fonte unificada da query (CTE `nf_unificada` / `itens_unificados`): colunas normalizadas `c_chave_nfe, n_nf, dest_razao, dest_cnpj_cpf, d_emi, n_id_receb, fiscal_pendente, cancelada, deletada` e `c_chave_nfe, n_cod_item, x_prod, cfop, q_com, u_com, valor_item` — a fonte (b) mapeia `c_numero_nfe→n_nf`, `c_razao_social→dest_razao`, `c_cnpj_cpf→dest_cnpj_cpf`, `d_emissao→d_emi`, `n_sequencia→n_cod_item`, `c_descricao_produto→x_prod`, `c_cfop_entrada→cfop`, `n_qtde_nfe→q_com`, `c_unidade_nfe→u_com`, `v_total_item→valor_item`.

## 7. Resultado do recebimento (extensão)

```ts
type StatusFiscal = 'concluido' | 'ja_concluido' | 'nao_aplicavel' | 'desligado';

interface ProcessarRecebimentoPorNfResult {
  // …campos atuais…
  fiscal: { status: StatusFiscal; concluidoEm: string | null; mensagem: string };
}
```

`nao_aplicavel` = NF já estava com fiscal feito (fonte a) ou nenhum produto será gravado; `desligado` = flag `false`.

> **Três enums com `concluido`, de propósito distintos — não misturar na implementação:** `SituacaoFiscal` (fila/detalhe: `pendente|concluido` — a NF já tem fiscal feito, por quem for); `StatusFiscal` (resultado do POST: o que o Atlas fez **neste clique**); `recebimento_fiscal.status` (ledger: o que aconteceu com **uma tentativa**). A fila deriva `SituacaoFiscal` da fonte + ledger; o POST deriva `StatusFiscal` do ledger + flag.
