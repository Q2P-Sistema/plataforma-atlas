# Data Model — Recebimento Nacional com Pedido de Compra

**Feature**: `017-recebimento-nacional-com-pc` | **Migrations**: `0056` (Q2P, Histórias 1 a 4) e `0057` (ACXE, História 5)

Base: o modelo da feature 016 (`specs/016-recebimento-fiscal-nf/data-model.md`). Aqui ficam só as extensões.

---

## 1. Espelho de recebimentos de NF-e: colunas de pedido (0056)

`public."tbl_recebimentoNFe_itens_Q2P"` ganha (`ADD COLUMN IF NOT EXISTS`, escrito pelo n8n):

| Coluna | Tipo | Origem no `ListarRecebimentos` (`cExibirDetalhes = 'S'`) |
|---|---|---|
| `n_id_pedido` | `bigint` | `itensCabec.nIdPedido` (0 ou ausente = sem vínculo → `NULL`) |
| `n_id_it_pedido` | `bigint` | `itensCabec.nIdItPedido`, só quando `nIdPedido > 0` (sem vínculo o OMIE repete o `nIdItem` aqui, então gravar `NULL`) |
| `n_num_ped_compra` | `varchar(15)` | `itensInfoAdic.nNumPedCompra`: número do pedido informado na NF |
| `c_num_it_ped_compra` | `integer` | `itensInfoAdic.cNumItPedCompra` |

Colunas que já existem e passam a ser usadas: `c_associar_existente`, `c_ignorar_item`, `c_nao_gerar_mov_estoque`, `n_id_produto` e `n_preco_unit`.

**Vínculo do OMIE** (derivado): `c_associar_existente = 'S' AND n_id_pedido > 0`.

**Estoque lançado pelo OMIE** (derivado, D7): recebimento com `c_recebido = 'S'` e algum item com `c_ignorar_item = 'N' AND c_nao_gerar_mov_estoque = 'N'`.

Caso real, NF 7813 na etapa 40 em 21/10/2026: `n_id_pedido` 8516905979, `n_id_it_pedido` 8516907022, `n_num_ped_compra` "304", `c_num_it_ped_compra` 1, `c_associar_existente` S, `c_nao_gerar_mov_estoque` N.

## 2. Espelho de recebimentos da ACXE (0057)

`public."tbl_recebimentoNFe_ACXE"` e `public."tbl_recebimentoNFe_itens_ACXE"`: mesma DDL das tabelas da Q2P (data-model da 016, §1 e §2), já com as colunas do §1, criadas com `IF NOT EXISTS` e escritas por um workflow n8n novo (contrato em `contracts/espelhos-n8n.md`).

## 3. `stockbridge.recebimento_fiscal`: extensão do ledger (0056)

| Mudança | Detalhe |
|---|---|
| `empresa varchar(4) NOT NULL DEFAULT 'q2p'` | `CHECK (empresa IN ('q2p','acxe'))`. As linhas existentes ficam `q2p` |
| `passo_falha` | o `CHECK` passa a aceitar também `'associar'` |
| `itens_vinculados integer` | itens que terminaram com vínculo de PC (nulo = fiscal sem vínculo, receita da 016) |

Máquina de estados e índice único parcial: os mesmos da 016.

## 4. `stockbridge.recebimento_fiscal_pc` (nova, 0056)

Vínculo item de NF → item de PC, uma linha por item e por tentativa (D5). FR-007, FR-015 e FR-023.

