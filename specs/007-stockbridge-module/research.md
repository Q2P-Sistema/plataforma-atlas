# Research: StockBridge — Decisoes Tecnicas e Contexto do Legado

**Feature**: 007-stockbridge-module
**Created**: 2026-04-16

## 1. Estrategia de Cutover — Validacao Paralela (Principio V)

### Decisao
Rodar StockBridge Atlas em paralelo ao sistema PHP legado por **2 semanas sem divergencia** antes do cutover.

### Rationale
- Principio V da constituicao: sistema financeiro em producao nao aceita big-bang.
- O legado processa ~43 movimentacoes/mes em 2 CNPJs simultaneamente — tem caminhos felizes bem testados e edge cases absorvidos ao longo de 2 anos.
- Cada recebimento durante o periodo paralelo e processado **manualmente** em ambos os sistemas (operador faz 2x) — ou via sombra automatica se implementarmos um shadow adapter.

### Criterios de paridade
1. Mesma NF processada em ambos os sistemas gera o mesmo `id_movest` e `id_ajuste` retornado pela OMIE.
2. Mesmo tratamento de divergencia (tipo, quantidade, destino).
3. Emails de notificacao enviados nos mesmos eventos (conteudo pode variar — so o gatilho importa).
4. Log de movimentacao com mesmas datas/usuarios/CNPJs.

### Alternativas consideradas
- **Big-bang cutover**: rejeitado — viola Principio V e risco de perder rastreabilidade em movimentacoes ativas.
- **Cutover por fornecedor**: rejeitado — complexidade operacional (operador precisaria saber qual sistema usar para cada NF).
- **Cutover por CNPJ (so ACXE ou so Q2P primeiro)**: rejeitado — a natureza dual-CNPJ torna essa separacao artificial e quebra o fluxo unico.

## 2. Integracao OMIE — Excecao ao Principio II

### Decisao
Manter as chamadas diretas a API OMIE que existem hoje no legado:
- `produtos/nfconsultar/` → `ConsultarNF` (leitura de NF por numero)
- `estoque/ajuste/` → `IncluirAjusteEstoque` (escrita — ajuste tipo TRF/ENT com motivo INI/TRF)
- `produtos/pedidocompra/` → `AlteraPedCompra` (escrita — reduzir saldo do pedido apos recebimento)

### Rationale
- O sync n8n → Postgres e incremental por `dDtAlt` e tem delay de minutos. NF recem-emitida pode nao estar disponivel no BD.
- A escrita no OMIE nao tem alternativa: OMIE nao tem webhook de entrada, nao ha fila de eventos. Unica forma de escrever e via API REST sincrona.
- O proprio Principio II reconhece essa excecao: "A API OMIE so e chamada diretamente pelo Atlas em duas situacoes documentadas: (1) dado fresquissimo e de volume pequeno que nao pode aguardar o proximo ciclo de sync, (2) escrita no ERP — hoje, exclusivamente a emissao de NF de entrada feita pelo StockBridge".
- O legado opera assim por 2 anos sem problemas operacionais.

### Padrao de implementacao
- Cliente HTTP em `packages/integrations/omie/` (ja parcialmente existente para Hedge consultar PTAX).
- Rate limiting e retry com backoff exponencial para cada chave de API (ACXE e Q2P separadas).
- Timeout de 30s por chamada (o legado usa `set_time_limit(300)`, mas 30s e suficiente para operacoes sincronas — so o Q2P pedido de compra com muitos itens pode demorar).
- Logs estruturados Pino para toda chamada (metodo, status, tempo, payload omitindo credenciais).

### Alternativas consideradas
- **Proxy via n8n**: rejeitado — adicionaria latencia e ponto de falha sem beneficio. n8n tambem chamaria a mesma API.
- **Fila de writes com retry**: rejeitado para v1 — o legado nao faz isso e funciona. Pode ser adicionado se surgir dor operacional.

## 3. Saidas Automaticas — Polling n8n

### Decisao
n8n faz polling periodico de NFs de saida OMIE e chama endpoint interno `POST /api/v1/stockbridge/saida-automatica/processar` para cada NF nova. Frequencia inicial: 5 minutos.

