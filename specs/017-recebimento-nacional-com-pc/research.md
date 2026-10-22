# Research — Recebimento Nacional com Pedido de Compra

**Feature**: `017-recebimento-nacional-com-pc` | **Data**: 2026-10-21 | **Jira**: ACXEGDP-437

Evidências: leitura ao vivo no OMIE da Q2P (sonda `m8moZ1C9xWvwyjmj` e teste `CA0PlrtFkzcdQlpM`, 21/10/2026), espelhos `public.*` em PROD (pg-acxe), documentação da API OMIE (`produtos/recebimentonfe/`, `produtos/pedidocompra/`, `estoque/consulta/`) e o código das features 015, 016 e da ACXEGDP-344.

---

## D1. Item que já chega vinculado ao PC: `EDITAR` (não movimentar estoque) e depois `ConcluirRecebimento`. Nunca `IGNORAR`

**Decisão**: quando o recebimento traz o item associado a um item de PC (`itensCabec.cAssociarExistente = 'S'` e `nIdPedido > 0`) e o operador confirma esse mesmo PC, a receita é:

1. `AlterarRecebimento` com `itensRecebimentoEditar: [{ itensIde: { nSequencia, cAcao: 'EDITAR' }, itensAjustes: { cNaoGerarMovEstoque: 'S', cNaoGerarFinanceiro: 'N' } }]`, só nos itens que ainda não têm esses ajustes.
2. `ConcluirRecebimento { nIdReceb, cEtapa: '60' }`.

**Evidência**: teste controlado na NF 7813 da Replas, autorizado pelo usuário em 21/10/2026, das 18h10 às 18h16.

| Momento | Recebimento | PC 304 | Estoque PS CRISTAL B no local 8123584710 |
|---|---|---|---|
| Antes | etapa 40, item associado ao PC 304 (`nIdPedido 8516905979`, `nIdItPedido 8516907022`, `nNumPedCompra "304"`), `cNaoGerarMovEstoque = N` | etapa 15, `nQtdeRec` 0 | 13.500 kg |
| Depois do `EDITAR` | vínculo mantido, `cNaoGerarMovEstoque = S` | sem mudança | 13.500 kg |
| Depois do `Concluir` | etapa 60, `cRecebido = S`, vínculo mantido, conta a pagar gerada (título 8517008510) | **`nQtdeRec` 18.000**, etapa 15 | **13.500 kg** (`ListarMovimentoEstoque` sem movimento da NF) |

Efeito colateral esperado: a descrição do item no recebimento passou a ser a do produto do PC ("PS CRISTAL B" no lugar de "SUCATA PLASTICO"). Esse é o caso da ACXEGDP-412, já tratado pelo reconhecimento do item pela sequência.

**Por que não `IGNORAR`**: o `IGNORAR` da receita da 016 desfaz a associação. A NF 7736, concluída pelo Atlas com `IGNORAR` em 21/10, hoje está sem `nNumPedCompra` e com `cIgnorarItem = S`. A hipótese de que ela tinha vínculo com o PC 302 não foi comprovada, mas é o motivo de a regra existir.

**Alternativas**: concluir sem o `EDITAR` foi rejeitado, porque o recebimento chega com `cNaoGerarMovEstoque = N` e o OMIE lançaria o estoque.

## D2. Item sem vínculo: `ASSOCIAR-PEDIDO`, depois `EDITAR`, depois `ConcluirRecebimento`. Ainda falta o teste com NF real

**Decisão**: para o item sem vínculo, ou com vínculo trocado pelo operador, o Atlas grava o vínculo antes de marcar os ajustes:

1. `AlterarRecebimento` com `itensIde: { nSequencia, cAcao: 'ASSOCIAR-PEDIDO', nIdPedidoExistente, nIdItPedidoExistente }`.
2. `EDITAR` com os ajustes de D1.
3. `ConcluirRecebimento` na etapa 60.

**Rationale**: reproduz o estado que funcionou na NF 7813 (associação existente e depois `EDITAR`). As duas ações vão em chamadas separadas porque `itensAjustes` só é aceito com `cAcao = 'EDITAR'` (erro `SOAP-ENV:Client-151`, visto na 016).

