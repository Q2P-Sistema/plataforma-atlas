# ADR-0002: Postgres compartilhado via views em schema `shared`

**Status:** Aceito
**Data:** 2026-04-11

## Contexto

Todos os módulos do Atlas operam sobre o mesmo banco Postgres (`dev_acxe_q2p_sanitizado`), com 28 tabelas OMIE já sincronizadas mais tabelas privadas que cada módulo precisa criar (Hedge: `posicao_snapshot`, `ptax_historico`, `ndf_registro`, etc.; StockBridge: `tbl_lotes_stockbridge`, `tbl_movimentos_stockbridge`, etc.).

Se módulos leem tabelas cruas uns dos outros, qualquer refactor interno de um módulo quebra outro — acoplamento implícito via schema. Se módulos se comunicam só por chamada de função in-process, resolvem comunicação mas não resolvem leitura de estado.

## Decisão

Cada módulo tem seu próprio schema Postgres (`hedge`, `stockbridge`, `comexflow`, etc.) para tabelas privadas. Quando um módulo precisa ler dados de outro, essa leitura acontece **apenas através de views publicadas em um schema `shared`**.

As views são o contrato público. Tabelas privadas são implementação.

## Consequências

- Refactor de tabela privada dentro de um módulo não quebra outros módulos enquanto a view correspondente no `shared` continuar respondendo o mesmo formato.
- A view vira documentação executável: olhando o `shared` você sabe exatamente o que cada módulo expõe.
- Migrations centralizadas em `packages/db/migrations/` criam tanto as tabelas privadas quanto as views do `shared`.
- OMIE permanece fonte de verdade para NFs, contas e cadastros — views do `shared` **não reescrevem** dados OMIE, só consolidam ou projetam.
- Tabelas OMIE existentes ficam no schema `public` (como estão hoje). Módulos leem delas diretamente apenas se forem dados OMIE nativos; dados derivados/calculados por outros módulos passam pelo `shared`.

## Alternativas rejeitadas

- **Cada módulo lê qualquer tabela de qualquer outro.** Rejeitado: acoplamento implícito, impossível refatorar nada sem cascata.
- **Toda leitura cross-módulo via chamada de função em TypeScript.** Rejeitado: não resolve queries analíticas, joins entre domínios ou dashboards agregadores (C-Level). Views SQL são a ferramenta certa pra esse problema.
