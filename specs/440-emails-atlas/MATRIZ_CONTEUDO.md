# ACXEGDP-440: matriz de conteúdo (antes × depois)

Para cada e-mail: o que o corpo antigo dizia e onde isso foi parar no novo. Cada item foi mantido, movido, reescrito ou retirado, com o motivo. Nunca saem: o que o leitor precisa para agir, o prazo, a consequência e quem age.

## E22. Recuperação de senha (`packages/core/src/email.ts`, `buildPasswordResetEmail`)

| Item do e-mail antigo | Destino no novo | Situação e motivo |
|---|---|---|
| Assunto "Atlas — Recuperação de senha" | "[AÇÃO REQUERIDA] - Acesso - Redefinir a senha - Atlas" | Reescrito (padrão aprovado na proposta, seção 4) |
| Remetente "Plataforma Atlas" | "Sistema Integrador Q2P" (mesmo endereço) | Reescrito (decisão 2) |
| Cabeçalho "Atlas · StockBridge" | Faixa com a etiqueta e o título | Retirado: o e-mail não é do StockBridge, e a faixa já diz o que é |
| Título "Recuperação de senha" | Título "Redefinição de senha do Atlas" | Reescrito, com o mesmo verbo do botão e do assunto |
| "Você solicitou a recuperação de senha da Plataforma Atlas." | Resumo: "Foi pedida a redefinição da senha do seu usuário no Atlas." | Reescrito: qualquer pessoa pode pedir a troca para um e-mail, então o texto não afirma que foi o leitor |
| "Clique no botão abaixo para definir uma nova senha:" | O que fazer, passo 1: "Clique em **Redefinir senha** e escolha a nova senha." | Movido para a caixa de ação |
| "Este link expira em 1 hora." | Nota do botão: "O link vale por 1 hora e só pode ser usado uma vez." | Movido. "Uso único" foi acrescentado porque o token é apagado na troca (`auth.routes.ts`, reset-password) |
| "Se você não solicitou a recuperação, ignore este e-mail." | Nota da ação: "Se você não pediu a troca, ignore este e-mail: a senha atual continua valendo." | Movido; diz também a consequência |
| Botão "Redefinir senha" | Botão "Redefinir senha" | Mantido |
| Rodapé "E-mail automático gerado pela Plataforma Atlas · ACXE + Q2P" | "Mensagem automática do Sistema Integrador Q2P. Dúvidas: fale com o Gestor do Sistema Integrador." | Reescrito (decisão 1) |

Destinatário: o usuário que pediu a troca, como antes. Lint (`lint_corpo.py`): 0 ERRO e 0 AVISO; o antigo dava 3 ERRO.

## Regras comuns aos 21 e-mails do StockBridge

Vale para todos e não se repete abaixo:

| Item | Antes | Depois |
|---|---|---|
| Assunto | "StockBridge — ..." | Padrão `[ETIQUETA] - Tema - Situação - Identificador`; NF sem zeros à esquerda; "NF ACXE N" quando a nota é da ACXE |
| Remetente | "Plataforma Atlas" | "Sistema Integrador Q2P", mesmo endereço (decisão 2) |
| Cabeçalho | "Atlas · StockBridge", cor por variante (4 cores) | Faixa com a etiqueta, o título e o subtítulo, só 2 cores |
| Bloco de ação | Seis nomes ("Ação necessária", "O que verificar", "Pendência no OMIE"...) e às vezes ausente | "O que fazer" com "Quem age" em todo [AÇÃO REQUERIDA]; faixa cinza "Nenhuma ação necessária" nos [INFORMATIVO] |
| Datas | "26/10/2026, 10:00:00" (dispensa) | "26/10/2026 às 10:00", sempre no horário de Brasília |
| Rodapé | "E-mail automático gerado pela Plataforma Atlas · ACXE + Q2P" | "Mensagem automática do Sistema Integrador Q2P. Dúvidas: fale com o Gestor do Sistema Integrador." (decisão 1); sem "Dúvidas" nos e-mails do Gestor SI |
| Cópia ao admin | Cc visível | Cco (decisão 4); some quando é o mesmo endereço do Para |
| NF e fornecedor nos dados | Linhas "NF" e "Fornecedor" | Vão para o subtítulo ("NF 90601 · FORNECEDOR"); a tabela de dados só traz o resto |

