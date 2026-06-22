# Contract: `GET /api/v1/stockbridge/conferencia/contagem`

Endpoint barato para o **badge** da navegação. Retorna quantos itens estão com `Status Geral ≠ OK` na posição mais recente.

- **Auth**: `requireAuth` + `requireModule('stockbridge')` + `requireGestor`.
- **Envelope**: `{ data, error }`.
- **Sem params.**

## Response — `200`

```jsonc
{
  "data": {
    "contagem": 27,                 // == itens com statusGeral != OK  (valor do badge)
    "porStatus": {
      "divergenteENegativo": 4,
      "divergente": 12,
      "negativo": 11
    },
    "dataPosicaoAcxe": "2026-06-22",
    "dataPosicaoQ2p": "2026-06-22",
    "defasagemEntreEmpresas": false
  },
  "error": null
}
```

## Consumo no frontend (replica o badge de aprovações)

```typescript
// apps/web/src/App.tsx — junto aos outros badges de stockbridge
const { data: conferenciaCount = 0 } = useQuery<number>({
  queryKey: ['stockbridge', 'conferencia', 'contagem'],
  enabled: !!user && ['gestor', 'diretor'].includes(user.role),
  refetchInterval: 30_000,
  queryFn: async () => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
    const res = await fetch('/api/v1/stockbridge/conferencia/contagem', { credentials: 'include', headers });
    if (!res.ok) return 0;
    const body = (await res.json()) as { data: { contagem: number } };
    return body.data?.contagem ?? 0;
  },
});
// ...e no map dos sub-itens:
//   if (s.id === 'sb-conferencia-estoque') return { ...s, badge: conferenciaCount };
```

O componente `Sidebar.tsx` já renderiza a bolinha vermelha quando `badge > 0` (`bg-red-600 rounded-full`, `99+` acima de 99). Sem mudança no componente — só wiring no `App.tsx`.

## Erros

| HTTP | code | Quando |
|---|---|---|
| 401/403 | (middleware) | sem auth / papel / módulo off → front trata como `0` |
| 500 | `CONFERENCIA_FAIL` | falha → front trata como `0` (badge não aparece) |

## Casos de teste

1. `contagem == porStatus.divergenteENegativo + divergente + negativo`.
2. `contagem` == `GET /conferencia` `resumo.totalProblemas` (mesma engine, mesma posição).
3. Posição sem problemas → `contagem == 0` (front não exibe badge).
