"""ACXEGDP-440: compara as saídas do roteiro (antes = main, depois = 440). Uso: python3 -I compara.py <pasta_harness> <lint_corpo.py>"""
import json, pathlib, re, subprocess, sys

raiz = pathlib.Path(sys.argv[1]); lint = sys.argv[2]
GSI = 'flavio.endo@acxe-polimeros.com.br'
COMEX = 'comex_acxe@acxe-polimeros.com.br'
VAZA = re.compile(r'undefined|\bnull\b|NaN|\[object')
ALERTAS_GSI = ('E01', 'E02', 'E03', 'E09', 'E10', 'E14', 'E15')

def lista(v):
    if v is None: return []
    return [x.strip() for x in (v if isinstance(v, list) else [v]) if isinstance(x, str) and x.strip()]

def efetivos(e, novo):
    to = e['to'].strip()
    vistos = {to.lower()}
    cc = []
    for x in lista(e.get('cc')):
        if x.lower() not in vistos: vistos.add(x.lower()); cc.append(x)
    bcc = []
    if novo:
        for x in lista(e.get('bcc')):
            if x.lower() not in vistos: vistos.add(x.lower()); bcc.append(x)
    return to, cc, bcc

(raiz / 'previa').mkdir(exist_ok=True)
linhas, problemas, lints = [], [], []
for f in sorted((raiz / 'saida' / 'depois').glob('*.json')):
    d = json.loads(f.read_text()); a = json.loads((raiz / 'saida' / 'antes' / f.name).read_text())
    cid = d['id']
    if d['erro']: problemas.append(f'{cid}: erro no novo: {d["erro"]}')
    if not d['envios']: problemas.append(f'{cid}: novo não enviou nada'); continue
    if not d['dificil']:
        if a['erro']: problemas.append(f'{cid}: erro no antigo: {a["erro"]}')
        if a['retorno'] != d['retorno']: problemas.append(f'{cid}: retorno mudou {a["retorno"]} -> {d["retorno"]}')
        if len(a['envios']) != len(d['envios']): problemas.append(f'{cid}: nº de envios {len(a["envios"])} -> {len(d["envios"])}')
        for i, (ea, ed) in enumerate(zip(a['envios'], d['envios'])):
            ta, ca, _ = efetivos(ea, False); td, cd, bd = efetivos(ed, True)
            antes = {x.lower() for x in [ta, *ca]}; depois = {x.lower() for x in [td, *cd, *bd]}
            if cid.startswith('E16'):
                if not (td == COMEX and GSI in [x.lower() for x in bd] and ta == GSI): problemas.append(f'{cid}: destinatários da decisão 7 errados')
            else:
                if ta.lower() != td.lower(): problemas.append(f'{cid}[{i}]: Para mudou {ta} -> {td}')
                if antes != depois: problemas.append(f'{cid}[{i}]: quem recebe mudou {sorted(antes)} -> {sorted(depois)}')
                if GSI in [x.lower() for x in cd]: problemas.append(f'{cid}[{i}]: Gestor SI ainda em Cc visível')
    e0 = d['envios'][0]
    for campo in ('subject', 'html', 'text'):
        if VAZA.search(str(e0.get(campo, ''))): problemas.append(f'{cid}: valor vazado em {campo}: {VAZA.search(str(e0[campo])).group(0)}')
    if '<script>' in e0['html'] or '<b>' in e0['html']: problemas.append(f'{cid}: HTML do dado não escapado')
    assunto = e0['subject']
    if not re.match(r'^\[(AÇÃO REQUERIDA|INFORMATIVO)\] - ', assunto): problemas.append(f'{cid}: assunto sem etiqueta')
    tem_forn = 'FORNECEDOR EXEMPLO' in assunto or 'ACME' in assunto
    if len(assunto) > 76 and not tem_forn: problemas.append(f'{cid}: assunto com {len(assunto)} caracteres')
    # prévias (1º envio) e lint do novo
    for arvore, e in (('antes', a['envios'][0] if a['envios'] else None), ('depois', e0)):
        if not e: continue
        html = e['html'] if '<title>' in e['html'] else e['html'].replace('<head>', '<head><title>%s</title>' % e['subject'], 1)
        (raiz / 'previa' / f'{cid}__{arvore}.html').write_text(html, encoding='utf-8')
        to, cc, bcc = efetivos(e, arvore == 'depois')
        (raiz / 'previa' / f'{cid}__{arvore}.meta.json').write_text(json.dumps({'de': 'Sistema Integrador Q2P' if arvore == 'depois' else 'Plataforma Atlas', 'to': to, 'cc': ', '.join(cc), 'bcc': ', '.join(bcc), 'assunto': e['subject'], 'envios': len((d if arvore == 'depois' else a)['envios'])}, ensure_ascii=False), encoding='utf-8')
    gestor = cid.startswith(ALERTAS_GSI)
    r = subprocess.run(['python3', '-I', lint] + (['--gestor'] if gestor else []) + [str(raiz / 'previa' / f'{cid}__depois.html')], capture_output=True, text=True)
    cab = r.stdout.splitlines()[0] if r.stdout else ''
    m = re.search(r'(\d+) ERRO, (\d+) AVISO', cab)
    erros, avisos = (int(m.group(1)), int(m.group(2))) if m else (-1, -1)
    det = [l.strip() for l in r.stdout.splitlines()[1:]]
    # No Atlas, "fila" é a tela Fila de Recebimento do StockBridge (termo de negócio), não fila de mensagens.
    fila = [l for l in det if l.startswith('ERRO R06') and re.search(r'fila de recebimento|fila do StockBridge|via fila', l) and not re.search(r'[Ww]orkflow|[Ee]xecução|RabbitMQ|cron|n8n|payload', l)]
    erros -= len(fila)
    det = [('PERMITIDO (tela Fila) ' + l[5:]) if l in fila else l for l in det]
    lints.append((cid, erros, avisos, det))
    if not d['dificil']:
        ta, ca, _ = efetivos(a['envios'][0], False) if a['envios'] else ('', [], [])
        td, cd, bd = efetivos(e0, True)
        linhas.append((cid, a['envios'][0]['subject'] if a['envios'] else '', assunto, len(assunto), f'{ta} / {", ".join(ca) or "—"}', f'{td} / {", ".join(cd) or "—"} / {", ".join(bd) or "—"}', len(d['envios'])))

print('== Assuntos e destinatários (1º envio de cada cenário; Para / Cc [/ Cco])')
for l in linhas:
    print(f'{l[0]:24} | {l[1]}\n{"":24} | -> {l[2]} ({l[3]})\n{"":24} | antes: {l[4]}\n{"":24} | depois: {l[5]}  ({l[6]} envio(s))')
print('\n== Lint (lint_corpo.py)')
tot_e = 0
for cid, e, a_, det in lints:
    tot_e += max(e, 0)
    print(f'{cid:24} {e} ERRO, {a_} AVISO' + ('' if not det else '  ' + ' | '.join(det)[:300]))
print(f'\nTotal de ERRO no lint: {tot_e}')
print('\n== Problemas' if problemas else '\n== Nenhum problema na comparação')
for p in problemas: print(' -', p)