## E01. Produto sem correlato na Q2P (`enviarAlertaProdutoSemCorrelato`)

| Item antigo | Destino | Situação e motivo |
|---|---|---|
| "o produto abaixo não possui correlato cadastrado na Q2P (correspondência por descrição textual)" | Resumo: "O recebimento da NF está bloqueado: não há na Q2P um produto com a mesma descrição deste produto da ACXE." | Reescrito sem "correlato"; acrescenta a consequência (bloqueado), que é a do código |
| Produto (descrição ACXE), NF | Subtítulo | Movido |
| 3 passos (cadastrar com a descrição exata; aguardar a sincronização do n8n; tentar de novo) | O que fazer, 3 passos, Quem age: Gestor SI | Mantido, no imperativo |
| "Ref. técnica — código OMIE ACXE" | Detalhes técnicos (suporte) | Movido; e-mail do Gestor SI (ACXEGDP-313: código só em rodapé técnico) |
| Botão "Abrir fila de recebimento" | "Abrir a fila de recebimento" | Mantido |

## E02. NF recebida sem validação completa (`enviarAlertaNfIndeterminada`)

| Item antigo | Destino | Situação e motivo |
|---|---|---|
| "foi liberado, mas o sistema não conseguiu determinar com segurança um dos sinais da NF no OMIE" | Resumo: "... o Atlas não conseguiu confirmar no OMIE se a nota está cancelada ou se foi emitida pela empresa certa." | Reescrito: diz quais são os "sinais" |
| Empresa "(ACXE)" no assunto e no corpo | Assunto "NF ACXE N"; subtítulo "NF N · ACXE"; passo "no OMIE da ACXE" | Movido |
| Motivo | Dados | Mantido |
| 2 passos (conferir no OMIE; estornar) | O que fazer, Quem age: Gestor SI; "estorne em Movimentações" | Mantido, com a tela onde se estorna |
| Botão "Abrir movimentações" | "Abrir Movimentações" | Mantido |

## E03. Débito cruzado (`enviarAlertaDebitoCruzado`)

| Item antigo | Destino | Situação e motivo |
|---|---|---|
| "gerou divergência cruzada entre o CNPJ emissor e o CNPJ onde está o estoque físico" + linhas Emissor/Físico | Resumo: "A NF de saída foi faturada pela Q2P, mas o estoque físico estava na ACXE." | Reescrito; as duas linhas viraram a frase |
| Quantidade | Subtítulo | Movido |
| "O setor contábil deve emitir a NF de transferência FÍSICO → EMISSOR" | Passo: "Peça ao setor contábil a NF de transferência da ACXE para a Q2P..." (Quem age: Gestor SI, que recebe o e-mail) | Reescrito para quem recebe |
| "A divergência será fechada automaticamente quando a NF de regularização for processada." | Nota da ação | Mantido |
| Botão "Abrir pendências fiscais" | Mantido | — |

## E04. Aprovação pendente de 1 item (`enviarAlertaAprovacaoPendente`)

