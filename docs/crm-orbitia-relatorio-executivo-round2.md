# CRM OrbitIA — Relatório Técnico Detalhado (Round 2)

**Período de Testes:** 22/06/2026 — 30/06/2026
**Data do Relatório:** 01/07/2026
**Total de Findings acumulados:** 49 (Round 1: F1–F12 · Round 2: F13–F49)
**Ponto de contato técnico:** Flavio Endo — flavio.endo@acxe-polimeros.com.br

---

## COMO LER ESTE DOCUMENTO

Cada finding está descrito com a seguinte estrutura, para facilitar a investigação e correção:

- **Área / Tela** — onde o problema ocorre
- **Perfil** — que tipo de usuário é afetado (vendedor, admin/gestor)
- **Severidade** — Crítica / Alta / Média / Baixa / Melhoria
- **Comportamento atual** — o que o sistema faz hoje (bug)
- **Comportamento esperado** — o que deveria fazer
- **Hipótese técnica / fonte de dados** — quando aplicável, pistas para o desenvolvedor

Convenção de unidades: **o OMIE opera exclusivamente em quilos (kg)**. Toda tela de pedido/volume deve usar kg. Esta é a origem de vários findings.

---

## 1. SUMÁRIO EXECUTIVO

### 1.1. Distribuição por severidade

| Severidade | Qtde | Findings |
|-----------|------|----------|
| 🔴 **Crítica (bloqueante)** | 8 | F23, F24, F31, F38, F39, F45, F46, F49 |
| 🟠 **Alta** | 9 | F13, F15, F16, F18, F19, F21, F22, F25, F27 |
| 🟡 **Média** | 9 | F14, F20, F26, F29, F30, F32, F33, F40, F48 |
| 🟢 **Baixa** | 8 | F34, F35, F36, F37, F41, F42, F43, F44 |
| 💡 **Melhoria** | 2 | F17, F47 |

### 1.2. Os 3 problemas de maior impacto (bloqueiam a operação em produção)

1. **Integração de Pedidos CRM → OMIE não funciona** (F38, F46, F23) — pedidos são "confirmados" na tela mas **nunca chegam ao OMIE**.
2. **Parametrização de Comissão impossível** (F39, F45) — a tabela de regras está vazia e **não é possível cadastrar novas regras**, zerando toda a remuneração (F31).
3. **Sincronização de Cliente CRM → OMIE não funciona** (F49) — cliente é "cadastrado" mas não vai ao OMIE e não fica buscável, impedindo criar pedido para ele.

Estes três compartilham um padrão comum descrito na seção 2.

---

## 2. ANÁLISE DE CAUSAS-RAIZ (padrões sistêmicos)

Os findings não são 49 problemas isolados. Eles se agrupam em **5 causas-raiz**. Corrigir a raiz resolve vários findings de uma vez.

### RAIZ A — Camada de integração CRM → OMIE falha silenciosamente
**Findings afetados:** F38, F46, F23, F49 (escrita); parcialmente F24, F22 (leitura de produtos)

**Sintoma comum:** o CRM exibe mensagem de sucesso ("Pedido enviado ao OMIE" / "Cliente cadastrado com sucesso"), mas a operação **não se concretiza no OMIE**. Nos pedidos, o registro fica apenas no histórico do CRM (2 pedidos de teste ficaram órfãos no CRM, ausentes no OMIE).

**Hipótese técnica:** a chamada à API do OMIE está falhando (erro de autenticação, payload inválido, timeout) mas o retorno de erro **não está sendo tratado** — o front-end assume sucesso independentemente da resposta. Não há confirmação real (ID retornado pelo OMIE) antes de exibir sucesso ao usuário.

**Comportamento esperado:**
- Sucesso só deve ser exibido após o OMIE retornar confirmação (ex: número do pedido/cliente gerado).
- O erro real da API do OMIE (status HTTP, corpo da resposta) precisa ser capturado e registrado.
- Em caso de falha, exibir mensagem clara e manter o registro em estado "pendente/erro" com opção de reenvio.

### RAIZ B — Lista de produtos incompleta e busca não-funcional
**Findings afetados:** F12, F18, F22, F24, F33, F37

**Sintoma comum:** a lista de "Produtos Disponíveis" nas telas de pedido é incompleta — produtos que existem no OMIE **com estoque** não aparecem (ex: `PEAD EM5333AAH`). A busca textual não filtra por código nem descrição (só os botões de família funcionam). Não há filtro por estoque nem exibição de saldo.

**Hipótese técnica:** pode haver (a) um filtro implícito removendo produtos (categoria/estoque), (b) limite de registros sem paginação (só retorna ~50-60), ou (c) query de busca com lógica incorreta (não busca por código/descrição). Investigar a query que popula a lista e a que responde à busca.

**Fonte de dados sugerida para saldo:** `public."tbl_posicaoEstoque_Q2P"` ou a view unificada de saldo.

### RAIZ C — Configuração de Comissão inexistente e não-cadastrável
**Findings afetados:** F39 (raiz), F45, F31, F28

