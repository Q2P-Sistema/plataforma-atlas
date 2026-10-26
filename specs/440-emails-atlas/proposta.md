# ACXEGDP-440: e-mails do Atlas no padrão da ACXEGDP-436 (proposta)

Proposta de 25/10/2026 para decisão do usuário. **Nada foi alterado no código.** O padrão é o mesmo dos e-mails do n8n (ACXEGDP-436): assunto `[ETIQUETA] - Tema - Situação - Identificador`, quem age em Para e quem acompanha em Cc, corpo gerado por uma função comum com o visual e as cores da `emailQ2P`.

## 1. Inventário

O Atlas monta **22 tipos de e-mail**: 21 do StockBridge, todos em `modules/stockbridge/src/services/notificacao.service.ts`, e a recuperação de senha em `packages/core/src/email.ts`. O E12 (fiscal desfeito no OMIE, D21 da 437) ainda não está publicado. O `test-email.ts` (teste do SendGrid) fica fora.

Volume: eventos de PROD nos 30 dias até 25/10/2026, contados no banco. Os alertas que vão para a caixa de operação não deixam registro no banco (só no log): aparecem como "sem registro".

| ID | E-mail | Gatilho | Para / Cc hoje | 30 dias |
|---|---|---|---|---|
| E01 | Produto sem correlato na Q2P | Recebimento de importação, produto da ACXE sem par na Q2P | Ops / admin* | sem registro |
| E02 | NF recebida sem validação completa | Recebimento liberado sem conseguir ler cancelamento ou emitente no OMIE | Ops / admin* | sem registro |
| E03 | Débito cruzado | Saída automática faturada por uma empresa com estoque na outra | Ops / admin* | 0 |
| E04 | Aprovação pendente (1 item) | Saída manual, retorno de comodato, divergência de 1 item | Cada gestor (1 e-mail cada) | 1 |
| E05 | Recebimento nacional aguardando aprovação | Recebimento nacional por NF ou baixa externa | Cada gestor | 48 |
| E06 | NF dispensada da fila | Gestor dispensa NF nacional | Cada fiscal | 10 NFs × 4 destinatários |
| E07 | Aviso a compras (3 motivos) | NF sem PC, PC aguardando aprovação, recebida sem vínculo | Cada endereço de compras (vazio = ops) | 1 aviso × 2 destinatários |
| E08 | Entrada rejeitada com PC baixado acima da nota | Rejeição do gestor depois da baixa pelo peso conferido | Compras | 0 (chave desligada) |
| E09 | Espelho de recebimentos parado | Cron `5,35`, reaviso a cada 6 h | Ops | sem registro |
| E10 | Cópia de pedidos de compra parada | Cron `5,35`, reaviso próprio | Ops | sem registro |
| E11 | Dispensa desfeita | Gestor desfaz a dispensa | Cada fiscal | 1 NF × 4 destinatários |
| E12 | Recebimento fiscal desfeito no OMIE | Cron `5,35`, entrada física já lançada (D21) | Cada fiscal | novo |
| E13 | Divergências de importação (2+ itens) | Recebimento de importação multi-item | Cada gestor | 0 |
| E14 | Pendência OMIE | Ajuste na ACXE feito e na Q2P não (ou o inverso) | Ops / admin* | 0 |
| E15 | Baixa do pedido Q2P (falha ou sem saldo) | Depois do recebimento de importação | Ops / admin* | 0 |
| E16 | NFs sem vínculo com pedido na FUP | Cron horário, NF parada há mais de 3 dias | Ops / admin* | 0 |
| E17 | Lançamento rejeitado | Gestor rejeita (NF, manual ou saída) | Quem lançou / `STOCKBRIDGE_ADMIN_CC_EMAIL` | 2 |
| E18 | Lançamento aprovado | Gestor aprova | Quem lançou / admin, mais Comex na divergência aprovada | 57 |
| E19 | Recebimento concluído (1 produto) | Recebimento de importação sem divergência | Quem lançou e Comex (1 e-mail cada) | 25 NFs, 50 e-mails no total com o E20 |
| E20 | Recebimento concluído (2+ produtos) | Idem, NF multi-item | Quem lançou e Comex | (no E19) |
| E21 | Comodatos vencidos (resumo por pessoa) | Cron diário, D+1 e a cada 15 dias; diretoria a partir de 15 dias | Quem lançou, gestores, diretores (1 e-mail cada) | 0 (nenhum aberto) |
| E22 | Recuperação de senha | Usuário pede na tela de login | O usuário | sem registro |

