# Data Model — Recebimento Nacional com Pedido de Compra

**Feature**: `017-recebimento-nacional-com-pc` | **Migrations**: `0056` (Q2P, Histórias 1 a 4), `0057` (cache de PCs vistos, ajuste de 22/10/2026), `0058` (ACXE, História 5) e `0059` (baixa do PC pelo peso conferido, research D20)

Base: o modelo da feature 016 (`specs/016-recebimento-fiscal-nf/data-model.md`). Aqui ficam só as extensões.

---

## 1. Espelho de recebimentos de NF-e: colunas de pedido (0056)

`public."tbl_recebimentoNFe_itens_Q2P"` ganha (`ADD COLUMN IF NOT EXISTS`, escrito pelo n8n):

| Coluna | Tipo | Origem no `ListarRecebimentos` (`cExibirDetalhes = 'S'`) |
|---|---|---|
| `n_id_pedido` | `bigint` | `itensCabec.nIdPedido` (0 ou ausente = sem vínculo → `NULL`) |
| `n_id_it_pedido` | `bigint` | `itensCabec.nIdItPedido`, só quando `nIdPedido > 0` (sem vínculo o OMIE repete o `nIdItem` aqui, então gravar `NULL`) |
| `n_num_ped_compra` | `varchar(15)` | `itensInfoAdic.nNumPedCompra`: número do pedido informado na NF |
| `c_num_it_ped_compra` | `integer` | `itensInfoAdic.cNumItPedCompra` |

Colunas que já existem e passam a ser usadas: `c_associar_existente`, `c_ignorar_item`, `c_nao_gerar_mov_estoque`, `n_id_produto` e `n_preco_unit`.

**Vínculo do OMIE** (derivado): `n_id_pedido > 0` (o `c_associar_existente` não entra: confirmado com a sessão do n8n em 21/10/2026; o `n_num_ped_compra` é o xPed do fornecedor e nunca é o vínculo).

**Estoque lançado pelo OMIE** (derivado, D7): recebimento com `c_recebido = 'S'` e algum item com `c_ignorar_item = 'N' AND c_nao_gerar_mov_estoque = 'N'`.

Caso real, NF 7813 na etapa 40 em 21/10/2026: `n_id_pedido` 8516905979, `n_id_it_pedido` 8516907022, `n_num_ped_compra` "304", `c_num_it_ped_compra` 1, `c_associar_existente` S, `c_nao_gerar_mov_estoque` N.

## 2. Espelho de recebimentos da ACXE (0058)

`public."tbl_recebimentoNFe_ACXE"` e `public."tbl_recebimentoNFe_itens_ACXE"`: mesma DDL das tabelas da Q2P (data-model da 016, §1 e §2), já com as colunas do §1, criadas só onde faltam (em PROD já existem, vazias, desde 21/10/2026) e escritas por um workflow n8n novo (contrato em `contracts/espelhos-n8n.md`).

## 3. `stockbridge.recebimento_fiscal`: extensão do ledger (0056)

| Mudança | Detalhe |
|---|---|
| `empresa varchar(4) NOT NULL DEFAULT 'q2p'` | `CHECK (empresa IN ('q2p','acxe'))`. As linhas existentes ficam `q2p` |
| `passo_falha` | o `CHECK` passa a aceitar também `'associar'` (escrita) e `'consultar_pc'` (releitura ao vivo do PC, sem escrita — recusa de PC fecha o ledger com ele) |
| `itens_vinculados integer` | itens que terminaram com vínculo de PC (nulo = fiscal sem vínculo, receita da 016) |

Máquina de estados e índice único parcial: os mesmos da 016.

## 4. `stockbridge.recebimento_fiscal_pc` (nova, 0056)

Vínculo item de NF → item de PC, uma linha por item e por tentativa (D5). FR-007, FR-015 e FR-023.