**Pendência que bloqueia a ativação, não o plano**: testar com uma NF real **sem** vínculo, no mesmo formato do teste da 7813 (n8n de teste, passo a passo, autorização do usuário). Pontos a conferir no teste:

- (a) se o `ASSOCIAR-PEDIDO` é aceito na etapa 40;
- (b) se o `EDITAR` seguinte preserva a associação;
- (c) se trocar um vínculo existente exige desassociar antes ou se o `ASSOCIAR-PEDIDO` sobrescreve;
- (d) o efeito no PC quando a NF é **menor** que o saldo: o PC continua aberto com o saldo, ou o OMIE o encerra.

Até o teste, a implementação fica atrás da chave da 016, que está desligada em PROD.

**Alternativas**: `EDITAR` antes de `ASSOCIAR-PEDIDO`. Ficou como plano B, se o teste mostrar que a associação zera os ajustes.

**Plano B da troca de vínculo**: se o OMIE recusar o `ASSOCIAR-PEDIDO` sobre um item que já tem vínculo, a troca deixa de ser oferecida na tela. O item mantém o vínculo do OMIE ou, se ele não servir, a NF é recusada com a orientação de pedir a troca ao fiscal no portal. Em nenhum caso o item é ignorado (FR-011a).

## D3. A sugestão vem de duas fontes locais, sem chamar o OMIE ao abrir a tela

**Decisão**: a sugestão de cada item é montada só a partir de dados que já estão no Postgres:

1. **Vínculo do OMIE**, lido do espelho de recebimentos, que ganha colunas novas (D9): `n_id_pedido`, `n_id_it_pedido`, `n_num_ped_compra`, `c_num_it_ped_compra`, além dos já existentes `c_associar_existente`, `c_ignorar_item` e `c_nao_gerar_mov_estoque`. Quando presente, é a sugestão principal.
2. **Candidatos**, lidos de `public."tbl_pedidosCompras_<empresa>"`, a cópia local atualizada pela Rev 1.5 do n8n `qPJFEIY1PQ2LDQG2`: a cada aviso de PC, com agenda de 10 min, troca atômica e PCs recebidos parcialmente incluídos.

**Regra de candidato** (FR-002):

- mesmo fornecedor: `pc.ncodfor` = `nIdFornecedor` do recebimento, ou o código do fornecedor no cadastro pela CNPJ, para a fonte "fiscal já feito";
- `cetapa = '15'`;
- quantidade do item, em kg, até 2% acima do saldo do PC: `qtdKg ≤ saldoKg × 1,02`. Na cópia local, o saldo é `nqtde − nqtderec`, menos os vínculos `concluido` do Atlas no mesmo item de PC depois de `data_atualizacao` da cópia (ela ainda não os viu) e menos as reservas em andamento de outras NFs (D4). A quantidade em kg usa a conversão de unidade da 015;
- preço da NF por kg até 1% diferente do preço do PC por kg, com o preço do PC como base: `|preçoNfKg − preçoPcKg| ≤ preçoPcKg × 0,01`. O preço da NF é o **comercial**, sem tributos: `n_preco_unit` no espelho de recebimentos e `v_un_com` em `tbl_nf_itens_<empresa>`, nunca `v_prod`. Para o item agregado por descrição, `preçoNfKg = Σ(preço comercial × qtd) ÷ Σ kg`, chamando `converterItemNfParaKg(qtd, unidade, preço comercial × qtd)` por linha, porque a função recebe o valor **total**. O preço do PC por kg é `nvalunit` com `cunidade = 'KG'` (todos os PCs hoje) ou `nvalunit ÷ 1000` com `'T'`/`'TON'`; outra unidade deixa o PC fora, com o motivo. Item com unidade não conversível fica sem sugestão (já é bloqueado na 015 e vai ao formulário manual);
- **nunca** PC de fornecedor ACXE com valor total abaixo de R$ 200 (PCs-espelho da importação). A ACXE é reconhecida pela CNPJ do fornecedor no cadastro, comparada sem máscara com `CNPJ_ACXE_NUMERICO` (`types.ts`); `CNPJ_ACXE` é um rótulo, não a CNPJ. A regra é defensiva: como o candidato precisa ser do fornecedor da NF e a ACXE já fica fora da fila da Q2P por `fornecedor_exclusao`, o caso só aparece num vínculo do OMIE que aponte para PC-espelho.

