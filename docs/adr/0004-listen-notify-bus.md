# ADR-0004: Eventos cross-módulo via Postgres LISTEN/NOTIFY

**Status:** Aceito
**Data:** 2026-04-11

## Contexto

O ciclo de trânsito de uma carga atravessa vários módulos dentro do mesmo processo de negócio:

```
PO criado (ComexFlow) → Hedge abre título USD
Booking confirmado (ComexFlow) → ComexInsight inicia rastreio + Hedge marca em_aguas
Navio atraca (ComexInsight) → StockBridge aguarda escolha de armazém
StockBridge escolhe armazém → OMIE emite NF entrada → Hedge fixa câmbio
```

Cada seta é um evento cross-módulo. Como o Atlas é monólito modular (ADR-0001), esses eventos poderiam ser apenas chamadas de função in-process — mas queremos desacoplar **quem emite** de **quem consome** (evitar que ComexFlow importe Hedge só pra avisar dele).

Precisamos também de uma garantia crítica: **consistência transacional**. Se StockBridge grava a NF entrada e o Hedge precisa fixar câmbio, os dois efeitos têm que acontecer juntos ou nenhum — não pode haver janela onde a NF existe e o câmbio ficou esquecido.

## Decisão

Usar **Postgres `LISTEN/NOTIFY`** como bus de eventos cross-módulo, rodando **dentro do processo `apps/api`**. Um cliente `pg` dedicado fica conectado no boot do processo, escuta canais definidos por cada módulo, e despacha eventos pros handlers internos.

## Consequências

- **Consistência transacional grátis**: `NOTIFY` é emitido no `COMMIT` da transação. Se der `ROLLBACK`, ninguém nunca soube que o evento existiu. Zero risco de evento fantasma.
- **Zero infra nova**: já temos Postgres, já temos processo Node. O cliente dedicado é só mais uma conexão.
- **Payload limitado a ~8KB**: eventos passam `{type, id}`, não objetos inteiros. O consumidor lê o estado real do banco. Isso força idempotência natural.
- **Restart perde eventos em trânsito**: se o `apps/api` reinicia no momento exato de um `NOTIFY`, o evento é perdido (LISTEN/NOTIFY não persiste). Mitigação: cada módulo reconcilia seu estado na inicialização, lendo do banco o que "deveria ter processado" e processando o que faltou. Idempotência > persistência do evento.
- **Uma conexão dedicada pro listener**: a lib `pg` resolve isso com `client.on('notification')` — padrão conhecido, nada exótico.

## Alternativas rejeitadas

- **Redis pub/sub.** Mesmo problema de persistência, mais infra pra manter. Pra garantir a mesma consistência transacional precisaria implementar outbox pattern (tabela de eventos + worker) — mais código pra solução igual.
- **HTTP entre módulos.** Traz de volta toda a dor de microserviços (timeouts, autenticação, fallback, x-api-key) que o ADR-0001 matou.
- **Chamada de função direta entre módulos.** Funciona, mas acopla o emissor ao consumidor — quem emite o evento precisa importar todos os handlers. Não escala quando um mesmo evento tem 3+ consumidores.

## Futuro

Se um dia o volume crescer (hoje são dezenas de eventos por dia, não milhares por segundo) ou precisarmos de replay histórico, migrar pra **outbox pattern + Redis Streams**. Redis 8 já tem Streams first-class, então o upgrade é direto sem trocar ferramenta.
