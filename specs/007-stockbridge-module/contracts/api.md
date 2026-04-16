# API Contracts: StockBridge

**Feature**: 007-stockbridge-module
**Base path**: `/api/v1/stockbridge`
**Authentication**: Cookie session (Atlas infra) + role-based middleware

---

## Convencoes

- Todos os endpoints retornam `{ "data": ... }` em sucesso e `{ "error": { "code", "message" } }` em falha.
- Paginacao: `?page=1&pageSize=50`, resposta inclui `meta: { total, page, pageSize }`.
- Timestamps em ISO 8601 UTC.
- Quantidades sempre em toneladas (numeric).
- Role middleware aplicado por endpoint: `@operador`, `@gestor`, `@diretor`, `@any`.

---

## 1. Fila OMIE — Operador

### `GET /fila` `@operador`
Lista NFs pendentes de conciliacao (nao processadas) nos dois CNPJs.

**Query params**:
- `tipo?`: `importacao` | `devolucao` | `compra_nacional` | `retorno_remessa` | `retorno_comodato`
- `busca?`: string (NF, fornecedor, produto)

**Response**:
```json
{
  "data": [
    {
      "nf": "IMP-2026-0301",
      "tipo": "importacao",
      "subtipo": "Pos-DI",
      "cnpj_emissor": "Acxe Matriz",
      "remetente": "Sinopec",
      "produto": { "codigo": 12345, "nome": "PP RAFIA", "ncm": "3902.10.10" },
      "qtd_original": 980,
      "unidade": "saco",
      "qtd_t": 24.5,
      "localidade_sugerida": "11.1",
      "dt_emissao": "2026-03-10",
      "custo_usd": 1175
    }
  ]
}
```

**Regras**:
- Operador so ve NFs cujo CNPJ emissor/destino corresponde ao seu armazem.
- Fornecedores excluidos (via `stockbridge.fornecedor_exclusao`) sao filtrados apenas para NFs de `compra_nacional`.

---

## 2. Recebimento — Operador

### `POST /recebimento` `@operador`
Confirma recebimento fisico de uma NF.

**Request**:
```json
{
  "nf": "IMP-2026-0301",
  "quantidade_recebida_t": 24.5,
  "unidade_input": "saco",
  "quantidade_input": 980,
  "localidade_id": "uuid-localidade",
  "observacoes": "Material OK, embalagens integras",
  "tipo_divergencia": null
}
```

**Response (sem divergencia)**:
```json
{
  "data": {
    "lote_id": "uuid",
    "codigo_lote": "L742",
    "status": "provisorio",
    "movimentacao_id": "uuid",
    "omie_acxe": { "id_movest": "4809443706", "id_ajuste": "..." },
    "omie_q2p": { "id_movest": "8455282361", "id_ajuste": "..." }
  }
}
```

**Response (com divergencia)**:
```json
{
  "data": {
    "lote_id": "uuid",
    "codigo_lote": "L743",
    "status": "aguardando_aprovacao",
    "aprovacao_id": "uuid",
    "delta_t": -0.5,
    "tipo_divergencia": "faltando"
  }
}
```

**Regras**:
- Valida idempotencia por `nf` (409 se ja processada).
- Valida correlacao de produto ACXE↔Q2P via `vw_sb_correlacao_produto` (409 se nao existe + envia email admin).
- Se `quantidade_recebida_t` diverge da NF: cria lote `aguardando_aprovacao`, dispara aprovacao.
- Se confere: chama OMIE (ACXE primeiro, depois Q2P), cria lote `provisorio`, grava movimentacao com ambos os lados.
- Transacional: se OMIE Q2P falhar apos ACXE ter sucesso, rollback no BD + log de alerta (mas o ajuste ACXE na OMIE ja aconteceu — cenario que operador precisa ser notificado).

---

## 3. Cockpit — Gestor/Diretor

### `GET /cockpit` `@gestor`
Retorna SKUs com saldos, cobertura e criticidade.

**Query params**:
- `familia?`: `PP` | `PE` | `PS` | `todas`
- `cnpj?`: `acxe` | `q2p` | `ambos`
- `criticidade?`: `critico` | `alerta` | `ok` | `excesso`

**Response**:
```json
{
  "data": {
    "resumo": {
      "total_fisico_t": 285.4,
      "total_fiscal_t": 287.2,
      "transito_intl_t": 60,
      "transito_interno_t": 30,
      "provisorio_t": 12,
      "divergencias_count": 3,
      "aprovacoes_pendentes": 2,
      "skus_criticos": 1,
      "skus_alerta": 3
    },
    "skus": [
      {
        "codigo_acxe": 12345,
        "nome": "PP RAFIA",
        "familia": "PP",
        "ncm": "3902.10.10",
        "fisica_t": 42,
        "fiscal_t": 42,
        "transito_t": 15,
        "provisorio_t": 0,
        "consumo_medio_diario_t": 1.2,
        "cobertura_dias": 35,
        "lead_time_dias": 60,
        "criticidade": "alerta",
        "divergencias": 0,
        "aprovacoes_pendentes": 0,
        "lotes": [{ "id": "uuid", "codigo": "L020", "quantidade_fisica_t": 35, "status": "reconciliado", "localidade": "Q2P - 21.1 EXTREMA" }]
      }
    ]
  }
}
```

