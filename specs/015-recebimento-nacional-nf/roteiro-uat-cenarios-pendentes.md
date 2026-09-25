# Roteiro de teste em UAT — os 5 cenários que faltam (ACXEGDP-328)

**Para quem executa o teste em UAT** (operador + gestor). Preparado em 25/09/2026 a partir da fila real de UAT.

O que já foi validado com OMIE real — receber sem digitar, correlação memorizada com reuso, rejeição e re-recebimento — está registrado em `tasks.md` (T059) e não se repete aqui.

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

## Cenário 6 — Idempotência (FR-013)

1. Abra uma NF **já recebida e aprovada** — **36565**, **59697** ou **59704**. O item deve aparecer como **"Já recebido"**, sem permitir nova entrada.
2. A NF não pode estar de volta na lista de notas pendentes.

**Sobre a colisão de número** (duas NFs de fornecedores diferentes com o mesmo número): não é testável em UAT hoje. Os únicos pares no espelho são `5682`, `6936`, `6937` e `5624` — e em todos a contraparte é **PLASTFIX** ou a **ACXE intercompany**, os dois fornecedores excluídos da fila por decisão de escopo. A regra está coberta por teste automatizado (a identidade é a chave de acesso, não o número) e só dá para exercitar na tela quando aparecer um par elegível.

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