\* "Ops" é `STOCKBRIDGE_OPS_EMAIL`. "admin" é `SEED_ADMIN_EMAIL`, em Cc só quando é diferente da caixa ops.

**Quem é quem em PROD** (valores informados pelo usuário em 25/10/2026). `STOCKBRIDGE_OPS_EMAIL` e `STOCKBRIDGE_COMEX_EMAIL` não foram informados e valem os padrões do código, porque variável vazia conta como ausente. Todos os endereços são @acxe-polimeros.com.br, exceto o remetente.

| Papel | Variável | Em PROD |
|---|---|---|
| Caixa ops (alertas) | `STOCKBRIDGE_OPS_EMAIL` | flavio.endo (padrão) |
| Admin em cópia dos alertas | `SEED_ADMIN_EMAIL` | flavio.endo, igual à caixa ops: a cópia não sai |
| Admin em cópia dos e-mails ao operador | `STOCKBRIDGE_ADMIN_CC_EMAIL` | flavio.endo |
| Fiscal | `STOCKBRIDGE_FISCAL_EMAILS` | nfe, mauricio, gustavo.dreer, flavio.endo (um e-mail para cada) |
| Compras | `STOCKBRIDGE_COMPRAS_EMAILS` | gustavo.dreer, flavio.endo (um e-mail para cada) |
| Comex | `STOCKBRIDGE_COMEX_EMAIL` | comex_acxe (padrão) |
| Gestores do StockBridge | usuários ativos com o módulo | gustavo.dreer (único) |
| Remetente | `SENDGRID_FROM_EMAIL` | sistema@q2p.com.br, o mesmo do n8n |

Só gustavo.dreer e flavio.endo têm usuário no Atlas. nfe, mauricio e comex_acxe não têm.

Total: cerca de 200 e-mails por mês. A maior parte vai para o Gustavo Dreer, que é o único gestor, lança e aprova as entradas e está nas listas do fiscal e de compras, e para a Comex.

## 2. O que encontrei

O visual já segue o padrão de julho (ACXEGDP-294: 700 px, faixa colorida, botão azul). O texto e a estrutura não seguem o padrão novo:

| Ponto | Como está hoje |
|---|---|
| Assunto | Os 22 começam com "StockBridge —" (a senha, com "Atlas —"), sem etiqueta. A NF aparece como "NF 6842" ou "(NF 6842)", e o fornecedor entre parênteses em 7 deles. |
| Cores | Quatro (verde "sucesso", vermelho "erro", âmbar, cinza) em vez das duas da etiqueta. Cabeçalho fixo "Atlas · StockBridge", inclusive na recuperação de senha, que não é do StockBridge. |
| Bloco de ação | Seis nomes: "Ação necessária", "O que fazer", "O que verificar", "Pendência no OMIE", "Atenção", "Escalado — atraso acima de 15 dias". Sem "Quem age" em nenhum. Em E04, E05, E13 e E17 alguém precisa agir e não há bloco de ação. |
| Rodapé e remetente | Rodapé "E-mail automático gerado pela Plataforma Atlas · ACXE + Q2P" e remetente "Plataforma Atlas". O n8n usa "Sistema Integrador Q2P" nos dois. |
| Termos internos para quem não é o Gestor SI | "correlato", "espelho do OMIE", "Varredura", "lado pendente: OMIE Q2P", "gestor/diretor", "NF(s) recebida(s)", "dia(s)". Ids internos no rodapé do e-mail do operador ("Aprovação: 1a2b…" em uuid). Caixa alta para ênfase no aviso ao fiscal ("NÃO tinha sido concluído", "JÁ foi concluído"). |
| Datas | Dispensa e dispensa desfeita saem como "25/10/2026, 17:13:22" (com segundos e vírgula). Só o E12 usa "às 17:13". O fuso já é o de Brasília em todos. |
| Botões | Botão para telas do Atlas nos e-mails ao fiscal (E06, E11) e a compras (E07, E08), que agem no OMIE. |
| Cópia oculta | O envio do Atlas não tem Cco. Toda cópia é visível. |
| Repetição | O Gustavo lançou 54 das 59 entradas e aprova as próprias: recebe "aguardando aprovação" e "aprovado" da mesma NF, cerca de 100 e-mails por mês. |
| Destino trocado | O E16 diz "basta preencher as NFs filhotes na FUP", que é trabalho da Comex, mas vai só para a caixa ops. O CLAUDE.md descreve esse e-mail como "digest à Comex". |