| Coluna | Tipo | Regra |
|---|---|---|
| `id` | `uuid` PK | — |
| `recebimento_fiscal_id` | `uuid NOT NULL` → `stockbridge.recebimento_fiscal(id)` | tentativa a que pertence |
| `empresa` | `varchar(4) NOT NULL` | `q2p` \| `acxe` |
| `nf_chave_acesso` | `varchar(44) NOT NULL` | — |
| `n_sequencia` | `integer NOT NULL` | item no recebimento (identidade do item, ACXEGDP-412) |
| `origem` | `varchar(10) NOT NULL` | `omie` (vínculo que veio do OMIE) \| `sugestao` (candidato dentro da tolerância) \| `manual` (fora da tolerância, com justificativa) — CHECK |
| `n_cod_ped` | `bigint NOT NULL` | PC escolhido (`nCodPed`) |
| `n_cod_item_ped` | `bigint NOT NULL` | item do PC (`nCodItem`) |
| `pc_numero` | `varchar(15) NOT NULL` | número legível do PC, para mensagens |
| `n_cod_ped_omie_anterior` | `bigint` | vínculo do OMIE substituído pelo operador (nulo se não houve troca) |
| `n_cod_item_ped_omie_anterior` | `bigint` | idem |
| `dentro_tolerancia` | `boolean NOT NULL` | se o PC confirmado estava dentro da tolerância do FR-002, calculada na confirmação |
| `justificativa` | `text` | obrigatória quando `dentro_tolerancia = false` ou há troca do vínculo do OMIE (`n_cod_ped_omie_anterior IS NOT NULL`), por CHECK. Ver a matriz abaixo |
| `candidatos` | `jsonb NOT NULL` | retrato do que foi oferecido: `[{nCodPed, nCodItem, pcNumero, saldoKg, precoUnit, motivo, dentroTolerancia}]` |
| `qtd_nf_kg` | `numeric(14,3) NOT NULL` | quantidade do item da NF, em kg |
| `preco_nf` | `numeric(14,6) NOT NULL` | preço comercial unitário do item da NF, por kg |
| `saldo_pc_kg_lido` | `numeric(14,3)` | saldo do item do PC relido ao vivo na confirmação |
| `preco_pc_lido` | `numeric(14,6)` | preço do item do PC relido |
| `etapa_pc_lida` | `varchar(2)` | etapa do PC relida (precisa ser 15) |
| `status` | `varchar(12) NOT NULL` | `confirmado` → `associado` → `concluido` \| `falha` — CHECK |
| `erro_omie_codigo`, `erro_omie_mensagem` | `varchar(60)`, `text` | técnico, nunca vai à UI |
| `confirmado_por` | `uuid NOT NULL` → `atlas.users(id)` | — |
| `confirmado_em` | `timestamptz NOT NULL DEFAULT now()` | — |
| `concluido_em` | `timestamptz` | — |
| `created_at`, `updated_at` | `timestamptz NOT NULL DEFAULT now()` | — |

**Índices**:

- único parcial `(nf_chave_acesso, n_sequencia) WHERE status IN ('confirmado','associado','concluido')`: um vínculo vivo por item (FR-015);
- `(n_cod_item_ped, concluido_em)` para a regra "PC recém-usado" (D4) e para o desconto, na cópia local, dos vínculos concluídos depois de `data_atualizacao` (D3);
- parcial `(n_cod_item_ped) WHERE status IN ('confirmado','associado')` para as **reservas** em andamento (D4). Na releitura ao vivo, o saldo disponível é `nQtde − nQtdeRec` menos as reservas de outras NFs iniciadas há menos de 15 min; vínculos concluídos não são descontados, porque o OMIE já os mostra.

**Quando a justificativa é obrigatória** (FR-007, matriz única para o CHECK, o portão 1, a releitura e a tela):

| Origem | Dentro da tolerância | Troca do vínculo do OMIE | Justificativa |
|---|---|---|---|
| `omie` (vínculo mantido) | sim | não | não |
| `omie` (vínculo mantido) | não | não | **sim** |
| `sugestao` (candidato) | sim | não | não |
| `sugestao` ou `manual`, no lugar de um vínculo do OMIE | qualquer | sim | **sim** |
| `manual` (outros do fornecedor) | não, por definição | qualquer | **sim** |

**Máquina de estados**:

```
confirmado ──ASSOCIAR-PEDIDO ok (ou vínculo do OMIE mantido)──▶ associado ──Concluir ok──▶ concluido
     └──────────────── qualquer falha ────────────────────────────────▶ falha
```

O vínculo do OMIE mantido (D1) vai de `confirmado` direto a `associado`, sem chamada.

**Trigger**: `stockbridge.audit_recebimento_fiscal_pc()` + `trg_audit_sb_recebimento_fiscal_pc` (INSERT/UPDATE/DELETE).

## 5. `stockbridge.nf_aviso_compras` (nova, 0056)

Aviso a compras sobre NF sem PC (D6), deduplicado.