**Sintoma comum:** a tela `Configurações → Comissão` exibe "Nenhuma configuração de comissão cadastrada" — a tabela está **vazia**. Pior: não é possível **cadastrar** novas regras (F45). Como consequência, todos os vendedores aparecem com comissão R$ 0 mesmo superando a meta (F31: Danilo, R$ 1,69M, 112,3%).

**Não é bug de cálculo — é falta de parametrização + bloqueio no cadastro.** Resolver F45 (habilitar o cadastro) e preencher a tabela resolve F31 e F28 automaticamente.

### RAIZ D — Ausência de validação e feedback nos formulários
**Findings afetados:** F5, F23, F25, F30, F35, F36, F29

**Sintoma comum:** formulários (Novo Pedido, Fazer Pedido, Cadastro Cliente, Novo Acompanhamento, Registrar Atendimento) não validam campos obrigatórios antes de enviar e **não dão feedback** — nem de erro (campo faltando) nem de sucesso (confirmação). O usuário clica e "nada acontece", sem saber se funcionou.

**Comportamento esperado:** validação dos campos obrigatórios com destaque visual + feedback de sucesso/erro (toast). Ocorre de forma transversal, nas cinco telas listadas acima.

### RAIZ E — Inconsistência de unidade (toneladas vs kg)
**Findings afetados:** F4, F12, F19

**Sintoma comum:** telas de volume/pedido usam toneladas, enquanto o OMIE opera em kg. Além disso, o campo não aceita fracionados (0,2 t = 200 kg é impossível de lançar) e o cálculo do total não converte a unidade (1 t × R$1,00/kg resulta R$ 1,00 em vez de R$ 1.000,00).

**Decisão de negócio (definida no Round 2):** todos os campos de volume de pedido devem ser **fixos em kg, sem toggle** para toneladas.

---

## 3. FINDINGS DETALHADOS — ROUND 2 (F13–F49)

> Os findings do Round 1 (F1–F12) estão na seção 4 com seu status de validação. Aqui detalhamos os itens abertos do Round 2, que são o foco de correção.

### 🔴 BLOQUEANTES (Crítica)

---

#### F38 — Pedidos: falsa confirmação de envio ao OMIE
- **Área:** Novo Pedido / Fazer Pedido
- **Perfil:** Vendedor e Admin
- **Severidade:** 🔴 Crítica
- **Relacionado a:** F23, F46 (mesma raiz)

**Comportamento atual:** ao clicar em "Enviar ao OMIE", o sistema exibe mensagem de sucesso. Porém o pedido **nunca chega ao OMIE**. Comprovação: os 2 pedidos de teste criados aparecem no histórico do CRM, mas estão **ausentes no OMIE real**.

**Comportamento esperado:** confirmar o envio somente após o OMIE retornar sucesso; em caso de falha, exibir erro e permitir reenvio.

**Hipótese técnica:** ver RAIZ A. A integração falha silenciosamente e o front confirma sucesso sem validar a resposta da API.

**Onde investigar:** logs de integração com o OMIE — autenticação, payload enviado e resposta HTTP da API `produtos/pedidovenda` (ou equivalente).

---

#### F46 — Novo Pedido (admin): UX correta, mas integração OMIE falha igual
- **Área:** Painel Diretor → Novo Pedido
- **Perfil:** Admin
- **Severidade:** 🔴 Crítica
- **Relacionado a:** F38 (mesma raiz)

**Comportamento atual:** o fluxo do admin é **tecnicamente superior** ao do vendedor — a seleção de cliente funciona (combo box abre), a UX é mais madura. **Porém o pedido também não chega ao OMIE**, exatamente como em F38.

**Conclusão importante para o desenvolvedor:** como o problema ocorre em **dois fluxos diferentes** (vendedor e admin), a falha está na **camada de integração compartilhada CRM → OMIE**, não no front-end de cada tela. Isso reduz o escopo da investigação a um único ponto.

---

#### F23 — Fazer Pedido: falsa confirmação + sem histórico + campos obrigatórios faltando
- **Área:** Carteira → Atender → Fazer Pedido
- **Perfil:** Vendedor
- **Severidade:** 🔴 Crítica

**Três problemas combinados:**

1. **Falsa confirmação de envio** — mesma manifestação de F38 no fluxo do vendedor.
2. **Sem histórico ou rastreamento** — após "criar" o pedido, não fica registro nenhum (nem de sucesso, nem de falha). O pedido some da tela. O vendedor não consegue confirmar envio, ver o motivo de falha, reenviar, nem consultar histórico de operações.
3. **Campos obrigatórios ausentes no formulário** — o sistema não solicita informações que o OMIE exige:
   - **Data de entrega prevista**
   - **Tipo de frete** (afeta custo e responsabilidade de entrega)
   - Possivelmente outros conforme regra de negócio

**Comportamento esperado:** validar obrigatórios antes de enviar; manter histórico visível (mesmo de pedidos com erro); exibir erro claro com opção de reenvio; após sucesso, mostrar o número do pedido no OMIE.

