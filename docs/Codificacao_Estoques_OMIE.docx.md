# **Codificação de Estoques — OMIE**

Este documento descreve o padrão de codificação adotado para os estoques cadastrados no ERP OMIE.

## **Estrutura do Código**

O código segue o formato:

**\[LOCAL\]\[GALPÃO\]  .  \[ORIGEM\]  .  \[CATEGORIA\]**

*O terceiro bloco (categoria) é opcional e aparece apenas em estoques operacionais.*

## **Blocos e Valores**

**1º bloco — Local \+ Galpão (2 dígitos)**

A dezena identifica a região e a unidade identifica o galpão dentro dessa região:

  • 1x \= Santo André  (11 \= Galpão A, 12 \= Galpão B, 13+ \= expansão futura)

  • 2x \= Extrema  (21 \= Galpão principal, 22+ \= expansão futura)

  • 3x \= ATN / Armazém Externo  (31 \= principal)

  • 9x \= Estoques globais (sem vínculo de localidade)

**2º bloco — Origem do material**

  • 1 \= Importado

  • 2 \= Nacional

  • 0 \= Não se aplica (estoques operacionais/globais)

**3º bloco — Categoria operacional (opcional)**

  • 1 \= Troca    • 2 \= Trânsito    • 3 \= Varredura    • 4 \= Faltando

  • 5 \= Processo    • 6 \= Consumo    • 7 \= Produção

## **Escalabilidade**

A estrutura foi desenhada para crescer sem quebrar a ordenação existente. Novos galpões em Santo André recebem 13, 14, 15... Novas regiões utilizam as faixas 4x, 5x, 6x e assim por diante. Novas categorias operacionais seguem a sequência a partir do número 8\.

## **Tabela de Estoques Ativos**

| CÓDIGO | DESCRIÇÃO | LOCAL FÍSICO | OBS |
| :---: | :---: | :---: | :---: |
| **21.1** | Extrema | Extrema | — |
| **31.1** | Armazém Externo | ATN | — |
| **11.1** | Santo André | Galpão A | Importado |
| **12.1** | Santo André | Galpão B | Importado |
| **11.2** | Santo André | Galpão A | Nacional |
| **12.2** | Santo André | Galpão B | Nacional |
| **90.0.1** | Troca | — | Global |
| **90.0.2** | Trânsito | — | Global |
| **10.0.3** | Varredura | Santo André | Operacional |
| **20.0.3** | Varredura | Extrema | Operacional |
| **20.0.4** | Faltando | Extrema | Operacional |
| **20.1.5** | Processo | Extrema | Importado |
| **20.0.6** | Consumo | Extrema | Operacional |
| **20.2.7** | Produção | Extrema | Nacional |

*Nota: a distinção entre importado e nacional é transparente para o usuário de vendas — o vendedor seleciona o estoque pelo saldo disponível exibido no OMIE no momento do pedido.*