---

## 4. Lotes — Gestor/Diretor

### `GET /lotes` `@gestor`
Listagem paginada de lotes.

**Query params**: `page, pageSize, produto_codigo_acxe?, status?, localidade_id?, cnpj?`

### `GET /lotes/:id` `@gestor`
Detalhes de um lote especifico.

### `PATCH /lotes/:id` `@gestor`
Edicao manual (ajuste de qtd, localidade) — gera movimentacao tipo `ajuste`.

**Request**:
```json
{ "quantidade_fisica_t": 41.5, "observacoes": "Ajuste apos contagem" }
```

---

## 5. Aprovacoes — Gestor/Diretor

### `GET /aprovacoes` `@gestor`
Pendencias do nivel do usuario.

**Response**:
```json
{
  "data": [
    {
      "id": "uuid",
      "lote_id": "uuid",
      "tipo_aprovacao": "recebimento_divergencia",
      "quantidade_prevista_t": 25.0,
      "quantidade_recebida_t": 24.5,
      "delta_t": -0.5,
      "tipo_divergencia": "faltando",
      "observacoes": "2 big bags avariados",
      "lancado_por": { "id": "uuid", "nome": "Flavia Novak" },
      "lancado_em": "2026-04-16T18:57:12Z",
      "produto": { "nome": "PP RAFIA" }
    }
  ]
}
```

### `POST /aprovacoes/:id/aprovar` `@gestor`
Aprova a pendencia, atualiza lote, registra movimentacao.

### `POST /aprovacoes/:id/rejeitar` `@gestor`
**Request**: `{ "motivo": "Quantidade incorreta, reconfirmar" }`
Rejeita. Lote vai para status `rejeitado`. Operador pode re-submeter depois.

### `POST /aprovacoes/:id/resubmeter` `@operador`
**Request**: `{ "quantidade_recebida_t": 24.5, "observacoes": "..." }`
Re-submete apos rejeicao. Lote volta para `aguardando_aprovacao`.

---

## 6. Pipeline de Transito — Gestor/Diretor

### `GET /transito` `@gestor`
Lotes em cada estagio de trânsito.

**Response**:
```json
{
  "data": {
    "transito_intl": [{ "lote_id": "uuid", "codigo": "T001", "produto": "PP RAFIA", "qtd_prev_t": 60, "dt_prev_chegada": "2026-04-22", "custo_usd": 1170 }],
    "porto_dta": [{ "lote_id": "uuid", "codigo": "T003", "di": "DI-2026-...", "dta": "DTA-2026-0312", "porto": "Santos" }],
    "transito_interno": [{ "lote_id": "uuid", "codigo": "T004", "nf": "NF-004321", "qtd_fiscal_t": 18 }],
    "reservado": []
  }
}
```

### `PATCH /transito/:lote_id/avancar` `@gestor`
Avanca um lote para o proximo estagio (manual enquanto ComexFlow nao existe).

**Request**: `{ "proximo_estagio": "porto_dta", "di": "DI-...", "dta": "DTA-..." }`

---

## 7. Movimentacoes — Gestor/Diretor

### `GET /movimentacoes` `@gestor`
Log paginado.

**Query params**: `page, pageSize, nf?, tipo_movimento?, cnpj?, dt_inicio?, dt_fim?`

**Response**:
```json
{
  "data": [
    {
      "id": "uuid",
      "nota_fiscal": "IMP-2026-0301",
      "tipo_movimento": "entrada_nf",
      "subtipo": "importacao",
      "quantidade_t": 24.5,
      "lote_codigo": "L742",
      "lado_acxe": { "status": "Sucesso", "dt": "2026-04-16T18:57:11Z", "usuario": "Flavia Novak", "id_movest": "4809443706" },
      "lado_q2p": { "status": "Sucesso", "dt": "2026-04-16T18:57:12Z", "usuario": "Flavia Novak", "id_movest": "8455282361" },
      "observacoes": null
    }
  ],
  "meta": { "total": 731, "page": 1, "pageSize": 50 }
}
```

### `DELETE /movimentacoes/:id` `@gestor`
Soft delete — marca `ativo=false` e grava audit.

---

## 8. Saidas Automaticas — Sistema (n8n)

### `POST /saida-automatica/processar` `@system`
Endpoint interno chamado pelo n8n para cada NF de saida nova.

**Header**: `X-Atlas-Integration-Key: <secret>`