| Coluna | Tipo | Regra |
|---|---|---|
| `id` | `uuid` PK | — |
| `recebimento_fiscal_id` | `uuid NOT NULL` → `stockbridge.recebimento_fiscal(id)` | tentativa a que pertence |
| `empresa` | `varchar(4) NOT NULL` | `q2p` \| `acxe` |
| `nf_chave_acesso` | `varchar(44) NOT NULL` | — |
| `n_sequencia` | `integer NOT NULL` | item no recebimento (identidade do item, ACXEGDP-412) |
| `origem` | `varchar(10) NOT NULL` | `omie` (vínculo que veio do OMIE) \| `sugestao` (candidato dentro da tolerância) \| `manual` (fora da tolerância, com justificativa) — CHECK |
| `n_cod_ped` | `bigint NOT NULL` | PC escolhido (`nCodPed`) |
| `n_cod_item_ped` | `bigint NOT NULL` | item do PC (`nCodItem`) |
| `pc_numero` | `varchar(50) NOT NULL` | número legível do PC, para mensagens (`cnumero` da cópia tem 50 posições) |
| `n_cod_ped_omie_anterior` | `bigint` | vínculo do OMIE substituído pelo operador **nesta linha**: o que a sequência tinha no portão 1, quando difere do escolhido (nulo se a linha não foi trocada) |
| `n_cod_item_ped_omie_anterior` | `bigint` | idem |
| `dentro_tolerancia` | `boolean NOT NULL` | se o PC confirmado estava dentro da tolerância do FR-002, calculada na confirmação |
| `justificativa` | `text` | obrigatória quando `dentro_tolerancia = false` ou há troca do vínculo do OMIE (`n_cod_ped_omie_anterior IS NOT NULL`), por CHECK. Ver a matriz abaixo |
| `candidatos` | `jsonb NOT NULL` | retrato do que foi oferecido: `[{nCodPed, nCodItem, pcNumero, saldoKg, precoUnit, motivo, dentroTolerancia}]` |
| `qtd_nf_kg` | `numeric(14,3) NOT NULL` | quantidade do item da NF, em kg |
| `kg_recebido_pc` | `numeric(14,3)` | kg que o item baixou no PC quando a quantidade recebida não é a da NF: o que o Atlas mandou em `itensAjustes.nQtdeRecebida` (modo `converter`, D15; peso conferido acima da NF, D20; ou a da NF de volta na retomada) ou o que o OMIE mostrou ao concluir (`ja_concluido`, quando difere da NF em mais de 1 g). Nulo = sem quantidade definida (vale a da NF). CHECK `> 0` (0059) |
| `preco_nf` | `numeric(14,6) NOT NULL` | preço do item da NF por kg, na base comparada com o PC escolhido: comercial ou valor do item (research D3) |
| `saldo_pc_kg_lido` | `numeric(14,3)` | saldo do item do PC relido ao vivo na confirmação |
| `preco_pc_lido` | `numeric(14,6)` | preço do item do PC relido |
| `etapa_pc_lida` | `varchar(2)` | etapa do PC relida (precisa ser 15) |
| `status` | `varchar(12) NOT NULL` | `confirmado` → `associado` → `concluido` \| `falha` — CHECK |
| `erro_omie_codigo`, `erro_omie_mensagem` | `varchar(60)`, `text` | técnico, nunca vai à UI |
| `confirmado_por` | `uuid NOT NULL` → `atlas.users(id)` | — |
| `confirmado_em` | `timestamptz NOT NULL DEFAULT now()` | — |
| `concluido_em` | `timestamptz` | — |
| `created_at`, `updated_at` | `timestamptz NOT NULL DEFAULT now()` | — |

**Índices**:

- único parcial `(nf_chave_acesso, n_sequencia) WHERE status IN ('confirmado','associado','concluido')`: um vínculo vivo por item (FR-015);
- `(n_cod_item_ped, concluido_em)` para a regra "PC recém-usado" (D4) e para o desconto, na cópia local, dos vínculos concluídos depois de `data_atualizacao` (D3);
- parcial `(n_cod_item_ped) WHERE status IN ('confirmado','associado')` para as **reservas** em andamento (D4). Na releitura ao vivo, o saldo disponível é `nQtde − nQtdeRec` menos as reservas de outras NFs iniciadas há menos de 15 min, cada uma pelo que baixa do PC (`COALESCE(kg_recebido_pc, qtd_nf_kg)`, D20); vínculos concluídos não são descontados, porque o OMIE já os mostra.