---

#### F24 — Novo Pedido: combo box de cliente não funciona + produto com estoque não aparece
- **Área:** Novo Pedido
- **Perfil:** Admin
- **Severidade:** 🔴 Crítica
- **Relacionado a:** F22 (lista de produtos)

**Dois problemas:**

1. **Combo box de cliente inoperante** — o campo de seleção de cliente não abre/filtra/seleciona. Impede começar o pedido.
   - *(Observação: em F46 o combo do admin é descrito como funcional. Verificar se há duas telas distintas de "Novo Pedido" ou se o comportamento é intermitente — vale confirmar com o desenvolvedor.)*
2. **Produto com estoque não listado** — exemplo concreto: `PEAD EM5333AAH` existe no OMIE **com estoque**, mas não aparece na lista nem é encontrado pela busca. Ver RAIZ B.

---

#### F49 — Cadastro de Cliente: campos insuficientes + não sincroniza ao OMIE
- **Área:** Cadastro de Cliente
- **Perfil:** Vendedor / Admin
- **Severidade:** 🔴 Crítica
- **Consolida:** F5 (Round 1)

**Três problemas:**

1. **Campos obrigatórios insuficientes** — o formulário aceita apenas Nome, Razão Social e CNPJ. Faltam campos que o OMIE exige:
   - ❌ Telefone
   - ❌ Email
   - ❌ Nome de contato
   - Possivelmente outros exigidos pela API do OMIE
2. **Cliente não sincroniza ao OMIE** — o sistema exibe "Cliente cadastrado com sucesso", mas o cliente **não aparece na busca posterior** e **não chega ao OMIE**. Resulta em cliente "fantasma": existe no CRM, mas não é utilizável em pedidos.
3. **Validação parcial** — o sistema bloqueia cadastro sem CNPJ/nome (correto), mas não informa claramente o que é obrigatório.

**Comportamento esperado:**
- Formulário deve capturar os campos obrigatórios do OMIE (telefone, email, contato).
- Cliente deve sincronizar ao OMIE na criação (ver RAIZ A — mesmo problema de integração dos pedidos).
- Só marcar como sucesso após confirmação de criação no OMIE.
- Exibir erro claro se o OMIE rejeitar o cadastro.

---

#### F39 — Configurações → Comissão: tabela vazia (RAIZ do problema de comissão)
- **Área:** Painel Diretor → Configurações → Comissão
- **Perfil:** Admin
- **Severidade:** 🔴 Crítica

**Comportamento atual:** a tela exibe literalmente **"Nenhuma configuração de comissão cadastrada"**. A tabela que deveria conter as regras está completamente vazia:
- Base de comissão (R$/kg por família)
- Bônus de Volume (% ou valor por meta atingida)
- Bônus de Margem (% ou valor por faixa de margem)

**Causa raiz confirmada:** todos os vendedores recebem R$ 0 (F31, F28) **porque não há regra cadastrada** — não é bug de cálculo, é falta de parametrização inicial.

**Dependência:** o preenchimento da tabela depende de F45 (cadastro de regra) estar funcional. Enquanto a tabela estiver vazia, a comissão de todos os vendedores permanece zerada.

---

#### F45 — Configurações → Comissão: não é possível cadastrar nova regra
- **Área:** Painel Diretor → Configurações → Comissão
- **Perfil:** Admin
- **Severidade:** 🔴 Crítica
- **Bloqueia:** F39, F31, F28

**Comportamento atual:** o admin **não consegue criar** uma nova configuração de comissão. Ao tentar (botão "+ Nova Comissão" ou similar), a operação falha — botão não responde, formulário não abre/salva, ou há erro silencioso.

**Impacto em cadeia:** sem cadastrar regras (F45), é impossível preencher a tabela (F39), o que mantém a comissão de todos os vendedores zerada (F31, F28).

**Onde investigar:** o fluxo de criação de comissão — qual é o botão, o que ocorre ao clicar e a mensagem de erro (se houver).

---

#### F31 — Minha Remuneração: Danilo com R$ 1,69M em vendas (112,3%) e comissões zeradas
- **Área:** Menu Minha Remuneração
- **Perfil:** Vendedor (Danilo)
- **Severidade:** 🔴 Crítica
- **Causa:** F39 / F45

**Dados concretos:**
- Meta: 100% · Realizado: **112,3%** (superou) · Vendas: **R$ 1.690.000,00**
- Comissão Base: R$ 0,00 · Bônus Volume: R$ 0,00 · Bônus Margem: R$ 0,00 · **Total: R$ 0,00**

**Análise:** incoerência crítica — um vendedor com R$ 1,69M e 112,3% de meta deveria exibir ao menos comissão base + bônus de volume. Tudo zerado confirma a RAIZ C (tabela de comissão vazia / não cadastrável). **Resolver F39+F45 corrige este item automaticamente.** Risco: desconfiança do vendedor e conflito com RH/Financeiro.

---

### 🟠 ALTA PRIORIDADE