| Coluna | Tipo | Regra |
|---|---|---|
| `id` | `uuid` PK | — |
| `empresa` | `varchar(4) NOT NULL` | — |
| `nf_chave_acesso` | `varchar(44) NOT NULL` | — |
| `nota_fiscal`, `fornecedor_nome` | `varchar` | exibição |
| `motivo` | `varchar(30) NOT NULL` | `sem_pc` \| `pc_aguardando_aprovacao` \| `recebida_sem_vinculo` — CHECK |
| `itens` | `jsonb NOT NULL` | `[{nSequencia, descricao, qtdKg, precoUnit}]` |
| `enviado_para` | `text NOT NULL` | destinatários efetivos |
| `enviado_em` | `timestamptz NOT NULL DEFAULT now()` | — |
| `disparado_por` | `uuid` → `atlas.users(id)` | operador que tentou receber |

**Deduplicação**: não enviar se houver linha com o mesmo `(nf_chave_acesso, motivo)` nas últimas 24 h. **Trigger**: padrão `audit_*`.

## 6. `stockbridge.fornecedor_exclusao`: empresa (0057, História 5)

`empresa varchar(4) NOT NULL DEFAULT 'q2p'`, com `CHECK (empresa IN ('q2p','acxe'))`. Linhas novas com a Q2P como fornecedor excluído na ACXE (intercompany): as duas CNPJs da Q2P no cadastro da ACXE, `27.019.059/0001-88` (matriz) e `27.019.059/0002-69` (filial), com máscara, como já está gravada a ACXE (`42.672.052/0001-54`). Não há constante de CNPJ da Q2P em `types.ts` (`CNPJ_Q2P_MATRIZ` é um rótulo). O índice único passa a incluir `empresa`, e `fornecedor.service.ts` passa a filtrar por empresa.

## 7. Função `stockbridge.refresh_lotes_em_transito_se_stale`: não muda

Continua como na 0037 (decisão de 21/10/2026, research D10). Ela usa `pc.nqtde` em vez do saldo, mas é PL/pgSQL que escreve em `stockbridge.lote`, e reeditá-la reforçaria um desvio ao Princípio III. Como não existe PC de importação recebido em parte, ela não erra hoje. A limitação fica registrada para um card próprio (trânsito em TypeScript).

## 8. Shapes de leitura (fila e detalhe), extensões

```ts
type Empresa = 'q2p' | 'acxe';
type PcSituacaoNf = 'vinculado_omie' | 'sugerido' | 'escolha_necessaria' | 'aguardando_aprovacao' | 'sem_pc' | 'nao_aplicavel';

interface FilaNacionalItem {
  // …campos da 015/016…
  empresa: Empresa;                    // 'q2p' até a História 5
  pcSituacao: PcSituacaoNf;            // resumo da NF para o selo da fila (pior caso entre os itens)
  estoqueLancadoPeloOmie: boolean;     // D7
}

interface PcCandidato {
  nCodPed: number;
  nCodItem: number;
  pcNumero: string;
  produtoDescricao: string;            // produto do PC (referência; não substitui a correlação)
  qtdPedidaKg: number;
  saldoKg: number;                     // nqtde - nqtderec
  precoUnit: number;                   // R$/kg do PC (nvalunit em KG, ou ÷ 1000 em T/TON)
  dtPrevisao: string | null;
  etapa: '15' | '10';
  dentroTolerancia: boolean;
  casaNumeroPedidoNf: boolean;         // n_num_ped_compra = cnumero
  motivo: string;                      // "Número do pedido na NF", "Quantidade e preço compatíveis", "Preço 3,2% acima", …
}

interface PcDoItem {
  vinculoOmie: PcCandidato | null;     // FR-000 (pode vir com alerta: PC sem saldo, etapa ≠ 15, PC-espelho)
  alertaVinculoOmie: string | null;
  candidatos: PcCandidato[];           // dentro da tolerância, ordenados (D3)
  outrosDoFornecedor: PcCandidato[];   // etapa 15 com saldo, fora da tolerância (escolha manual, FR-002a)
  aguardandoAprovacao: PcCandidato[];  // etapa 10 (FR-002b), não selecionáveis
  preSelecionado: { nCodPed: number; nCodItem: number } | null; // vínculo do OMIE ou candidato único pelo número do pedido
  semPcMotivo: string | null;          // FR-019, quando não há nada selecionável
  vinculadoNoOmie: { pcNumero: string } | null; // fiscal já feito: PC vinculado à vista (FR-021)
}

interface ItemNfNacional {
  // …campos da 015/016: indice, descricaoFornecedor, quantidadeNfKg, valorUnitarioBrl, sequenciasRecebimento[], …
  /** PC do item. O item é agregado por descrição e pode juntar várias sequências da NF; todas recebem o mesmo item de PC (FR-002c). */
  pc: PcDoItem | null;                 // null = fiscal pelo Atlas desligado e nenhum vínculo a mostrar
}

interface DetalheNfNacional {
  // …campos da 015/016…
  empresa: Empresa;
  exigePc: boolean;                    // STOCKBRIDGE_RECEBIMENTO_NACIONAL_EXIGE_PC (só relevante com fiscal pendente)
  estoqueLancadoPeloOmie: boolean;     // D7 — bloqueia o POST
  copiaPcsDefasada: boolean;           // D13 — cópia de PCs acima de STOCKBRIDGE_COPIA_PCS_MAX_MIN: sem sugestão confiável; POST com fiscal pendente dá 503
}
```

