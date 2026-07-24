# Phase 1 — Data Model: Conferência de Estoque ACXE vs Q2P

## 1. Entidades

### 1.1. `stockbridge.conferencia_local_map` (NOVA — config, mutável, auditada)

Mapa De→Para de locais — espelho da aba `tbl_locaisEstoque` da planilha. Única tabela escrita pela feature.

| Coluna | Tipo | Regras |
|---|---|---|
| `id` | `uuid` PK | `gen_random_uuid()` |
| `codigo_local_estoque` | `bigint` | **NOT NULL, UNIQUE** — relaciona com `tbl_posicaoEstoque_*.codigo_local_estoque` |
| `codigo` | `varchar(50)` | NOT NULL — código textual do local (ex. `11.1`); chave de agrupamento ACXE↔Q2P |
| `descricao` | `varchar(255)` | NOT NULL — nome do local (ex. `SANTO ANDRÉ (IMPORTADO)`) |
| `nome_comparativo` | `varchar(255)` | NULL — rótulo amigável por empresa (ex. `IMPORTADO 1 - ACXE`) |
| `tipo` | `varchar(20)` | NOT NULL, `CHECK IN ('ESPELHADO','INDIVIDUAL')` |
| `empresa` | `varchar(20)` | NOT NULL, `CHECK IN ('ACXE','Q2P')` |
| `ativo` | `boolean` | NOT NULL DEFAULT `true` |
| `updated_by` | `uuid` | FK → `atlas.users(id)`, NULL no seed |
| `created_at` / `updated_at` | `timestamptz` | DEFAULT `now()` |

**Índices**: UNIQUE(`codigo_local_estoque`); `(codigo)`; `(tipo)` parcial `WHERE ativo`.
**Trigger de auditoria** (Princípio IV): `AFTER INSERT/UPDATE/DELETE` → `shared.audit_log` (padrão da migration 0039).

**Drizzle** (`packages/db/src/schemas/stockbridge.ts`):

```typescript
export const conferenciaLocalMap = stockbridgeSchema.table('conferencia_local_map', {
  id: uuid('id').defaultRandom().primaryKey(),
  codigoLocalEstoque: bigint('codigo_local_estoque', { mode: 'number' }).notNull().unique(),
  codigo: varchar('codigo', { length: 50 }).notNull(),
  descricao: varchar('descricao', { length: 255 }).notNull(),
  nomeComparativo: varchar('nome_comparativo', { length: 255 }),
  tipo: varchar('tipo', { length: 20 }).notNull().$type<'ESPELHADO' | 'INDIVIDUAL'>(),
  empresa: varchar('empresa', { length: 20 }).notNull().$type<'ACXE' | 'Q2P'>(),
  ativo: boolean('ativo').notNull().default(true),
  updatedBy: uuid('updated_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('conferencia_local_map_codigo_idx').on(t.codigo),
  index('conferencia_local_map_tipo_idx').on(t.tipo),
]);
```

> ⚠️ Gotcha (memória do projeto): em `db.execute`/raw SQL, `bigint` volta como **string** mesmo com `mode:'number'`. Tipar `string|null` e aplicar `Number()` no `.map()`.

### 1.2. `ConferenciaItem` (saída — efêmera, não persiste)

Resultado por `(codigo do local, descrição, tipo, produto normalizado)`.

```typescript
export interface ConferenciaItem {
  codigoEstoque: string;          // codigo textual do local (ex. "11.1")
  nomeEstoque: string;            // descricao do local
  tipoEstoque: 'ESPELHADO' | 'INDIVIDUAL';
  produto: string;               // descrição normalizada (TRIM+UPPER)
  saldoAcxeKg: number;           // SUM(fisico) ACXE no grupo (0 se ausente)
  saldoQ2pKg: number;            // SUM(fisico) Q2P no grupo (0 se ausente)
  diferencaKg: number;           // saldoAcxe - saldoQ2p
  statusSaldoNegativo: 'ACXE e Q2P negativos' | 'ACXE negativo' | 'Q2P negativo' | 'OK';
  statusGeral: 'Divergente e Negativo' | 'Divergente' | 'Negativo' | 'OK';
}

export interface ConferenciaResumo {
  totalSkusDivergentes: number;   // itens com statusGeral em {Divergente, Divergente e Negativo}
  totalProblemas: number;         // itens com statusGeral != OK  (== contagem do badge)
  totalQuebrasNegativas: number;  // itens com statusSaldoNegativo != OK
  somaDiferencaKg: number;        // SUM(diferencaKg) — pode ser negativa
  dataPosicaoAcxe: string | null; // ISO date
  dataPosicaoQ2p: string | null;
  defasagemEntreEmpresas: boolean; // dataAcxe != dataQ2p
}

export interface ConferenciaResponse {
  resumo: ConferenciaResumo;
  itens: ConferenciaItem[];
}
```