---

#### F13 — Autenticação: fluxo "Esqueci minha senha" inexistente
- **Área:** Tela de Login · **Perfil:** Qualquer · **Severidade:** 🟠 Alta

**Comportamento atual:** a tela de login não tem recuperação de senha. Se um usuário perde a senha, a única saída é intervenção manual de admin — inviável em produção.

**Comportamento esperado:** link "Esqueci minha senha" com envio de e-mail de redefinição.

---

#### F15 — Metas: lógica da meta global está invertida (bottom-up em vez de top-down)
- **Área:** Metas / Cockpit do Gestor · **Perfil:** Admin / Gestor · **Severidade:** 🟠 Alta

**Comportamento atual:** o cockpit calcula a "meta global da empresa" como a **soma das metas individuais** (bottom-up). Não há campo para definir a meta corporativa separadamente.

**Comportamento esperado (top-down):**
1. Gestor define a **meta global da empresa** (ex: R$ 1.000.000/mês).
2. Sistema **sugere distribuição** por vendedor (ex: proporcional ao histórico).
3. Gestor **edita** a meta de cada vendedor individualmente.
4. Sistema valida que **Σ metas individuais ≥ meta global** e alerta se houver gap.
5. Cockpit exibe: meta global, distribuição individual e % de cobertura (soma individual vs. global).

---

#### F16 — Usuários: tela permite criar novo usuário (não deveria)
- **Área:** Configurações → Gestão de Usuários · **Perfil:** Admin · **Severidade:** 🟠 Alta

**Comportamento atual:** a tela permite **criar** um novo usuário diretamente no CRM.

**Por que é um problema:** o OMIE não expõe API para criar vendedores/usuários externamente. O cadastro precisa ser feito **primeiro no OMIE**; só depois o usuário se torna disponível no CRM. Criar pelo CRM gera um usuário "fantasma" (existe no CRM, não no OMIE), quebrando a integridade de pedidos, carteira e metas.

**Comportamento esperado:**
- Remover o botão "Criar usuário".
- CRM deve listar apenas usuários já existentes no OMIE (sincronizados).
- Permitir **editar** apenas dados de acesso ao próprio CRM (perfil, permissões, carteira atribuída) — nunca dados do OMIE.

---

#### F18 — Novo Pedido: lista de produtos sem filtro de estoque e sem saldo
- **Área:** Novo Pedido — seleção de produtos · **Perfil:** Vendedor / Admin · **Severidade:** 🟠 Alta
- **Relacionado a:** F12, RAIZ B

**Comportamento atual:** a lista "Produtos Disponíveis" mostra todos os produtos, inclusive com estoque zero/negativo. Não há coluna de saldo — o vendedor não sabe quanto há disponível antes de digitar o volume.

**Comportamento esperado:** exibir apenas produtos com estoque > 0 (ou sinalizar claramente os sem estoque) e mostrar a **quantidade disponível** por produto (coluna "Saldo"/"Disponível").

**Fonte sugerida:** `public."tbl_posicaoEstoque_Q2P"` ou a view unificada de saldo.

---

#### F19 — Fazer Pedido: volume em toneladas e sem aceitar fracionados
- **Área:** Carteira → Atender → Fazer Pedido · **Perfil:** Vendedor · **Severidade:** 🟠 Alta
- **Relacionado a:** F12, RAIZ E

**Comportamento atual:** o campo de quantidade está em toneladas e **não aceita fracionados** (ex: `0,2`). Um pedido de 200 kg (0,2 t) é impossível de lançar.

**Comportamento esperado:** campo fixo em **kg** (sem toggle), aceitando inteiros e fracionados (`150`, `1500`, `750,5`). Em kg, a maioria dos pedidos deixa de precisar de fração.

---

#### F21 — Fazer Pedido: tipo "Imediato" não filtra por estoque disponível
- **Área:** Carteira → Atender → Fazer Pedido · **Perfil:** Vendedor · **Severidade:** 🟠 Alta
- **Relacionado a:** F19

**Comportamento atual:** ao escolher o tipo **"Imediato"**, a lista mostra todos os produtos, inclusive sem estoque. O vendedor pode criar um pedido imediato que não pode ser atendido.

**Comportamento esperado:**
- **Imediato** → filtrar apenas produtos com estoque > 0.
- **Futuro** → exibir todos (permite programar entrega futura).
- Exibir a quantidade disponível em cada linha.

---

#### F22 — Fazer Pedido / Novo Pedido: lista de produtos incompleta (produtos somem até na busca)
- **Área:** Fazer Pedido e Novo Pedido · **Perfil:** Vendedor / Admin · **Severidade:** 🟠 Alta
- **Relacionado a:** F12, F18, F24 — RAIZ B

**Comportamento atual:** a lista está incompleta. Produtos existentes no OMIE não aparecem na listagem inicial e, mais grave, **não são encontrados na busca** por nome ou código.