### Rationale
- Decisao registrada na Q1 da spec (`/speckit-clarify`).
- Padrao ja adotado pelo modulo Hedge para sync incremental.
- n8n nao calcula nada — apenas detecta eventos novos e notifica o Atlas. Todo calculo financeiro em TS (Principio III preservado).

### Fluxo
1. n8n query OMIE: NFs de saida com `dDtAlt >= ultima_sync` filtradas por tipo (venda, remessa, transf, devolucao).
2. Para cada NF nova, chama endpoint interno do Atlas com o payload.
3. Endpoint do Atlas: valida idempotencia (nota_fiscal ja processada?), roda `saidaAutomaticaService.processar()`.
4. Servico identifica tipo de saida, calcula impacto fisico/fiscal (incluindo debito cruzado), cria `stockbridge.movimentacao`, grava em audit log via trigger.

### Alternativas consideradas
- **Webhook OMIE**: rejeitado — OMIE nao suporta webhook de saida.
- **Polling dentro do Atlas**: rejeitado — quebra o padrao do projeto (todo polling e n8n).
- **Webhook OMIE + fallback polling**: rejeitado — complexidade sem beneficio ja que OMIE nao tem webhook.

## 4. Correlacao de Produto ACXE↔Q2P

### Decisao
Manter match por texto da descricao na v1: `tb_produtos_ACXE.descricao = tb_produtos_Q2P.descricao`. Criar view `shared.vw_sb_correlacao_produto` que encapsula o match para os servicos.

### Rationale
- Decisao registrada na Q6 da spec. Legacy preservado.
- Criar tabela explicita de correlacao na v1 aumenta escopo sem ganho imediato.
- Bug historico do sistema legado ("produto nao encontrado na Q2P") vai persistir, mas e conhecido e tratado com notificacao ao admin.

### Migracao para tabela explicita (v2, futuro)
Quando a dor do text-match ficar insuportavel, migrar para `stockbridge.correlacao_produto` com `id_ACXE`, `id_Q2P`, criada manualmente pelo admin. Nao faz parte do escopo desta feature.

### Alternativas consideradas
- **Tabela explicita na v1**: rejeitado — escopo maior, necessita UI de gerenciamento de correlacoes, migracao de dados historicos.
- **Match por multiplos campos (codigo + NCM + descricao)**: rejeitado — mudanca de comportamento em relacao ao legado, pode produzir resultados diferentes e quebrar validacao paralela.

## 5. Modelo de Dados — Movimentacao Pareada

### Decisao
Manter modelo legado: uma linha em `stockbridge.movimentacao` por NF com ambos os lados ACXE e Q2P na mesma row.

### Rationale
- Decisao registrada na Q8 da spec.
- O sistema legado grava assim ha 2 anos. Quebrar o modelo na v1 inviabiliza comparacao de paridade.
- Estrutura pareada reflete a realidade: uma NF sempre dispara dois ajustes de estoque (um em cada OMIE).

### Schema proposto
Ver `data-model.md` para detalhes. Colunas:
- `id_movimentacao` (PK, autoincrement)
- `nota_fiscal` (chave logica, indexada, UNIQUE para idempotencia)
- `tipo_movimento` (entrada_nf, entrada_manual, saida_automatica, saida_manual, ajuste)
- Lado ACXE: `mv_acxe`, `dt_acxe`, `id_movest_acxe`, `id_ajuste_acxe`, `id_user_acxe`
- Lado Q2P: `mv_q2p`, `dt_q2p`, `id_movest_q2p`, `id_ajuste_q2p`, `id_user_q2p`
- `ativo` (soft delete)
- `lote_id` (FK para `stockbridge.lote`)
- `observacoes`
- `created_at`, `updated_at`

### Alternativas consideradas
- **Dois registros separados (um por CNPJ)**: rejeitado — quebra validacao paralela com legado. Pode ser considerado em v2.

## 6. Migracao de Dados MySQL → PostgreSQL

### Decisao
Script one-shot `scripts/migrate-from-mysql.ts` que le do MySQL via `mysql2` e insere no Postgres via Drizzle. Executado manualmente no dia do cutover.

### Escopo da migracao

