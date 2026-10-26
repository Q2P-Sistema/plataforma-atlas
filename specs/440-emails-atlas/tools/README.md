# Ferramentas da comparação antes × depois (ACXEGDP-440)

Elas geraram o caderno `../Caderno_440_antes_depois.pdf`: os mesmos cenários rodados no código antigo e no novo, com o e-mail que iria ao SendGrid. Nada é enviado: o `sendEmail` é simulado.

| Arquivo | O que faz |
|---|---|
| `zz-harness-440.test.ts` | Roteiro vitest com os 52 cenários: dados fictícios (NF 90601) e destinatários de PROD de 25/10/2026. Grava um JSON por cenário em `$HARNESS_OUT/$HARNESS_TREE` |
| `compara.py` | Compara antes × depois: número de envios, retorno, Para/Cc/Cco e assunto. Roda o lint da 436 e gera as prévias HTML |
| `render.py` | Renderiza as prévias em PNG, com a faixa De/Para/Cc/Cco/Assunto |
| `caderno.py` + `caderno_intro.html` | Monta o PDF: a tabela com o quadro e uma página lado a lado por cenário |

## Como rodar de novo

1. Prepare duas worktrees: uma no commit antigo (`git worktree add --detach ../atlas-antes <sha>`) e outra nesta branch. Rode `pnpm install --frozen-lockfile --offline` nas duas.
2. Em cada uma, copie o roteiro para `modules/stockbridge/src/__tests__/` e rode-o (apague-o depois):
   `HARNESS_OUT=<pasta> HARNESS_TREE=antes|depois DATABASE_URL=postgres://t:t@localhost/t REDIS_URL=redis://localhost:6379 SESSION_SECRET=<32+ caracteres> npx vitest run src/__tests__/zz-harness-440.test.ts`
3. `python3 -I compara.py <pasta> <lint_corpo.py>`, depois `python3 -I render.py <pasta>` e por fim `python3 -I caderno.py <pasta> <saida.pdf>`.

## Dependências

- `lint_corpo.py` e `caderno_lib.py` estão em `backup-workflow-n8n/specs/436-emails/` (ACXEGDP-436). Os scripts apontam para o caminho desse repositório nesta máquina; ajuste o caminho em outra máquina.
- Chromium headless do Playwright (`~/.cache/ms-playwright`), Pillow, `pdfunite` e fontes Noto.
- O e-mail de senha (E22) entra no caderno por prévias geradas à parte, a partir de `buildPasswordResetEmail`.