| Item antigo | Destino | Situação e motivo |
|---|---|---|
| Assunto "Aprovação pendente (Gestor) — tipo" | "[AÇÃO REQUERIDA] - Aprovação - tipo - identificador" | O nível vai no corpo: "(nível diretor)" |
| "Uma nova pendência aguarda sua aprovação" | Resumo com o tipo | Reescrito |
| Tipo; "Item: lote — produto"; Quantidade | Título (tipo) e subtítulo ("Lote L900 · produto · 24.975 kg") | Movido |
| Detalhes (montados por quem chama) | Dados "Detalhes" | Mantido; os chamadores deixaram de mandar o subtipo cru, "[DIVERGENTE]" e "Re-submetida pelo operador" |
| Sem bloco de ação | O que fazer: abrir Aprovações, aprovar ou rejeitar com o motivo; Quem age: Gestor ou Diretor | Acrescentado: o e-mail pede ação |
| Botão "Abrir aprovações pendentes" | Mantido | — |
| Retorno de comodato: "Retorno comodato <id>" | O cliente do comodato (ou "Comodato de dd/mm/aaaa" sem cliente) | Reescrito: o id interno não diz nada ao gestor |

## E05. Recebimento nacional aguardando aprovação (`enviarAlertaRecebimentoNacionalLote`)

| Item antigo | Destino | Situação e motivo |
|---|---|---|
| "N itens aguardando aprovação" no assunto | Subtítulo "NF N · 2 itens" | Movido (o assunto segue o quadro) |
| Tabela Produto · "Empresa · Galpão" · Quantidade | Tabela Produto · Empresa · Local · Quantidade | Mantido, com a empresa e o local em colunas próprias |
| Detalhes | Dados "Detalhes" | Mantido |
| Sem bloco de ação | O que fazer (Gestor) | Acrescentado |

## E06. NF dispensada da fila (`enviarAlertaNfDispensada`)

| Item antigo | Destino | Situação e motivo |
|---|---|---|
| "ela não será recebida no estoque pelo Atlas" | Resumo: "o estoque dela não vai entrar pelo Atlas, e nada mudou no OMIE" | Mantido, junto com "A dispensa não alterou nada no OMIE" |
| Valor da nota | Subtítulo | Movido |
| "Recebimento fiscal no OMIE: Pendente / Concluído" | 2ª frase do resumo | Movido |
| Pendente: "ainda NÃO tinha sido concluído ... etapa 'Faturado pelo fornecedor' ... aguardando manifestação ou cancelamento, sem conta a pagar" | Resumo + passos ("Confira a nota no OMIE"; "Dê o destino dela: manifestação, recusa ou cancelamento") | Reescrito sem caixa alta |
| "Pelo espelho do OMIE no momento da dispensa ... Confira no OMIE antes de agir." | Passo "Confira a nota no OMIE" + nota "A situação acima é a que o Atlas tinha na hora da dispensa e pode ter mudado." | Reescrito sem "espelho" e sem prometer atraso de minutos |
| Concluído: "JÁ foi concluído ... conta a pagar de R$ N a estornar ou manter" | Resumo + passo "Estorne ou mantenha a conta a pagar no OMIE" | Reescrito sem caixa alta |
| "cancelar, recusar, devolver ou estornar a nota continua com o fiscal" | "Quem age: Fiscal" + passos | Reescrito |
| Motivo, Pedido de compra vinculado, Dispensada por, Quando | Dados | Mantido |
| Linha "Empresa: ACXE" | Subtítulo "NF ACXE N" | Movido |
| Botão "Abrir aprovações do StockBridge" | — | Retirado (decisão 6): o fiscal age no OMIE |

## E07. Aviso a compras (`enviarAvisoComprasNfSemPc`, 3 motivos + trava de unidade)

