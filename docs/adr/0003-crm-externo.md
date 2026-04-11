# ADR-0003: CRM Q2P como integração HTTP externa

**Status:** Aceito
**Data:** 2026-04-11

## Contexto

O CRM Q2P é operado por outra empresa contratada. No plano original rodava em `:3001` como "mais um microserviço", mas na prática ele é externo ao Atlas em três sentidos:
1. Código não é nosso, não vive no nosso repositório.
2. Deploy não é nosso, não roda na nossa VPS Swarm.
3. Ciclo de release é independente — eles podem atualizar o CRM sem nos avisar.

Tratá-lo como "mais um módulo" cria a ilusão de que podemos confiar nele como código interno. Não podemos.

## Decisão

CRM Q2P fica **fora** do monorepo Atlas. A comunicação acontece via cliente HTTP dedicado em `integrations/crm/`, autenticado com `x-api-key`.

Todas as garantias que **não** aplicamos aos módulos internos **são obrigatórias** aqui:
- Timeout configurável.
- Retry com backoff em erros transitórios.
- Fallback gracioso quando o CRM está indisponível — o Atlas nunca para de funcionar por causa do CRM.
- Circuit breaker para evitar cascata de falhas.
- Logging explícito de toda chamada cruzada (auditoria e debugging de integração).

## Consequências

- `integrations/crm/` é o único lugar no Atlas onde fallback gracioso e x-api-key fazem sentido. Entre módulos internos, essas coisas não existem.
- Se o CRM cair, módulos que dependem dele (recebíveis, pipeline comercial) degradam graciosamente — mostram "dados de CRM indisponíveis" em vez de quebrar a página inteira.
- Qualquer módulo interno que precisar de dados do CRM importa o cliente de `@atlas/integration-crm`, nunca faz chamada HTTP direta.

## Alternativas rejeitadas

- **CRM dentro do monorepo como `modules/crm`.** Rejeitado: código não é nosso, e tratar integração externa como código interno apaga a distinção crítica entre "confio" e "não confio".