**Ordenação**: (1) o número do pedido informado na NF (`n_num_ped_compra`) igual a `pc.cnumero`; (2) menor diferença de preço; (3) previsão de entrega mais antiga; (4) `ncodped`. Empates aparecem todos, e nada é pré-selecionado. Só o vínculo do OMIE, ou um único candidato que case pelo número do pedido, vem pré-selecionado. O operador confirma sempre (FR-007).

**Outros PCs do fornecedor** (FR-002a/b): os PCs da etapa 15 com saldo, mas fora da tolerância, aparecem numa lista à parte para escolha manual com justificativa. Os da etapa 10 aparecem como "PC aguardando aprovação" e não podem ser escolhidos.

**Evidência de volume**: em 21/10/2026, a Q2P tinha 3 PCs nacionais (302, 303 e 304) e a ACXE nenhum. A cópia local inteira tem cerca de 250 linhas, então a consulta por fornecedor é trivial.

**Alternativas**: `PesquisarPedCompra` ao vivo por fornecedor ao abrir o detalhe foi rejeitado pelo Princípio II e pelo custo de API. A cópia frequente da Rev 1.5 resolve a defasagem.

## D4. Na confirmação, o Atlas relê ao vivo o recebimento e cada PC

**Decisão**: no POST, depois da validação dos dados e antes de qualquer escrita, o Atlas:

1. lê o recebimento com `ConsultarRecebimento`, que já existe na 016;
2. lê cada PC escolhido com `ConsultarPedCompra`, cliente da ACXEGDP-344;
3. recusa o vínculo (`409 PC_VINCULO_INVALIDO`) se o PC não estiver na etapa 15, não tiver o item, for de outro fornecedor ou não tiver saldo disponível, ou se a quantidade passar da tolerância sem justificativa;
4. recusa com `409 VINCULO_OMIE_MUDOU` se o vínculo vivo no recebimento for diferente do que a tela mostrou (o corpo do POST leva `n_cod_item_omie_visto`) e diferente do PC escolhido. Vínculo vivo igual ao escolhido nunca é conflito, o que evita recusas em série enquanto o n8n ainda não preenche as colunas de pedido.

**Saldo disponível na releitura**: é o que o OMIE devolve (`nQtde − nQtdeRec`), **sem** descontar vínculos concluídos pelo Atlas, porque o OMIE atualiza `nQtdeRec` ao concluir (teste da NF 7813). Desconta só as **reservas em andamento** de outras NFs no mesmo item de PC: linhas de `recebimento_fiscal_pc` em `confirmado` ou `associado`, de outra NF, iniciadas há menos de 15 min.

**Cache e concorrência**: `ConsultarPedCompra` com corpo idêntico em menos de cerca de 1 min devolve resposta antiga (ACXEGDP-406). A ordem no POST é:

1. a trava da NF (ledger da 016);
2. `ConsultarPedCompra` de cada PC escolhido, fora de transação;
3. numa transação com `pg_advisory_xact_lock` por item de PC (`n_cod_item_ped`), em ordem crescente para não travar em ciclo:
   - se houver vínculo `concluido` pelo Atlas no mesmo item de PC há menos de 75 s, `409 PC_RECEM_USADO_AGUARDE` com `retryAfterSeconds` (a leitura do passo 2 pode ter vindo do cache);
   - checa o saldo disponível;
   - grava as linhas `confirmado`, que são a **reserva**;
4. só então `ConsultarRecebimento` e as escritas no OMIE.

A trava solta no fim da transação, mas a reserva continua valendo para as outras NFs até a linha virar `concluido` ou `falha`. Isso fecha a janela de duas NFs simultâneas no mesmo item de PC sem segurar a trava durante as chamadas ao OMIE.

**Alternativas**: confiar só na cópia local foi rejeitado, porque ela pode estar minutos atrás e outra NF pode ter consumido o PC.