**Causas a investigar (RAIZ B):**
- Filtro automático (só "comercializáveis", só "com estoque", só uma categoria).
- Query de busca incorreta (substring, case-sensitive, sem match em campos auxiliares).
- Sincronização de produtos desatualizada/incompleta.
- Limite de registros sem paginação correta.

**Comportamento esperado:** listar todos os produtos comercializáveis; busca deve achar qualquer produto do OMIE por código, nome ou descrição.

---

#### F25 — Pedido: sem validação nem feedback ao enviar com dados incompletos
- **Área:** Novo Pedido / Fazer Pedido · **Perfil:** Vendedor / Admin · **Severidade:** 🟠 Alta
- **Relacionado a:** F23, RAIZ D

**Comportamento atual:** ao enviar com obrigatórios faltando (ex: cliente não selecionado), o sistema não exibe erro, não destaca o campo e não dá feedback. Operação silenciosa — o usuário não sabe se o pedido foi processado.

**Comportamento esperado:** validar antes de enviar; mensagem de erro clara indicando o campo faltante; destaque visual (borda vermelha/ícone); bloquear envio enquanto houver erro.

---

#### F27 — Estoque: discrepância de saldo (~600k kg) e origem de dados obscura
- **Área:** Menu Estoque · **Perfil:** Admin / Gestor · **Severidade:** 🟠 Alta

**Problema 1 — Discrepância de saldo:**
- Sistema exibe: **2.183.664 kg** de total em estoque.
- Relatórios reais: **~600.000 kg a MAIS** do que o sistema mostra.
- Investigar: há filtro automático ocultando produtos/galpões? (ex: filtrando só Q2P e excluindo ACXE, exclusão de categorias, produtos inativos ocultos, ou bases distintas OMIE vs. tabela local).

**Problema 2 — "Chegando em até 7 dias" sem origem clara:**
- A tela mostra **1.325 kg "chegando em até sete dias"** sem indicar a fonte. É pedido de compra em trânsito? Transferência entre galpões? Qual a lógica dos "7 dias"?

**Observações positivas:** nesta tela a lista de produtos está **bem mais completa** que nas telas de pedido (contraste com F12/F22/F24) e o estoque disponível é exibido corretamente — pode servir de referência para corrigir a RAIZ B.

**Sugestão:** filtro global para ocultar produtos com estoque zero em toda a plataforma.

---

### 🟡 MÉDIA PRIORIDADE

---

#### F14 — Listagens: ausência de ordenação por coluna
- **Área:** UX / Listagens (global) · **Perfil:** Admin / Vendedor · **Severidade:** 🟡 Média

**Comportamento atual:** as tabelas têm ordem fixa; não é possível ordenar por coluna (ex: lista de vendedores por nome, meta ou % atingido em Configurações).

**Comportamento esperado:** colunas clicáveis com toggle ascendente/descendente (padrão de tabela de gestão).

---

#### F20 — Cliente → Financeiro: título que vence HOJE é marcado como atraso
- **Área:** Detalhe do Cliente → seção Financeiro · **Perfil:** Admin / Vendedor · **Severidade:** 🟡 Média

**Comportamento atual:** títulos/boletos com vencimento **hoje** são marcados como "em atraso"/vencido.

**Comportamento esperado:** um título só está em atraso a partir de **D+1**. Vencimento hoje = ainda no prazo. Corrigir a comparação de datas (usar `> hoje`, não `>= hoje`). Impacta a acurácia das métricas de saldo e pendências.

---

#### F26 — Agenda: clicar no cliente agendado leva à Carteira sem filtrar
- **Área:** Menu Agenda · **Perfil:** Vendedor · **Severidade:** 🟡 Média
- **Relacionado a:** F9

**Comportamento atual:** ao clicar no nome do cliente agendado, o sistema vai para a Carteira (destino correto), mas **exibe a lista completa** em vez de abrir o cliente clicado.

**Comportamento esperado:** abrir diretamente o detalhe daquele cliente (ou aplicar filtro/busca automática por ele).

---

#### F29 — Registrar Atendimento: sem feedback de confirmação
- **Área:** Modal de Atendimento → aba Registrar · **Perfil:** Vendedor · **Severidade:** 🟡 Média
- **Relacionado a:** RAIZ D

**Comportamento atual:** ao clicar em "Registrar Atendimento", não há feedback visual/sonoro. O usuário não sabe se registrou, se houve erro silencioso, ou se precisa repetir (risco de registro duplicado).

**Comportamento esperado:** toast de sucesso ("Atendimento registrado com sucesso"); opcionalmente spinner durante o processamento; fechar modal ou limpar formulário ao concluir.

---

#### F30 — Cadastro de Cliente: formulário multi-aba sem progresso nem validação em tempo real
- **Área:** Cadastro de Cliente (Novo Prospecto/Cliente) · **Perfil:** Vendedor / Admin · **Severidade:** 🟡 Média
- **Relacionado a:** F5, F49, RAIZ D

**Contexto:** o formulário tem **4 abas** — (1) Dados Básicos, (2) Entrega, (3) Contatos, (4) Comercial.

