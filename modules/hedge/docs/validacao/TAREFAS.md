# Tarefas — Validação e Versionamento das Views Hedge

**Objetivo**: Documentar e versionar todas as views SQL do módulo hedge.

---

## Fase 1 — Documentação das Views

- [X] `01-exposicao-usd-total.md` — KPI Exposição USD Total + pipeline completo até o frontend
- [X] `02-vw_hedge_pagar_usd.md` — Contas a pagar em USD (fornecedores exterior)
- [X] `03-vw_hedge_estoque.md` — Estoque físico por localidade e origem
- [X] `04-vw_hedge_receber_usd.md` — Contas a receber em USD
- [X] `05-vw_hedge_importacoes.md` — Importações em trânsito / FUP Comex
- [X] `06-vw_hedge_resumo.md` — View mestre (consolida as 4 sub-views + fórmulas)

---

## Fase 2 — Versionamento das Views SQL

- [X] Criar diretório `modules/hedge/src/db/views/`
- [X] Extrair SQL de cada view para arquivo `.sql` individual
- [X] Criar script `apply-views.sql` (ordem de dependência correta)
- [X] Documentar como aplicar (README ou seção em TAREFAS)

---

## Fase 3 — Correções identificadas nas Views

- [X] `vw_hedge_receber_usd` — adicionar `UNION ALL tbl_contasReceber_Q2P_Filial` (filial Q2P ausente) — SQL atualizado, aguarda apply no BD
- [X] `vw_hedge_pagar_usd` — trocar CTE `categorias` hardcoded por `LEFT JOIN tbl_categorias_ACXE` — SQL atualizado, aguarda apply no BD

---

## Notas

- Ordem de dependência das views: `pagar_usd` + `estoque` + `receber_usd` + `importacoes` → `resumo`
- Views não são versionadas no repo hoje — existem só no BD (`pg-atlas-dev` e `pg-acxe`)
- Ao versionar, manter os arquivos `.sql` como fonte da verdade e incluir no processo de deploy