**Quando a justificativa é obrigatória** (FR-007, matriz única para o CHECK, o portão 1, a releitura e a tela):

| Origem | Dentro da tolerância | Troca do vínculo do OMIE | Justificativa |
|---|---|---|---|
| `omie` (vínculo mantido) | sim | não | não |
| `omie` (vínculo mantido) | não | não | **sim** |
| `sugestao` (candidato) | sim | não | não |
| `sugestao` ou `manual`, no lugar de um vínculo do OMIE | qualquer | sim | **sim** |
| `manual` (outros do fornecedor) | não, por definição | qualquer | **sim** |

**Máquina de estados**:

```
confirmado ──ASSOCIAR-PEDIDO ok (ou vínculo do OMIE mantido)──▶ associado ──Concluir ok──▶ concluido
     └──────────────── qualquer falha ────────────────────────────────▶ falha
```

O vínculo do OMIE mantido (D1) vai de `confirmado` direto a `associado`, sem chamada.

**Trigger**: `stockbridge.audit_recebimento_fiscal_pc()` + `trg_audit_sb_recebimento_fiscal_pc` (INSERT/UPDATE/DELETE).

## 5. `stockbridge.nf_aviso_compras` (nova, 0056)

Aviso a compras sobre NF sem PC (D6), deduplicado.

| Coluna | Tipo | Regra |
|---|---|---|
| `id` | `uuid` PK | — |
| `empresa` | `varchar(4) NOT NULL` | — |
| `nf_chave_acesso` | `varchar(44) NOT NULL` | — |
| `nota_fiscal`, `fornecedor_nome` | `varchar` | exibição |
| `motivo` | `varchar(30) NOT NULL` | `sem_pc` \| `pc_aguardando_aprovacao` \| `recebida_sem_vinculo` \| `excedente_rejeitado` (0059, D20: entrada rejeitada pelo gestor depois de o PC ser baixado pelo peso conferido) — CHECK |
| `itens` | `jsonb NOT NULL` | `[{nSequencia, descricao, qtdKg, precoUnit, quantidadeTexto?}]` — `qtdKg` nulo para item de unidade não convertida, com `quantidadeTexto` ("40 UN"). No `excedente_rejeitado`, `qtdKg` é o baixado no PC, com `pcNumero` e `qtdNfKg` |
| `enviado_para` | `text NOT NULL` | destinatários efetivos |
| `enviado_em` | `timestamptz NOT NULL DEFAULT now()` | — |
| `disparado_por` | `uuid` → `atlas.users(id)` | operador que tentou receber |

**Deduplicação** (revista em 22/10/2026): por destinatário. No `excedente_rejeitado` (D20), também por item: só conta aviso anterior cujo `itens` contém as sequências do novo (`itens @> [{nSequencia}]`). Numa transação com trava consultiva por `(nf_chave_acesso, motivo)`, o envio vai só a quem ainda não consta no `enviado_para` das linhas das últimas 24 h; sem ninguém pendente, `deduplicado`. A linha grava em `enviado_para` só os destinatários **entregues**: quem falhou fica pendente para a próxima tentativa. Duas chamadas simultâneas não enviam duas vezes. **Trigger**: padrão `audit_*`.

## 6. `stockbridge.fornecedor_exclusao`: empresa (0058, História 5)

`empresa varchar(4) NOT NULL DEFAULT 'q2p'`, com `CHECK (empresa IN ('q2p','acxe'))` (`fornecedor_exclusao_empresa_check`). O índice único `fornecedor_exclusao_ativa_idx` passa a `(empresa, fornecedor_cnpj) WHERE reincluido_em IS NULL`. Linhas novas com a Q2P como fornecedor excluído na ACXE (intercompany): as duas CNPJs da Q2P no cadastro da ACXE, `27.019.059/0001-88` (matriz) e `27.019.059/0002-69` (filial), com máscara, como já está gravada a ACXE (`42.672.052/0001-54`). Não há constante de CNPJ da Q2P em `types.ts` (`CNPJ_Q2P_MATRIZ` é um rótulo). O índice único passa a incluir `empresa`, e `fornecedor.service.ts` passa a filtrar por empresa.