## 2. Engine de regras (TypeScript, coberta por Vitest)

Aplicada a cada linha pivotada vinda do SQL. **Ordem importa.**

```typescript
// Saldo Negativo
function statusSaldoNegativo(acxe: number, q2p: number) {
  if (acxe < 0 && q2p < 0) return 'ACXE e Q2P negativos';
  if (acxe < 0) return 'ACXE negativo';
  if (q2p < 0) return 'Q2P negativo';
  return 'OK';
}

// Status Geral — prioridade EXATA (FR-007)
function statusGeral(tipo, diferenca, saldoNeg) {
  const espelhado = tipo === 'ESPELHADO';
  if (espelhado && diferenca !== 0 && saldoNeg !== 'OK') return 'Divergente e Negativo';
  if (espelhado && diferenca !== 0)                       return 'Divergente';
  if (saldoNeg !== 'OK')                                  return 'Negativo';
  return 'OK';
}
```

**Invariantes** (viram casos de teste):
- `INDIVIDUAL` nunca é `Divergente`/`Divergente e Negativo` (mesmo com `diferenca ≠ 0`).
- `ESPELHADO` com `diferenca = 0` e ambos negativos iguais → `Negativo` (não `Divergente e Negativo`). Caso real: PEBD 100 em 11.1, ACXE=Q2P=−1500.
- `diferenca` calculada como `acxe - q2p`; ausência de um lado = `0`.

## 3. Ordenação (FR-011)

Problemas no topo. Prioridade de `statusGeral` desc, depois dimensões asc:

```text
1. peso(statusGeral) DESC   // Divergente e Negativo=3, Divergente=2, Negativo=1, OK=0
2. tipoEstoque ASC
3. nomeEstoque ASC
4. produto ASC
```

(`dataPosicao` é única por empresa nesta v1, então sai da chave de ordenação fina.)

## 4. SQL de agregação (pivot por empresa)

Executado em `conferencia.service.ts` via `getPool()`. Parametriza datas; blacklist e normalização no SQL; engine em TS depois.

```sql
WITH datas AS (
  SELECT
    (SELECT MAX(ddataposicao) FROM public."tbl_posicaoEstoque_ACXE") AS d_acxe,
    (SELECT MAX(ddataposicao) FROM public."tbl_posicaoEstoque_Q2P")  AS d_q2p
),
base AS (
  SELECT m.codigo, m.descricao AS descricao_local, m.tipo, m.empresa,
         TRIM(UPPER(p.cdescricao)) AS produto, p.fisico
  FROM public."tbl_posicaoEstoque_ACXE" p
  JOIN stockbridge.conferencia_local_map m
    ON m.codigo_local_estoque = p.codigo_local_estoque AND m.empresa = 'ACXE' AND m.ativo
  CROSS JOIN datas
  WHERE p.ddataposicao = datas.d_acxe
    AND p.ccodigo NOT LIKE 'CONS\_%' ESCAPE '\'
    AND p.ccodigo NOT LIKE 'PRD00001%'
    AND p.ccodigo NOT LIKE 'SUC-%'
    AND p.ccodigo NOT LIKE 'STRETCH%'
  UNION ALL
  SELECT m.codigo, m.descricao, m.tipo, 'Q2P',
         TRIM(UPPER(p.cdescricao)), p.fisico
  FROM public."tbl_posicaoEstoque_Q2P" p
  JOIN stockbridge.conferencia_local_map m
    ON m.codigo_local_estoque = p.codigo_local_estoque AND m.empresa = 'Q2P' AND m.ativo
  CROSS JOIN datas
  WHERE p.ddataposicao = datas.d_q2p
    AND p.ccodigo NOT LIKE 'CONS\_%' ESCAPE '\'
    AND p.ccodigo NOT LIKE 'PRD00001%'
    AND p.ccodigo NOT LIKE 'SUC-%'
    AND p.ccodigo NOT LIKE 'STRETCH%'
)
SELECT
  codigo                                              AS codigo_estoque,
  MAX(descricao_local)                                AS nome_estoque,
  tipo                                                AS tipo_estoque,
  produto,
  COALESCE(SUM(fisico) FILTER (WHERE empresa='ACXE'), 0)::bigint AS saldo_acxe,
  COALESCE(SUM(fisico) FILTER (WHERE empresa='Q2P'),  0)::bigint AS saldo_q2p
FROM base
GROUP BY codigo, tipo, produto;
```

