# Phase 1 — Data Model: Recebimento de NF de Importação com Múltiplos Produtos

**Feature**: 013-importacao-multi-produto | **Date**: 2026-07-15

> **Uma migration, nenhuma tabela nova.** A única mudança de schema é o **índice de idempotência** de `stockbridge.movimentacao` (por-produto). As tabelas `lote`, `movimentacao` e `aprovacao` já são **por-produto** e são reusadas sem alteração de colunas. Os demais "modelos" são **tipos TypeScript** (em memória) do fluxo de recebimento.

---

## 1. Migration `0046_stockbridge_idempotencia_entrada_por_produto.sql`

**Motivação**: o índice atual (`0044`) garante uma `entrada_nf` ativa por (NF, empresa). Multi-item exige N `entrada_nf` ativas para a mesma NF (uma por produto). Split do índice compartilhado em dois, purpose-specific.

```sql
-- Antes (0044): UNIQUE (nota_fiscal, tipo_movimento, empresa) para entrada_nf E saida_automatica.
-- Agora: entrada_nf por (NF, empresa, produto); saida_automatica mantém (NF, empresa).

DROP INDEX IF EXISTS stockbridge.movimentacao_nf_idempotencia_idx;

-- entrada_nf: uma movimentação ativa por (NF, empresa, PRODUTO) — habilita multi-item
CREATE UNIQUE INDEX movimentacao_nf_entrada_idempotencia_idx
    ON stockbridge.movimentacao (nota_fiscal, empresa, produto_codigo_acxe)
    WHERE tipo_movimento = 'entrada_nf'
      AND ativo = true
      AND empresa IS NOT NULL
      AND produto_codigo_acxe IS NOT NULL;

-- saida_automatica: inalterado (por NF+empresa); produto pode ser NULL na saída
CREATE UNIQUE INDEX movimentacao_nf_saida_idempotencia_idx
    ON stockbridge.movimentacao (nota_fiscal, empresa)
    WHERE tipo_movimento = 'saida_automatica'
      AND ativo = true
      AND empresa IS NOT NULL;
```

**Segurança**: dados que satisfazem a chave antiga (NF, empresa) única para `entrada_nf` também satisfazem a nova (NF, empresa, produto) — a nova é mais permissiva, então a migration não pode falhar por violação em dados existentes. `saida_automatica` mantém exatamente a chave anterior.

**Sem trigger nova**: não há tabela nova (Princípio IV satisfeito pela trigger de audit já existente em `movimentacao`). Índice não dispara audit.

**Contrapartida Drizzle**: atualizar `packages/db/src/schemas/stockbridge.ts` (definição dos índices de `movimentacao`) para refletir os dois índices — manter TS em sync com o DDL (skill `stockbridge-migration` §4).

**Código que referencia o nome antigo**: `isViolacaoIdempotenciaNf` (em `recebimento.service.ts`) compara `constraint === 'movimentacao_nf_idempotencia_idx'` — passa a aceitar `movimentacao_nf_entrada_idempotencia_idx`.

---

## 2. `ConsultarNFResponse` (reestruturado) — `packages/integrations/omie/src/stockbridge/nf.ts`

**Antes** (achatado, um produto): `{ nNF, cChaveNFe, dEmi, nCodProd, codigoLocalEstoque, qCom, uCom, xProd, vUnCom, vNF, nCodCli, cRazao }`.

**Depois** (cabeçalho + itens):

```text
interface ItemNF {
  nCodProd: number;            // det[i].nfProdInt.nCodProd
  codigoLocalEstoque: string;  // det[i].prod.codigo_local_estoque (origem/trânsito)
  qCom: number;                // det[i].prod.qCom  (quantidade da linha)
  uCom: string;                // det[i].prod.uCom  (unidade)
  xProd: string;               // det[i].prod.xProd (descrição)
  vUnCom: number;              // det[i].prod.vUnCom (valor unitário comercial)
}

interface ConsultarNFResponse {
  nNF: number;
  cChaveNFe: string;
  dEmi: string;
  vNF: number;                 // total da NF (com tributos) — raw.total.ICMSTot.vNF
  nCodCli: number;
  cRazao: string;
  itens: ItemNF[];             // 1..N — mapa de raw.det[]
}
```

