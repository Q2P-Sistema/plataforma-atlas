# Briefing — Sync de Itens de NF OMIE para o banco Atlas

**Destinatário**: agente de automação (n8n)
**Contexto**: módulo StockBridge do Atlas precisa comparar posição fiscal (NF no OMIE)
com posição física (estoque confirmado no armazém) por produto/SKU.

---

## Objetivo

Criar um sync periódico que popule duas tabelas no banco Atlas com todos os itens
de NF de entrada e saída de ACXE e Q2P, permitindo:

1. Identificar NFs que existem fiscalmente no OMIE mas ainda **não foram fisicamente
   recebidas** no armazém.
2. Calcular posição fiscal por produto (separada do saldo físico).
3. Histórico completo de movimentações fiscais por SKU.

---

## API a usar

**Endpoint único**: `produtos/nfconsultar/`

Este endpoint retorna **AMBOS os tipos de NF** — entrada e saída — com detalhe
completo por item. Não usar `notaentrada/` (retorna só cabeçalho, sem itens).

Chamar separadamente para cada empresa:
- ACXE: usando as credenciais `OMIE_ACXE_KEY` / `OMIE_ACXE_SECRET`
- Q2P: usando as credenciais `OMIE_Q2P_KEY` / `OMIE_Q2P_SECRET`

---

## Distinção entre entrada e saída

O campo `ide.tpNF` distingue o tipo:

| `tpNF` | Tipo | CFOPs típicos | Significado |
|---|---|---|---|
| `"0"` | Entrada | 2.101, 2.118, 2.122, ... | NF recebida de fornecedor (compra, importação) |
| `"1"` | Saída | 5.102, 5.101, ... | NF emitida para cliente (venda) |

---

## Campo-chave para reconciliação fiscal/físico

```
compl.nIdReceb
```

| Valor | Significado |
|---|---|
| `0` | NF existe **só fiscalmente** — mercadoria ainda não recebida fisicamente |
| `> 0` | NF foi recebida fisicamente e linkada ao recebimento no OMIE |

Este é o campo mais importante para o StockBridge: permite saber quais NFs de
compra chegaram no sistema fiscal mas o operador ainda não confirmou o
recebimento físico no armazém.

---

## Tabelas a criar no banco Atlas

> **Atenção**: estas tabelas **não existem ainda** no banco. Precisam ser criadas
> antes de qualquer sync. Criar em `public.*` (mesmo schema das outras tabelas
> sincronizadas do OMIE), preferencialmente via migration SQL versionada no
> repositório (`packages/db/migrations/`) para rastreabilidade.

```
public.tbl_nf_itens_ACXE
public.tbl_nf_itens_Q2P
```

### Colunas (1 linha = 1 item de 1 NF)

| Coluna | Fonte na API | Tipo | Observação |
|---|---|---|---|
| `n_id_nf` | `compl.nIdNF` | bigint | ID único OMIE da NF |
| `n_id_receb` | `compl.nIdReceb` | bigint | **0 = não recebida fisicamente** |
| `c_chave_nfe` | `compl.cChaveNFe` | varchar(44) | Chave NF-e |
| `n_nf` | `ide.nNF` | varchar(20) | Número da NF |
| `serie` | `ide.serie` | varchar(5) | Série da NF |
| `tp_nf` | `ide.tpNF` | smallint | 0=entrada, 1=saída |
| `tp_amb` | `ide.tpAmb` | smallint | 1=produção, 2=homologação |
| `d_emi` | `ide.dEmi` | date | Data de emissão |
| `d_sai_ent` | `ide.dSaiEnt` | date | Data de saída/entrada |
| `n_cod_emp_emit` | `nfEmitInt.nCodEmp` | bigint | Código OMIE da empresa emissora |
| `cnpj_dest` | `nfDestInt.cnpj_cpf` | varchar(20) | CNPJ do destinatário |
| `razao_dest` | `nfDestInt.cRazao` | varchar(200) | Razão social do destinatário |
| `n_cod_item` | `det[].nfProdInt.nCodItem` | bigint | ID do item dentro da NF |
| `n_cod_prod` | `det[].nfProdInt.nCodProd` | bigint | **Código OMIE do produto** (join com catálogo) |
| `c_prod` | `det[].prod.cProd` | varchar(60) | Código interno (ex: "PP-016", "PEAD-041") |
| `x_prod` | `det[].prod.xProd` | varchar(200) | Descrição do produto |
| `ncm` | `det[].prod.NCM` | varchar(10) | NCM |
| `cfop` | `det[].prod.CFOP` | varchar(10) | CFOP |
| `q_com` | `det[].prod.qCom` | numeric(14,3) | **Quantidade em KG** |
| `u_com` | `det[].prod.uCom` | varchar(6) | Unidade (esperado "KG") |
| `v_un_com` | `det[].prod.vUnCom` | numeric(14,4) | Preço unitário em BRL |
| `v_prod` | `det[].prod.vProd` | numeric(14,2) | Valor total do item (sem impostos) |
| `v_tot_item` | `det[].prod.vTotItem` | numeric(14,2) | Valor total com impostos |
| `codigo_local_estoque` | `det[].prod.codigo_local_estoque` | bigint | Código do armazém OMIE |
| `n_cmc_unitario` | `det[].prod.nCMCUnitario` | numeric(14,6) | Custo médio ponderado unitário |
| `synced_at` | gerado no sync | timestamptz | Timestamp da sincronização |

