# ADR-0005: Deploy "Opção A" — `apps/api` único com módulos habilitados por feature flag

**Status:** Aceito
**Data:** 2026-04-11

## Contexto

Requisitos do Flavio pro deploy:

1. Docker Swarm na infra existente (1 VPS manager + 1 VPS database), gerenciado via Portainer com stack yaml.
2. Traefik como reverse proxy (já em uso).
3. **Deploy incremental por módulo**: conforme um módulo fica pronto, colocar em produção sem esperar os outros. Hedge sobe primeiro, depois StockBridge, etc.
4. Identidade visual única em todo o conjunto (mesmo quando só um módulo estiver no ar).

O desenho inicial considerado foi "um `apps/api-hedge`, `apps/api-stockbridge`, ..." — uma imagem Docker por módulo, cada um com seu container no Swarm. Parecia combinar com "deploy incremental", mas é complexidade prematura: 7 containers no Swarm, 7 pipelines de build, 7 targets Traefik, 7 vezes o custo operacional. Nada disso é necessário pro volume atual da operação.

## Decisão

**Um único `apps/api`** (TypeScript + Express) importa módulos de `modules/*` via registradores internos. Um arquivo de configuração (`.env` ou similar) define quais módulos estão habilitados. No boot, `apps/api` registra rotas apenas dos módulos habilitados.

**Um único `apps/web`** (React + Vite) serve o shell completo. Rotas de módulos não habilitados ficam ocultas do menu ou mostram "em breve".

**Deploy incremental = habilitar módulo via flag + redeploy do container `api`.** Usuário final vê exatamente o mesmo comportamento (Hedge vai ao ar, depois StockBridge vai ao ar, etc.), com uma fração da complexidade de infra.

### Topologia no Swarm

```
Traefik → / → container apps/web (nginx:alpine servindo build Vite)
Traefik → /api/* → container apps/api (Node 20 + Express)
```

Apenas **dois** containers no stack yaml do Atlas. `apps/api` abre uma conexão dedicada pro listener LISTEN/NOTIFY dentro do próprio processo (ADR-0004) — zero container extra.

## Consequências

- **Simples operacionalmente**: 2 containers, 2 builds, 2 labels Traefik. Flavio consegue gerenciar sozinho sem ceremônia.
- **LISTEN/NOTIFY roda in-process**, não precisa daemon separado.
- **Módulos não escalam independentemente**: se um dia o Hedge precisar de mais CPU que os outros, aumentar recursos afeta todos. Aceito pro volume atual, não é requisito real.
- **Um bug que trava o processo `api` derruba todos os módulos habilitados**. Compensado por: (a) volume baixo, (b) monitoramento, (c) o trade-off contra a complexidade de 7 containers é claramente favorável.
- **Redeploy incremental ainda funciona**: mudar feature flag e dar `docker service update` é rápido, previsível, reversível.

## Alternativas rejeitadas

- **Múltiplos `apps/api-*`, um por módulo.** Descartado como prematuramente complexo. A ganho teórico (isolamento de processo, escalabilidade independente) não se traduz em valor real pro volume e equipe atuais. Se algum dia um módulo precisar ser extraído, o padrão `modules/*` com `index.ts` público torna a extração mecânica.

## Futuro

Se um módulo específico crescer a ponto de justificar isolamento (ex: Hedge batendo câmbio em tempo real com carga alta), extrai **aquele** em um `apps/api-hedge` separado e mantém os outros no `apps/api` compartilhado. Regra: extrair é opção, não obrigação.