> Notas:
> - O `FILTER (WHERE empresa=...)` faz o pivot ACXE/Q2P sem FULL OUTER JOIN explícito — produto presente só num lado vira `0` no outro (regra de tratamento da planilha).
> - Agrupamento por `(codigo, tipo, produto)` une os pares `ESPELHADO` (mesmo `codigo`).
> - Registros cujo `codigo_local_estoque` não está em `conferencia_local_map` são **descartados** pelo INNER JOIN (regra do órfão).
> - `::bigint` → vem como **string** no driver; `Number()` no map.
> - `Diferenca`, `Saldo Negativo`, `Status Geral`, ordenação e KPIs: calculados em TS sobre essas linhas.

**Endpoint de contagem (badge)**: mesma CTE; o service roda a engine e retorna apenas `COUNT(statusGeral != 'OK')` + breakdown + datas. (Pode envolver a mesma função de service com flag `apenasContagem`.)

## 5. Seed das 23 linhas {#seed}

Incluído na migration `0040` (INSERT idempotente `ON CONFLICT (codigo_local_estoque) DO NOTHING`):

| codigo_local_estoque | codigo | descricao | nome_comparativo | tipo | empresa |
|---|---|---|---|---|---|
| 4506526722 | 10.0.3 | VARREDURA | VARREDURA STO ANDRÉ - ACXE | INDIVIDUAL | ACXE |
| 8115873874 | 11.1 | SANTO ANDRÉ (IMPORTADO) | IMPORTADO 1 - Q2P | ESPELHADO | Q2P |
| 4498926337 | 11.1 | SANTO ANDRÉ (IMPORTADO) | IMPORTADO 1 - ACXE | ESPELHADO | ACXE |
| 8123584710 | 11.2 | SANTO ANDRÉ (NACIONAL) | NACIONAL 1 - Q2P | INDIVIDUAL | Q2P |
| 8115873724 | 12.1 | SANTO ANDRÉ (IMPORTADO) | IMPORTADO 2 - Q2P | ESPELHADO | Q2P |
| 4498926061 | 12.1 | SANTO ANDRÉ (IMPORTADO) | IMPORTADO 2 - ACXE | ESPELHADO | ACXE |
| 8123584481 | 12.2 | SANTO ANDRÉ (NACIONAL) | NACIONAL 2 - Q2P | INDIVIDUAL | Q2P |
| 4504071362 | 20.0.3 | VARREDURA | VARREDURA EXTREMA - ACXE | INDIVIDUAL | ACXE |
| 4506855468 | 20.0.4 | FALTANDO | FALTANDO - ACXE | INDIVIDUAL | ACXE |
| 4530985781 | 20.0.5 | PROCESSO | PROCESSO - ACXE | INDIVIDUAL | ACXE |
| 4553878431 | 20.0.6 | CONSUMO | CONSUMO - ACXE | INDIVIDUAL | ACXE |
| 4553940398 | 20.0.7 | PRODUÇÃO | PRODUÇÃO - ACXE | INDIVIDUAL | ACXE |
| 7960459966 | 21.1 | EXTREMA | EXTREMA - Q2P | ESPELHADO | Q2P |
| 4004166399 | 21.1 | EXTREMA | EXTREMA - ACXE | ESPELHADO | ACXE |
| 8042180936 | 31.1 | ARMAZÉM EXTERNO | ARMAZÉM EXTERNO - Q2P | ESPELHADO | Q2P |
| 4776458297 | 31.1 | ARMAZÉM EXTERNO | ARMAZÉM EXTERNO - ACXE | ESPELHADO | ACXE |
| 8197553809 | 90.0.1 | TROCA | TROCA - Q2P | INDIVIDUAL | Q2P |
| 8429029971 | 90.0.2 | TRÂNSITO | TRÂNSITO - Q2P | INDIVIDUAL | Q2P |
| 4503767789 | 90.0.2 | TRÂNSITO | TRÂNSITO - ACXE | INDIVIDUAL | ACXE |
| 2994810198 | INATIVO 01 | INATIVO 01 | Estoque Físico | INDIVIDUAL | Q2P |
| 4452867179 | INATIVO 01 | INATIVO 01 | Estoque Físico | INDIVIDUAL | ACXE |
| 3031596403 | INATIVO 02 | INATIVO 02 | EIM | INDIVIDUAL | Q2P |
| 8123584925 | INATIVO 03 | INATIVO 03 | Q2P-SP-P3 | INDIVIDUAL | Q2P |

> Observação: há pares `INDIVIDUAL` que compartilham `codigo` entre empresas (`90.0.2`, `INATIVO 01`). Eles serão agrupados, mas como `tipo=INDIVIDUAL` jamais viram `Divergente` — só podem ser `Negativo`/`OK`. Comportamento idêntico à planilha.
