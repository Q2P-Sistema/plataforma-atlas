# Roteiro de teste em UAT — os 5 cenários que faltam (ACXEGDP-328)

**Para quem executa o teste em UAT** (operador + gestor). Preparado em 25/09/2026 a partir da fila real de UAT.

O que já foi validado com OMIE real — receber sem digitar, correlação memorizada com reuso, rejeição e re-recebimento — está registrado em `tasks.md` (T059) e não se repete aqui.

## Resultado da execução (25/09/2026)

| Cenário | Resultado |
|---|---|
| 2 — Divergência de peso | ✅ OK |
| 3 — 1 item → N produtos | ✅ OK |
| 8 — Recebimento externo | ✅ OK |
| 5 — Unidade **não conversível** (NF 67305, `UN`) | ✅ OK |
| 5 — Unidade **incoerente** | ⚠️ Sem caso disponível em UAT — ver nota abaixo |
| 6 — Idempotência | 🔁 Instrução estava errada; refeita abaixo |

> **Correção de método (25/09).** Ao levantar as NFs candidatas eu chequei "já recebida" **só pela via da chave de acesso**, esquecendo as outras duas vias da regra (número no histórico manual e baixa externa aprovada). Por isso sugeri NFs que já estavam recebidas — a 71347 da APTA, por exemplo, tinha sido recebida pelo formulário manual em 23/09. Refeito com as três vias, a fila real tem hoje **apenas 2 NFs pendentes**:
>
> | NF | Fornecedor | Emissão | Item | Quantidade |
> |---|---|---|---|---|
> | **6936** | TRADECONNEX | 11/09 | POLIETILENO 641 PRIME | 30.000 kg |
> | **6937** | TRADECONNEX | 11/09 | POLIETILENO 641 PRIME | 3.000 kg |
>
> As duas têm **um item só** — por isso o cenário 6 precisa de uma NF fora da janela (abaixo).

**Cenário 5, parte incoerente**: as NFs 59311/59321 da Zaraplast não apareceram na fila com o corte em `2026-08-28` — e **isso está certo**: as duas já haviam sido recebidas pelo formulário manual, e a checagem de duas vias as retirou da fila. O acaso validou o **SC-008** ("nenhuma NF já recebida pelo manual reaparece como pendente"). Varrendo o espelho desde maio/2026, **todos** os itens com unidade incoerente já foram recebidos pelo manual — não há caso testável em UAT hoje. A regra está coberta por Vitest (`unidade-nf.test.ts`, caso da NF 58067 com os números reais) e fica pendente de observação quando aparecer uma NF nova nessa condição.

> ⚠️ **UAT está com `OMIE_MODE=real`: todo recebimento aprovado grava ajuste de estoque no OMIE de verdade.** Por isso o roteiro prefere as NFs de menor volume. Se não quiser mexer no estoque, pare antes da aprovação do gestor — o que se quer provar nos cenários 2, 3 e 5 acontece **antes** dela.

> Antes de começar: a stack precisa estar com a imagem `uat` mais recente (há quatro correções desde o último deploy) e `OMIE_MODE=real` no Portainer. Ctrl+Shift+R no navegador antes de reprovar qualquer tela.

---

## Cenário 2 — Divergência de peso (História 2) · **o mais importante**

Prova que a balança manda, que o motivo é obrigatório e que a diferença fica registrada nos dois sentidos.

**NF sugerida: 6937 — TRADECONNEX**, 3.000 kg, R$ 28.546,88 (a menor pendente da fila).

1. Abra a NF, escolha produto e estoque destino.
2. Digite **2.940** no peso conferido (60 kg a menos). A tela deve acusar a diferença e **exigir o motivo** — sem ele, o envio é recusado.
3. Informe o motivo e envie.
4. Como gestor, veja a aprovação: ela deve mostrar **na NF 3.000 / conferido 2.940 / diferença −60**.
5. Repita com peso **maior** que o da nota (ex.: 3.060) noutra NF — a importação recusaria; aqui tem de passar, com motivo.