**Comportamento atual:**
1. Sem indicador de progresso (não se sabe em qual aba se está).
2. Sem validação ao navegar entre abas — dá para avançar deixando obrigatórios em branco.
3. Erro só aparece ao tentar salvar no final — obriga a voltar às abas para achar o campo faltante.
4. Campos obrigatórios não sinalizados durante o preenchimento.

**Comportamento esperado:** indicador de progresso ("1 de 4"/barra); validar ao trocar de aba; asterisco nos obrigatórios; badge de erro na aba com problema; resumo de erros antes de salvar.

---

#### F32 — Agenda: sem visualização em calendário
- **Área:** Menu Agenda · **Perfil:** Vendedor · **Severidade:** 🟡 Média
- **Relacionado a:** F9

**Comportamento atual:** a Agenda mostra apenas uma **lista linear** de sugestões. Não há visão de calendário.

**Comportamento esperado:** visões de **Dia / Semana / Mês** com toggle, badges nos dias com agendamentos, para planejamento visual e identificação de conflitos. Hoje o vendedor precisa recorrer a ferramenta externa (Google Calendar/Outlook).

---

#### F33 — Novo Pedido: busca textual não filtra por código nem descrição
- **Área:** Novo Pedido — campo "Buscar Produto" · **Perfil:** Vendedor / Admin · **Severidade:** 🟡 Média
- **Relacionado a:** F12, F22 — RAIZ B

**Comportamento atual:** o campo aceita digitação mas não filtra:
- ❌ Por código (ex: "PP-146") — não funciona.
- ❌ Por descrição parcial (ex: "HPMD400R", "PP HOMO") — não funciona.
- ✅ Só os botões de família filtram.

**Comportamento esperado:** buscar por código, nome/descrição e família, atualizando resultados em tempo real.

---

#### F40 — Cockpit: alerta "EQUIPE ABAIXO DA META" persiste com mensagem zerada
- **Área:** Painel Diretor → Cockpit · **Perfil:** Admin · **Severidade:** 🟡 Média

**Comportamento atual:** o Cockpit exibe:
> ⚠️ EQUIPE ABAIXO DA META — Para fechar o mês, a equipe precisa entregar +R$0/dia e +0 kg/dia coletivos nos próximos **0 dias úteis**.

O gap real é **−R$ 3,9M** e **−627.403 kg**, mas a mensagem mostra "0 dias úteis" porque o mês já encerrou (30/06). O alerta vermelho de urgência continua disparando, embora não seja mais acionável. O sistema não distingue "meta não atingida no fim do mês" de "meta em risco no meio do mês".

**Comportamento esperado:** após o fim do mês, exibir resumo ("Meta de junho não atingida: faltaram R$ 3,9M — 84,2% vs. 100%"). Alertas de urgência só durante o mês, quando ainda há dias úteis.

---

#### F48 — Configurações → Capacidade: não exibe o valor atual registrado
- **Área:** Painel Diretor → Configurações → Capacidade · **Perfil:** Admin · **Severidade:** 🟡 Média

**Comportamento atual:** o campo de capacidade (limite diário de kg) não mostra o valor já registrado (ex: 120.000 kg). O admin não sabe o valor atual antes de editar.

**Comportamento esperado:** exibir o valor atual como pré-preenchido/placeholder ("Capacidade Logística Diária: [120.000] kg"), facilitando ajustes incrementais.

---

### 🟢 BAIXA PRIORIDADE

---

#### F34 — Tema claro/escuro dessincroniza ao alternar kg/toneladas
- **Área:** Metas / Dashboard · **Perfil:** Qualquer · **Severidade:** 🟢 Baixa

**Reprodução:** (1) ativar tema escuro; (2) clicar em "kg/toneladas"; (3) clicar no tema claro → o tema não responde como esperado, exigindo clique adicional. É dessincronização de estado interno do tema, sem impacto funcional.

---

#### F35 — Novo Pedido: envio sem "Entrega Prevista" não exibe erro
- **Área:** Novo Pedido · **Perfil:** Vendedor / Admin · **Severidade:** 🟢 Baixa
- **Relacionado a:** F23, F25 — RAIZ D

**Comportamento atual:** o campo "Entrega Prevista *" está marcado como obrigatório (asterisco), mas ao enviar sem preencher não há erro nem destaque — o pedido pode ir incompleto ao ERP.

**Comportamento esperado:** validar antes do envio, com toast/destaque, bloqueando até preencher.

---

#### F36 — Agenda: "Novo Acompanhamento" sem validação silenciosa
- **Área:** Agenda — modal "Novo Acompanhamento" · **Perfil:** Vendedor · **Severidade:** 🟢 Baixa
- **Relacionado a:** F9, F25 — RAIZ D

**Comportamento atual:** ao clicar "Agendar" sem preencher nada (sem cliente/data), o modal permanece aberto, sem erro nem destaque. O usuário acha que o botão não funciona.

**Comportamento esperado:** validar obrigatórios; erro claro ("Cliente e Data são obrigatórios"); destacar os campos vazios.