Remove-se o `NotaFiscalMultiItemError` e o `throw` em `det.length>1`.

---

## 3. Tipos de entrada/saída do recebimento multi-item — `recebimento.service.ts`

```text
// Um item conferido pelo operador (linha da NF)
interface ItemRecebimentoImportacaoInput {
  produtoCodigoAcxe: number;      // identifica a linha da NF (veio do fila)
  quantidadeInput: number;        // quantidade física recebida
  unidadeInput: 't'|'kg'|'saco'|'bigbag';
  localidadeId: string;           // UUID — destino (pode diferir por item)
  observacoes?: string;           // obrigatório se o item diverge
  tipoDivergencia?: 'faltando'|'varredura'; // obrigatório se o item diverge
}

interface ProcessarRecebimentoInput {
  nf: string;
  cnpj: 'acxe';                   // importação ACXE-only
  itens: ItemRecebimentoImportacaoInput[]; // 1..N
  userId: string;
}

// Resultado por item
interface ItemRecebimentoResult {
  produtoCodigoAcxe: number;
  status: 'provisorio' | 'aguardando_aprovacao' | 'pendente_q2p' | 'falha_acxe';
  loteId?: string;
  loteCodigo?: string;
  movimentacaoId?: string;
  aprovacaoId?: string;           // presente se aguardando_aprovacao
  deltaKg?: number;               // presente se houve divergência
  omie?: { acxe?: string; q2p?: string };
}

interface ProcessarRecebimentoResult {
  nf: string;
  itens: ItemRecebimentoResult[];
  resumo: { recebidos: number; aguardandoAprovacao: number; pendentesOmie: number; falhas: number };
}
```

**Nota de reuso**: `ItemRecebimentoResult` é o resultado single-item de hoje (`{loteId, loteCodigo, status, movimentacaoId, aprovacaoId, deltaKg, omie}`) promovido a por-item; a versão single-item vira `itens: [1]`.

---

## 4. Entidades persistidas (reusadas sem mudança de colunas)

| Entidade | Cardinalidade por NF multi-item | Observação |
|---|---|---|
| `stockbridge.lote` | **N** (1 por produto) | `produto_codigo_acxe` NOT NULL (já por-produto). `nota_fiscal` agrupa os N lotes. `valor_total_nf_brl` carrega o **valor rateado do item** (não o total da NF) — ver D2/D3 do research. |
| `stockbridge.movimentacao` (`entrada_nf`) | **N** (1 por produto) | `empresa`, `produto_codigo_acxe`, `op_id`, `status_omie` já por-produto. Coberta pelo novo índice de idempotência por (NF, empresa, produto). |
| `stockbridge.aprovacao` (`recebimento_divergencia`) | **0..N** (1 por produto divergente) | Criada só para itens divergentes; independente por item (ramo inalterado de `aprovacao.service.ts`). |
| `shared.audit_log` | automático | Triggers de audit já existentes em `lote`/`movimentacao`/`aprovacao` cobrem as N linhas. |

**Chave de agrupamento**: `nota_fiscal` (já existe em `lote` e `movimentacao`). Fila e aprovações agrupam por ela para exibir "NF X — N produtos". Nenhuma coluna/tabela de "recebimento" nova.

---

## 5. Invariantes

- **INV-1**: para uma NF de importação recebida, `COUNT(entrada_nf ativa por NF+empresa) = número de produtos distintos da NF` (nenhum produto perdido — SC-001).
- **INV-2**: `Σ valor_total_nf_brl dos N lotes da NF = vNF` (dentro do arredondamento, via reconciliação de resíduo — SC-003).
- **INV-3**: um mesmo (NF, empresa, produto) não pode ter duas `entrada_nf` ativas (novo índice) — reprocessamento exige soft-delete (`ativo=false`) do anterior.
- **INV-4**: um produto sem correlato Q2P ⇒ zero linhas gravadas para **toda** a NF (tudo-ou-nada, Portão 1 — SC-004).
