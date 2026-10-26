"""ACXEGDP-440: monta o caderno de aprovação (PDF) — tabela antes × depois + uma página lado a lado por cenário.
Uso: python3 -I caderno.py <pasta_harness> <saida.pdf>. Usa a renderização da 436 (só leitura) e as prévias de render.py."""
import html as H, json, pathlib, subprocess, sys
sys.path.insert(0, '/home/primebot/Documentos/Github/q2p/backup-workflow-n8n/specs/436-emails/quadro/tools')
import caderno_lib as L
from PIL import Image

raiz = pathlib.Path(sys.argv[1]); saida = pathlib.Path(sys.argv[2])
build = raiz / 'caderno'; build.mkdir(exist_ok=True)
GSI = 'flavio.endo@acxe-polimeros.com.br'
PAPEL = {GSI: 'Gestor SI', 'gustavo.dreer@acxe-polimeros.com.br': 'Gustavo Dreer', 'mauricio@acxe-polimeros.com.br': 'Maurício',
         'nfe@acxe-polimeros.com.br': 'NFe ACXE', 'comex_acxe@acxe-polimeros.com.br': 'Comex ACXE', 'operador@exemplo.com.br': 'quem lançou',
         'gestor@exemplo.com.br': 'gestor do StockBridge', 'usuario@exemplo.com.br': 'o usuário'}
def papel(e): return PAPEL.get(e.strip().lower(), e.strip())
def lst(s): return [x for x in (s or '').split(', ') if x]