## 7. Função `stockbridge.refresh_lotes_em_transito_se_stale`: não muda

Continua como na 0037 (decisão de 21/10/2026, research D10). Ela usa `pc.nqtde` em vez do saldo, mas é PL/pgSQL que escreve em `stockbridge.lote`, e reeditá-la reforçaria um desvio ao Princípio III. Como não existe PC de importação recebido em parte, ela não erra hoje. A limitação fica registrada para um card próprio (trânsito em TypeScript).

## 8. Shapes de leitura (fila e detalhe), extensões

```ts
type Empresa = 'q2p' | 'acxe';
type PcSituacaoNf = 'vinculado_omie' | 'sugerido' | 'escolha_necessaria' | 'aguardando_aprovacao' | 'sem_pc' | 'nao_aplicavel';

interface FilaNacionalItem {
  // …campos da 015/016…
  empresa: Empresa;                    // 'q2p' até a História 5
  pcSituacao: PcSituacaoNf;            // resumo da NF para o selo da fila (pior caso entre os itens)
  estoqueLancadoPeloOmie: boolean;     // D7
}

interface PcCandidato {
  nCodPed: number;
  nCodItem: number;
  pcNumero: string;
  produtoDescricao: string;            // produto do PC (referência; não substitui a correlação)
  qtdPedidaKg: number;
  saldoKg: number;                     // nqtde - nqtderec
  precoUnit: number;                   // R$/kg do PC (nvalunit em KG, ou ÷ 1000 em T/TON)
  precoNfKgComparado: number | null;   // R$/kg da NF na base usada com este PC: comercial ou valor do item, a mais próxima (D3)
  dtPrevisao: string | null;
  etapa: string;                       // '15' ou '10'; outra etapa só aparece num vínculo do OMIE, com alerta
  dentroTolerancia: boolean;
  casaNumeroPedidoNf: boolean;         // n_num_ped_compra = cnumero
  motivo: string;                      // "Número do pedido na NF", "Quantidade e preço compatíveis", "Preço da NF 3,2% acima do PC", …;
                                       // com outroCadastro ganha o sufixo "· em outro cadastro do fornecedor (CNPJ …)"
  semDadosLocais: boolean;             // true só no vínculo do OMIE cujo PC não está na cópia nem no cache: produto, saldo e preço desconhecidos
  outroCadastro: boolean;              // D17 — o cadastro do PC difere do fornecedor da NF (mesma raiz de CNPJ: matriz × filial)
  cnpjCadastro: string;                // CNPJ do cadastro do PC, só dígitos ('' sem cadastro); a tela formata
  dadosEmCache: boolean;               // D16 — dados do cache `pedido_compra_visto`: o PC saiu da lista de pendentes; saldo e etapa são os da última vez em que foi visto
  unidade: string;                     // unidade do PC no OMIE ('KG', 'TON', …); a tela a mostra ao lado do saldo
  localidadeId: string | null;         // D18 — local do item do PC no Atlas (só NF da ACXE; Q2P e local virtual/desconhecido: null)
  localDescricao: string | null;       // D18 — "20.0.7 · PRODUÇÃO"; nunca o código OMIE
}

interface PcDoItem {
  vinculoOmie: PcCandidato | null;     // FR-000 (pode vir com alerta: PC sem saldo, etapa ≠ 15, PC-espelho)
  vinculoOmieElegivel: boolean;        // false = aparece mas não pode ser mantido (PC-espelho; PC em unidade diferente da NF no modo bloquear); o operador troca ou a NF é recusada (FR-011a)
  vinculosDivergentes: boolean;        // linhas do item vinculadas a PCs diferentes no OMIE: vinculoOmie null, alerta preenchido (com os números, se estão na cópia);
                                       // qualquer escolha é troca (justificativa) e a base do 409 é, por linha, o vínculo lido no portão 1;
                                       // sem PC possível: motivo vinculo_invalido (recusa nos dois modos, FR-011a)
  alertaVinculoOmie: string | null;
  candidatos: PcCandidato[];           // dentro da tolerância, ordenados (D3)
  outrosDoFornecedor: PcCandidato[];   // etapa 15 com saldo, fora da tolerância (escolha manual, FR-002a)
  aguardandoAprovacao: PcCandidato[];  // etapa 10 (FR-002b), não selecionáveis
  unidadeIncompativel: PcCandidato[];  // D15 — etapa 15 com saldo, em unidade diferente da NF (modo bloquear): visíveis, não selecionáveis
  preSelecionado: { nCodPed: number; nCodItem: number } | null; // vínculo do OMIE ou candidato único pelo número do pedido
  semPcMotivo: string | null;          // FR-019, quando não há nada selecionável
  vinculadoNoOmie: { pcNumero: string } | null; // fiscal já feito: PC vinculado à vista (FR-021)
}
// pcNumero vem da cópia de PCs ou, se o PC já saiu dela (recebido por inteiro), do ledger do Atlas;
// sem nenhum dos dois fica '' ("PC vinculado no OMIE"). Nunca do n_num_ped_compra, que é o xPed do
// fornecedor (vem até em NF sem PC — confirmado pela sessão do n8n em 21/10/2026).

interface ItemNfNacional {
  // …campos da 015/016: indice, descricaoFornecedor, quantidadeNfKg, valorUnitarioBrl, sequenciasRecebimento[], …
  /** PC do item. O item é agregado por descrição e pode juntar várias sequências da NF; todas recebem o mesmo item de PC (FR-002c). */
  pc: PcDoItem | null;                 // null = fiscal pelo Atlas desligado e nenhum vínculo a mostrar
}

// PC por NF (D14, 22/10/2026): o operador escolhe o PC uma vez para a nota. O POST continua por item.
interface PcDaNfItem {                 // atribuição de um item da NF a um item do PC
  indice: number;                      // item agregado da NF
  nCodItem: number;                    // item do PC atribuído (id de seleção, nunca texto)
  produtoDescricao: string;
  dentroTolerancia: boolean;
  motivo: string;
  origem: 'omie' | 'sugestao' | 'manual';
  justificativaNecessaria: boolean;    // fora da tolerância, escolha manual, troca do vínculo do OMIE ou vínculo sem dados locais
}
interface PcDaNf {                     // um PC que atende a nota
  nCodPed: number;
  pcNumero: string;
  outroCadastro: boolean;
  cnpjCadastro: string;
  dadosEmCache: boolean;
  itens: PcDaNfItem[];                 // um por item da NF atendido; item sem opção neste PC fica de fora
  cobreTodos: boolean;                 // nenhum item a receber sem PC possível, e este PC atende todos
  dentroTolerancia: boolean;           // todas as atribuições
  vinculoOmie: boolean;                // é o PC que o OMIE já tem vinculado em algum item
  justificativaNecessaria: boolean;    // alguma atribuição exige: uma só justificativa para a nota
}
interface PcsDaNf {
  pcs: PcDaNf[];                       // ordem: cobre todos; vínculo do OMIE; atende mais itens; dentro da tolerância; número
  preSelecionado: number | null;       // nCodPed: o vínculo do OMIE que cobre todos sem justificativa, ou o único PC que cobre todos dentro da tolerância
}

interface DetalheNfNacional {
  // …campos da 015/016…
  empresa: Empresa;
  exigePc: boolean;                    // STOCKBRIDGE_RECEBIMENTO_NACIONAL_EXIGE_PC (só relevante com fiscal pendente)
  estoqueLancadoPeloOmie: boolean;     // D7 — bloqueia o POST
  copiaPcsDefasada: boolean;           // D13 — cópia de PCs acima de STOCKBRIDGE_COPIA_PCS_MAX_MIN: sem sugestão confiável; POST com fiscal pendente dá 503
  itensSemAvaliacaoPc: Array<{ indice: number; descricao: string }>; // pendentes que o Atlas não recebe (unidade não convertida) e sem PC no OMIE;
                                       // modo bloquear: POST → 422 NF_SEM_PC (orienta o fiscal, sem aviso a compras); sem vínculo: seguem sem PC
                                       // e compras é avisado. Só com o fluxo de PC (chave da 016 + fiscal pendente); senão []
  pcsDaNf: PcsDaNf;                    // D14 — só itens a receber (pendentes, unidade convertida, sem baixa externa pedida);
                                       // { pcs: [], preSelecionado: null } fora do fluxo de PC ou com a cópia de PCs defasada
}
```