## D5. Registro dos vínculos: tabela nova `stockbridge.recebimento_fiscal_pc`, filha do ledger da 016

**Decisão**: uma linha por item da NF e por tentativa, ligada à linha do ledger `stockbridge.recebimento_fiscal` daquela tentativa. Guarda:

- origem: `omie`, `sugestao` ou `manual`;
- o PC e o item de PC escolhidos, e o PC original do OMIE quando o operador troca;
- se o PC estava dentro da tolerância (`dentro_tolerancia`) e a justificativa, obrigatória fora dela ou na troca do vínculo do OMIE;
- o retrato dos candidatos oferecidos (`jsonb`);
- quantidade e preço da NF, saldo e preço do PC relidos;
- o passo e o resultado.

Status: `confirmado → associado → concluido | falha`. Há índice único parcial por `(nf_chave_acesso, n_sequencia)` para os status vivos, e índice parcial `(n_cod_item_ped) WHERE status IN ('confirmado','associado')` para as reservas de D4. Tem trigger de auditoria (Princípio IV).

O ledger da 016 ganha:

- `empresa` (`q2p` | `acxe`, default `q2p`);
- o passo `associar` no `CHECK` de `passo_falha`.

**Rationale**:

- FR-023 pede rastrear sugeridos, confirmado, quem e quando;
- FR-015 pede idempotência por item;
- o `409 PC_RECEM_USADO_AGUARDE` de D4 precisa consultar vínculos recentes por item de PC.

**Alternativas**: um `jsonb` no ledger foi rejeitado por dificultar a consulta "vínculos recentes no item de PC X" e a auditoria por item.

## D6. NF sem PC: regra configurável, bloquear por padrão, e aviso a compras com deduplicação

**Decisão**: a variável `STOCKBRIDGE_RECEBIMENTO_NACIONAL_EXIGE_PC` (default `true`) define o modo.

- **`true` (bloquear)**: se algum item a gravar não tem PC possível (definição antes do FR-019 da spec), o POST responde `422 NF_SEM_PC` sem escrever nada, e a NF continua na fila como "aguardando PC de compras".
- **`false` (receber sem vínculo)**: os itens sem PC possível seguem a receita da 016 (`EDITAR` + `IGNORAR`), e os itens com PC seguem D1 ou D2. As duas receitas cabem na mesma NF, porque `AlterarRecebimento` aceita uma ação por item.
- **Item com PC possível e sem escolha**, nos dois modos: `422 PC_NAO_ESCOLHIDO` ("escolha o pedido de compra do item …"). Ele nunca vira "sem PC" nem gera aviso a compras. Item com vínculo do OMIE nunca segue o `IGNORAR` (FR-011a).

Nos dois modos, compras recebe um aviso com a NF, o fornecedor e os itens sem PC. O aviso vai para `STOCKBRIDGE_COMPRAS_EMAILS`; se a variável estiver vazia, vai para `STOCKBRIDGE_OPS_EMAIL` e fica registrado no log. Ele é deduplicado em `stockbridge.nf_aviso_compras`: no máximo um por NF e motivo a cada 24 h. Com a cópia de PCs defasada (D13), a regra não é aplicada: o POST responde `503 COPIA_PCS_DEFASADA` e nada é avisado.

**A regra só vale quando o fiscal é feito pelo Atlas.** Com o fiscal já feito no portal, ou com a chave da 016 desligada (contenção), não há o que bloquear: o fiscal já existe, e o Atlas faz só o físico.

**Alternativas**: bloquear sem chave foi rejeitado, porque o usuário pediu para poder desligar o bloqueio.

## D7. Estoque já lançado pelo OMIE: o Atlas detecta e bloqueia a entrada física

**Decisão**: uma NF com o fiscal concluído fora do Atlas é marcada como `estoqueLancadoPeloOmie` quando algum item está recebido, não ignorado e sem "não movimentar estoque". No espelho de recebimentos, isso é `c_recebido = 'S'`, `c_ignorar_item = 'N'` e `c_nao_gerar_mov_estoque = 'N'`.

