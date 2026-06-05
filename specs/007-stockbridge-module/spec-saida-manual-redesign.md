---
status: implemented
data: 2026-05-06
autor: Flavio + Claude (sessão de design + implementação)
contexto: validação StockBridge — refator da Saída Manual sob a arquitetura "Atlas como camada sobre OMIE"
migrations: 0026, 0027
---

> **Status — 2026-05-06**: implementado e em teste no DEV. Comodato passou de Q2P-only
> para **dual ACXE+Q2P** após criação do TROCA também no OMIE ACXE
> (`codigo_local_estoque=4816825713`). Migration 0027 cobre essa mudança.

# Spec — Redesign da Saída Manual de Materiais

## 1. Motivação

A Saída Manual atual exige `lote_id` e debita do `stockbridge.lote.quantidade_fisica_kg` (FIFO).
Com a arquitetura **Atlas-como-camada-sobre-OMIE** (CLAUDE.md, doc `arquitetura-atlas-camada-omie.md`):

- **Saldo físico vem do OMIE** (`vw_posicaoEstoqueUnificadaFamilia`), agregado por SKU+galpão+empresa
- Atlas não tem como controlar FIFO de forma confiável (sem visibilidade lote-a-lote no OMIE)
- UX atual obriga operador a colar UUID de lote — inutilizável

Este redesign torna a operação **agnóstica de lote**: operador escolhe **SKU + galpão + empresa**,
Atlas registra a movimentação e, após aprovação, baixa direto no OMIE via API.

## 2. Decisões fechadas

| # | Tópico | Decisão |
|---|---|---|
| 1 | Granularidade da seleção | **SKU + galpão + empresa(CNPJ)** — fonte: `vw_posicaoEstoqueUnificadaFamilia` |
| 2 | Schema | `lote_id` vira nullable em `movimentacao` e `aprovacao`; novas colunas `produto_codigo_acxe`, `galpao`, `empresa` em ambas |
| 3 | Baixa no OMIE | Após aprovação, Atlas chama OMIE: ajuste de saída pra subtipos definitivos; **transferência** pra TROCA pro comodato |
| 4 | Comodato como transferência | Material vai pro local virtual **`90.0.1 TROCA`** (não sai do nosso estoque, só muda de localidade) |
| 4.1 | `dt_prevista_retorno` | Operador informa; alerta quando vencer (cronjob diário) |
| 4.2 | Retorno divergente | Aceita SKU e/ou qtd diferentes do original; gera 2 movimentações (baixa TROCA + entrada destino) |
| 4.3 | Diferença de qtd no retorno | Operador justifica caso a caso (perda/quebra/etc) — não é automática |
| 4.4 | Aprovação do retorno | **Gestor** aprova (diretor não precisa) |
| 5 | Reserva de saldo | Atlas **reserva** o saldo no momento do lançamento; saídas concorrentes que excederem o saldo disponível são rejeitadas |
| 6 | Saída automática | Vira **só log de auditoria** — não debita mais nada (saldo é OMIE puro) |
| 7 | Histórico | Aproveita tela de **Movimentações** com filtros; precisa coluna `criado_por` (user_id) e filtro "minhas" |

## 3. Mudanças de schema — Migration **0026** (nova)

### 3.1 Localidade `90.0.1 TROCA`

```sql
INSERT INTO stockbridge.localidade (codigo, nome, tipo, cnpj)
VALUES ('90.0.1', 'TROCA', 'virtual_ajuste', NULL)
ON CONFLICT (codigo) DO NOTHING;
```

**Correlação OMIE:** comodato é **dual ACXE+Q2P** após migration 0027.

| Empresa | `codigo_local_estoque` OMIE | Status |
|---|---|---|
| Q2P | `8197553809` | criado migration 0026 |
| ACXE | `4816825713` | criado migration 0027 (após decisão 2026-05-06 de tornar comodato dual) |

```sql
-- migration 0026
INSERT INTO stockbridge.localidade_correlacao (localidade_id, codigo_local_estoque_q2p)
SELECT id, 8197553809 FROM stockbridge.localidade WHERE codigo='90.0.1';

-- migration 0027
UPDATE stockbridge.localidade_correlacao
SET codigo_local_estoque_acxe = 4816825713
WHERE localidade_id = (SELECT id FROM stockbridge.localidade WHERE codigo = '90.0.1');
```

### 3.2 Tornar `lote_id` opcional + novas colunas