**Request**:
```json
{
  "nf": "NF-VENDA-12345",
  "tipo_omie": "venda",
  "cnpj_emissor": "Q2P Matriz",
  "produto_codigo": 123,
  "quantidade_original": 18000,
  "unidade": "kg",
  "localidade_origem_codigo": 8115873874,
  "dt_emissao": "2026-04-16",
  "id_movest_omie": "8455282361"
}
```

**Response**:
```json
{
  "data": {
    "movimentacao_id": "uuid",
    "subtipo": "venda",
    "debito_cruzado": false
  }
}
```

**Regras**:
- Idempotente: se `nf` + `tipo_omie` ja processada, retorna 200 com referencia existente.
- Identifica debito cruzado se localidade origem pertence a CNPJ diferente do emissor → cria `stockbridge.divergencia` tipo `cruzada` + notifica gestor/diretor.

---

## 9. Saidas Manuais — Operador

### `POST /saida-manual` `@operador`
Registra saida manual com aprovacao.

**Request**:
```json
{
  "subtipo": "comodato",
  "lote_id": "uuid",
  "quantidade_t": 2.5,
  "localidade_destino": "Cliente XYZ",
  "observacoes": "Empréstimo para teste",
  "referencia": "COM-2026-001"
}
```

**Response**: `{ "data": { "movimentacao_id": "...", "aprovacao_id": "...", "status": "aguardando_aprovacao", "precisa_nivel": "diretor" } }`

**Regras**:
- `comodato` → exige aprovacao `diretor`
- `transf_intra_cnpj`, `amostra`, `descarte`, `quebra`, `inventario_menos` → `gestor`

### `POST /comodato/:movimentacao_id/retorno` `@operador`
Registra retorno de comodato (reverte debito temporario).

---

## 10. Localidades — Gestor/Diretor

### `GET /localidades` `@gestor`
### `POST /localidades` `@gestor`
**Request**: `{ "codigo": "32.1", "nome": "Nova Filial", "tipo": "proprio", "cnpj": "Acxe Matriz", "cidade": "Guarulhos" }`
### `PATCH /localidades/:id` `@gestor`
### `DELETE /localidades/:id` `@gestor` (soft, marca `ativo=false`)

---

## 11. Fornecedores — Diretor

### `GET /fornecedores` `@diretor`
Lista fornecedores com flag de exclusao.

### `POST /fornecedores/:cnpj/excluir` `@diretor`
**Request**: `{ "motivo": "Problemas recorrentes de qualidade" }`

### `POST /fornecedores/:cnpj/reincluir` `@diretor`

---

## 12. Metricas — Diretor

### `GET /metricas` `@diretor`
KPIs consolidados.

**Response**:
```json
{
  "data": {
    "valor_estoque_brl": 3200000,
    "valor_estoque_usd": 550000,
    "exposicao_cambial_usd": 120000,
    "giro_medio_dias": { "PP": 45, "PE": 52, "PS": 60 },
    "taxa_divergencia_pct": 2.1,
    "ptax_brl": 5.82
  }
}
```

### `GET /metricas/evolucao?meses=6` `@diretor`
Evolucao mensal por familia.

### `GET /metricas/tabela-analitica` `@diretor`
Tabela completa por SKU (qtd, CMP, cobertura, divergencias).

---

## 13. Configuracao — Diretor

### `GET /config/produtos` `@diretor`
### `PATCH /config/produtos/:codigo_acxe` `@diretor`
**Request**: `{ "consumo_medio_diario_t": 1.2, "lead_time_dias": 55, "incluir_em_metricas": true }`

---

## Resumo de endpoints

**18 endpoints** distribuidos em 13 grupos:
1. Fila (1)
2. Recebimento (1)
3. Cockpit (1)
4. Lotes (3)
5. Aprovacoes (4)
6. Transito (2)
7. Movimentacoes (2)
8. Saida automatica (1)
9. Saidas manuais (2)
10. Localidades (4)
11. Fornecedores (3)
12. Metricas (3)
13. Config (2)

**Total real**: ~29 endpoints considerando todas as variacoes. Foco inicial: 18 do caminho critico (US1-US5).

## Error Codes

| Code | HTTP | Quando |
|---|---|---|
| `NF_JA_PROCESSADA` | 409 | Idempotencia |
| `PRODUTO_SEM_CORRELATO` | 409 | Correlacao ACXE↔Q2P falhou |
| `OMIE_ACXE_FAIL` | 502 | Erro na API OMIE ACXE |
| `OMIE_Q2P_FAIL` | 502 | Erro na API OMIE Q2P |
| `OPERADOR_ARMAZEM_NAO_VINCULADO` | 403 | Operador sem `armazem_id` |
| `APROVACAO_NIVEL_INSUFICIENTE` | 403 | Gestor tentando aprovar comodato (precisa diretor) |
| `LOTE_STATUS_INVALIDO` | 409 | Tentativa de operacao invalida no ciclo do lote |
| `LOCALIDADE_INATIVA` | 400 | |
| `FORNECEDOR_EXCLUIDO` | 400 | Recebimento de compra nacional de fornecedor excluido |