Com essa marca, o detalhe mostra o motivo e o POST responde `409 ESTOQUE_JA_LANCADO_PELO_OMIE` sem escrever nada. Quando o espelho de recebimentos não tem a NF, o POST de uma NF "fiscal já feito" lê o recebimento ao vivo uma vez (`ConsultarRecebimento` por chave) antes de gravar. Essa leitura é uma exceção ao Princípio II e fica documentada no comentário do código e na seção 2 da 007.

**Também no ramo `ja_concluido` e na reconsulta depois de falha.** Se a NF ainda aparecia com fiscal pendente e o fiscal foi concluído no portal entre a abertura da tela e a confirmação, a `ConsultarRecebimento` do fiscal (016) volta com `cRecebido = 'S'`. Antes de seguir para o físico, o Atlas aplica a mesma checagem aos itens lidos ao vivo: item não ignorado com `cNaoGerarMovEstoque = 'N'` dá `409 ESTOQUE_JA_LANCADO_PELO_OMIE`. O mesmo vale para a reconsulta depois de falha.

**Vale com a chave da 016 desligada.** É justamente o cenário da contenção, com o fiscal concluindo no portal.

**Rationale**: o estoque lançado duas vezes, uma pelo OMIE e outra pelo Atlas, é o pior desfecho possível (SC-009). A informação já está no espelho, e a leitura ao vivo só acontece quando ela falta.

**Alternativas**: só orientar o fiscal foi rejeitado pelo usuário.

## D8. A chave liga/desliga é a da 016

**Decisão**: `STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED`. Desligada, vale a contenção de 21/10/2026: a fila mostra só as NFs com fiscal feito no portal e o Atlas faz o físico, mas com D7 (detecção de estoque) e FR-021 (PC vinculado à vista) ativos. Ligada **com esta feature implantada**, o Atlas conclui o fiscal mantendo ou gravando o vínculo.

**Risco de ativação**: religar a chave com uma imagem anterior à 017 volta a receita do `IGNORAR`, que é o problema original. O quickstart e o runbook de deploy registram que a chave só volta a `true` depois da versão com a 017 em PROD e do teste de D2.

## D9. Espelhos de recebimento: colunas de pedido e espelho novo da ACXE, com DDL na migration e mudança no n8n

**Decisão**:

- a migration `0056` (Fase 1) acrescenta `n_id_pedido bigint`, `n_id_it_pedido bigint`, `n_num_ped_compra varchar(15)` e `c_num_it_ped_compra integer` em `public."tbl_recebimentoNFe_itens_Q2P"` (`ADD COLUMN IF NOT EXISTS`);
- a migration `0057` (Fase 2, História 5) cria `public."tbl_recebimentoNFe_ACXE"` e `"_itens_ACXE"` com a mesma DDL (`IF NOT EXISTS`), já com essas colunas.

O workflow n8n "Q2P - Exporta Recebimentos NF-e" passa a gravar os quatro campos, que vêm de `itensCabec.nIdPedido` e `nIdItPedido` e de `itensInfoAdic.nNumPedCompra` e `cNumItPedCompra`. Um workflow novo, "ACXE - Exporta Recebimentos NF-e", copia o da Q2P com as chaves da ACXE.

O contrato para a sessão dos workflows está em `contracts/espelhos-n8n.md`.

**Rationale**: é o mesmo padrão da 016 (D4). A DDL canônica fica no repositório do Atlas, porque a fila e os testes dependem dela.

## D10. Leitores da cópia de PCs passam a descontar o recebido (menos a função de trânsito)

**Decisão**: `cockpit.service.ts` e `pendencias-fiscais.service.ts` trocam `pc.nqtde` por `pc.nqtde - COALESCE(pc.nqtderec, 0)` como saldo, e `pc.nqtde > 0` por saldo `> 0`.

**A função `stockbridge.refresh_lotes_em_transito_se_stale` (migration 0037) fica como está** (decisão do usuário em 21/10/2026, achado C2 do `/speckit-analyze`). Ela também usa `pc.nqtde`, mas é PL/pgSQL que faz UPSERT e soft-delete em `stockbridge.lote`, uma tabela de domínio. O Princípio III reserva essa escrita ao TypeScript, e reeditá-la nesta feature reforçaria o desvio herdado da 0037. Como hoje não existe PC de importação recebido em parte em nenhuma das empresas, a função não erra na prática. A limitação fica registrada para um card próprio: levar o refresh do trânsito para TypeScript, já com o saldo.

