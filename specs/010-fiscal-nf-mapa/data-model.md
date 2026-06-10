# Data Model: Posição Fiscal via Mapa NF Mãe/Filhote

**Feature Branch**: `010-fiscal-nf-mapa`  
**Date**: 2026-06-10

## New Entities

### `stockbridge.nf_pedido_mapa`

Relacionamento entre um pedido de importação ACXE, sua NF mãe e zero a 12 NF filhotes. Um pedido tem no máximo um mapa ativo (`UNIQUE WHERE ativo = true`).

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `id` | uuid PK | Identificador único |
| `pedido_acxe_omie` | varchar(50) NOT NULL | Número do pedido em `tbl_pedidosCompras_ACXE.cnumero` |
| `nf_mae` | varchar(50) NOT NULL | Número da NF mãe (sempre em `21.1 Extrema`, nunca `n_id_receb > 0`) |
| `ativo` | boolean DEFAULT true | false quando todas as filhotes foram recebidas |
| `importado_em` | timestamptz DEFAULT now() | Data de criação do registro |
| `updated_at` | timestamptz DEFAULT now() | Data da última atualização |

**Constraints**:
- `UNIQUE (pedido_acxe_omie) WHERE ativo = true` — um pedido só tem um mapa ativo

**Lifecycle**:
1. Criado pelo gestor ou n8n via POST endpoint
2. Ativo (`ativo = true`) enquanto alguma filhote não foi recebida
3. Desativado automaticamente (`ativo = false`) quando todas filhotes têm `n_id_receb > 0` no OMIE

---

### `stockbridge.nf_pedido_filhote`

Uma NF filhote por container/caminhão. Sempre há ≥1 filhote por pedido (confirmado Comex 10/06/2026).

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `id` | uuid PK | Identificador único |
| `mapa_id` | uuid FK → `nf_pedido_mapa.id` | Pedido pai |
| `nf_filhote` | varchar(50) NOT NULL | Número da NF filhote (em `90.0.2 TRANSITO`, `n_id_receb > 0` quando recebida) |
| `posicao` | smallint NOT NULL | Posição 1-12 (coluna da planilha FUP) |
| `ativo` | boolean DEFAULT true | false quando soft-deleted por upsert |
| `created_at` | timestamptz DEFAULT now() | Data de criação |

**Lifecycle**:
- Criada junto com o mapa pai
- Em cada upsert do pedido: filhotes antigas ficam `ativo = false`, novas são inseridas
- `n_id_receb` é lido de `public."tbl_nf_header_ACXE"` via LEFT JOIN (não armazenado aqui — fonte de verdade é OMIE)

---

## Existing Entities (referenced, not modified)

### `public."tbl_pedidosCompras_ACXE"` (OMIE — leitura)

| Campo relevante | Uso |
|-----------------|-----|
| `cnumero` | JOIN com `pedido_acxe_omie` |
| `ncodprod` | Agrupamento por produto na posição fiscal |
| `nqtde` | Quantidade do pedido (fonte para `pendente_importacao_kg`) |

### `public."tbl_nf_header_ACXE"` (OMIE — leitura)

| Campo relevante | Uso |
|-----------------|-----|
| `n_nf` | JOIN com `nf_filhote` |
| `n_id_nf` | Presença indica NF sincronizada do OMIE |
| `n_id_receb` | `0` = em trânsito; `> 0` = recebida no galpão físico |
| `d_emi` | Data de emissão (usado no fallback CFOP) |
| `tp_nf` | `0` = entrada (NF de importação) |

### `public."tbl_nf_itens_ACXE"` (OMIE — leitura, somente fallback)

| Campo relevante | Uso |
|-----------------|-----|
| `n_id_nf` | JOIN com header |
| `n_cod_prod` | Produto ACXE |
| `cfop` | Filtra `LEFT(cfop, 1) = '3'` para importações |
| `q_com` | Quantidade no fallback |

---

## Relationships

```
nf_pedido_mapa (1) ──── (N) nf_pedido_filhote
    │                              │
    │ pedido_acxe_omie             │ nf_filhote
    ▼                              ▼
tbl_pedidosCompras_ACXE    tbl_nf_header_ACXE
(nqtde para quantidade)    (n_id_receb para status)
```

---

## State Transitions

```
Mapa: ativo=true
  │
  │  [upsert: filhotes atualizadas]
  │
  ├── alguma filhote: n_id_receb=0 ou NF não sincronizada → permanece ativo=true (pendente)
  │
  └── todas filhotes: n_id_receb > 0 → ativo=false (desativado automaticamente)
        │
        └── pedido cai para fallback CFOP 3.xxx se movimentacao Atlas não existe
```