# (id do cenário, título da página, variante)
CENARIOS = [
    ('E01', 'E01. Produto sem par na Q2P bloqueia o recebimento de importação', ''),
    ('E02a_acxe', 'E02. NF recebida sem validação completa', 'nota da ACXE'),
    ('E02b_q2p', 'E02. NF recebida sem validação completa', 'nota da Q2P'),
    ('E03', 'E03. Débito cruzado na saída', ''),
    ('E04a_divergencia', 'E04. Aprovação pendente (1 item)', 'recebimento com divergência'),
    ('E04b_saida_diretor', 'E04. Aprovação pendente (1 item)', 'saída manual, nível diretor'),
    ('E04c_retorno_comodato', 'E04. Aprovação pendente (1 item)', 'retorno de comodato (identificado pelo cliente)'),
    ('E05a_2itens', 'E05. Recebimento nacional aguardando aprovação', '2 itens da Q2P'),
    ('E05b_acxe_1item', 'E05. Recebimento nacional aguardando aprovação', '1 item da ACXE, entrada nas duas empresas'),
    ('E06a_pendente', 'E06. NF dispensada da fila (aviso ao fiscal)', 'recebimento fiscal pendente'),
    ('E06b_concluido_acxe_pc', 'E06. NF dispensada da fila (aviso ao fiscal)', 'fiscal concluído, NF da ACXE, com pedido de compra'),
    ('E06c_sem_fornecedor', 'E06. NF dispensada da fila (aviso ao fiscal)', 'fornecedor não identificado'),
    ('E07a_sem_pc', 'E07. Aviso a compras', 'NF sem pedido de compra'),
    ('E07b_aguardando', 'E07. Aviso a compras', 'pedido aguardando aprovação'),
    ('E07c_sem_vinculo', 'E07. Aviso a compras', 'NF recebida sem pedido de compra'),
    ('E07d_unidade', 'E07. Aviso a compras', 'pedido em unidade diferente da nota'),
    ('E07e_item_un', 'E07. Aviso a compras', 'item que o Atlas não converte para kg'),
    ('E07f_acxe', 'E07. Aviso a compras', 'NF da ACXE'),
    ('E08', 'E08. Entrada rejeitada com o pedido baixado acima da nota', ''),
    ('E09a_parado_q2p', 'E09. Espelho de recebimentos de NF-e', 'parado (Q2P)'),
    ('E09b_vazio_acxe', 'E09. Espelho de recebimentos de NF-e', 'vazio (ACXE)'),
    ('E09c_sem_leitura_q2p', 'E09. Espelho de recebimentos de NF-e', 'sem leitura (Q2P)'),
    ('E10a_parada_q2p', 'E10. Cópia de pedidos de compra', 'parada (Q2P)'),
    ('E10b_vazia_acxe', 'E10. Cópia de pedidos de compra', 'vazia (ACXE)'),
    ('E10c_sem_leitura_q2p', 'E10. Cópia de pedidos de compra', 'sem leitura (Q2P)'),
    ('E11a_pendente', 'E11. Dispensa desfeita (aviso ao fiscal)', 'fiscal pendente na dispensa'),
    ('E11b_concluido', 'E11. Dispensa desfeita (aviso ao fiscal)', 'fiscal já concluído na dispensa'),
    ('E12a_q2p', 'E12. Recebimento fiscal desfeito no OMIE (aviso ao fiscal)', 'NF da Q2P, 1 pedido de compra'),
    ('E12b_acxe_2pcs', 'E12. Recebimento fiscal desfeito no OMIE (aviso ao fiscal)', 'NF da ACXE, 2 pedidos, parte aprovada'),
    ('E12c_fora_do_atlas', 'E12. Recebimento fiscal desfeito no OMIE (aviso ao fiscal)', 'concluído pelo fiscal no portal, sem pedido'),
    ('E13', 'E13. Divergências de importação aguardando aprovação', '2 itens'),
    ('E14a_q2p', 'E14. Lançamento no OMIE pendente', 'falta a Q2P'),
    ('E14b_acxe_faltando', 'E14. Lançamento no OMIE pendente', 'falta a transferência da diferença na ACXE'),
    ('E15a_falha', 'E15. Baixa do pedido de compra Q2P', 'baixa não feita'),
    ('E15b_sem_saldo', 'E15. Baixa do pedido de compra Q2P', 'saldo insuficiente'),
    ('E16a_1nf', 'E16. NF sem vínculo com pedido na FUP', '1 NF'),
    ('E16b_3nfs', 'E16. NF sem vínculo com pedido na FUP', '3 NFs'),
    ('E17a_por_nf', 'E17. Lançamento rejeitado (a quem lançou)', 'recebimento nacional pela NF'),
    ('E17b_manual', 'E17. Lançamento rejeitado (a quem lançou)', 'recebimento manual'),
    ('E17c_saida', 'E17. Lançamento rejeitado (a quem lançou)', 'saída manual'),
    ('E18a_por_nf', 'E18. Lançamento aprovado (a quem lançou)', 'recebimento nacional pela NF'),
    ('E18b_divergencia_comex', 'E18. Lançamento aprovado (a quem lançou)', 'divergência de importação (Comex em cópia)'),
    ('E18c_acxe', 'E18. Lançamento aprovado (a quem lançou)', 'compra nacional da ACXE'),
    ('E18d_divergencia_pendente', 'E18. Lançamento aprovado (a quem lançou)', 'divergência aprovada com lançamento pendente no OMIE'),
    ('E19', 'E19. Recebimento concluído', '1 produto'),
    ('E20', 'E20. Recebimento concluído', '3 produtos'),
    ('E21a_1', 'E21. Comodatos vencidos', '1 comodato'),
    ('E21b_escalada', 'E21. Comodatos vencidos', '3 comodatos, com escalada'),
    ('E22', 'E22. Recuperação de senha', ''),
]

def meta(cid, lado):
    p = raiz / 'previa' / f'{cid}__{lado}.meta.json'
    return json.loads(p.read_text(encoding='utf-8')) if p.exists() else None

def diferencas(a, d):
    def mapa(m):
        r = {}
        for campo, nome in (('to', 'Para'), ('cc', 'Cc'), ('bcc', 'Cco')):
            for e in (lst(m[campo]) if campo != 'to' else [m['to']]): r.setdefault(papel(e), nome)
        return r
    x, y = mapa(a), mapa(d)
    fr = []
    sai = [p for p in x if p not in y]; entra = [p for p in y if p not in x]
    if sai: fr.append('Sai: ' + ', '.join(sai) + '.')
    if entra: fr.append('Entra: ' + ', '.join(f'{p} ({y[p]})' for p in entra) + '.')
    mov = [f'{p} de {x[p]} para {y[p]}' for p in y if p in x and x[p] != y[p]]
    if mov: fr.append('; '.join(mov) + '.')
    return 'Destinatários: ' + (' '.join(fr) if fr else 'iguais aos de hoje.')