Os candidatos são calculados por item agregado: quantidade = soma das linhas (`quantidadeNfKg`); preço em duas bases por kg, o comercial (`n_preco_unit` / `v_un_com`) e o valor do item (`v_total_item` / `v_prod`), valendo a mais próxima do PC (D3). Os vínculos do OMIE são lidos por sequência. Se as sequências de um mesmo item agregado apontarem para itens de PC diferentes, o item mostra `alertaVinculoOmie` e exige escolha (`escolha_necessaria`); a escolha troca todas as linhas pelo PC escolhido. PCs de **outro cadastro com a mesma raiz de CNPJ** do fornecedor (filial × matriz) são oferecidos, com `outroCadastro` e `cnpjCadastro` (D17). PCs em **unidade diferente** da NF (fator para kg diferente; T, TON e TL são a mesma unidade) vão para `unidadeIncompativel` no modo `bloquear` (D15); sem outro PC possível, o motivo interno é `unidade_pc` (a situação do item é `sem_pc`, o `semPcMotivo` explica e o aviso a compras ganha o quadro de unidade). Os PCs vêm da cópia local e, para o que ela não traz, do cache de PCs vistos (§11).

`pcSituacao` da NF é o pior caso entre os itens a receber (pendentes e com unidade convertida — item bloqueado por unidade não conta; NF sem fornecedor cadastrado no OMIE é `nao_aplicavel`), nesta ordem: `sem_pc` > `aguardando_aprovacao` > `escolha_necessaria` (empate, só fora da tolerância ou vínculos divergentes) > `sugerido` > `vinculado_omie`. `nao_aplicavel` = fiscal já feito ou fiscal pelo Atlas desligado.

