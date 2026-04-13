# Quickstart: Forecast Advanced Features

**Feature**: 005-forecast-advanced-features
**Date**: 2026-04-13

---

## Cenario 1: Aba Demanda — vendas mensais e YoY

1. Acessar `/forecast/demanda` no menu lateral
2. Verificar que a tabela mostra todas as familias com:
   - 3 colunas de meses recentes (ex: Jan, Fev, Mar 2026)
   - Coluna YoY% com seta colorida (verde subindo, vermelho descendo)
   - Sparkline (mini grafico 24 meses) na ultima coluna
3. Clicar em uma familia para expandir
4. Verificar SKUs com contribuicao % e cobertura dias

**Resultado esperado**: Comprador identifica em <10s se demanda de uma familia esta subindo ou caindo.

---

## Cenario 2: Aba Insights — fornecedores e score COMEX

1. Acessar `/forecast/insights` no menu lateral
2. Verificar tabela de fornecedores (nome, pais, familias, LT efetivo)
3. Verificar score COMEX dos proximos 4 meses (barras coloridas 0-100)
4. Verificar historico de importacao (12 meses) com grafico de tendencia

**Resultado esperado**: Comprador identifica o melhor mes para compra em <30s.

---

## Cenario 3: Janela de compra otima

1. Na aba Insights, verificar a secao "Oportunidade"
2. Verificar que familias com ruptura proxima + score COMEX favoravel mostram "COMPRAR" no mes atual
3. Verificar que familias sem ruptura proxima + score desfavoravel mostram "CAUTELA" ou "EVITAR"

**Resultado esperado**: Cruzamento automatico de urgencia (ruptura) com oportunidade (score).

---

## Cenario 4: Analise IA da Shopping List

1. Acessar `/forecast/shopping` (Shopping List)
2. Montar lista com 5+ itens selecionados
3. Clicar botao "Analisar com IA"
4. Verificar que aparece loading e apos <15s o painel de analise:
   - Resumo executivo
   - Alertas
   - Recomendacao por item (COMPRAR AGORA / AGUARDAR / REVISAR / OK) com justificativa
5. Alterar a lista (desmarcar um item) — verificar que a analise anterior e descartada

**Resultado esperado**: Analise retorna recomendacoes contextualizadas por item.

---

## Cenario 5: Fallback LLM indisponivel

1. Simular n8n indisponivel (webhook offline)
2. Clicar "Analisar com IA"
3. Verificar que mostra mensagem amigavel "Servico de analise temporariamente indisponivel"
4. Verificar que shopping list continua funcional (copiar, editar qtds, etc)

**Resultado esperado**: Falha gracioso, sem quebrar a interface.