def celula(m, novo):
    if not m: return '<span class="nulo">—</span>'
    rec = f"Para: {H.escape(papel(m['to']))}" + (f" (1 e-mail para cada um: {m['envios']})" if m['envios'] > 1 else '')
    if m['cc']: rec += ' · Cc: ' + H.escape(', '.join(papel(e) for e in lst(m['cc'])))
    if novo and m['bcc']: rec += ' · Cco: ' + H.escape(', '.join(papel(e) for e in lst(m['bcc'])))
    cls = 'novo' if novo else 'velho'
    return f'<div class="{cls}">{H.escape(m["assunto"])} <span class="tam">({len(m["assunto"])})</span></div><div class="rec">{rec}</div>'

linhas, paginas, ult = [], [], None
for cid, titulo, variante in CENARIOS:
    a, d = meta(cid, 'antes'), meta(cid, 'depois')
    eid = titulo.split('.')[0]
    linhas.append(f'<tr class="{"novoid" if eid != ult else ""}"><td class="id">{eid if eid != ult else ""}</td><td>{H.escape(variante) or "—"}</td><td>{celula(a, False)}</td><td>{celula(d, True)}</td></tr>')
    ult = eid
    pa = Image.open(raiz / 'png' / f'{cid}__antes.png').convert('RGB')
    pd = Image.open(raiz / 'png' / f'{cid}__depois.png').convert('RGB')
    pg = L.pagina(titulo, variante.capitalize() if variante else ' ', pa, pd, diferencas(a, d), rot_antes='ANTES (e-mail de hoje)', rot_depois='DEPOIS (proposto)')
    arq = build / f'{cid}.png'; pg.save(arq); paginas.append(arq)

intro = (raiz / 'caderno_intro.html').read_text(encoding='utf-8')
doc = f'''<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>ACXEGDP-440: e-mails do Atlas, antes e depois</title>
<style>
@page {{ size: A3 landscape; margin: 12mm; }}
body {{ font-family: "Noto Sans", Arial, sans-serif; color:#111827; font-size: 12.5px; line-height: 1.45; }}
h1 {{ font-size: 26px; margin: 0 0 4px 0; }} h2 {{ font-size: 18px; margin: 22px 0 8px 0; border-bottom: 2px solid #e5e7eb; padding-bottom: 4px; }}
.sub {{ color:#4b5563; margin: 0 0 14px 0; font-size: 14px; }}
ul {{ margin: 6px 0 6px 18px; padding: 0; }} li {{ margin: 4px 0; }}
table {{ border-collapse: collapse; width: 100%; font-size: 12px; }}
th {{ background:#f3f4f6; text-align:left; padding:7px 9px; border:1px solid #d1d5db; }}
td {{ vertical-align: top; padding: 7px 9px; border: 1px solid #e5e7eb; }}
td.id {{ width: 44px; font-weight: bold; font-size: 14px; }}
tr.novoid td {{ border-top: 2px solid #9ca3af; }} tr {{ break-inside: avoid; }}
.velho {{ color:#991b1b; }} .novo {{ font-weight: bold; color:#14532d; }} .nulo {{ color:#6b7280; font-style: italic; }}
.tam {{ font-weight: normal; color:#6b7280; font-size: 11px; }}
.rec {{ margin-top: 4px; font-size: 11.5px; color:#374151; }}
.box {{ background:#fffbeb; border:1px solid #fcd34d; border-radius:8px; padding:10px 16px; }}
</style></head><body>
{intro}
<h2>Quadro completo: assunto e destinatários, antes e depois</h2>
<table><thead><tr><th>ID</th><th style="width:16%">Variante</th><th style="width:38%">ANTES (e-mail de hoje)</th><th>DEPOIS (proposto)</th></tr></thead><tbody>
{''.join(linhas)}
</tbody></table></body></html>'''
(build / 'tabela.html').write_text(doc, encoding='utf-8')
subprocess.run([L.CHROME, '--headless', '--disable-gpu', '--no-sandbox', '--no-pdf-header-footer', '--print-to-pdf=' + str(build / 'tabela.pdf'), 'file://' + str(build / 'tabela.html')], check=True, capture_output=True)
ims = [Image.open(p).convert('RGB') for p in paginas]
ims[0].save(build / 'paginas.pdf', save_all=True, append_images=ims[1:], resolution=150.0, quality=72)
subprocess.run(['pdfunite', str(build / 'tabela.pdf'), str(build / 'paginas.pdf'), str(saida)], check=True)
print('ok', saida, saida.stat().st_size // 1024, 'KB', len(paginas), 'páginas lado a lado')