## 9. POST por-nf: corpo e resultado, extensões

```ts
// corpo (.strict(), snake_case como na 015), cada item de `itens[]` ganha:
pc?: {
  n_cod_ped: number;                   // > 0
  n_cod_item: number;                  // > 0
  justificativa?: string | null;       // 1..500; obrigatória conforme a matriz do §4
  n_cod_item_omie_visto?: number | null; // vínculo do OMIE que a tela mostrou para o item (null = nenhum); base do 409 VINCULO_OMIE_MUDOU
} | null;                              // ausente/null = sem PC: aceito só para item sem PC possível no modo "receber sem vínculo", ou com fiscal já feito.
                                       // Item com PC possível e sem `pc` → 422 PC_NAO_ESCOLHIDO.

// resultado, acrescido:
fiscal: {
  // …status/concluidoEm/mensagem da 016…
  vinculos: Array<{ nSequencia: number; pcNumero: string; origem: 'omie'|'sugestao'|'manual'; status: 'concluido' }>;
  semVinculo: number[];                // nSequencia recebidos sem PC (modo "receber sem vínculo")
  avisoCompras: boolean;               // se um aviso a compras foi disparado neste clique
};
```

**PC por NF** (D14): o corpo não muda. A tela escolhe o PC da nota em `pcsDaNf` e monta o `pc` de cada item com o `nCodItem` atribuído a ele, repetindo a mesma `justificativa` quando exigida. Cada item continua validado, relido ao vivo e reservado sozinho (§4).

## 10. Configuração nova