**Rationale**: com a Rev 1.5, um PC recebido em parte passa a ficar na cópia local; sem a correção, ele seria contado pela quantidade cheia. Hoje não existe nenhum caso nas duas empresas, então a correção é preventiva. A baixa da ACXEGDP-344 não é afetada: ela só usa PCs com "Pedido original ACXE" casando com a NF filhote.

## D11. Compra nacional pela ACXE (User Story 5): mesma fila, empresa como dimensão, estoque pela regra da importação

**Decisão**:

- a fila e o detalhe ganham `empresa` (`q2p` | `acxe`) nas duas fontes, com os espelhos da ACXE (`tbl_nf_header_ACXE` e `tbl_nf_itens_ACXE`, que já existem, e o espelho de recebimentos novo de D9);
- `stockbridge.fornecedor_exclusao` ganha `empresa`. Na ACXE ficam excluídas as duas CNPJs da Q2P no cadastro da ACXE, `27.019.059/0001-88` (matriz) e `27.019.059/0002-69` (filial), gravadas com máscara como o caso inverso (`42.672.052/0001-54`). Não há constante de CNPJ da Q2P em `types.ts`: `CNPJ_Q2P_MATRIZ` é um rótulo. `fornecedor.service.ts`, que lista, exclui e reinclui por CNPJ, passa a considerar a empresa;
- o fiscal e o vínculo usam `callOmie('acxe', …)`, com a mesma receita de D1 e D2;
- **não há PC na Q2P.** O n8n `RDa9ilL3tbx5ETIk` só espelha PC de fornecedor estrangeiro (gate `gate_internacional_ativo`, ACXEGDP-376; o nacional cai em `Pedido_Nacional_Ignorado`). Logo, não há baixa de PC na Q2P (FR-029);
- **estoque**: o operador escolhe o local entre os mesmos oferecidos na importação. Os locais espelhados vêm de `listarLocalidadesEspelhadas` (`localidade.service.ts`, a mesma lista do `ConferenciaModal` da importação), com a correspondência ACXE↔Q2P em `stockbridge.localidade_correlacao`. A entrada é sempre nas duas empresas: no local escolhido da ACXE e no local correlato da Q2P. **Não há entrada só na ACXE.** Não há trânsito: o lado da ACXE é `ENT`, e não `TRF`. Os sufixos de idempotência ficam `acxe-ent` e `q2p-ent`; falha só no lado da Q2P reaproveita `pendente_q2p` e o painel de retentativa;
- **valor**: o mesmo valor unitário nas duas empresas, o do item na NF por kg, **sem** o acréscimo de 14,5% que a importação aplica na entrada da Q2P (`ceil(vNF / kg × 1,145)` em `executarAjusteOmieDual`). Decisão do usuário em 21/10/2026;
- é entregue numa fase separada, atrás de `STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_ENABLED` (default `false`), com migration própria (`0057`).

**Extrema (decidido em 21/10/2026)**: quando o material chega fisicamente a Extrema (sede da ACXE), o local é o **21.1 EXTREMA**, espelhado (ACXE 4004166399 ↔ Q2P 7960459966, já correlacionados em `stockbridge.localidade_correlacao`). Assim o estoque aparece na Q2P e vendas pode vender. O 21.2 "EXTREMA (NACIONAL)" da ACXE (4452867179, só ACXE) **não** é usado por esta feature. Vale notar que, no OMIE da ACXE, o 21.1 está descrito como "EXTREMA (IMPORTADO)": a descrição não reflete o uso para compra nacional, mas não afeta o recebimento.

## D12. Cliente OMIE: uma ação nova em `recebimento-nfe.ts`, leitura de PC reaproveitada

**Decisão**:

