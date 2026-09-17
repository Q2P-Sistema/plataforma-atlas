# Prompt — ACXEGDP-365: prova de par `TRI-<idPar>` no bypass triangular do `3Dzk` (Rev 1.8)

> Para colar no agente do repo `backup-workflow-n8n`. Autossuficiente — não depende do histórico da outra sessão.

---

## Tarefa

Implementar a **fase 2 do bypass triangular** no fluxo `3Dzk23bO2b7a1hYf` ("Q2P Matriz - Verifica PV - Ajusta Seguradora ou Fintech", hoje **Rev 1.7**), conforme **ACXEGDP-365** — leia a tarefa e o comentário de desbloqueio de 14/09 antes de começar. Publicar como **Rev 1.8**, com spec, stickies e comentário no Jira, no mesmo padrão da Rev 1.7 (ACXEGDP-364, comentários 14888/14890).

**Escopo desta rodada: só o `3Dzk`.** O item 2 da 365 (prova de par no `1iPx`) fica fora — o CRM já envia CST 50 + cBenef SP054020 na remessa (auto-correção do 1iPx virou rede de segurança; execução 406472, PV 19568, `auto_correcao: null`). Não tocar no `1iPx` nem no `GaaauV3oB6uSl7Q5`.

## Contexto que já está confirmado (não precisa reverificar)

- O CRM (OrbitIA) cria as duas pernas da triangular no OMIE com `cabecalho.codigo_pedido_integracao` no formato **`TRI-<idPar>-R`** (remessa, CFOP 5.924) e **`TRI-<idPar>-V`** (venda/faturamento, CFOP do formulário — 5.102 ou 5.123). Pares reais em produção: `TRI-16366-R/V` (19393/19394), `TRI-16367-R/V` (19395/19396), `TRI-16557-R/V` (19568/19569). Pedidos não triangulares levam o id puro do CRM (`6540`). PVs criados à mão no OMIE **não têm carimbo** (ex.: par KOVACS 19486/19487 de 08/09 — `codigo_pedido_integracao` vazio).
- A contraparte é derivável sem busca: `TRI-16557-R` → `TRI-16557-V`.
- A API OMIE `produtos/pedido/` / `ConsultarPedido` aceita `codigo_pedido_integracao` como chave de consulta (além de `codigo_pedido`). **Confirme com uma chamada real** antes de amarrar — e capture também o `faultstring` exato de um código inexistente (a OrbitIA reportou algo como "Pedido não cadastrado para o Código…"): é esse texto que separa "par não existe" de erro transitório.
- Estado atual do `3Dzk` Rev 1.7 (verificado no JSON do repo):
  - `Subworkflow_Trigger → Triangular (IF) → [TRUE] ConsultarPedido_Refresh_Triangular → …_IF → PreparaPayloadTriangular → AlterarPV_Triangular` (bypass: etapa 50); `[FALSE] Avista → …` (crédito normal).
  - Condição do IF `Triangular`: todos os itens com CFOP ∈ {5924, 6924} (normalizado sem pontos), `length > 0`, padrão `'S'/'N'` + string equals.
  - Chamadas OMIE: httpRequest v4.5, `POST https://app.omie.com.br/api/v1/produtos/pedido/`, `authentication: genericCredentialType`, credencial `httpCustomAuth` **"Omie Q2P" (id `1BKrU6xm8F94LUXo`)**, `timeout 60000`, `retryOnFail=false`, e **cadeia de retry explícita** `X → X_IF (!!$json.error) → X_Wait90 → X_Retry → X_IF2 → X_Wait300 → X_Retry2`. Replique esse padrão para a nova consulta.
  - Code nodes: `decodeEnt` em loop (ACXEGDP-331), `sanitize` de `obs_venda` com `'|'` → `\n`, `codigo_item_integracao: 'PrimeBot-<codigo_item>'` no `det` parcial, carimbo `[dd/mm/aaaa, hh:mm:ss] [Análise de Crédito - …]`. Mantenha as convenções.
