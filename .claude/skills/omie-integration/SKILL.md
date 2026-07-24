---
name: omie-integration
description: Use ao mexer em integração OMIE do StockBridge — chamadas IncluirAjusteEstoque, ListarAjusteEstoque, retentativas de operações pendentes, modo mock. Cobre idempotência via cod_int_ajuste, fluxo dual ACXE→Q2P, estados pendente_q2p e pendente_acxe_faltando, e exceção documentada ao Princípio II. Ative quando o usuário mencionar "OMIE", "ajuste de estoque", "cod_int_ajuste", "pendente_q2p", "retentar", "OMIE_MODE", ou estiver editando arquivos em packages/integrations/omie/ ou modules/stockbridge/src/services/.
---

# OMIE Integration (StockBridge)

Padrões para escrever código que fala com a API OMIE, garantindo idempotência e tratamento correto de falhas parciais.

## 1. Por que existe um cliente OMIE (exceção ao Princípio II)

O Princípio II do projeto manda **ler do espelho Postgres, não da API OMIE**. StockBridge tem exceção documentada em [specs/007-stockbridge-module/research.md](specs/007-stockbridge-module/research.md) (seção 2): precisa **escrever** em `estoque/ajuste/`, `produtos/pedidocompra/` e **ler NF individual** em `produtos/nfconsultar/`. OMIE não oferece webhook de saída — sem isso, não há como persistir movimentos sem chamar a API.

**Não estenda essa exceção sem justificar em spec.** Se você está prestes a chamar OMIE para *ler* algo que existe no espelho Postgres, pare e use `getPool()` na view/tabela `public.*`.

## 2. Estrutura do cliente

Toda comunicação OMIE passa por [packages/integrations/omie/src/](packages/integrations/omie/src/):

```
packages/integrations/omie/src/
├── client.ts                    # HTTP wrapper + isMockMode()
├── index.ts
└── stockbridge/
    ├── ajuste-estoque.ts        # incluirAjusteEstoque
    ├── listar-ajuste-estoque.ts # listarAjusteEstoque
    ├── nf.ts                    # consultarNF
    ├── pedido-compra.ts         # alterarPedidoCompra
    └── mock.ts                  # fixtures OMIE_MODE=mock
```

Wrappers de alto nível com idempotência ficam em [modules/stockbridge/src/services/omie-idempotente.ts](modules/stockbridge/src/services/omie-idempotente.ts). **Sempre prefira esses wrappers** — não chame `incluirAjusteEstoque` cru de fluxos de negócio.

## 3. Idempotência via `cod_int_ajuste` — regra de ouro

Todo `IncluirAjusteEstoque` deve enviar `cod_int_ajuste` derivado de `op_id`. Nunca passe string ad-hoc.

**Construção** (definida em [modules/stockbridge/src/types.ts](modules/stockbridge/src/types.ts)):

```typescript
export const COD_INT_AJUSTE_SUFIXO = {
  acxeTrf: 'acxe-trf',          // ACXE: transferência de filial (TRF)
  q2pEnt: 'q2p-ent',            // Q2P: entrada (ENT)
  acxeFaltando: 'acxe-faltando', // ACXE: ajuste de saída quando NF chega depois
} as const;

export function buildCodIntAjuste(opId: string, sufixo: CodIntAjusteSufixo): string {
  return `${opId}:${sufixo}`;
}
```

**Uso correto** (de [modules/stockbridge/src/services/recebimento.service.ts](modules/stockbridge/src/services/recebimento.service.ts)):

```typescript
const acxeRes = await incluirAjusteIdempotente(
  'acxe',
  buildCodIntAjuste(args.opId, COD_INT_AJUSTE_SUFIXO.acxeTrf),
  { /* ...input... */ },
);

const q2pRes = await incluirAjusteIdempotente(
  'q2p',
  buildCodIntAjuste(args.opId, COD_INT_AJUSTE_SUFIXO.q2pEnt),
  { /* ...input... */ },
);
```

**Adicionar novo sufixo** exige:

1. Estender constante `COD_INT_AJUSTE_SUFIXO` em `types.ts`
2. Estender migration nova (ver skill `stockbridge-migration`) para acomodar novo `status_omie` se necessário
3. Atualizar handler em `operacoes-pendentes.service.ts`
4. Documentar no CLAUDE.md

## 4. Fluxo dual ACXE→Q2P e estados parciais

`executarAjusteOmieDual` chama OMIE serial: ACXE primeiro, Q2P depois. Falha em qualquer ponto produz estado conhecido:

| Estado em `movimentacao.status_omie` | Significado | Quem pode retentar |
|---|---|---|
| `concluida` | Ambos OK | — |
| `pendente_q2p` | ACXE ok, Q2P falhou | Operador (1x), gestor+ (sem limite) |
| `pendente_acxe_faltando` | NF chegou tardia, precisa ajustar saída ACXE | Apenas gestor+ |
| `falha` | Marcado como falha definitiva | — (terminal) |