**MIGRAR do MySQL:**
- `tb_movimentacao` → `stockbridge.movimentacao` (731 rows ativas, mapear id_user legado → novo id_user Atlas por email)
- `tb_estoque_local_acxe` → `stockbridge.localidade` (6 rows, convertidas para o modelo unificado)
- `tb_estoque_local_q2p` → `stockbridge.localidade` (3 rows, mesma tabela)
- `tb_converteCodigoLocalEstoque` → `stockbridge.localidade_correlacao` (10 rows)
- `tb_tp_divergencia` → enum `stockbridge.tipo_divergencia` (2 valores: Varredura, Faltando)
- `tb_tp_status_movimento` → enum `stockbridge.status_movimento` (1 valor: Sucesso)

**NAO migrar (ja no PG ou descarte):**
- `tb_produtos_ACXE`, `tb_produtos_Q2P` → ja em `pg-acxe` public schema via sync OMIE
- `tbl_cadastroFornecedoresClientes_*` → ja em `pg-acxe`
- `tb_comex_controle_compra_venda` → de outro sistema, migracao futura
- `tb_users` → nao migrar, users novos criados no Atlas auth (spec 001) com mesmo email
- `tb_log` → log textual, sem valor de negocio
- `refresh_tokens` → auth legado, Atlas usa seu proprio
- Todas as tabelas `*_bkp*`, `*_old`, `*_v2` → descartar

### Estrategia
1. Antes do cutover: rodar em staging, validar integridade dos dados, checar que `id_movest_*` retornados pelo OMIE podem ser encontrados via API (sanity check de consistencia).
2. No cutover: (a) desabilitar escrita no sistema legado, (b) rodar script de migracao, (c) validar contagens, (d) habilitar `MODULE_STOCKBRIDGE_ENABLED=true`, (e) desabilitar Apache do legado.

## 7. Usuarios e Permissionamento

### Decisao
Usar o sistema de auth do Atlas (spec 001): `shared.users`, roles, 2FA obrigatorio para gestor/diretor. Adicionar campo `armazem_id` em `shared.users` (ou tabela de vinculo) para operadores.

### Rationale
- Clarificacao Q2 da spec: operador vinculado a armazem fixo, admin atribui, operador nao pode trocar.
- Centralizar auth em `shared.users` evita duplicidade com o legado.
- Mapeamento legado → Atlas por email:

| Email legado | Nome | Papel provavel |
|---|---|---|
| dfavacho@primebot.com.br | Dayvison Favacho | Dev (desabilitar no Atlas) |
| flavio@primebot.com.br | Flavio Endo | Admin |
| mauricio@acxe-polimeros.com.br | Mauricio Yared | Diretor |
| flavia@q2p-plasticos.com | Flavia Novak | Gestor/Operador |
| gustavo.dreer@acxe-polimeros.com.br | Gustavo Dreer | Operador (criado 2026-04-16) |

### Alternativas consideradas
- **Tabela `stockbridge.operador_armazem`**: considerado — adicionar complexidade. Rejeitado a favor de coluna em `shared.users` por simplicidade (um operador tem 1 armazem).

## 8. Locais Fisicos Reais (validados no legado)

Dados reais extraidos do MySQL (tabela `tb_estoque_local_acxe` + `tb_converteCodigoLocalEstoque`):

| Codigo ACXE | Descricao | Par Q2P | Tipo logico |
|---|---|---|---|
| 11.1 | SANTO ANDRE (antigo Galpao 5) | 11.1 | Proprio |
| 12.1 | SANTO ANDRE (antigo Galpao 4) | 12.1 | Proprio |
| 21.1 | EXTREMA | 21.1 | Proprio (MG) |
| 31.1 | ARMAZEM EXTERNO (ATN) | 31.1 | 3PL |
| 90.0.2 | TRANSITO | 90.0.2 | Virtual/Transito interno |
| 10.0.3 | VARREDURA | ELIMINADO | Virtual/Ajuste |
| A-PADRAO / A-EX1/2/3 | Estoques padrao ACXE | Q-* | Proprio (novos) |

**Nota**: os codigos OMIE `codigo_local_estoque_*` (bigint) mudam entre OMIE ACXE e OMIE Q2P — por isso a tabela `tb_converteCodigoLocalEstoque` (ACXE↔Q2P mapping). Schema novo preserva isso.

## 9. Familias de Produtos Reais

