# Critérios de Paridade — StockBridge vs Legado PHP

**Feature**: 007-stockbridge-module
**Fase**: 13 — Validação Paralela (Princípio V)
**Duração**: 2 semanas sem divergência nova → decisão de cutover
**Script de validação**: `modules/stockbridge/src/scripts/validar-paridade.ts`

---

## Como funciona a validação paralela

Durante o período de validação, cada recebimento de NF é processado **manualmente nos dois sistemas**:
1. Operador recebe NF no sistema legado (PHP/MySQL) — fluxo normal
2. Operador repete a mesma operação no Atlas (StockBridge UAT)
3. Ao final do dia, o script `validar-paridade.ts` compara os resultados

---

## Critério 1 — Paridade de Movimentação no OMIE

**O que comparar**: para cada NF processada em ambos os sistemas, deve haver registros de sucesso de movimentação no OMIE (IDs preenchidos) tanto no ACXE quanto no Q2P. Os IDs **serão diferentes** entre o sistema legado e o Atlas, pois representam movimentos distintos registrados no ERP.

| Campo MySQL (`tb_movimentacao`) | Campo PG (`stockbridge.movimentacao`) | Condição de Paridade |
|---|---|---|
| `id_movest_acxe` | `id_movest_acxe` | Ambas devem ser ≠ null (sucesso na chamada) |
| `id_movest_q2p` | `id_movest_q2p` | Ambas devem ser ≠ null (sucesso na chamada) |
| `id_ajuste_acxe` | `id_ajuste_acxe` | Ambas devem ser ≠ null |
| `id_ajuste_q2p` | `id_ajuste_q2p` | Ambas devem ser ≠ null |

**Critério de aprovação**: 100% das NFs processadas com IDs de sucesso em ambos os sistemas. Divergência de ID (um sistema gerou, o outro falhou) deve ser zero.

**Por que importa**: Como os sistemas rodam em paralelo, o OMIE identificará cada chamada como um movimento diferente (2 chamadas do Legado e 2 chamadas do Atlas para a mesma NF). O importante não é a identidade do ID, mas a garantia de que ambos os sistemas conseguiram completar o ciclo de integração com o ERP para os mesmos parâmetros de entrada.

---

## Critério 2 — Tratamento de divergência idêntico

**O que comparar**: quando o operador registra uma divergência (quantidade recebida ≠ quantidade da NF), o tipo, a quantidade e o destino do fluxo de aprovação devem ser iguais nos dois sistemas.

| Aspecto | Legado (MySQL) | Atlas (PG) | Condição de paridade |
|---|---|---|---|
| Tipo divergência | `tb_tp_divergencia.descricao` | `stockbridge.divergencia.tipo` | mesmo tipo (`faltando` / `varredura`) |
| Quantidade divergente | `tb_movimentacao.mv_acxe` com sinal | `stockbridge.movimentacao.quantidade_t` delta | mesma magnitude em toneladas |
| Status lote resultante | campo status legado | `stockbridge.lote.status` = `aguardando_aprovacao` | ambos bloqueados para aprovação |

**Critério de aprovação**: 100% das divergências do período com tipo e fluxo idênticos.

---

## Critério 3 — Emails disparados nos mesmos eventos

**O que comparar**: os gatilhos de notificação (não o conteúdo) devem coincidir.

| Evento | Legado dispara? | Atlas dispara? |
|---|---|---|
| Produto sem correlato ACXE↔Q2P | Sim | Sim (T039) |
| Divergência criada → notifica gestor | Sim | Sim (T062) |
| Débito cruzado detectado → notifica gestor+diretor | Sim | Sim (T077b) |
| Aprovação pendente >24h | Não | Não (dashboard apenas) |

**Critério de aprovação**: nenhum evento disparado em apenas um dos sistemas no mesmo recebimento.

**Observação**: conteúdo e formatação dos emails podem variar — só o *gatilho* importa para paridade.

---

## Critério 4 — Log de movimentação com datas/usuários/CNPJs corretos

**O que comparar**: os campos de rastreabilidade devem ser equivalentes.

| Campo MySQL | Campo PG | Tolerância |
|---|---|---|
| `dt_acxe` | `stockbridge.movimentacao.dt_acxe` | ±5 min (processamento manual duplo) |
| `dt_q2p` | `stockbridge.movimentacao.dt_q2p` | ±5 min |
| `id_user` (via email) | `id_user_acxe` / `id_user_q2p` | mesmo email mapeado |
| CNPJ origem | `stockbridge.lote.cnpj` | exato |
| `nota_fiscal` | `nota_fiscal` | exato |

**Critério de aprovação**: 100% das NFs com `nota_fiscal`, CNPJ e usuário corretos; tolerância de ±5 min em timestamps (operador processa dois sistemas sequencialmente).

---

## Critério 5 — Contagem de movimentações diárias coincide

**O que comparar**: ao final de cada dia, total de movimentações ativas em ambos os sistemas deve ser igual ao volume do dia.

| Métrica | Fonte MySQL | Fonte PG |
|---|---|---|
| Total movs do dia | `COUNT(*) FROM tb_movimentacao WHERE DATE(dt_acxe) = hoje AND ativo=1` | `COUNT(*) FROM stockbridge.movimentacao WHERE DATE(dt_acxe) = hoje AND ativo=true` |
| Movs com divergência | `COUNT(*) WHERE tp_divergencia_id IS NOT NULL` | `COUNT(*) FROM stockbridge.divergencia WHERE DATE(created_at) = hoje` |

**Critério de aprovação**: contagens iguais ao final de cada dia operacional.

---

## Resolução de divergências encontradas

Quando o script `validar-paridade.ts` reportar divergência:

1. **Investigar** o recebimento específico (NF, operador, horário)
2. **Classificar** a causa:
   - Bug do legado conhecido → aceitar via ADR (`specs/007-stockbridge-module/adr/`)
   - Bug do Atlas → corrigir antes do cutover, zerar contador de dias sem divergência
   - Erro operacional (operador errou em um dos sistemas) → reprocessar e não contar
3. **Registrar** em `specs/007-stockbridge-module/paridade-diario.md` (criado durante a fase 13)

---

## Condição de cutover

- **2 semanas corridas** sem divergência nova não explicada por erro operacional
- Todos os critérios acima com aprovação
- Decisão registrada em ADR ou PR de decisão (T120)
- Script `quickstart.md` executado completamente em staging (T130)

---

## Referências

- `research.md` seção 1 — estratégia de validação paralela
- `research.md` seção 6 — mapeamento MySQL → PG
- `tasks.md` Phase 13 — T116–T120
- `specs/001-atlas-infra-base/` — Princípio V da constituição