| Item antigo | Destino | Situação e motivo |
|---|---|---|
| Abertura por motivo (bloqueado / aguardando aprovação / recebida sem vínculo) | Resumo por motivo | Mantido, com "no OMIE da ACXE" quando for o caso |
| NF, Fornecedor, Empresa | Subtítulo ("NF N" ou "NF ACXE N" · fornecedor); "Empresa: Q2P" nos dados | Movido |
| Tabela Item · Quantidade · Preço unitário | Seção "Item(ns) da nota" | Mantido ("40 UN" quando não converte para kg) |
| Quadro "Pedido em unidade diferente da nota" | Seção com destaque | Mantido; a instrução final virou o passo |
| "O que fazer" (texto) e "PC aguardando aprovação: PC N" | O que fazer (Quem age: Compras), passo + nota; "Pedido aguardando aprovação no OMIE" nos dados | Mantido |
| "Siga a orientação acima..." (trava de unidade) | Passo "Lance (ou ajuste) o pedido de compra no OMIE na mesma unidade da nota." | Reescrito: o passo diz o que fazer |
| Botão "Abrir o StockBridge" | "Abrir a fila do StockBridge" (decisão 6) | Mantido; retirado no motivo "recebida sem vínculo" (a nota saiu da fila) |

## E08. Entrada rejeitada com o pedido baixado acima da nota (`enviarAvisoComprasExcedenteRejeitado`)

| Item antigo | Destino | Situação e motivo |
|---|---|---|
| Abertura (pedido baixado acima da nota; gestor rejeitou) | Resumo, frase 1 | Mantido |
| "A rejeição no StockBridge não desfaz a baixa do pedido no OMIE." | Resumo, frase 2 | Mantido |
| Confira com o fiscal; ajuste o recebimento no OMIE; a nota volta à fila | 2 passos + nota (Quem age: Compras) | Mantido |
| Item da NF, Produto, Empresa, Motivo da rejeição | Dados | Mantido (Motivo saiu do bloco de citação) |
| Pedido de compra (lista) + tabela Pedido · Na nota · Baixado · Acima | Seção "Quantidades" | Mantido; a lista repetia a tabela e saiu |
| Botão | "Abrir a fila do StockBridge" | Mantido |

## E09 e E10. Espelho de recebimentos e cópia de pedidos de compra parados (`enviarAlertaEspelhoRecebimentosDefasado`, `enviarAlertaCopiaPcsDefasada`)

| Item antigo | Destino | Situação e motivo |
|---|---|---|
| Frase da situação (vazio / não pôde ser lido / há N minutos, limite) | Resumo, frase 1; subtítulo com a empresa e a idade | Mantido |
| Consequência na fila / no recebimento | Resumo, frase 2 | Mantido; "Notas com o recebimento fiscal já feito seguem normalmente" foi para a nota da ação (E10) |
| "O que verificar": fluxo do n8n e a cópia do UAT | O que fazer (Quem age: Gestor SI) | Mantido; "workflow" virou "fluxo" |
| Assunto "... sem atualização" | "Infra - Espelho de recebimentos parado / vazio / sem leitura - Q2P/ACXE" | Reescrito pelo estado |

## E11. Dispensa desfeita (`enviarAlertaDispensaRevertida`)

| Item antigo | Destino | Situação e motivo |
|---|---|---|
| "voltou à fila ... será recebida pelo Atlas[, que também concluirá o recebimento fiscal]" | Resumo | Mantido |
| Motivo da reversão, Desfeita por, Quando | Dados | Mantido |
| Caixa "Atenção": avisar o gestor se já agiu no OMIE | Faixa cinza: "Nenhuma ação necessária, a não ser que você já tenha agido no OMIE ... avise o gestor ..." | Reescrito como [INFORMATIVO] com a exceção |
| Botão "Abrir aprovações do StockBridge" | — | Retirado (decisão 6) |

## E12. Recebimento fiscal desfeito no OMIE (`enviarAvisoFiscalRevertido`, D21)