Do MySQL `tb_produtos_ACXE` (top 15 familias com mais produtos):
- USO E CONSUMO (161), sem familia (84), ATIVO IMOBILIZADO (48)
- **Materias-primas**: PEAD FILME (22), PEAD SOPRO (19), PEBD CONV C/D (14), PELBD C/D (14), PP RAFIA (11), PP HOMO 35 (11), PEAD INJ 8 (10), PEAD INJ 20 (8), PP RANDOM (8), PEBD IND (7), PP HOMO 25 (6), INDUSTRIALIZADO (20)

### Observacao
A granularidade real e muito maior que os 6 SKUs genericos do frontend v5. O cockpit do StockBridge deve:
- Filtrar apenas familias relevantes (excluir "USO E CONSUMO", "ATIVO IMOBILIZADO", etc.)
- Agrupar por familia PP / PE / PS para visao consolidada
- Mostrar o detalhe SKU dentro de cada familia

## 10. Procedures do Legado — Logica Extraida

As 11 procedures relevantes foram lidas do MySQL. Logica portada para TypeScript:

| Procedure legado | Servico TS equivalente | Observacao |
|---|---|---|
| `PR_VERIFICA_NOTA_PROCESSADA` | `recebimento.service.ts#isNFProcessada()` | Query SELECT simples |
| `PR_VERIFICA_PRODUTO_ESTOQUE_EXISTE_Q2P` | `correlacao.service.ts#getCorrelacao()` | Match de descricao preservado |
| `PR_IN_TB_MOVIMENTACAO_ACXE` | `recebimento.service.ts#inserirLadoACXE()` | INSERT |
| `PR_UP_TB_MOVIMENTACAO_Q2P` | `recebimento.service.ts#atualizarLadoQ2P()` | UPDATE pela NF |
| `PR_UP_REMOVE_MOVIMENTACAO` | `movimentacao.service.ts#softDelete()` | **Mudanca**: soft delete (ativo=0) em vez de DELETE fisico |
| `PR_SE_TB_ESTOQUE_LOCAL_ACXE*` | `localidade.service.ts#list*()` | Queries paginadas |
| `PR_SE_TB_TP_DIVERGENCIA` | `divergencia.service.ts#tipos()` | Lista de enum |
| `PR_SE_MOVIMENTACAO_PAGINACAO` | `movimentacao.service.ts#list()` | JOIN users + status |
| `PR_SE_TB_ESTOQUE_DISPONIVEL_PEDIDOS_Q2P` | Adiado — dependente de `tb_comex_controle_compra_venda` (outro sistema) | Fora do escopo v1 |

## 11. Observabilidade

### Decisao
Seguir padrao Atlas:
- Pino estruturado → Loki → Grafana
- Metricas-chave: recebimentos/hora, latencia OMIE (p50/p95/p99), taxa de divergencia, pendencias abertas, aprovacoes pendentes >24h
- Alerta Grafana: OMIE latencia p95 >10s por 5min; qualquer recebimento falho ao escrever no OMIE; divergencia nao tratada em 7 dias

### Dashboards dedicados
- **Operacional**: fila OMIE, recebimentos hoje, erros
- **Gestao**: divergencias abertas, aprovacoes pendentes, pipeline de transito
- **Diretoria**: valor estoque, exposicao cambial, evolucao 6m

## 12. Riscos e Mitigacoes

| Risco | Mitigacao |
|---|---|
| OMIE indisponivel durante recebimento | Transacao aborta, operador ve erro, tenta novamente. Nenhum estado parcial gravado (recebimento escreve no BD apenas apos ambos os OMIE retornarem sucesso). |
| Divergencia encontrada na validacao paralela | Investigar caso a caso; se for bug do legado aceita como ADR; se for bug do Atlas corrige antes do cutover. |
| Escopo do ComexFlow indefinido | Avanco manual de estagio de transito no StockBridge ate ComexFlow existir. Interface prepara futura integracao. |
| Migracao de usuarios legados | Script de migracao cria `shared.users` com `password_hash=null` forcando reset no primeiro login. |
| Correlacao de produto por texto falha para produto novo | Notificacao ao admin (como no legado) + bloqueio de recebimento ate cadastro manual do correlato. |