---

#### F37 — Estoque: busca por código expande a família inteira
- **Área:** Menu Estoque — busca · **Perfil:** Admin / Vendedor · **Severidade:** 🟢 Baixa
- **Relacionado a:** F33

**Comportamento atual:** buscar um código específico (ex: "PP-146") expande a **família inteira** ("PP HOMO 25", com os 4 produtos), sem filtrar o item exato.

**Comportamento esperado:** buscar "PP-146" exibe apenas o PP-146 (ou destaca-o dentro da família).

---

#### F41 — Cockpit: título desatualizado ao trocar de mês
- **Área:** Painel Diretor → Cockpit · **Perfil:** Admin · **Severidade:** 🟢 Baixa

**Comportamento atual:** ao trocar o mês no seletor, o subtítulo demora 1-2s para atualizar — mostra o mês antigo enquanto os dados abaixo já são do novo mês (risco de leitura errada momentânea).

**Comportamento esperado:** título e dados atualizam sincronamente.

---

#### F42 — Performance: cards de vendedor não são clicáveis
- **Área:** Painel Diretor → Performance · **Perfil:** Admin · **Severidade:** 🟢 Baixa

**Comportamento atual:** os cards de vendedor parecem clicáveis, mas não respondem. O gestor precisa ir manualmente a Pedidos e filtrar.

**Comportamento esperado:** card clicável levando ao drill-down do vendedor (Pedidos filtrados + evolução detalhada).

---

#### F43 — Cockpit/Performance: "Enviado via API" aparece como vendedor fantasma
- **Área:** Painel Diretor → Cockpit e Performance · **Perfil:** Admin · **Severidade:** 🟢 Baixa

**Comportamento atual:** aparece um "vendedor" chamado **"Enviado via API"** com Meta 315.200 kg, Meta R$ 3.307.906 e Realizado 0%. São pedidos integrados via API **sem vendedor associado**, que inflam a meta total da equipe e distorcem a cobertura.

**Comportamento esperado:** agrupar pedidos "sem vendedor" numa categoria administrativa separada, ou exigir associação de vendedor em todo pedido.

---

#### F44 — Ajuste de Preço: inoperante por falta de dados históricos
- **Área:** Painel Diretor → Ajuste de Preço · **Perfil:** Admin · **Severidade:** 🟢 Baixa

**Comportamento atual:** a seção de sugestões automáticas de reajuste exibe "Nenhuma sugestão pendente/aprovada". **Não é bug:** o fluxo que coleta "motivo de perda" (com preço do concorrente) ainda não foi usado pelos vendedores — sem dados de entrada, o motor não gera sugestões.

**Próximos passos:** treinar vendedores para registrar motivo de perda com preço do concorrente; após alguns dias de operação, as sugestões passam a aparecer. *(Item de adoção, não de correção.)*

---

### 💡 MELHORIAS (não são bugs)

---

#### F17 — Novo Pedido: aprimorar a fonte do "Limite Disponível"
- **Área:** Novo Pedido / Cadastro de Cliente · **Perfil:** Vendedor / Admin · **Tipo:** 💡 Melhoria

**Situação atual:** o campo "Limite Disponível" é lido de `public."tbl_cadastroFornecedoresClientes_Q2P"`, um valor **estático** de cadastro.

**Sugestão:** calcular o limite dinamicamente a partir de `public."tbl_limitesSeguroCreditoClientes"`.

**Fórmula sugerida:**
```
Limite Disponível = Limite Total Geral − (valores tomados: seguradora + molde + flow)
```
- Se o resultado for negativo → exibir **R$ 0,00** (nunca valor negativo na tela).

**Benefício:** o vendedor vê o limite de crédito real e dinâmico, reduzindo risco de pedidos acima da capacidade de crédito.

---

#### F47 — Configurações → Metas: duplicar metas do mês anterior
- **Área:** Painel Diretor → Configurações → Metas · **Perfil:** Admin · **Tipo:** 💡 Melhoria

**Situação atual:** para configurar o mês novo, o admin adiciona **cada vendedor individualmente** (31 vendedores = 31 operações do zero).

**Sugestão:** botão "📋 Duplicar metas de [mês anterior]" que copia todas as metas do mês anterior para edição — reduz ~90% das operações e evita esquecer de incluir algum vendedor. Validar que o mês anterior tem metas e confirmar antes de duplicar.

---

## 4. VALIDAÇÃO DO ROUND 1 (F1–F12) — STATUS FINAL

Revalidamos em 01/07/2026 cada finding do Round 1 no sistema atual.

### Resumo
- **Corrigidos:** 9 de 12
- **Não corrigidos:** 2 (F7, F12-integração)
- **Parcial:** 1 (F5 → escalado como F49)

### Detalhe por finding