```sql
ALTER TABLE stockbridge.movimentacao
  ALTER COLUMN lote_id DROP NOT NULL,                         -- já era nullable (FK só), confirmar
  ADD COLUMN produto_codigo_acxe BIGINT,
  ADD COLUMN galpao TEXT,                                     -- prefixo 11/13/40/etc (mesmo da localidade.galpao)
  ADD COLUMN empresa TEXT CHECK (empresa IN ('acxe','q2p')),
  ADD COLUMN criado_por UUID REFERENCES atlas.users(id);

ALTER TABLE stockbridge.aprovacao
  ALTER COLUMN lote_id DROP NOT NULL,
  ADD COLUMN produto_codigo_acxe BIGINT,
  ADD COLUMN galpao TEXT,
  ADD COLUMN empresa TEXT CHECK (empresa IN ('acxe','q2p'));

-- Constraint: pelo menos UM dos dois (lote_id OU sku+galpao) tem que estar preenchido
ALTER TABLE stockbridge.movimentacao
  ADD CONSTRAINT chk_lote_ou_sku CHECK (
    lote_id IS NOT NULL
    OR (produto_codigo_acxe IS NOT NULL AND galpao IS NOT NULL AND empresa IS NOT NULL)
  );
```

### 3.3 Reserva de saldo

Tabela auxiliar pra rastrear **saldo reservado** por SKU+galpão+empresa enquanto a aprovação está pendente:

```sql
CREATE TABLE stockbridge.reserva_saldo (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  movimentacao_id UUID NOT NULL UNIQUE REFERENCES stockbridge.movimentacao(id) ON DELETE CASCADE,
  produto_codigo_acxe BIGINT NOT NULL,
  galpao TEXT NOT NULL,
  empresa TEXT NOT NULL CHECK (empresa IN ('acxe','q2p')),
  quantidade_kg NUMERIC(12,3) NOT NULL,
  status TEXT NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa','liberada','consumida')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX reserva_sku_idx ON stockbridge.reserva_saldo (produto_codigo_acxe, galpao, empresa, status);
```

**Vida útil:**
- `ativa` → enquanto aprovação está pendente
- `consumida` → após aprovação + sucesso na API OMIE (saldo já saiu do OMIE, libera reserva)
- `liberada` → se aprovação for rejeitada (devolve saldo disponível)

### 3.4 Comodato — campos extras em `movimentacao`

```sql
ALTER TABLE stockbridge.movimentacao
  ADD COLUMN dt_prevista_retorno DATE,                        -- só pra subtipo=comodato
  ADD COLUMN movimentacao_origem_id UUID REFERENCES stockbridge.movimentacao(id);  -- retorno aponta pra saída
```

(Hoje a relação saída↔retorno é por `nota_fiscal` parseando "RET-" — substituir por FK.)

## 4. Workflows

### 4.1 Saída Manual (subtipos definitivos: transf_intra_cnpj, amostra, descarte, quebra, inventario_menos)

```
1. Operador abre /stockbridge/operador/saida-manual
2. Escolhe: empresa → galpão → SKU (combos cascateados de vw_posicaoEstoqueUnificadaFamilia)
   - Mostra saldo disponível: saldo_OMIE - SUM(reservas ativas do mesmo SKU+galpão+empresa)
3. Operador informa: subtipo, quantidade (kg), motivo/observação, [destino se transf_intra_cnpj]
4. Atlas valida: quantidade ≤ saldo disponível
5. Cria:
   - movimentacao (status implícito = pendente — não tem coluna status, é via aprovacao)
   - aprovacao (precisa_nivel = gestor pra todos esses; diretor só pra comodato)
   - reserva_saldo (status='ativa')
   - divergencia (apenas amostra/descarte/quebra/inventario_menos)
   - alerta enviado (email pro gestor)
6. Gestor aprova ou rejeita:
   APROVA →
     a. Atlas chama OMIE estoque/ajuste/ (cod_int_ajuste = movimentacao.id + sufixo)
     b. Sucesso → reserva.status='consumida', movimentacao.status_omie='concluida'
     c. Falha → movimentacao.status_omie='pendente_q2p' (vai pro painel de retentativa)
   REJEITA →
     a. reserva.status='liberada'
     b. divergencia (se houver) cancelada
     c. movimentacao.ativo=false
```

### 4.2 Comodato (subtipo=comodato) — **dual ACXE+Q2P**

Mesma fase 1-5 da Saída Manual, com adições:

- Nível de aprovação: **diretor**
- Operador informa adicionalmente: **`dt_prevista_retorno`** + **cliente/destinatário** (texto livre)
- Após aprovação, Atlas chama OMIE **transferência** (não ajuste): origem=galpão atual, destino=`90.0.1 TROCA`
- Reserva de saldo é "consumida" e o material aparece no estoque TROCA
- Cronjob diário verifica `dt_prevista_retorno < today` AND comodato sem retorno → email de alerta

### 4.3 Retorno de Comodato

```
1. Operador (ou gestor) abre /stockbridge/operador/comodato-retorno
2. Lista comodatos abertos:
   SELECT m.* FROM movimentacao m
   WHERE m.subtipo='comodato'
     AND m.status_omie='concluida'
     AND NOT EXISTS (SELECT 1 FROM movimentacao r WHERE r.movimentacao_origem_id = m.id)
3. Operador escolhe qual fechar e informa:
   - SKU recebido (default = SKU original; pode ser ≠)
   - Quantidade recebida (default = qtd original; pode ser ≠)
   - Galpão destino (pra onde entra de volta)
4. Atlas cria 2 movimentações + aprovacao gestor:
   - mov_baixa_troca: tipo=ajuste, subtipo=retorno_comodato_baixa, lote=null, SKU=original, qtd=-original, galpao=TROCA
   - mov_entrada_destino: tipo=entrada_manual, subtipo=retorno_comodato, SKU=novo, qtd=+nova, galpao=destino, movimentacao_origem_id=mov_saida_original.id
   - Se qtd_recebida != qtd_original OU sku_recebido != sku_original: cria divergencia pro operador justificar
5. Gestor aprova → Atlas chama OMIE:
   - estoque/ajuste/ saída no TROCA (qtd original do SKU original)
   - estoque/ajuste/ entrada no galpão destino (qtd nova do SKU novo)
   - Idempotência: cod_int_ajuste = retorno_id + sufixo (-baixa, -entrada)
```

### 4.4 Listagem (Movimentações + filtros)

Tela existente de Movimentações ganha:
- Filtro por `tipo_movimento` e `subtipo`
- Filtro "**Apenas minhas**" (criado_por = current_user_id)
- Operador vê **só as suas** por padrão; gestor/diretor veem todas
- Coluna nova: status efetivo (pendente / aprovada / rejeitada / OMIE-pendente / concluída)

## 5. Pré-requisitos operacionais

- [ ] Confirmar com OMIE qual endpoint suporta transferência entre locais (`estoque/transferencia/` ou se precisa fazer 2 ajustes pareados).
- [ ] Cronjob diário pra alertas de comodato vencido (pode aproveitar infra de alertas existente).

## 6. Tarefas de implementação (ordem proposta)

1. Migration 0026 (schema acima + seed da localidade TROCA Q2P)
2. Service `saida-manual.service.ts` — refator pra A1 (sem lote_id no caminho principal); criar `validarSaldoDisponivel(sku, galpao, empresa, qtd_pedida)` consultando OMIE menos reservas ativas
3. Service `aprovacao.service.ts` — após APROVA, chamar OMIE (ajuste pro definitivo, transferência pro comodato); marcar reserva como consumida
4. Service novo `comodato-retorno.service.ts` — fluxo da seção 4.3
5. Service `saida-automatica.service.ts` — remover lógica de FIFO/débito do lote; manter apenas `INSERT movimentacao` pra log
6. Schema Drizzle + types atualizados
7. Front: `SaidaManualPage.tsx` reescrita com seletor cascateado (empresa→galpão→SKU+saldo)
8. Front: `ComodatoRetornoPage.tsx` nova
9. Front: `MovimentacoesPage.tsx` adiciona filtros + "minhas"
10. Cronjob alerta comodato vencido
11. Testes (saida-manual.test.ts já existe — adaptar pra novo schema)

## 7. Riscos a vigiar

- **Sync OMIE atrasado**: saldo `vw_posicaoEstoqueUnificadaFamilia` pode estar minutos atrás da realidade. Reserva mitiga concorrência interna do Atlas, mas não cobre ações feitas direto no OMIE legado.
- **Espelhamento ACXE↔Q2P**: toda saída/transferência/comodato em galpão `.1` (importado) chama OMIE em ambas empresas. Pendência recuperável Q2P (após ACXE OK) grava `status_omie='pendente_q2p'` — vai pro painel de Operações Pendentes pra retry idempotente.
- **Migrações de dados**: movimentações antigas têm `lote_id` — não tocar; novo fluxo só preenche `produto_codigo_acxe+galpao+empresa`.
- **Coluna `status_omie` em `movimentacao`**: confirmar que existe (introduzida em 0016) — caso contrário, adicionar na 0026.