- `alterarRecebimentoNfeItens` passa a aceitar `cAcao: 'ASSOCIAR-PEDIDO'` com `nIdPedidoExistente` e `nIdItPedidoExistente`;
- o parser de `ConsultarRecebimento` (`parseRecebimentoNfeConsultado`) passa a ler `itensCabec.nIdPedido` e `nIdItPedido` e o bloco `itensInfoAdic` (`nNumPedCompra`, `cNumItPedCompra`), que hoje nem é declarado no tipo `RawRecebimento`;
- `validarItensRecebimentoEditar` continua recusando `itensAjustes` fora de `EDITAR`, agora também com `ASSOCIAR-PEDIDO`;
- o mock ganha associação com estado (a sombra do modo leitura também), e `nQtdeRec` do PC atualiza ao concluir;
- `consultarPedidoCompra` (344) é reaproveitado sem mudança, com `retries 2` na leitura;
- a escrita continua sem retry (STK-23);
- `ASSOCIAR-PEDIDO` entra na lista de escritas bloqueadas em `OMIE_MODE=leitura` (ACXEGDP-405), porque não está em `METODOS_LEITURA`: o método é `AlterarRecebimento`, já bloqueado.

**Exceção ao Princípio II**: a escrita em `produtos/recebimentonfe/` já é exceção documentada (016). A ação `ASSOCIAR-PEDIDO` é acrescentada ao texto da seção 2 de `specs/007-stockbridge-module/research.md`, junto com as leituras ao vivo desta feature: `ConsultarPedCompra` na confirmação (D4) e `ConsultarRecebimento` por chave para NF "fiscal já feito" fora do espelho (D7).

## D13. Frescor da cópia de PCs: monitorada, e defasada não decide nada

**Decisão**: com esta feature, a cópia `tbl_pedidosCompras_<empresa>` passa a decidir a sugestão, o bloqueio de NF sem PC e o aviso a compras, e vira tabela crítica para o Princípio II ("Monitoramento DEVE alertar se MAX(dDtAlt) das tabelas críticas ficar defasado"). Então:

- **idade** da cópia = `now() − max(data_atualizacao)` (a Rev 1.5 grava o início do sync em todas as linhas, na troca atômica);
- **health** do módulo ganha `pedidosCompraCopiaIdadeMin`, `degraded` acima de `STOCKBRIDGE_COPIA_PCS_MAX_MIN` (default 120: com aviso por evento e agenda de 10 min, passar de 2 h significa pipeline quebrado);
- **alerta** no cron que já vigia o espelho de recebimentos (`alerta-espelho-recebimentos.service.ts`), para `STOCKBRIDGE_OPS_EMAIL`, com o mesmo reaviso;
- **modo seguro**: com a cópia defasada, o detalhe mostra "lista de pedidos de compra desatualizada" e o POST com fiscal pendente responde `503 COPIA_PCS_DEFASADA`, sem gravar nada, sem aplicar `NF_SEM_PC` e sem avisar compras. NF com fiscal já feito não depende da cópia e segue normal;
- na Fase 2, o mesmo para a cópia da ACXE e o espelho de recebimentos da ACXE.

**Alternativas**: tratar cópia defasada como "sem PC" foi rejeitado, porque bloquearia NFs e mandaria avisos falsos a compras justamente quando o problema é do pipeline.

---

## Pendências de pesquisa (não bloqueiam o plano)

1. **Teste de D2** com NF real sem vínculo, incluindo NF menor que o PC e troca de vínculo. Bloqueia a **ativação**, não o desenvolvimento.
2. **Se a etapa do PC muda depois** do recebimento total. No PC 304, ela ficou em 15 logo depois da conclusão. Conferir no espelho do dia seguinte. Não afeta o desenho: a elegibilidade usa o saldo (`nqtde − nqtderec`) além da etapa.
3. **Como o OMIE associa sozinho.** Na NF 7813, o recebimento foi incluído por `cUsuarioInc = P000548700` já com o vínculo. Ainda não se sabe se foi automático (pelo `xPed` do XML) ou manual. Não afeta o desenho: o vínculo existente é sempre a sugestão principal.
4. ~~Local da ACXE em Extrema~~: resolvido, é o 21.1 EXTREMA, espelhado; a entrada é sempre nas duas empresas (D11).