- Do lado do CRM, a detecção de exclusão olha **só uma perna** (achado #55 em ACXEGDP-325). Aqui: **consultar a contraparte de fato**, nunca inferir.

## Desenho a implementar

Inserir, **apenas no ramo TRUE** do IF `Triangular` (antes de `ConsultarPedido_Refresh_Triangular`):

1. **`ProvaDePar_Deriva` (Code)** — lê `cabecalho.codigo_pedido_integracao` do trigger; se casa `^TRI-(.+)-R$` → `temCarimbo=true`, `codigoPar='TRI-<id>-V'`; senão `temCarimbo=false`. Expor também a flag de convivência **`EXIGIR_CARIMBO_TRI`** (constante no topo do código, **`false` nesta rodada**).
2. **IF `Tem_Carimbo_TRI`**
   - **TRUE →** `ConsultarPedido_Par` (ConsultarPedido por `codigo_pedido_integracao = codigoPar`, com a cadeia de retry) → **`ProvaDePar_Valida` (Code)** → IF `Par_OK`.
   - **FALSE (sem carimbo)** → se `EXIGIR_CARIMBO_TRI=false`: segue o bypass atual **com linha de auditoria adicional** em `obs_venda`: `[Análise de Crédito - VENDA TRIANGULAR] Remessa sem carimbo TRI (PV criado fora do CRM) — bypass por CFOP mantido em convivência.`; se `=true`: pendência (abaixo).
3. **`ProvaDePar_Valida`** — `parOK` só se: resposta sem `error`/`faultstring`; `pedido_venda_produto.cabecalho.codigo_pedido_integracao` termina em `-V` com o mesmo `<id>`; **nenhum** item do par com CFOP 5924/6924 (é a perna de venda, não outra remessa); e, se disponível, `det[].inf_adic.nao_movimentar_estoque='S'` (reforço, não condição). PV inexistente/excluído (faultstring "não cadastrado") → `parOK=false` com `motivo='par_inexistente'`. Erro persistente após os retries → `parOK=false` com `motivo='par_nao_confirmado'` — **fail-safe: nunca liberar o bypass sem confirmação positiva.**
4. **IF `Par_OK`**
   - **TRUE →** bypass existente (`ConsultarPedido_Refresh_Triangular → …`), acrescentando ao log de `obs_venda` a referência do par: `… perna de venda TRI-<id>-V localizada (PV <numero_pedido>).`
   - **FALSE → pendência ao vendedor, NÃO crédito normal.** Racional: rodar crédito na perna de remessa validaria o limite contra o industrializador (cliente errado); e o caso motivador (PV 19479, venda lançada como 5.924) se resolve com o humano corrigindo o CFOP, não com o fluxo adivinhando. Reutilize o padrão de `PreparaPayloadReprovado → AlterarPV_Reprovado → Monta_Email_Reprovado → Envia_Email_Reprovado` (etapa 10, carimbo `[Análise de Crédito - REPROVADO]`, e-mail ao vendedor). Texto do motivo: `Remessa triangular (TRI-<id>-R) sem perna de venda correspondente no OMIE (TRI-<id>-V não localizada: <motivo>). Verifique se o pedido de venda foi criado ou se o CFOP 5.924 foi lançado por engano.`

Ramo FALSE do IF `Triangular` (`Avista → crédito`) **não muda**.

## Critérios de aceite — testes de mesa com payload real (tabela no comentário do Jira)

| Cenário | Fonte do payload | Esperado |
|---|---|---|
| Remessa com carimbo e par existente | PV 19568 (`TRI-16557-R`; 1iPx exec 406472) | bypass + log com "perna de venda TRI-16557-V localizada (PV 19569)" |
| Remessa com carimbo e par inexistente | mesmo payload com código forçado `TRI-99999-R` | **pendência** `par_inexistente`, etapa 10, e-mail |
| Remessa com carimbo, ConsultarPedido falhando (erro transitório simulado) | idem | retries; se persistir → **pendência** `par_nao_confirmado` (nunca bypass) |
| Remessa **sem** carimbo (manual) | PV 19487 KOVACS (3Dzk exec 401618) | `EXIGIR=false`: bypass + log "sem carimbo TRI (convivência)"; `EXIGIR=true`: pendência |
| 5.924 lançado errado sem carimbo (limitação conhecida) | PV 19479 (1iPx exec 399678) | `EXIGIR=false`: bypass (documentar que só a Fase B fecha); `EXIGIR=true`: pendência |
| Venda comum / misto / det vazio | qualquer 5.102 | ramo FALSE intacto — crédito normal |

Antes do publish: MD5 byte a byte repo × produção nos nós alterados; spec atualizada para Rev 1.8; stickies `Sticky_Trigger`/`Sticky_Triangular` reescritas (regra nova + convivência + flag); comentário na ACXEGDP-365 com a tabela acima e a versão publicada. Se algum teste de mesa falhar, **não publique** — reporte.

## Não fazer

- Não alterar a semântica do IF `Triangular` nem o ramo FALSE.
- Não tocar em `1iPx`/`Gaaau`.
- Não liberar bypass por inferência (só com par confirmado).
- Não trocar a flag para `true` — a data de corte é decisão do Flavio (alinhada à ACXEGDP-377).