| Variável | Default | Uso |
|---|---|---|
| `STOCKBRIDGE_RECEBIMENTO_NACIONAL_EXIGE_PC` | `true` | D6: bloquear NF sem PC (`true`) ou receber sem vínculo (`false`) |
| `STOCKBRIDGE_PC_TOLERANCIA_QTD_PCT` | `2` | D3: quantidade da NF acima do saldo do PC |
| `STOCKBRIDGE_PC_TOLERANCIA_PRECO_PCT` | `1` | D3: diferença de preço unitário |
| `STOCKBRIDGE_COMPRAS_EMAILS` | vazio (cai em `STOCKBRIDGE_OPS_EMAIL`) | D6: aviso de NF sem PC |
| `STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_ENABLED` | `false` | D11: História 5 |
| `STOCKBRIDGE_COPIA_PCS_MAX_MIN` | `120` | D13: idade máxima da cópia de PCs antes do alerta e do modo seguro |
| `STOCKBRIDGE_PC_UNIDADE_DIFERENTE` | `bloquear` | D15: PC em unidade diferente da NF. `bloquear` = o PC não é oferecido e a NF é recusada sem outro PC; `converter` = o `EDITAR` manda `itensAjustes.nQtdeRecebida` na unidade do PC (só depois de teste com NF real) |
| `STOCKBRIDGE_PC_BAIXA_PESO_CONFERIDO` | `false` | D20: peso conferido acima da NF como quantidade recebida no `EDITAR`, com teto no saldo do PC; rejeição do gestor depois disso avisa compras. Sem a 0059 fica desligada (log) |
| `STOCKBRIDGE_PC_PESO_CONFERIDO_MAX_PCT` | `10` | D20: excedente acima deste percentual da NF do item não vai ao PC (provável erro de digitação) |

Reaproveitada: `STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED` (D8).

## 11. `stockbridge.pedido_compra_visto` (nova, 0057)

Cache da última versão vista de cada item de PC (D16). Derivado da cópia `tbl_pedidosCompras_<empresa>`, sem valor de negócio próprio. A migration é aditiva (`CREATE TABLE IF NOT EXISTS`, sem alterar tabela existente) e a leitura e a gravação são best-effort: sem a tabela, a sugestão segue só com a cópia.

| Coluna | Tipo | Regra |
|---|---|---|
| `id` | `uuid` PK | `gen_random_uuid()` |
| `empresa` | `varchar(4) NOT NULL` | `q2p` \| `acxe` — CHECK |
| `n_cod_ped` | `bigint NOT NULL` | PC (`ncodped` da cópia) |
| `n_cod_item` | `bigint NOT NULL` | item do PC (`ncoditem`) |
| `pc_numero` | `varchar(50) NOT NULL DEFAULT ''` | número legível (`cnumero`) |
| `n_cod_for` | `bigint` | cadastro do fornecedor do PC (`ncodfor`) |
| `produto_descricao` | `varchar(255)` | `cdescricao`, ou `cproduto` |
| `unidade` | `varchar(10)` | `cunidade` em caixa alta |
| `qtde`, `qtde_rec` | `numeric(14,3)` | pedida e recebida, na unidade do PC |
| `preco_unit` | `numeric(14,6)` | `nvalunit`, na unidade do PC |
| `etapa` | `varchar(2)` | `cetapa` |
| `dt_previsao` | `date` | `ddtprevisao` |
| `valor_total_pc` | `numeric(14,2)` | soma do PC inteiro; com o CNPJ do cadastro identifica o PC-espelho (fornecedor ACXE abaixo de R$ 200) |
| `visto_em` | `timestamptz NOT NULL DEFAULT now()` | quando o Atlas viu os dados atuais do item; só se atualiza quando algo muda. É o `atualizadoEmMs` do item vindo do cache |
| `created_at`, `updated_at` | `timestamptz NOT NULL DEFAULT now()` | — |

**Índices**: único `pedido_compra_visto_item_uq (empresa, n_cod_item)`; `pedido_compra_visto_ped_idx (empresa, n_cod_ped)`; `pedido_compra_visto_for_idx (empresa, n_cod_for)`.

