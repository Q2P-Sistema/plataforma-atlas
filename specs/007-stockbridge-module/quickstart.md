# Quickstart: StockBridge

**Feature**: 007-stockbridge-module

Como rodar, testar e habilitar o StockBridge em desenvolvimento.

## Pre-requisitos

- Node.js 20 LTS + pnpm
- Docker Desktop (ou equivalente) com PostgreSQL 16 + Redis 8
- Acesso ao `pg-atlas-dev` (credenciais no `.env`)
- Acesso ao `mysql-q2p` (apenas para script de migracao; nao necessario em dev normal)
- Credenciais OMIE sandbox ou producao (par app_key + app_secret) para ACXE e Q2P

## 1. Habilitar o modulo em dev

```bash
# .env local
MODULE_STOCKBRIDGE_ENABLED=true
```

Sem esta flag, o router nao e registrado em `apps/api/src/modules.ts` e a rota `/stockbridge/*` nao aparece no menu do `apps/web`.

## 2. Executar migrations

```bash
pnpm --filter @atlas/db migrate
```

Isso aplica `0008_stockbridge_core.sql` + `0009_stockbridge_views.sql` em `pg-atlas-dev`.

Verificar:
```sql
SELECT table_name FROM information_schema.tables WHERE table_schema = 'stockbridge' ORDER BY table_name;
-- Esperado: 8 tabelas
```

## 3. Migrar dados do MySQL legado (opcional em dev)

Use apenas se voce quer popular o ambiente de dev com os dados reais do legado. Caso contrario, os seeds da migration criam localidades basicas.

```bash
pnpm --filter @atlas/stockbridge migrate-from-mysql --dry-run
# Inspecione o log, confirme as contagens.

pnpm --filter @atlas/stockbridge migrate-from-mysql
# Executa a migracao de fato
```

O script le do `mysql-q2p` e escreve no `pg-atlas-dev`. Variaveis esperadas:
```bash
# .env
MYSQL_Q2P_HOST=database-01
MYSQL_Q2P_USER=claude_readonly
MYSQL_Q2P_PASS=<senha>
MYSQL_Q2P_DB=db_q2p
```

## 4. Configurar credenciais OMIE

```bash
# .env
OMIE_API_URL=https://app.omie.com.br/api/v1/
OMIE_ACXE_KEY=<app_key>
OMIE_ACXE_SECRET=<app_secret>
OMIE_Q2P_KEY=<app_key>
OMIE_Q2P_SECRET=<app_secret>
```

Para desenvolvimento local sem credenciais reais, usar `OMIE_MODE=mock` — a integracao retorna respostas sinteticas.

## 5. Subir API e Web

```bash
pnpm dev
# API em http://localhost:3001
# Web em http://localhost:5173
```

Acessar `/stockbridge` apos login. Submenu depende do perfil do usuario logado (operador/gestor/diretor).

## 6. Rodar testes

```bash
pnpm --filter @atlas/stockbridge test
```

Esperado:
- `motor.test.ts` — calculos puros (saldos, cobertura, criticidade, conversao de unidade)
- `recebimento.test.ts` — fluxo completo com mock OMIE
- `aprovacao.test.ts` — aprovacao/rejeicao/re-submissao
- `debito-cruzado.test.ts` — cenarios de CNPJ faturador != CNPJ fisico
- `correlacao.test.ts` — match de descricao (casos positivos e negativos)

Cobertura minima: 90% em services financeiros.

## 7. Smoke test end-to-end

```bash
# Criar localidade
curl -X POST http://localhost:3001/api/v1/stockbridge/localidades \
  -H "Cookie: session=..." \
  -H "Content-Type: application/json" \
  -d '{"codigo":"11.1","nome":"SANTO ANDRE","tipo":"proprio","cnpj":"Acxe Matriz","cidade":"Santo Andre"}'

# Listar fila OMIE
curl -H "Cookie: session=..." http://localhost:3001/api/v1/stockbridge/fila

# Consultar cockpit
curl -H "Cookie: session=..." http://localhost:3001/api/v1/stockbridge/cockpit
```

## 8. Configuracao do polling n8n (dev)

Para testar o fluxo de saidas automaticas em dev:

1. Em n8n local: importar workflow `workflows/stockbridge-saida-automatica.json`
2. Configurar variaveis: URL do Atlas, `X-Atlas-Integration-Key`, credenciais OMIE
3. Executar manualmente para processar NFs de saida existentes

Em producao, o workflow roda com cron de 5 minutos.

## 9. Validacao paralela (pre-cutover)

Em ambiente de staging, enquanto o legado PHP ainda roda:

1. Habilitar `MODULE_STOCKBRIDGE_ENABLED=true` em staging
2. Operadores recebem NFs em **ambos** os sistemas (manual) durante 2 semanas
3. Comparar diariamente:
   - Contagem de movimentacoes no dia (deve bater)
   - `id_movest_acxe` e `id_movest_q2p` para mesma NF (devem ser iguais ou pelo menos ambos preenchidos com sucesso)
   - Triggers de email enviados nos mesmos casos
4. Investigar qualquer divergencia. Decisao final (cutover ou continuar) e de Flavio.

## 10. Cutover em producao

1. Comunicar operadores do horario (idealmente fim de expediente sexta).
2. Desabilitar acesso ao Apache do legado (firewall ou container stop).
3. Rodar `migrate-from-mysql` em producao.
4. Validar contagens com queries de sanity:
   ```sql
   SELECT COUNT(*) FROM stockbridge.movimentacao WHERE ativo = true;
   -- Deve bater com: SELECT COUNT(*) FROM tb_movimentacao WHERE ativo = 1 (MySQL)
   ```
5. Habilitar `MODULE_STOCKBRIDGE_ENABLED=true` em prod (deploy via Portainer).
6. Teste smoke no dia seguinte cedo — processar 1 NF real, verificar que OMIE retornou sucesso.
7. Monitorar Grafana dashboard `stockbridge-operacional` pela primeira semana.

## Troubleshooting

| Sintoma | Causa provavel | Acao |
|---|---|---|
| "PRODUTO_SEM_CORRELATO" ao receber NF | descricao do produto ACXE != Q2P | Admin cadastra produto na Q2P com descricao EXATA do ACXE; apos sync n8n, re-tentar |
| OMIE timeout | API OMIE indisponivel ou lenta | Verificar status API OMIE; recebimento nao fica em estado parcial (transacao aborta) |
| Operador nao ve nenhuma NF na fila | `armazem_id` nao setado no usuario | Diretor/admin atribui armazem em `shared.users` |
| Divergencia apos cutover entre Atlas e legado | Bug de portacao | Revisar logs, comparar com regras da procedure legada em `research.md` secao 10 |