## 3. Decisões que dependem de você

Cada item traz a recomendação. Responda só o que for diferente dela.

Situação em 25/10/2026: a 3 foi respondida. A 6 teve a recomendação revista com os valores de PROD e aguarda confirmação. Nas outras não houve objeção, e vale a recomendação.

1. **Rodapé.** Igual ao do n8n: "Mensagem automática do Sistema Integrador Q2P. Dúvidas: fale com o Gestor do Sistema Integrador." A alternativa é citar o Atlas ("Mensagem automática da Plataforma Atlas (Sistema Integrador Q2P)..."). O corpo continua citando o Atlas onde manda abrir uma tela dele. *Recomendação: igual ao n8n.*
2. **Remetente.** Hoje "Plataforma Atlas" &lt;sistema@q2p.com.br&gt;. Passar para "Sistema Integrador Q2P", com o mesmo endereço, como no n8n. Alguém tem regra de caixa de entrada pelo nome "Plataforma Atlas"? *Recomendação: alinhar ao n8n.*
3. **Gestor do Sistema Integrador no Atlas.** O mesmo da 436 (flavio.endo@acxe-polimeros.com.br). Os 9 e-mails para a caixa ops (E01, E02, E03, E09, E10, E14, E15, E16, e E07 quando compras está vazio) passam a ser e-mails do Gestor SI, com "Detalhes técnicos". **Respondida em 25/10/2026:** os valores estão no quadro "Quem é quem em PROD" da seção 1. O Gestor SI já está nas listas do fiscal e de compras. Como o Atlas manda um e-mail separado para cada endereço, ninguém vê essa cópia, que na prática já é um Cco. Nada muda aí.
4. **Cópia fixa do administrador vai para Cco.** `STOCKBRIDGE_ADMIN_CC_EMAIL` nos e-mails ao operador (E17, E18) e `SEED_ADMIN_EMAIL` nos alertas (quando difere da caixa ops). A Comex continua em Cc visível no E18 da divergência aprovada. Para isso o envio do Atlas ganha Cco, sem endereço repetido entre Para, Cc e Cco (o SendGrid recusa). *Recomendação: aprovar (regra da 436).*
5. **Fornecedor no assunto.** Só nos e-mails ao fiscal e a compras (E06, E07, E08, E11, E12): o número da NF se repete entre fornecedores, e eles procuram a nota no OMIE pelo fornecedor. Até 25 caracteres, cortado em fim de palavra (`clienteAssunto` da 436). Esses assuntos passam de 76 caracteres, como A08, A15 e A16. Sai do assunto do E17 e do E18 (quem lançou já sabe; o fornecedor fica no corpo). *Recomendação: aprovar.*
6. **Botão nos e-mails ao fiscal e a compras.** Revista com os valores de PROD. Compras são o Gustavo e o Gestor SI, que usam o Atlas: o E07 e o E08 mantêm o botão para a fila. O fiscal age no OMIE, e nfe e mauricio não têm usuário no Atlas: o E06 e o E11 saem sem botão, como o E12. *Recomendação revista: botão só no E07 e no E08.*
7. **E16 (NFs sem vínculo na FUP).** Para Comex, com o Gestor SI em Cco, porque é a Comex que preenche a FUP. A alternativa é manter só com o Gestor SI. Volume zero nos últimos 30 dias. *Recomendação: Para Comex, Cco Gestor SI.*
8. **E-mails para quem aprovou o próprio lançamento** (cerca de 100 por mês ao Gustavo). Nesta tarefa, só padronizar. Cortar o "aprovado" quando quem lançou é quem aprovou muda a lógica e fica como proposta à parte. *Recomendação: só padronizar.*

## 4. Quadro por e-mail

Exemplos com NF 6842, lote L216 e fornecedor FORNECEDOR EXEMPLO LTDA. Os tamanhos estão entre parênteses. "GSI" é o Gestor do Sistema Integrador.