Handler em [modules/stockbridge/src/services/operacoes-pendentes.service.ts](modules/stockbridge/src/services/operacoes-pendentes.service.ts):

```typescript
if (mov.statusOmie === 'pendente_q2p') {
  return retentarQ2p({ mov, ator: input.ator });
}
if (mov.statusOmie === 'pendente_acxe_faltando') {
  return retentarAcxeFaltando({ mov, ator: input.ator });
}
```

**Novo estado parcial** = nova condição neste switch + novo sufixo `cod_int_ajuste` + nova migration ampliando o CHECK constraint.

## 5. Endpoints administrativos

Painel de pendências em [modules/stockbridge/src/routes/operacoes-pendentes.routes.ts](modules/stockbridge/src/routes/operacoes-pendentes.routes.ts):

| Método | Rota | Auth | Função |
|---|---|---|---|
| GET | `/api/v1/stockbridge/operacoes-pendentes` | `requireGestor` | Lista movimentações com `status_omie != 'concluida'` |
| POST | `/api/v1/stockbridge/operacoes-pendentes/:id/retentar` | `requireOperador` | Retry idempotente; operador limitado a 1x |
| POST | `/api/v1/stockbridge/operacoes-pendentes/:id/marcar-falha` | `requireGestor` | Marca como falha terminal (com motivo) |

Operador atinge limite → `OperadorSemRetentativasError`. Gestor+ sem limite. Cobertura simétrica em `aprovacao.aprovar()`.

## 6. `OMIE_MODE=mock` para dev/teste

Detector em [packages/integrations/omie/src/client.ts](packages/integrations/omie/src/client.ts):

```typescript
export function isMockMode(): boolean {
  return (process.env.OMIE_MODE ?? 'real') === 'mock';
}
```

Em modo mock, fixtures vêm de [packages/integrations/omie/src/stockbridge/mock.ts](packages/integrations/omie/src/stockbridge/mock.ts) — mantém lista em-memória `ajustesRegistrados` que `mockListarAjusteEstoque` filtra por `codIntAjuste` para preservar idempotência.

**Em testes**, sempre:

```typescript
beforeEach(() => {
  process.env.OMIE_MODE = 'mock';
  __resetMockState();
});
```

Use `__injectMockAjuste()` para simular ajuste pré-existente (cenário "OMIE já processou, retry deve ser no-op"). Exemplo em [packages/integrations/omie/src/__tests__/mock.test.ts](packages/integrations/omie/src/__tests__/mock.test.ts).

**Em prod**, OMIE_MODE deve ser `real` e exige variáveis: `OMIE_ACXE_KEY`, `OMIE_ACXE_SECRET`, `OMIE_Q2P_KEY`, `OMIE_Q2P_SECRET`. Sem essas, o app sobe mas chamadas reais quebram.

## 7. Princípios de implementação

- **Sempre** use `incluirAjusteIdempotente` em vez de `incluirAjusteEstoque` cru.
- **Nunca** invente um `cod_int_ajuste` à mão — use `buildCodIntAjuste(opId, sufixo)`.
- **Nunca** chame OMIE para *ler* dado que está no espelho Postgres (`public.*`). Exceção: NF individual via `produtos/nfconsultar/` (já justificado).
- **Estado parcial é normal**: trate `pendente_q2p` e `pendente_acxe_faltando` como caminhos felizes, não como erro a esconder.
- **Retry sempre passa pelo handler**, nunca direto pelo cliente — handler resolve `localidadeCorrelacao` e reconstrói input antes de chamar OMIE.
- **Saídas automáticas via n8n** exigem `ATLAS_INTEGRATION_KEY` (shared secret) e workflow importado de [workflows/stockbridge-saida-automatica.json](workflows/stockbridge-saida-automatica.json).

## Referências do projeto

- [packages/integrations/omie/src/client.ts](packages/integrations/omie/src/client.ts)
- [packages/integrations/omie/src/stockbridge/](packages/integrations/omie/src/stockbridge/)
- [modules/stockbridge/src/services/omie-idempotente.ts](modules/stockbridge/src/services/omie-idempotente.ts)
- [modules/stockbridge/src/services/recebimento.service.ts](modules/stockbridge/src/services/recebimento.service.ts)
- [modules/stockbridge/src/services/operacoes-pendentes.service.ts](modules/stockbridge/src/services/operacoes-pendentes.service.ts)
- [modules/stockbridge/src/routes/operacoes-pendentes.routes.ts](modules/stockbridge/src/routes/operacoes-pendentes.routes.ts)
- [modules/stockbridge/src/types.ts](modules/stockbridge/src/types.ts) — constantes `COD_INT_AJUSTE_SUFIXO`
- [specs/007-stockbridge-module/tasks-idempotencia-omie.md](specs/007-stockbridge-module/tasks-idempotencia-omie.md)
- [specs/007-stockbridge-module/arquitetura-atlas-camada-omie.md](specs/007-stockbridge-module/arquitetura-atlas-camada-omie.md)