Os candidatos são calculados por item agregado: quantidade = soma das linhas (`quantidadeNfKg`); preço = preço comercial unitário (`n_preco_unit` / `v_un_com`) convertido para R$/kg. Os vínculos do OMIE são lidos por sequência. Se as sequências de um mesmo item agregado apontarem para itens de PC diferentes, o item mostra `alertaVinculoOmie` e exige escolha (`escolha_necessaria`).

`pcSituacao` da NF é o pior caso entre os itens a receber, nesta ordem: `sem_pc` > `aguardando_aprovacao` > `escolha_necessaria` (empate, só fora da tolerância ou vínculos divergentes) > `sugerido` > `vinculado_omie`. `nao_aplicavel` = fiscal já feito ou fiscal pelo Atlas desligado.

## 9. POST por-nf: corpo e resultado, extensões

```ts
// corpo (.strict(), snake_case como na 015), cada item de `itens[]` ganha:
pc?: {
  n_cod_ped: number;                   // > 0
  n_cod_item: number;                  // > 0
  justificativa?: string | null;       // 1..500; obrigatória conforme a matriz do §4
  n_cod_item_omie_visto?: number | null; // vínculo do OMIE que a tela mostrou para o item (null = nenhum); base do 409 VINCULO_OMIE_MUDOU
} | null;                              // ausente/null = sem PC: aceito só para item sem PC possível no modo "receber sem vínculo", ou com fiscal já feito.
                                       // Item com PC possível e sem `pc` → 422 PC_NAO_ESCOLHIDO.

// resultado, acrescido:
fiscal: {
  // …status/concluidoEm/mensagem da 016…
  vinculos: Array<{ nSequencia: number; pcNumero: string; origem: 'omie'|'sugestao'|'manual'; status: 'concluido' }>;
  semVinculo: number[];                // nSequencia recebidos sem PC (modo "receber sem vínculo")
  avisoCompras: boolean;               // se um aviso a compras foi disparado neste clique
};
```

## 10. Configuração nova

| Variável | Default | Uso |
|---|---|---|
| `STOCKBRIDGE_RECEBIMENTO_NACIONAL_EXIGE_PC` | `true` | D6: bloquear NF sem PC (`true`) ou receber sem vínculo (`false`) |
| `STOCKBRIDGE_PC_TOLERANCIA_QTD_PCT` | `2` | D3: quantidade da NF acima do saldo do PC |
| `STOCKBRIDGE_PC_TOLERANCIA_PRECO_PCT` | `1` | D3: diferença de preço unitário |
| `STOCKBRIDGE_COMPRAS_EMAILS` | vazio (cai em `STOCKBRIDGE_OPS_EMAIL`) | D6: aviso de NF sem PC |
| `STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_ENABLED` | `false` | D11: História 5 |
| `STOCKBRIDGE_COPIA_PCS_MAX_MIN` | `120` | D13: idade máxima da cópia de PCs antes do alerta e do modo seguro |

Reaproveitada: `STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED` (D8).
