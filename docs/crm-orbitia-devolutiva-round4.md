# CRM OrbitIA — Devolutiva da Validação (Round 4)

**Data:** 13/07/2026
**Referência:** "Relatório de Correções — CRM Q2P (Round 3)" enviado pela OrbitIA
**Contato:** Flavio Endo — flavio.endo@acxe-polimeros.com.br

---

## 1. Contexto

Após o recebimento do relatório de correções, os itens indicados como corrigidos foram percorridos um a um no sistema, em 13/07/2026, incluindo verificação direta no OMIE para os itens que envolvem escrita no ERP. Este documento registra, de forma factual, para cada item: o **critério** descrito no relatório e o **comportamento observado**, com a evidência coletada.

Foram cobertos os 15 itens indicados como corrigidos no relatório, além de 2 funcionalidades novas mencionadas (Central de Logs de Erro, dados de Motivo da Perda).

---

## 2. Resumo

Dos **15 itens** do relatório de correções:

- **10** corresponderam ao critério descrito;
- **5** não corresponderam, ou corresponderam apenas em parte (seção 3).

Das **2 funcionalidades novas** testadas, ambas corresponderam ao descrito (Anexo A).

Além disso, **6 pontos novos** foram observados durante a validação (seção 4).

A lista dos itens que corresponderam ao critério está no Anexo A.

---

## 3. Itens que não corresponderam ao critério, ou corresponderam em parte (5)

### 3.1. Escrita para o OMIE

---

**F49 — Cadastro de Cliente → OMIE**

- **Critério (item 2.4):** Estado e Cidade passam a ser campos independentes; Cidade passa a ser obrigatória.
- **Observado:** testados 6 clientes de teste, com diferentes combinações de CNPJ, endereço e e-mails. Nas 6 tentativas, o cliente resultante não ficou disponível em nenhuma tela do CRM (Carteira, seletor de Novo Pedido) nem em consulta direta por ID, independentemente do motivo de validação retornado a cada tentativa (endereço incompleto, CNPJ inválido, e-mail obrigatório).
- Em uma das tentativas, com Estado, Cidade, CNPJ válido e e-mails comercial e fiscal preenchidos (confirmados no corpo da requisição enviada pelo CRM), a resposta do sistema para `POST /api/clientes/` (HTTP 201) e para `POST .../contatos/` (HTTP 201) incluiu um campo adicional, `omie_aviso`, com o texto "ERROR: É obrigatório o preenchimento do e-mail.". Uma consulta subsequente ao registro pelo ID retornado na mesma resposta ("GET /api/clientes/{id}/") teve como resultado "No Cliente matches the given query.". Não foi observada uma segunda chamada de rede entre a resposta inicial e essa consulta.

---

**F38 — Pedido (fluxo do vendedor) → OMIE**

- **Critério:** badge "⚠ Falha OMIE" persistente na listagem de pedidos, sinalizando falhas de sincronização.
- **Observado:** ao aprovar um pedido de teste, o sistema exibiu a mensagem "Falha no envio ao OMIE: ERROR: O preenchimento da tag [codigo_categoria] é obrigatório!" — mesma mensagem já relatada no Round 3. Em Gestão → Pedidos, a coluna "OMIE" do pedido exibiu o badge "⚠ Falha OMIE". A coluna "Status", posicionada à esquerda da coluna OMIE, exibiu "Aprovado", sem nenhuma indicação de falha de sincronização.
- Nota: a resposta sobre a fonte do `codigo_categoria` (constante, `1.01.03`) foi enviada separadamente antes deste teste.

---

**F53 — Numeração do pedido no OMIE**

- **Critério:** o número/badge do OMIE só aparece nos status corretos, sem número exibido para pedido que falhou ao sincronizar.
- **Observado:** em pedidos com falha de sincronização, a coluna "OMIE" exibiu o badge de falha ou um traço ("—"), sem nenhum número. Em pedidos com status "Faturado", a coluna exibiu um número (ex.: 8482982603). Ao consultar a origem desse número, ele corresponde ao identificador interno do registro no OMIE (`codigo_pedido`), e não ao número de pedido (`numero_pedido`) exibido nas telas do próprio OMIE — para o mesmo registro, os dois valores são diferentes (ex.: `codigo_pedido` 8482982603 corresponde a `numero_pedido` 18514).

