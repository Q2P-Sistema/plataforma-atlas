# Importando o Workflow de Saídas Automáticas no n8n

> **Objetivo**: Publicar o workflow `StockBridge — Saidas Automaticas OMIE` no n8n para polling de NFs e integração com Atlas.
>
> **Audience**: DevOps / Arquiteto responsável por deploy do n8n
>
> **Última revisão**: 2026-06-09

---

## Pré-requisitos

- Acesso ao n8n (`conector.q2p.com.br`) com permissão de importar workflows
- Arquivo JSON do workflow: `workflows/stockbridge-saida-automatica.json` do repositório Atlas
- Credenciais OMIE (ACXE e Q2P) já configuradas no n8n como "credentials"
- URL pública do Atlas acessível de dentro do n8n

---

## Passo a passo

### 1. Preparar credenciais OMIE no n8n

No n8n (`Workflows` → `Credentials`), crie ou confirme as credenciais:

| Nome | Tipo | Valores |
|---|---|---|
| `OMIE_ACXE_KEY` | Generic credential text | `<app_key OMIE ACXE>` |
| `OMIE_ACXE_SECRET` | Generic credential text | `<app_secret OMIE ACXE>` |
| `OMIE_Q2P_KEY` | Generic credential text | `<app_key OMIE Q2P>` |
| `OMIE_Q2P_SECRET` | Generic credential text | `<app_secret OMIE Q2P>` |

Essas credenciais serão injetadas via `$env` nos nós HTTP do workflow.

### 2. Importar o workflow JSON

Na interface do n8n:

1. Clique em **"Workflows"** → **"Import"** (ou ⚙️ Settings → Import from file)
2. Selecione `workflows/stockbridge-saida-automatica.json`
3. O n8n detectará os nós e fará parsing do JSON
4. Revise os nós para garantir que as credenciais estão ligadas corretamente

### 3. Configurar variáveis de ambiente

O workflow espera essas variáveis de ambiente:

| Variável | Tipo | Exemplo | Observação |
|---|---|---|---|
| `OMIE_ACXE_KEY` | credential | (via node HTTP) | Injetada nos nós "OMIE ACXE - Listar NFs Saida" |
| `OMIE_ACXE_SECRET` | credential | (via node HTTP) | Idem |
| `OMIE_Q2P_KEY` | credential | (via node HTTP) | Idem, para Q2P |
| `OMIE_Q2P_SECRET` | credential | (via node HTTP) | Idem |
| `ATLAS_URL` | env var | `https://uat-atlas.q2p.com.br` (UAT) ou `https://atlas.q2p.com.br` (prod) | URL da API Atlas |
| `ATLAS_INTEGRATION_KEY` | env var | `>=16 chars, compartilhado com `ATLAS_INTEGRATION_KEY` na stack Atlas` | Shared secret para validação de webhook |

### 4. Testar o workflow

Antes de publicar:

1. Abra o workflow em modo de edição
2. Clique em **"Execute"** (play button)
3. Observe a execução:
   - Nó "Cron 5min" salta (skip) em modo de teste; para testar via cron, clique em "Execute" novamente após 5 minutos
   - Nó "Calcular janela" deve retornar datas válidas
   - Nós "OMIE ACXE - Listar NFs Saida" e "OMIE Q2P" fazem chamadas reais ao OMIE — verifique se o JSON retorna "nfs_encontradas"
   - Nó "Normalizar NFs" converte para o formato esperado por Atlas
   - Nó "POST Atlas StockBridge" envia para `ATLAS_URL/api/v1/stockbridge/saida-automatica/processar`

**Resultado esperado** (caso bem-sucedido):
```json
{
  "data": { "processado": true, "nfCount": N },
  "error": null
}
```

### 5. Publicar o workflow

1. Clique em **"Save"** (ou Ctrl+S)
2. Clique em **"Publish"** (ou toggle no topo do editor)
3. Workflow começa a rodar automaticamente a cada 5 minutos (definido no nó "Cron 5min")

---

## Monitoramento e troubleshooting

### Logs do n8n

Cada execução do workflow fica em `Workflows → Executions`. Procure por:

- **Falhas de OMIE** — se `OMIE_*_KEY/SECRET` estão incorretos, o nó HTTP retorna `401`
- **Timeout** — se OMIE está lento, aumentar `options.timeout` em cada nó HTTP
- **Falhas de Atlas** — se `ATLAS_URL` ou `ATLAS_INTEGRATION_KEY` incorretos, a resposta é `401` ou `503`

### Endpoint de saúde do workflow

Não há endpoint de health específico, mas você pode:

1. Verificar na UI do n8n se o workflow está "Ativo" (verde)
2. Consultar o painel de Executions para tempo decorrido e status
3. No Atlas, verificar se a tabela `stockbridge.movimentacao` está recebendo novos registros com `tipo_movimento='saida_automatica'`

---

## Desmontagem (se precisar parar o workflow)

1. Abra o workflow em edição
2. Clique em **"Unpublish"** (desativa as execuções automáticas)
3. O workflow para de fazer polling, mas histórico de execuções é preservado

---

## Gotchas comuns

| Problema | Causa | Solução |
|---|---|---|
| Workflow não inicia a cada 5 min | Nó "Cron 5min" desabilitado | Clique no nó, verifique que está **não cinzento** |
| "INVALID_INTEGRATION_KEY" na resposta Atlas | `ATLAS_INTEGRATION_KEY` no n8n diferente da stack Atlas | Sincronize os valores (copie o mesmo secret) |
| Nenhuma NF retorna do OMIE | Sem NFs de saída no período (5 min) | Teste via UI Atlas com uma saída manual — deve aparecer aqui |
| Nó HTTP retorna `timeout` | OMIE sobrecarregado ou rede lenta | Aumentar `options.timeout` de 30s para 60s |

---

## Próximos passos

- [x] Workflow importado em n8n
- [ ] Testar com dados reais de saída OMIE (venda, remessa, transferência)
- [ ] Monitorar painel "Executions" do n8n por 1 hora
- [ ] Validar que `stockbridge.movimentacao` está crescendo com `tipo_movimento='saida_automatica'`
- [ ] Alertar em Grafana se execuções falharem por >3 ciclos consecutivos