**Gravação**: `registrarPcsVistos(empresa)` (`pc-visto.service.ts`) faz `INSERT … ON CONFLICT (empresa, n_cod_item) DO UPDATE … WHERE (colunas) IS DISTINCT FROM (EXCLUDED …)`, então só grava a linha nova ou alterada. Roda no cron `5,35 * * * *` (Q2P) e ao carregar o contexto da sugestão, no máximo 1× a cada 5 min por processo. Nunca lança: falha vira aviso no log. A cópia é lida com `DISTINCT ON (ncoditem)` (linha mais recente por `data_atualizacao`): um item repetido na cópia derrubaria o `ON CONFLICT` inteiro (SQLSTATE 21000) e entraria duas vezes no valor total do pedido. Não apaga linhas: o PC que sai da cópia (lista de pendentes, ou recebido por inteiro) permanece com o último saldo visto — por isso a leitura tem validade (abaixo).

**Leitura**: `lerPcsVistos` (por cadastro do fornecedor, raiz de CNPJ e PC de vínculo do OMIE) alimenta `carregarContextoPc`, que inclui só os itens que a cópia não trouxe (`fonte: 'cache'`, `PcCandidato.dadosEmCache`). **Validade**: por fornecedor e por raiz (candidatos) só entram itens com `visto_em` nos últimos 7 dias (`CACHE_PC_VALIDADE_DIAS`) — o PC que saiu da lista por recebimento total no portal, cancelamento ou exclusão não volta como candidato nem como pré-seleção; o PC apontado por um vínculo do OMIE entra sempre (a releitura ao vivo decide). `numerosDosPcs` (fila e detalhe) usa o cache como terceira fonte do número do PC, depois da cópia e do ledger.

**Trigger**: `stockbridge.audit_pedido_compra_visto()` + `trg_audit_sb_pedido_compra_visto` (INSERT/UPDATE/DELETE, Princípio IV). Como o upsert só grava o que mudou, cada registro da auditoria é uma mudança real do PC (saldo, etapa, preço), não o ruído de cada sincronização.

## 12. Compra nacional da ACXE: locais, idempotência e cache (0058, História 5, research D18)

**Locais operacionais**: `stockbridge.localidade.tipo` aceita `'operacional'` (CHECK `localidade_tipo_check` refeito). Seeds `20.0.5 PROCESSO` e `20.0.7 PRODUÇÃO`, `galpao` e `cnpj` nulos, com `localidade_correlacao` só do lado da ACXE (OMIE ACXE 4530985781 e 4553940398). Ficam fora de Meu Estoque, saída manual e transferência; entram só como destino do recebimento nacional da ACXE.

**Destinos da NF da ACXE** (`GET …/nacional/localidades?empresa=acxe&destino=nf`): locais ativos, não virtuais, com código da ACXE; `entradaEm = ['acxe','q2p']` quando a correlação também tem o código da Q2P (11.1, 12.1, 21.1, 31.1), senão `['acxe']` (21.2, 20.0.5, 20.0.7).

**Movimentação da NF da ACXE**: `entrada_manual`/`compra_nacional`, `empresa = 'acxe'`, `produto_codigo_acxe` = produto escolhido, `produto_codigo_q2p` = gêmeo da Q2P **só** quando o local também é da Q2P (entrada nas duas empresas, derivada: `subtipo = 'compra_nacional' AND empresa = 'acxe' AND nf_chave_acesso IS NOT NULL AND produto_codigo_q2p IS NOT NULL`), `status_omie = 'pendente_q2p'` até a aprovação. Na aprovação: `mv_acxe`/`id_*_acxe` e, nas duas empresas, `mv_q2p`/`id_*_q2p`; perna da Q2P com falha deixa `pendente_q2p` com a perna da ACXE gravada.

**Idempotência**: `movimentacao_nf_nacional_acxe_idempotencia_idx` — único em `(nf_chave_acesso, nf_item_descricao_normalizada, produto_codigo_acxe) WHERE subtipo = 'compra_nacional' AND ativo AND empresa = 'acxe' AND nf_chave_acesso IS NOT NULL AND produto_codigo_acxe IS NOT NULL`. O índice da 0052 continua valendo para a linha com `produto_codigo_q2p`.

**Cache de PCs vistos** (§11): `n_cod_prod bigint` e `codigo_local_estoque bigint` (produto e local do item do PC no OMIE da empresa), para sugerir o produto e pré-selecionar o local também quando o PC sai da lista de pendentes.