**Confere no banco:**
```sql
SELECT nota_fiscal, quantidade_nf_kg, quantidade_kg, quantidade_divergencia_kg, observacoes
FROM stockbridge.movimentacao WHERE nf_chave_acesso IS NOT NULL AND quantidade_divergencia_kg <> 0;
```
Esperado: `quantidade_kg − quantidade_nf_kg = quantidade_divergencia_kg`, negativo num caso e positivo no outro.

---

## Cenário 3 — Um item da NF vira vários produtos (História 4)

O caso real que motivou a feature: sucata que chega numa linha só e é classificada por grau.

**NF sugerida: 6223 — REPLAS**, "SUCATA PLASTICO", 13.750 kg, R$ 155.375,00.

1. Abra a NF e clique em **"+ Este item vira mais de um produto"**.
2. Distribua o peso entre 2 ou 3 produtos (ex.: 6.000 / 5.000 / 2.750).
3. Tente enviar com a soma **errada** de propósito (ex.: 6.000 + 5.000) — deve recusar dizendo quanto falta.
4. Acerte a soma e envie.

**Confere no banco** — o rateio tem de fechar no valor da nota, não multiplicá-lo:
```sql
SELECT produto_codigo_q2p, quantidade_kg, quantidade_nf_kg, round(custo_unitario_brl::numeric,4) AS rs_kg,
       round((quantidade_kg*custo_unitario_brl)::numeric,2) AS valor
FROM stockbridge.movimentacao WHERE nota_fiscal = '6223' AND ativo;
```
Esperado: uma linha por produto; **Σ valor = 155.375,00** e **Σ quantidade_nf_kg = 13.750**.

---

## Cenário 6 — Idempotência (FR-013) · **instrução corrigida**

> A instrução anterior ("abra uma NF já recebida") estava errada: a fila **só lista NF com item pendente**, então uma NF inteiramente recebida não aparece mesmo — e é esse o comportamento correto. O sumiço da fila já é metade da prova; a outra metade se faz numa NF de vários itens.

**Não há NF multi-item pendente na janela atual** — as duas que sobraram têm um item só. É preciso recuar `STOCKBRIDGE_RECEBIMENTO_NACIONAL_DATA_CORTE` para `2026-07-30` e usar uma destas, ainda não recebidas por nenhuma via:

| NF | Fornecedor | Emissão | Itens pendentes | Valor |
|---|---|---|---|---|
| **17787** | INTERACAO BENEFICIAMENTO | 30/07 | Borras de Polietileno (10 TON) + Tubos de Polietileno (11 TON) | R$ 91.320,00 |
| **37365** | DUTRAFER | 25/06 | BORRA DE PP (5.040 kg) + PROTETOR PEAD (1.720 kg) | R$ 23.316,00 |
| **1389** | ECOPLAST | 31/07 | DESPERDÍCIOS E RESÍDUOS (6 TON) + SUCATA DE PLÁSTICO (3.492 kg) | R$ 5.526,80 |

A **37365 (DUTRAFER)** é a mais indicada: menor volume, os dois itens em KG e descrições bem distintas.

1. Abra a NF e receba **apenas o primeiro item**.
2. Volte à lista: a NF **continua lá**, agora indicando 1 de 2 itens pendentes.
3. Reabra: o item recebido aparece como **"Já recebido"**, sem permitir nova entrada; o outro segue recebível.
4. Receba o segundo. Agora a NF **desaparece** da lista.

Isso prova idempotência **por item** (não por NF) e a fila parcial do FR-030. Devolva a data de corte depois.

**Confere no banco:**
```sql
SELECT nf_item_descricao, produto_codigo_q2p, quantidade_kg
FROM stockbridge.movimentacao WHERE nota_fiscal = '37365' AND ativo;
```
Esperado: uma linha por item, com as descrições distintas.

---

## Cenário 8 — Recebimento externo (História 6)

Prova a válvula para o que entrou no estoque por fora do Atlas — e que ela **não** move estoque.

**NF sugerida: 413054 — VALGROUP**, 12.588,9 kg.