| ID | Assunto hoje | Assunto proposto | Para / Cc / Cco proposto | Quem age |
|---|---|---|---|---|
| E01 | StockBridge — Produto sem correlato Q2P (NF 6842) | [AÇÃO REQUERIDA] - Recebimento - Produto não cadastrado na Q2P - NF 6842 (72) | GSI / — / admin* | GSI |
| E02 | StockBridge — NF 6842 recebida com dado indeterminado (Q2P) | [AÇÃO REQUERIDA] - Recebimento - Conferir a nota no OMIE - NF 6842 (66) | GSI / — / admin* | GSI |
| E03 | StockBridge — Débito cruzado (NF 6842) | [AÇÃO REQUERIDA] - Estoque - Débito cruzado - NF 6842 (53) | GSI / — / admin* | GSI (pede a NF de transferência à contabilidade) |
| E04 | StockBridge — Aprovação pendente (Gestor) — Descarte/Perda | [AÇÃO REQUERIDA] - Aprovação - Descarte/Perda - Galpão 11.1 (59). Divergência: "... - Recebimento com divergência - Lote L216" (70) | Cada gestor (ou diretor) | Gestor |
| E05 | StockBridge — Recebimento nacional NF 6842: 2 itens aguardando aprovação | [AÇÃO REQUERIDA] - Aprovação - Recebimento nacional - NF 6842 (61) | Cada gestor | Gestor |
| E13 | StockBridge — Recebimento NF 6842: 2 itens com divergência aguardando aprovação | [AÇÃO REQUERIDA] - Aprovação - Divergência no recebimento - NF 6842 (67) | Cada gestor | Gestor |
| E06 | StockBridge — NF 6842 (FORNECEDOR) dispensada da fila | [AÇÃO REQUERIDA] - Fiscal - NF dispensada da fila - FORNECEDOR EXEMPLO LTDA - NF 6842 (85) | Cada fiscal | Fiscal |
| E11 | StockBridge — Dispensa desfeita: NF 6842 (FORNECEDOR) voltou à fila | [INFORMATIVO] - Fiscal - Dispensa desfeita - FORNECEDOR EXEMPLO LTDA - NF 6842 (78) | Cada fiscal | ninguém ("se você já agiu no OMIE por causa da dispensa, avise o gestor") |
| E12 | Recebimento fiscal desfeito no OMIE da ACXE — NF 19252 (FORNECEDOR) | [AÇÃO REQUERIDA] - Fiscal - Recebimento desfeito no OMIE - FORNECEDOR EXEMPLO LTDA - NF ACXE 19252 (98) | Cada fiscal | Fiscal |
| E07 | StockBridge — NF 6842 de FORNECEDOR sem pedido de compra no OMIE | [AÇÃO REQUERIDA] - Compras - NF sem pedido de compra - FORNECEDOR... - NF 6842 (88). Outros motivos: "Pedido aguardando aprovação" (92), "Recebida sem pedido de compra" (94) | Cada endereço de compras (vazio = GSI) | Compras |
| E08 | StockBridge — NF 6842 de FORNECEDOR: entrada rejeitada com o pedido baixado acima da nota | [AÇÃO REQUERIDA] - Compras - Pedido baixado acima da nota - FORNECEDOR... - NF 6842 (93) | Compras | Compras |
| E09 | StockBridge — Espelho de recebimentos de NF-e da ACXE sem atualização | [AÇÃO REQUERIDA] - Infra - Espelho de recebimentos parado - ACXE (64) | GSI | GSI |
| E10 | StockBridge — Cópia de pedidos de compra da ACXE sem atualização | [AÇÃO REQUERIDA] - Infra - Cópia de pedidos de compra parada - ACXE (67) | GSI | GSI |
| E14 | StockBridge — Pendência OMIE (NF 6842) | [AÇÃO REQUERIDA] - Recebimento - Lançamento no OMIE pendente - NF 6842 (70) | GSI / — / admin* | GSI |
| E15 | StockBridge — Baixa de pedido Q2P falhou (NF 6842) / Recebimento sem pedido Q2P suficiente | [AÇÃO REQUERIDA] - Pedido de compra Q2P - Baixa não feita - NF 6842 (67) / "... - Saldo insuficiente - NF 6842" (70) | GSI / — / admin* | GSI |
| E16 | StockBridge — 12 NF(s) recebida(s) sem vínculo com pedido na FUP | [AÇÃO REQUERIDA] - Pedido de compra Q2P - NF sem vínculo na FUP - 12 NFs (72) | Decisão 7 | Comex |
| E17 | StockBridge — Recebimento rejeitado — NF 6842 (FORNECEDOR) | [AÇÃO REQUERIDA] - Recebimento - Rejeitado, corrigir e reenviar - NF 6842 (73). Sem NF: "[AÇÃO REQUERIDA] - Lançamento - Rejeitado - {tipo}" | Quem lançou / — / admin | Quem lançou |
| E18 | StockBridge — Recebimento aprovado — NF 6842 (FORNECEDOR) | [INFORMATIVO] - Recebimento - Aprovado - NF 6842 (48). Sem NF: "[INFORMATIVO] - Lançamento - Aprovado - {tipo}" | Quem lançou / Comex (divergência) / admin | ninguém |
| E19, E20 | StockBridge — Recebimento concluído (NF 6842[, 2 produtos]) | [INFORMATIVO] - Recebimento - Concluído - NF 6842 (49) | Quem lançou e Comex, 1 e-mail cada (como hoje) | ninguém |
| E21 | StockBridge — [Escalado] 3 comodatos vencidos aguardando retorno | [AÇÃO REQUERIDA] - Comodato - Retorno vencido - 3 comodatos (59). Escalado: "... - Vencido há mais de 15 dias - 3 comodatos" (70) | Como hoje, 1 e-mail por pessoa | Quem lançou e gestor |
| E22 | Atlas — Recuperação de senha | [AÇÃO REQUERIDA] - Acesso - Redefinir a senha - Atlas (53) | O usuário | O usuário (link vale 1 hora) |