**Chave primária**: `(n_id_nf, n_cod_item)` — identifica unicamente cada item de cada NF.

---

## Estratégia de sync

**Upsert** por `(n_id_nf, n_cod_item)` — sempre atualizar, pois `n_id_receb` muda
de `0` para um valor quando a NF é processada fisicamente. Este é o campo que
precisa ser mantido atualizado.

**Frequência sugerida**: a cada 30–60 minutos, buscando NFs dos últimos 90 dias.

**Carga inicial**: paginar `nfconsultar/` desde 2021 (total ~21.397 NFs de saída +
~6.072 NFs de entrada, conforme `total_de_registros` observado nos payloads).

**Filtro de ambiente**: ignorar registros com `ide.tpAmb = "2"` (homologação).

---

## Exemplo de payload recebido (entrada `tpNF=0`)

```json
{
  "compl": {
    "nIdNF": 3050665626,
    "nIdReceb": 3043701833,
    "cChaveNFe": "29211115689185000160550020000685571100169094"
  },
  "det": [{
    "nfProdInt": { "nCodItem": 3050665629, "nCodProd": 3033097815 },
    "prod": {
      "cProd": "PP-016", "xProd": "PP NATURAL Q33",
      "qCom": 24200, "uCom": "KG", "vUnCom": 8.5714,
      "vProd": 217799.27, "NCM": "3902.90.00", "CFOP": "2.118",
      "codigo_local_estoque": 2994810198, "nCMCUnitario": 6.749977
    }
  }],
  "ide": { "tpNF": "0", "tpAmb": "1", "dEmi": "04/11/2021", "nNF": "000068557" }
}
```

## Exemplo de payload recebido (saída `tpNF=1`)

```json
{
  "compl": {
    "nIdNF": 3042081251,
    "nIdReceb": 0,
    "cChaveNFe": "35211127019059000188550010000064571654698635"
  },
  "det": [{
    "nfProdInt": { "nCodItem": 3042070211, "nCodProd": 3033098035 },
    "prod": {
      "cProd": "PP-062", "xProd": "PP 03H82",
      "qCom": 5000, "uCom": "KG", "vUnCom": 12.3,
      "vProd": 61500, "NCM": "3902.10.20", "CFOP": "5.102",
      "codigo_local_estoque": 2994810198, "nCMCUnitario": 0
    }
  }],
  "ide": { "tpNF": "1", "tpAmb": "1", "dEmi": "03/11/2021", "nNF": "00006457" }
}
```

---

## Como o StockBridge vai usar esses dados

A aplicação Atlas vai cruzar estas tabelas com `stockbridge.lote` e
`stockbridge.movimentacao` para:

- **Posição fiscal por SKU** = soma de `q_com` onde `tp_nf=0` (entradas) menos
  soma de `q_com` onde `tp_nf=1` (saídas), agrupado por `n_cod_prod`
- **Gap fiscal/físico** = NFs de entrada com `n_id_receb = 0` que não têm
  correspondente em `stockbridge.lote` com status `provisorio` ou `reconciliado`
- **Histórico de custo** = `v_un_com` e `n_cmc_unitario` por produto ao longo do tempo

O join com o catálogo de produtos é por `n_cod_prod` →
`public.tbl_produtos_ACXE.codigo_produto` (para ACXE) ou
`public.tbl_produtos_Q2P.codigo_produto` (para Q2P).
