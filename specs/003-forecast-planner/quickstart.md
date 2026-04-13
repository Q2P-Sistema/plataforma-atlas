# Quickstart: Forecast Planner

## Scenario 1: View family stock position

1. Navigate to Forecast Planner module
2. See table of all ~30 families with columns: Familia, Disponivel, Reservado, Transito, Total, CMC, Cobertura, Status
3. Click on "PP HOMO 25" row to expand
4. See 5 SKUs with individual stock breakdown
5. Verify total matches sum of SKUs

**Expected**: All data comes from BD, no mock. Values match tbl_posicaoEstoque_Q2P.

## Scenario 2: Run forecast and see rupture

1. Find a family with low coverage (<60 days)
2. See the 120-day chart with colored zones
3. Red zone = rupture (estoque = 0)
4. See "Dia Pedido Ideal" badge
5. If prazo perdido, see emergency local purchase card

**Expected**: Chart matches legacy spreadsheet projections for same family.

## Scenario 3: Check purchase suggestion

1. Find family with status "critico"
2. See "Qtd Sugerida" column — should be MOQ-rounded (25t or 12t multiples)
3. Verify "Em Rota" column subtracts pipeline orders
4. See "Valor BRL" estimated from CMC or last purchase price

**Expected**: MOQ respected, pipeline deducted, value realistic.

## Scenario 4: Urgent purchases panel

1. Click "Compras 15 Dias" tab
2. See only families needing action in next 15 days
3. Sorted by urgency (critico first, then atencao)
4. Each row shows clear action: "Compra Internacional" or "Compra Local"

**Expected**: Only actionable items visible. No ok-status families.

## Scenario 5: Edit seasonality

1. Go to Config tab
2. Find PP HOMO family
3. Change June factor from 1.08 to 1.25
4. Go back to Forecast tab
5. Verify PP HOMO demand increased for June projection

**Expected**: Change persists across page reload. Log entry created.

## Validation against spreadsheet

Open "Planejador de Compras - Rev Latest.xlsm" side by side with Atlas Forecast.
Compare for 3-5 critical families:
- Pool total (should match spreadsheet "Estoque" column)
- Cobertura dias (should be within ±5 days)
- Qtd sugerida (should match MOQ logic)
- Rupture date (should match within ±3 days, accounting for sazonalidade differences)