### 3.2. Demais itens

---

**F50 — Meta Global zerada**

- **Critério:** ao zerar a Meta Global após defini-la, o sistema exibe mensagem indicando a ausência de meta global definida.
- **Observado:** ao zerar a Meta Global, a mensagem "cobertura: Infinity%" não aparece mais. A linha "Σ metas individuais deste mês" passou a ser exibida sem nenhum percentual ao lado, e sem texto explicando a ausência de meta global.

---

**F51 — Duplicação de metas do mês anterior**

- **Critério:** a ação de duplicar pede confirmação antes de sobrescrever, e a sobrescrita se limita às metas destravadas.
- **Observado:** ao acionar "Duplicar metas de junho de 2026", uma confirmação nativa do navegador é exibida antes de qualquer ação. Nas duas vezes em que a confirmação foi aceita, os valores das metas individuais permaneceram os mesmos antes e depois da ação, e não foi observada uma chamada de rede correspondente a um endpoint de duplicação.

---

## 4. Pontos novos observados (6)

Itens identificados durante a validação, adicionais aos 15 do relatório de correções.

| Código | Área | Descrição |
|---|---|---|
| F58 | Pedidos | Em um pedido com falha de sincronização, a coluna "Status" exibe "Aprovado", sem indicação de falha. A informação de falha aparece apenas na coluna "OMIE", separada. |
| F59 | Comissão | Na linha de família cuja "Comissão Base" já reflete o valor calculado (R$129), a coluna "% Comis." permanece em 0,00%. |
| F60 | Comissão | A linha "Totais" da tabela de comissão e o indicador "Comissão Base" no topo da página exibem R$0, mesmo com uma família contribuindo R$129 individualmente. O indicador no topo inclui o texto "Sempre paga · independe de metas". |
| F61 | Ajuste de Preço | Em uma sugestão gerada, os valores calculados via API (preço base R$15,0300/kg, ajuste R$0,5000/kg, novo preço R$14,5300/kg) aparecem na tela arredondados para número inteiro de reais ("Ajuste Sugerido +R$1/kg", "Novo Preço R$15/kg"). |
| F62 | Ajuste de Preço | Na mesma sugestão: o novo preço calculado via API (R$14,53/kg) é menor que o preço base (R$15,03/kg). Na tela, o ajuste é exibido como "+R$1/kg" (sinal de aumento). |
| F63 | Central de Logs de Erro | Na aba "Sincronização", constam registros datados de 11/07/2026, 09:57–10:17, origem `sync_daemon`/`Produtos`, com a mensagem `'SourceProduto' object has no attribute 'codigo_categoria'`, repetida em múltiplas entradas. |

---

## 5. Itens que dependem de dados a serem fornecidos pela ACXE

Seguem pendentes, não fazem parte deste round: **F47** (duplicação de metas contra um mês de destino vazio) e **F27b** (relatório de referência para reconciliação do total de estoque).

---

## Anexo A — Itens que corresponderam ao critério

Dos 15 itens do relatório: **F46** (pedido criado com a origem "Pedido da Gestão", sem o erro de perfil de vendedor relatado no Round 3 — a sincronização subsequente com o OMIE apresentou o mesmo comportamento relatado no F38, não específico desta origem), **F31** (valor de "Comissão Base" da família corrigido, conforme item 4 quanto ao percentual e ao total agregado), **F26**, **F25**, **F15**, **F52**, **F54**, **F55**, **F56**, **F57** (não reproduzido, com timestamp e evidência em 4 telas distintas).

Das 2 funcionalidades novas: **Central de Logs de Erro** (categorias e registros conforme descrito — ver item 4 quanto a um registro específico) e **dados de Motivo da Perda / mecanismo de sugestões de Ajuste de Preço** (sugestões passam a ser geradas quando há registros de perda — ver item 4 quanto à exibição dos valores).

---

*Documento gerado em 13/07/2026.*
