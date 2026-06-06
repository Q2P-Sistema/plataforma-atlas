# Resumo Executivo Mensal de TI — workflow n8n

Arquivo: [`resumo-mensal-ti-ia.json`](resumo-mensal-ti-ia.json)

Roda **todo dia 01, ~08h07**, consolida o **mês anterior** do projeto Jira `ACXEGDP`
(responsável = dono do token), gera o resumo executivo em HTML e envia por e-mail
para **flavio@livemind.com.br** e **flavio.endo@acxe-polimeros.com.br**.

## Fluxo

```
Schedule Dia 01
  ├─ Jira Concluidas    ┐  (GET /rest/api/3/search/jql, paginado via nextPageToken)
  ├─ Jira Criadas       ┤→ Preparar Dados → IA Sintese → Montar Email → Envia (SendGrid)
  └─ Jira Movimentadas  ┘     (Code: dados+      (Claude     (escolhe IA
                               fallback HTML)     opus-4-8)    ou fallback)
```

- **Paginação**: cada consulta Jira segue `nextPageToken` até `isLast`, sem teto de 100.
- **Síntese por IA**: a `IA Sintese` chama a API do Claude (`claude-opus-4-8`) e devolve o
  HTML com a análise agrupada por frente temática.
- **Degradação graciosa**: se a `IA Sintese` falhar (sem chave, timeout, erro), o nó
  `Montar Email` usa o **fallback HTML determinístico** (métricas + tabela de concluídas +
  lista de abertas). O e-mail sai de qualquer forma.

## Setup (1 vez)

### 1. Credencial do Jira — `Jira LiveMind (API token)`
- Gere um token em https://id.atlassian.net/manage-profile/security/api-tokens
- n8n → Credentials → New → **Basic Auth** → nome exatamente `Jira LiveMind (API token)`
  - **User** = `flavio@livemind.com.br`  ·  **Password** = o token

### 2. Credencial da Anthropic (opcional, p/ a síntese IA) — `Anthropic API (x-api-key)`
- Pegue uma API key em https://console.anthropic.com (Settings → API Keys)
- n8n → Credentials → New → **Header Auth** → nome `Anthropic API (x-api-key)`
  - **Name** = `x-api-key`  ·  **Value** = a API key
- *Se pular esta etapa*, o workflow ainda funciona — cai no relatório mecânico (fallback).

### 3. Importar e ativar
- n8n → Import from File → `resumo-mensal-ti-ia.json`
- Selecione a credencial Jira nos 3 nós `Jira *` (vêm com placeholder `REPLACE_JIRA_CRED`)
- Selecione a credencial Anthropic no nó `IA Sintese` (placeholder `REPLACE_ANTHROPIC_CRED`)
- **Active = ON**

## A validar no editor na primeira execução
- **Paginação** dos nós Jira: o bloco está em `options.pagination`. Confirme que segue as
  páginas (rode "Execute Node" e veja se vêm todos os itens). O schema de paginação pode
  variar entre versões do n8n.
- **`IA Sintese`**: o corpo é montado por expressão (`JSON.stringify(...)`). Rode uma vez e
  confira que retorna `content[0].text` com HTML.

## Notas
- SendGrid reusa a credencial existente `SendGrid account`; remetente `sistema@q2p.com.br`.
- Os dados do Jira **não estão no Postgres** de vocês — por isso o workflow bate direto na
  API REST do Jira Cloud (Basic Auth com API token).
