# Specification Quality Checklist: Recebimento Nacional com Pedido de Compra

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-21
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- O OMIE aparece no texto como sistema de negócio (o ERP onde o fiscal e o PC vivem), não como detalhe de implementação. É o mesmo critério das specs 015 e 016. Os detalhes de API ficam para o `research.md` do plano e estão registrados em ACXEGDP-437: `AlterarRecebimento` com `cAcao = "ASSOCIAR-PEDIDO"` (`nIdPedidoExistente`, `nIdItPedidoExistente`); `itensAjustes.cNaoGerarMovEstoque` só aceito com `cAcao = "EDITAR"` (erro 151); `ConcluirRecebimento` etapa 60; `ConsultarRecebimento` com `itensCabec.nIdPedido/nIdItPedido` e `itensInfoAdic.nNumPedCompra`; etapa do PC só de leitura na API de pedido de compra.
- Fato lido ao vivo no OMIE em 21/10/2026 às 18h (`ConsultarRecebimento` da NF 7813, etapa 40, cRecebido N): o item já vem associado ao PC 304 (`cAssociarExistente=S`, `nIdPedido=8516905979`, `nIdItPedido=8516907022`, `nIdProduto=3033097755`, `nNumPedCompra="304"`, `cNumItPedCompra="1"`), com `itensAjustes.cNaoGerarMovEstoque="N"`. Daí vêm o FR-000 (vínculo do OMIE como sugestão principal), o FR-011a (nunca ignorar item com PC associado) e a dependência das colunas de pedido em `tbl_recebimentoNFe_itens_Q2P`. A NF 7736, concluída pelo Atlas com IGNORAR, hoje está sem `nNumPedCompra` e com `cIgnorarItem=S`. A hipótese de que o IGNORAR apagou um vínculo com o PC 302 não foi comprovada.
- Teste controlado da NF 7813 (21/10/2026) fechou FR-011 e FR-012 para o vínculo que vem do OMIE. Continuam premissas técnicas, não pendências de negócio: a gravação de um vínculo novo pela API e o que acontece com o PC quando a NF é menor que ele (caso "NF menor que o PC").
- As 8 pendências de clarificação foram respondidas pelo usuário em 21/10/2026 e estão em "Clarifications":
  1. NF sem PC bloqueia, de forma configurável.
  2. Tolerâncias de 2% na quantidade e 1% no preço, com escolha manual justificada fora delas.
  3. Só PC na etapa 15.
  4. Um item da NF não se divide entre dois PCs.
  5. Fiscal com estoque pelo portal é detectado e a entrada física é bloqueada.
  6. A chave é a da 016.
  7. Não existe PC na Q2P para compra nacional da ACXE; o estoque segue a regra da importação (local espelhado nas duas empresas, local da ACXE só na ACXE).
  8. O valor é o mesmo nas duas empresas (o valor do item na NF), sem o acréscimo de 14,5% que a importação aplica na Q2P.
- Spec pronta para o `/speckit.plan`.
