# Specification Quality Checklist: Posição Fiscal via Mapa NF Mãe/Filhote

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-06-09
**Updated**: 2026-06-16 (emenda ACXEGDP-183: Fix 1/2/3 + aba Pendências Fiscais + dimensão temporal; speckit-clarify — +2 questões)
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Clarification Session Summary (2026-06-09)

| # | Categoria | Pergunta | Resposta |
|---|-----------|----------|----------|
| Q1 | Domain / Integration | Pedido não existente no ERP ao cadastrar mapa | Aceitar silenciosamente |
| Q2 | Lifecycle | O que desativa um mapa? | Auto ao receber todas as filhotes |
| Q3 | Failure Handling | Conflito n8n vs. gestor | Última escrita vence |
| Q4 | Data Volume | Pedidos ativos simultâneos | < 200 |

## Clarification Session Summary (2026-06-16 — emenda ACXEGDP-183)

| # | Categoria | Pergunta | Resposta |
|---|-----------|----------|----------|
| Q5 | Behavior | Recebimento parcial: pedido inteiro ou saldo? | Saldo (Fix 3) |
| Q6 | Domain | "Filhote recebida" = ? | n_id_receb OU movimentacao OU legado (Fix 1) |
| Q7 | Edge case | Dupla contagem A+B (filhote no fallback) | Fallback exclui mãe e filhote de mapa ativo (Fix 2) |
| Q8 | Scope | Natureza da aba Pendências Fiscais | Só importação, somente leitura |
| Q9 | Edge case | Sinal "chegou — NF aberta" | Filhote com NF emitida não recebida + fora do trânsito (FR-015) |
| Q10 | Completion | Base de convergência SC-002 | transito_local + saldo parcial + sem-mapa |
| Q11 | UX/Temporal | Dimensão de tempo da aba | Exoneração (entrada = emissão NF mãe + dias) + aging filhote (dias desde emissão) |

## Notes

- 21 FRs definidos (FR-001 a FR-021), todos testáveis. User Stories US1–US4.
- SC-002 reformulado (2026-06-16): convergência ≤5% contra `transito_local + saldo de filhotes pendentes (pedidos em recebimento) + importações sem mapa` — a base "Tr. p/ Galpão" puro não captura pendência fiscal legítima.
- **Assumption a confirmar**: faixas de aging (dentro do prazo / atenção / crítico) — limite configurável, default alinhado ao `config_produto.lead_time_dias`; o número de dias é sempre exibido (feature utilizável mesmo antes de fixar limites).
- **Deferred ao `/speckit.plan`**: estados vazio/carregando/erro da aba; latência de carregamento; performance das joins (escala <200 pedidos).
- Pronto para `/speckit.plan`.
