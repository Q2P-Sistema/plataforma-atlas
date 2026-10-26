"""ACXEGDP-440: renderiza as prévias (antes/depois) com a faixa De/Para/Cc/Cco/Assunto. Usa a renderização da 436 (só leitura)."""
import html as Hh, json, pathlib, sys
sys.path.insert(0, '/home/primebot/Documentos/Github/q2p/backup-workflow-n8n/specs/436-emails/quadro/tools')
import caderno_lib as L

GSI = 'flavio.endo@acxe-polimeros.com.br'
def papel(e):
    e = e.strip().lower()
    return {GSI: 'Gestor SI (flavio.endo)', 'gustavo.dreer@acxe-polimeros.com.br': 'Gustavo Dreer', 'mauricio@acxe-polimeros.com.br': 'Maurício',
            'nfe@acxe-polimeros.com.br': 'NFe ACXE', 'comex_acxe@acxe-polimeros.com.br': 'Comex ACXE', 'operador@exemplo.com.br': 'quem lançou',
            'gestor@exemplo.com.br': 'gestor do StockBridge'}.get(e, e)
def faixa(meta):
    l = ['<div style="color:#666;margin-bottom:4px">De: <b style="color:#333">%s</b> &lt;sistema@q2p.com.br&gt;</div>' % Hh.escape(meta['de'])]
    l.append('<div style="color:#666;margin-bottom:4px">Para: <span style="color:#333">%s</span>%s</div>' % (Hh.escape(papel(meta['to'])), ' <span style="color:#999">(1 e-mail para cada destinatário da lista: %d envios)</span>' % meta['envios'] if meta['envios'] > 1 else ''))
    if meta['cc']: l.append('<div style="color:#666;margin-bottom:4px">Cc: <span style="color:#333">%s</span></div>' % Hh.escape(', '.join(papel(x) for x in meta['cc'].split(', '))))
    if meta['bcc']: l.append('<div style="color:#666;margin-bottom:4px">Cco (oculta): <span style="color:#333">%s</span></div>' % Hh.escape(', '.join(papel(x) for x in meta['bcc'].split(', '))))
    l.append('<div style="color:#666">Assunto: <b style="color:#111;font-size:15px">%s</b></div>' % Hh.escape(meta['assunto']))
    return '<div style="font-family:Arial,Helvetica,sans-serif;background:#ffffff;border-bottom:1px solid #d0d7de;padding:14px 24px;font-size:14px;color:#333">' + ''.join(l) + '</div>'

raiz = pathlib.Path(sys.argv[1]); prev = raiz / 'previa'; png = raiz / 'png'; png.mkdir(exist_ok=True)
for html in sorted(prev.glob('*.html')):
    if len(sys.argv) > 2 and not any(html.name.startswith(x) for x in sys.argv[2:]): continue
    meta = json.loads(html.with_suffix('.meta.json').read_text(encoding='utf-8'))
    L.renderiza(html.read_text(encoding='utf-8'), faixa(meta), str(png / (html.stem + '.png')))
print('ok', len(list(png.glob('*.png'))))