| # | Área | Descrição original | Status atual |
|---|------|--------------------|--------------|
| F1 | Metas | Vendedor novo (Flavio Endo) não aparecia na seleção | ✅ Corrigido |
| F2 | Metas | Botão "Travar" sem opção de destravar | ✅ Corrigido |
| F3 | Metas | Volume com 4 casas decimais desnecessárias | ✅ Corrigido |
| F4 | Metas | Volume não convertia para Kg | ✅ Corrigido |
| F5 | Cadastro | Falha ao salvar sem mensagem de erro útil | ⚠️ Parcial → **F49** |
| F6 | Cadastro | "Limite de Crédito" visível para vendedor | ✅ Corrigido |
| F7 | Cadastro | Contato sem email/telefone e não editável | ❌ **Não corrigido** |
| F8 | Carteira | Erro 500 (AxiosError) ao abrir cliente | ✅ Corrigido |
| F9 | Agenda | Agendamento não editável / navegação incorreta | ✅ Corrigido |
| F10 | Pedidos | "Novo Pedido" ausente para vendedor | ✅ Corrigido |
| F11 | Pedidos | Nº incorreto (Polial 5874 vs 18103 OMIE), parcelas redundante, filtro de status | ✅ Corrigido |
| F12 | Novo Pedido | Múltiplos: produtos, unidade, preço R$0,01, cálculo do total | ⚠️ Parcial (unidade kg tratada; **integração OMIE segue falha → F38/F46**) |

### Pendências do Round 1 que continuam abertas
- **F7 — Contato não editável / sem exigência de e-mail ou telefone.** Segue sem correção. Relaciona-se com F49 (cadastro de cliente).
- **F12 — Cálculo/unidade foi tratado (kg), mas o envio ao OMIE nunca se concretizou** — reaparece de forma explícita no Round 2 como **F38 e F46**.

**Observação sobre F11:** o número do pedido foi corrigido para bater com o OMIE (o exemplo Polial 5874 → 18103 agora é consistente). Confirmar se o filtro de status passou a refletir todos os status do OMIE, não só "Faturado".

---

## 5. RESUMO DE UMA LINHA POR FINDING (referência rápida)

| # | Sev | Uma linha |
|---|-----|-----------|
| F13 | 🟠 | Login sem "esqueci minha senha" |
| F14 | 🟡 | Tabelas sem ordenação por coluna |
| F15 | 🟠 | Meta global soma individuais (deveria ser top-down) |
| F16 | 🟠 | CRM permite criar usuário (deveria vir do OMIE) |
| F17 | 💡 | Limite Disponível deveria ser dinâmico (`tbl_limitesSeguroCreditoClientes`) |
| F18 | 🟠 | Lista de produtos sem filtro de estoque nem saldo |
| F19 | 🟠 | Fazer Pedido em toneladas, não aceita fracionado |
| F20 | 🟡 | Título que vence hoje marcado como atraso (deveria D+1) |
| F21 | 🟠 | Tipo "Imediato" não filtra produtos com estoque |
| F22 | 🟠 | Lista de produtos incompleta, some até na busca |
| F23 | 🔴 | Fazer Pedido: falsa confirmação + sem histórico + campos faltando |
| F24 | 🔴 | Combo de cliente não abre + produto com estoque não listado |
| F25 | 🟠 | Pedido sem validação/feedback de erro |
| F26 | 🟡 | Cliente na Agenda → Carteira sem filtrar |
| F27 | 🟠 | Estoque ~600k kg a menos + "chegando 7 dias" sem origem |
| F29 | 🟡 | Registrar Atendimento sem feedback |
| F30 | 🟡 | Cadastro 4 abas sem progresso/validação |
| F31 | 🔴 | Danilo R$1,69M/112,3% com comissão R$0 |
| F32 | 🟡 | Agenda sem visão de calendário |
| F33 | 🟡 | Busca de produto não filtra por código/descrição |
| F34 | 🟢 | Tema dessincroniza ao alternar kg/t |
| F35 | 🟢 | Envio sem "Entrega Prevista" não dá erro |
| F36 | 🟢 | "Novo Acompanhamento" sem validação |
| F37 | 🟢 | Busca no Estoque expande família inteira |
| F38 | 🔴 | Pedido "enviado" nunca chega ao OMIE |
| F39 | 🔴 | Tabela de Comissão vazia (raiz) |
| F40 | 🟡 | Alerta "abaixo da meta" persiste zerado após fim do mês |
| F41 | 🟢 | Título do Cockpit atrasa ao trocar mês |
| F42 | 🟢 | Cards de vendedor não clicáveis |
| F43 | 🟢 | "Enviado via API" como vendedor fantasma |
| F44 | 🟢 | Ajuste de Preço aguardando dados de motivo de perda |
| F45 | 🔴 | Não consegue cadastrar nova comissão |
| F46 | 🔴 | Novo Pedido admin: mesma falha de OMIE do F38 |
| F47 | 💡 | Duplicar metas do mês anterior |
| F48 | 🟡 | Capacidade não mostra valor atual |
| F49 | 🔴 | Cliente sem campos e sem sync ao OMIE |

---

**Documento gerado em 01/07/2026 · Versão 2.0 (detalhada) · Relatório técnico para a equipe OrbitIA**