\* Some quando é o mesmo endereço do Para.

NF da ACXE leva a empresa no identificador ("NF ACXE 19252"), onde o assunto atual já diz "da ACXE". NF da Q2P fica "NF 6842", sem zeros à esquerda.

## 5. O que não muda

- Quando cada e-mail dispara e para quem vai, salvo as decisões 4 e 7.
- Um e-mail por destinatário onde já é assim (gestores, fiscal, compras, comodato, recebimento concluído).
- A deduplicação do aviso a compras (24 h por NF, motivo e destinatário), o reaviso de 6 h dos alertas de infra, o limite de envios simultâneos e o tempo máximo de 20 s no SendGrid.
- O desvio do UAT (faixa amarela "E-mail de teste" e assunto com `[UAT]`) e a versão em texto puro, que o n8n não tem e melhora a entrega.

## 6. Como será aplicado, depois do seu OK

1. **Ordem.** O E12 e outros trechos do mesmo arquivo estão na branch da D21 (437), ainda sem commit. A 440 roda na branch `feat/440-emails-atlas`, criada a partir da `main`. O gerador comum, o Cco, o remetente e o E22 foram adiantados em 25/10/2026, com o OK do usuário, porque não tocam nos arquivos da D21. A reescrita dos e-mails do StockBridge espera o merge da D21, para não haver conflito no `notificacao.service.ts`.
2. **Gerador comum.** Uma função em `@atlas/core` (no lugar de `buildEmailLayout`, `emailDataList` e `emailActionBox`), com a mesma estrutura, as mesmas cores e a mesma API da `emailQ2P` (etiqueta, assunto, título, subtítulo, resumo, ação, sem ação, cópia, dados, seções, botão, técnico, referência, dúvidas). Ela gera também o texto puro. Campo ausente vira "—" ou some. Nunca sai "undefined", "null", "NaN" nem "[object".
3. **Reescrita** dos 22 e-mails, só o conteúdo. Cco no `sendEmail`, com o desvio do UAT dizendo também para quem iria em Cco.
4. **Testes.** Código antigo × novo nas mesmas entradas: tudo fora do HTML igual, e o assunto e os destinatários mudando só no aprovado. Matriz de conteúdo por e-mail (cada informação fica, muda de lugar ou sai com motivo). Entradas difíceis (vazio, nulo, aspas e HTML, 400 caracteres, acentos). `lint_corpo.py` com zero ERRO (`--gestor` só nos e-mails do GSI). Dados fictícios. Nenhum envio real.
5. **Revisão independente** por até 2 agentes ao mesmo tempo.
6. **Caderno PDF antes × depois** (assunto, Para/Cc/Cco e a imagem de cada e-mail) para o seu OK.
7. **Deploy** só com o seu OK. Commit, push e PR só pedindo antes. Depois, o Jira e os manuais que citem esses e-mails.