| Item antigo | Destino | Situação e motivo |
|---|---|---|
| "O Atlas concluiu ... em X, mas aparece desfeito desde Y" (ou "estava concluído ... quando o Atlas o conferiu") | Resumo sem as datas; datas nos dados ("Concluído pelo Atlas em" / "Visto concluído pelo Atlas em", "Desfeito no OMIE desde") | Movido |
| "A entrada de estoque já foi lançada (situação) ... só o fiscal pode refazer" | Resumo, frase 2: "os itens lançados não voltam à fila de recebimento do StockBridge, e o recebimento fiscal precisa ser refeito no OMIE"; situação nos dados ("Entrada de estoque no Atlas") | Movido; frase da 2ª revisão da D21 (commit c525107 da 437: numa NF parcial o item rejeitado volta à fila) |
| "Conclua ... de novo no portal. Em cada item, confira: Não gerar movimento marcada; o vínculo com o PC" | Passos: 1. Abra; 2. confira "Não gerar movimento de estoque"; 3. confira o vínculo com o PC; 4. Depois, conclua | Reescrito com a ordem certa (a revisão achou que concluir primeiro lançaria o estoque em dobro) |
| Empresa | Subtítulo "NF ACXE N"; "no OMIE da ACXE" | Movido |
| Pedido de compra | Dados | Mantido |

## E13. Divergências de importação aguardando aprovação (`enviarAlertaAprovacaoPendenteImportacaoLote`)

| Item antigo | Destino | Situação e motivo |
|---|---|---|
| "N itens com divergência física × fiscal" | Resumo: "N itens com peso diferente da nota" | Reescrito sem jargão |
| "Os demais itens da NF que conferiram já entraram no estoque." | "Os itens desta nota que conferiram já entraram no estoque." | Mantido restritivo (a revisão viu que a forma "os outros itens" podia ser falsa) |
| Tabela Produto · Divergência · Qtd. recebida | Produto · Divergência ("Faltando: 25 kg a menos"; "Varredura (material para inspeção): ...") · Recebido | Mantido, com o nome da tela de conferência |
| Sem bloco de ação | O que fazer (Gestor) | Acrescentado |

## E14. Lançamento no OMIE pendente (`enviarAlertaPendenciaOmie`)

| Item antigo | Destino | Situação e motivo |
|---|---|---|
| "estado parcial — a chamada inicial teve sucesso, mas a continuação falhou. Nada foi perdido; basta retentar." | Resumo em 2 frases | Reescrito sem jargão |
| Lado pendente ("OMIE Q2P" / "OMIE ACXE (transferência da diferença)") | Subtítulo "falta o lançamento na Q2P" / "falta a transferência da diferença na ACXE" | Reescrito |
| Tentativas, Erro reportado | Dados "Tentativas já feitas", "Erro" | Mantido |
| Movimentação, op_id | Detalhes técnicos | Movido |
| Sem bloco de ação | O que fazer (Gestor SI): abrir Movimentações e tentar de novo | Acrescentado |

## E15. Baixa do pedido de compra Q2P (`enviarAlertaBaixaPedidoQ2p`)

| Item antigo | Destino | Situação e motivo |
|---|---|---|
| Introdução por motivo (falha / sem saldo) | Resumo por motivo | Mantido; "basta retentar" virou "Basta tentar outra vez: os pedidos já descontados não são descontados duas vezes." |
| "Verifique o pedido no OMIE (ou o cadastro do produto) e retente pelo painel" | Passos (Gestor SI) | Mantido |
| NF, Produto, Quantidade recebida | Subtítulo | Movido |
| Ainda por descontar / Sem pedido para descontar; Erro reportado | Dados | Mantido |
| Lista "Pedido N: antes → depois" | Seção "Pedidos descontados nesta baixa" (tabela) | Mantido |
| Movimentação | Detalhes técnicos | Movido |

## E16. NF sem vínculo com pedido na FUP (`enviarDigestBaixasAguardandoVinculo`)

| Item antigo | Destino | Situação e motivo |
|---|---|---|
| Para: caixa ops, Cc admin | Para: Comex; Cco: Gestor SI e admin | Decisão 7: quem age é a Comex |
| "recebidas há mais de N dias, mas a planilha FUP ainda não informa a qual pedido ... (o Atlas não escolhe pedido por ordem de data)" | Resumo em 2 frases | Mantido |
| "Basta preencher as NFs filhotes ... a baixa acontece automaticamente na hora seguinte." | Passo + nota (Quem age: Comex) | Mantido |
| Lista "NF N — recebida há N dia(s)" | Tabela NF · Recebida há (com 1 NF, só o subtítulo) | Mantido, sem "(s)" |
| Botão "Abrir movimentações" | — | Retirado: a Comex não tem usuário no Atlas |