1. Como operador, na NF, use **"Recebido fora do Atlas?"** e informe o motivo (obrigatório).
2. O item deve continuar na fila, marcado **"Baixa solicitada — aguardando o gestor"**.
3. Como gestor, aprove em **Aprovações**. O item sai da fila.
4. Ainda como gestor, em **"Baixas por recebimento fora do Atlas"**, use **Reverter** com motivo. O item volta à fila.

**Confere no banco** — o ponto central é a ausência de movimentação:
```sql
SELECT a.status, a.nota_fiscal, a.nf_item_descricao, a.observacoes, a.rejeicao_motivo
FROM stockbridge.aprovacao a WHERE a.tipo_aprovacao = 'recebimento_externo';

-- tem de voltar VAZIO: baixa externa nunca cria movimentação
SELECT * FROM stockbridge.movimentacao m
WHERE m.nota_fiscal = '413054' AND m.subtipo = 'compra_nacional';
```

---

## Cenário 5 — Unidade bloqueia (História 5) · **exige mexer na data de corte**

Não há nenhum caso na janela atual: todos os 19 itens da fila estão com unidade coerente. Os casos reais são mais antigos, então o teste exige recuar `STOCKBRIDGE_RECEBIMENTO_NACIONAL_DATA_CORTE` no Portainer **temporariamente** — e devolvê-la a `2026-09-11` depois.

**Unidade incoerente** (quantidade em tonelada rotulada como KG) — corte em `2026-08-28`:

- **NF 59311 — Zaraplast**, "MC PEAD GM9450F+ AN": `q_com` 2,750 com `u_com = KG`, R$ 26.125,09 → R$ 9.500/kg lido como KG, R$ 9,50/kg lido como tonelada.
- **NF 59321 — Zaraplast**, mesmo produto, 1,375.

Esperado: item **bloqueado**, com a mensagem mostrando as duas leituras e dizendo que o sistema não escolhe qual está certa. Sem botão de entrada para ele. **O bloqueio é só do item — os demais da mesma NF continuam recebíveis.**

**Unidade não conversível** — corte em `2026-07-23` (a fila vai encher; faça o teste e volte a data):

- **NF 67305 — Ecologika**, "BORRA DE HDPE CINZA", 12.220 com `u_com = UN`.

Esperado: bloqueio por unidade não conversível, encaminhando ao formulário manual.

---

## Ao terminar

- Devolva `STOCKBRIDGE_RECEBIMENTO_NACIONAL_DATA_CORTE` para `2026-09-11` (ou a data do go-live).
- Anote na ACXEGDP-328 o que passou e o que não passou. Com os cinco fechados, a T059 fica completa e a feature pode ser promovida para `main`.


---

## Anexo — a consulta certa para levantar candidatas

A checagem de "já recebida" tem **três** vias (research D21). Levantar candidatas olhando só uma delas produz falsos pendentes:

```sql
-- pendente = NENHUMA das três vias
WHERE NOT (
  -- 1. caminho novo: chave de acesso + descrição normalizada do item
  EXISTS (SELECT 1 FROM stockbridge.movimentacao m WHERE m.ativo AND m.subtipo='compra_nacional'
          AND m.nf_chave_acesso = h.c_chave_nfe AND m.nf_item_descricao_normalizada = <desc_norm>)
  -- 2. histórico do formulário manual: número da NF, sem chave (por NF inteira)
  OR EXISTS (SELECT 1 FROM stockbridge.movimentacao m WHERE m.ativo AND m.subtipo='compra_nacional'
             AND m.nf_chave_acesso IS NULL AND ltrim(m.nota_fiscal,'0') = ltrim(h.n_nf,'0') AND m.empresa='q2p')
  -- 3. baixa por recebimento externo aprovada
  OR EXISTS (SELECT 1 FROM stockbridge.aprovacao a WHERE a.tipo_aprovacao='recebimento_externo'
             AND a.status='aprovada' AND a.nf_chave_acesso = h.c_chave_nfe)
)
```
