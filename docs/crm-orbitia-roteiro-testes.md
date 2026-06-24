# Roteiro de Testes — CRM OrbitIA

**Jira:** ACXEGDP-163 | **Batch atual:** 2 | **Última atualização:** 2026-06-22

> Legenda: ⚠️ = finding já registrado no Batch 1 | ✅ = validar se foi corrigido | 🆕 = novo cenário ainda não testado

---

## 1. AUTENTICAÇÃO E PERFIS

- 🆕 Login com perfil **vendedor** — consegue entrar normalmente?
    Sim
- 🆕 Login com perfil **admin** — consegue entrar normalmente?
    Sim
- 🆕 Esqueci minha senha — o fluxo funciona?
    Não existe ainda - anotar ACXEGDP-163
- 🆕 Sessão expira corretamente? O que acontece ao tentar usar após expirar?
    Não testado ainda
- 🆕 Um vendedor consegue acessar URLs de admin diretamente? (ex: `/admin/...`)
    Não testado ainda

---

## 2. DASHBOARD / TELA INICIAL

- 🆕 O que aparece na home para **vendedor**? Faz sentido para o dia a dia?
- 🆕 O que aparece na home para **admin**?
- 🆕 Os números/métricas exibidos no dashboard correspondem à realidade?
- 🆕 Algum card ou widget quebrado / sem dados?

---

## 3. METAS ⚠️ (Findings 1–4 — ACXEGDP-185)

- 🆕 Consegue criar uma meta nova do zero?
- 🆕 Consegue editar uma meta existente?
- 🆕 Consegue excluir uma meta?
- 🆕 Meta por período (mensal/trimestral) — o sistema suporta?
- 🆕 Meta por produto específico — o sistema suporta?
- ⚠️ Vendedor novo ainda não aparece na seleção? (Finding 1)
- ⚠️ "Travar" ainda não tem destravar? (Finding 2)
- 🆕 Ao atingir a meta, o sistema dá algum feedback/alerta?

---

## 4. CARTEIRA ⚠️ (Finding 8 — ACXEGDP-187)

- ✅ O erro 500 foi corrigido? Consegue abrir o detalhe de um cliente?
- 🆕 (Se abrir) Os dados do cliente estão corretos?
- 🆕 Histórico de pedidos do cliente aparece?
- 🆕 Histórico de contatos/visitas aparece?
- 🆕 Consegue filtrar/buscar clientes na carteira?
- 🆕 Clientes estão associados ao vendedor correto?
- 🆕 Admin consegue ver a carteira de todos os vendedores?

---

## 5. CADASTRO DE CLIENTE ⚠️ (Findings 5–7 — ACXEGDP-186)

- ✅ O erro ao salvar foi corrigido? Consegue cadastrar um cliente novo?
- 🆕 Campos obrigatórios estão claramente sinalizados?
- 🆕 CNPJ — tem validação de formato? Aceita CNPJ inválido?
- 🆕 CEP — preenche endereço automaticamente?
- 🆕 Consegue **editar** um cliente já cadastrado?
- 🆕 Consegue **inativar** um cliente? Ele some da carteira?
- 🆕 Clientes duplicados — o sistema avisa se o CNPJ já existe?
- ⚠️ "Limite de Crédito" ainda aparece para vendedor? (Finding 6)
- ⚠️ Contato ainda aceita só nome sem email/telefone? (Finding 7)
- ⚠️ Contato ainda não é editável após criação? (Finding 7)

---

## 6. AGENDA ⚠️ (Finding 9 — ACXEGDP-188)

- 🆕 Consegue criar um agendamento escolhendo a data manualmente?
- ⚠️ Agendamento criado — consegue editar agora? (Finding 9a)
- ⚠️ Ao clicar no cliente agendado, abre os dados dele? (Finding 9b)
- ⚠️ "Novo Acompanhamento" vai para a tela correta agora? (Finding 9c)
- 🆕 Consegue excluir um agendamento?
- 🆕 Agendamentos passados ainda aparecem na agenda?
- 🆕 Agenda exibe corretamente por dia / semana / mês?
- 🆕 Dois vendedores com agendamentos — admin consegue ver todos?

---

## 7. PEDIDOS ⚠️ (Findings 10–11 — ACXEGDP-189)

- ⚠️ Número do pedido está corrigido (bater com OMIE)? (Finding 11)
- ⚠️ Filtro de status funciona além de "Faturado"? (Finding 11)
- ⚠️ "Novo Pedido" aparece agora para o perfil vendedor? (Finding 10)
- 🆕 Consegue buscar pedidos por cliente?
- 🆕 Consegue buscar pedidos por período?
- 🆕 Detalhe do pedido exibe todos os itens corretamente?
- 🆕 Detalhe do pedido exibe o valor total correto?
- 🆕 Vendedor consegue ver apenas seus próprios pedidos?

---

## 8. NOVO PEDIDO ⚠️ (Finding 12 — ACXEGDP-189)

- ⚠️ Lista de produtos prioriza itens com estoque? (Finding 12)
- ⚠️ Paginação foi implementada? (Finding 12)
- ⚠️ Produtos não comercializáveis (ex: empilhadeira) foram filtrados? (Finding 12)
- ⚠️ Volume aceita kg agora? (Finding 12)
- ⚠️ Preço sugerido vem do preço de lista? (Finding 12)
- ⚠️ Cálculo do total está correto? (Finding 12)
- 🆕 Consegue **finalizar e enviar** um pedido? Ele aparece no OMIE?
- 🆕 Após enviar, o status do pedido atualiza?
- 🆕 Consegue **cancelar** um pedido em aberto?
- 🆕 Campo de observação/nota no pedido existe?

---

## 9. RELATÓRIOS (ainda não testado)

- 🆕 Existe algum menu de relatórios?
- 🆕 Relatório de vendas por período funciona?
- 🆕 Relatório por vendedor funciona?
- 🆕 Exportação para Excel/PDF funciona?

---

## 10. CONFIGURAÇÕES / ADMIN (ainda não testado)

- 🆕 Consegue criar um novo usuário vendedor?
- 🆕 Consegue redefinir a senha de um usuário?
- 🆕 Consegue inativar um usuário?
- 🆕 Consegue atribuir/alterar a carteira de um vendedor?
- 🆕 Configurações gerais do sistema — existe algo editável?

---

## Histórico de Batches

| Batch | Data | Findings | Subtarefas Jira |
|-------|------|----------|-----------------|
| Batch 1 | 17/06/2026 | 1–12 | ACXEGDP-185 a 189 |
| Batch 2 | em andamento | 13+ | — |