## E17. Lançamento rejeitado (`enviarNotificacaoRejeicaoOperador`)

| Item antigo | Destino | Situação e motivo |
|---|---|---|
| "O gestor/diretor rejeitou um lançamento (tipo)" | Título "Lançamento rejeitado: tipo" + resumo | Reescrito sem a barra |
| NF, Fornecedor | Subtítulo | Movido |
| Item da NF, Produto, Quantidade, Local, Empresas da entrada | Dados | Mantido |
| Motivo informado (citação) | Seção "Motivo da rejeição" (destaque) | Mantido |
| "Corrija os dados e reenvie / lance novamente" | Passos (Quem age: quem fez o lançamento) | Mantido |
| "Você também pode abrir a tela de X e procurar 'Lançamentos rejeitados'" | Nota da ação | Mantido |
| "Aprovação: <uuid>" | Referência pequena ("aprovação 1a2b3c4d") | Reduzido |
| Botão "Reenviar agora" / "Lançar novamente" | Mantido | — |

## E18. Lançamento aprovado (`enviarNotificacaoAprovacaoOperador`)

| Item antigo | Destino | Situação e motivo |
|---|---|---|
| "Um lançamento que você fez foi aprovado pelo gestor/diretor"; "Tipo: X" | Título + resumo | Reescrito |
| Dados da entrada nacional | Subtítulo (NF · fornecedor) + dados | Movido |
| "O ajuste foi registrado automaticamente no OMIE (ACXE + Q2P)" (divergência) | Resumo, frase 2; com lançamento pendente: "Parte do lançamento no OMIE ficou pendente: o Gestor do Sistema Integrador vai concluir." | Corrigido (a revisão viu que a frase era falsa com pendência) |
| Cc Comex (divergência concluída) | Cc Comex + aviso "Em cópia (Comex): nenhuma ação" | Mantido |
| "Ref. técnica — aprovação" | Referência pequena | Reduzido |

## E19 e E20. Recebimento concluído (`enviarNotificacaoRecebimentoConcluido`, `...Lote`)

| Item antigo | Destino | Situação e motivo |
|---|---|---|
| "registrado sem divergências. O ajuste de estoque já foi aplicado no OMIE (ACXE + Q2P)" | Resumo | Mantido |
| Lote, Produto, Quantidade, Local de destino (1 produto) | Dados | Mantido |
| Tabela Produto · "Lote · Local" · Quantidade (vários) | Tabela Produto · Lote · Local · Quantidade | Mantido |
| Fornecedor; "N produtos" no assunto | Subtítulo | Movido |

## E21. Comodatos vencidos (`enviarDigestComodatosVencidos`)

| Item antigo | Destino | Situação e motivo |
|---|---|---|
| "[Escalado]" e "N comodatos vencidos aguardando retorno" no assunto | "Comodato - Retorno vencido / Vencido há mais de 15 dias - N comodatos" | Reescrito |
| Cartões por comodato (cliente, dias, escalado, produto, quantidade, galpão, saída, retorno previsto) | Tabela Cliente · Produto (galpão) · Quantidade · Saída · Retorno previsto · Vencido há | Mantido; a data da saída vem do horário de Brasília |
| Caixa da escalada (diretoria; repete a cada 15 dias) | Resumo, frase 2 + nota da ação | Mantido |
| Sem passos | O que fazer: conferir a devolução com o cliente; registrar o retorno em Retorno de Comodato | Acrescentado |
| Botão "Abrir Retorno de Comodato" | Mantido | — |
