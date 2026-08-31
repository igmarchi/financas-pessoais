import json
import os
import re
import urllib.request

REPO = os.environ['GITHUB_REPOSITORY']  # ex: "igmarchi/financas-pessoais"
TOKEN = os.environ['GITHUB_TOKEN']
MARKER = '<!-- verificacao-dependencias-cdn -->'
LABEL = 'dependencias-cdn'
TITLE = 'Bibliotecas via CDN — verificação de versões'

# Nome usado na URL do CDN -> nome real do pacote no npm, só quando é diferente.
NPM_NAME_OVERRIDES = {
    'babel-standalone': '@babel/standalone',
    'pdf.js': 'pdfjs-dist',
}


def read_index_html():
    with open('index.html', encoding='utf-8') as f:
        return f.read()


def find_pinned_versions(html):
    found = {}
    # cdnjs.cloudflare.com/ajax/libs/<lib>/<versao>/...
    for lib, version in re.findall(
        r'cdnjs\.cloudflare\.com/ajax/libs/([a-zA-Z0-9_.\-]+)/(\d+\.\d+\.\d+(?:-[\w.]+)?)/', html
    ):
        found[lib] = version
    # cdn.jsdelivr.net/npm/<pacote>@<versao>/...  (pacote pode ter escopo @org/nome)
    for pkg, version in re.findall(
        r'cdn\.jsdelivr\.net/npm/(@?[\w.\-]+(?:/[\w.\-]+)?)@(\d+\.\d+\.\d+(?:-[\w.]+)?)/', html
    ):
        found[pkg] = version
    return found


def npm_latest(pkg_name):
    url = f'https://registry.npmjs.org/{pkg_name}'
    req = urllib.request.Request(url, headers={'User-Agent': 'tonus-financeiro-dep-check'})
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read())
    return data['dist-tags']['latest']


def gh_api(method, path, body=None):
    url = f'https://api.github.com{path}'
    headers = {
        'Authorization': f'Bearer {TOKEN}',
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'tonus-financeiro-dep-check',
    }
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read()) if resp.length != 0 else {}


def main():
    html = read_index_html()
    pinned = find_pinned_versions(html)

    linhas = []
    algum_desatualizado = False
    for nome, versao_travada in sorted(pinned.items()):
        pacote_npm = NPM_NAME_OVERRIDES.get(nome, nome)
        try:
            versao_mais_recente = npm_latest(pacote_npm)
            desatualizado = versao_mais_recente != versao_travada
            situacao = '🔴 desatualizada' if desatualizado else '🟢 em dia'
        except Exception as e:
            versao_mais_recente = f'erro ao consultar ({e})'
            desatualizado = False
            situacao = '⚪ não verificado'
        if desatualizado:
            algum_desatualizado = True
        linhas.append((nome, versao_travada, versao_mais_recente, situacao))

    print('Biblioteca | Travada | Mais recente | Situação')
    for nome, travada, recente, situacao in linhas:
        print(f'{nome} | {travada} | {recente} | {situacao}')

    tabela = '| Biblioteca | Versão travada no app | Versão mais recente | Situação |\n'
    tabela += '|---|---|---|---|\n'
    for nome, travada, recente, situacao in linhas:
        tabela += f'| `{nome}` | `{travada}` | `{recente}` | {situacao} |\n'

    corpo = (
        f'{MARKER}\n\n'
        'Checagem semanal e automática das bibliotecas carregadas via CDN no `index.html`. '
        'Isso **não atualiza nada sozinho** — é só um aviso, pra você decidir com calma se quer '
        'atualizar, testar e trocar a versão travada manualmente.\n\n'
        f'{tabela}\n'
        '_Gerado automaticamente pelo workflow "Verificar versões das bibliotecas (CDN)"._'
    )

    if not TOKEN or os.environ.get('DRY_RUN') == 'true':
        print('\n[DRY RUN] Não vai chamar a API do GitHub. Corpo que seria publicado:\n')
        print(corpo)
        return

    existentes = gh_api('GET', f'/repos/{REPO}/issues?state=open&labels={LABEL}')

    # Comentário novo a cada execução com pendência — é o que dispara e-mail toda semana.
    # Só editar o corpo da issue (sem comentar) NÃO gera notificação por e-mail.
    comentario = (
        f'Checagem de {os.environ.get("DATA_EXECUCAO", "hoje")}:\n\n{tabela}\n'
        '_Gerado automaticamente. Isso não atualiza nada sozinho — é só um aviso._'
    )

    if algum_desatualizado:
        if existentes:
            numero = existentes[0]['number']
            gh_api('PATCH', f'/repos/{REPO}/issues/{numero}', {'body': corpo})
            gh_api('POST', f'/repos/{REPO}/issues/{numero}/comments', {'body': comentario})
            print(f'\nIssue #{numero} atualizada e comentada (dispara e-mail).')
        else:
            nova = gh_api('POST', f'/repos/{REPO}/issues', {'title': TITLE, 'body': corpo, 'labels': [LABEL]})
            print(f"\nIssue #{nova['number']} criada (dispara e-mail).")
    else:
        if existentes:
            numero = existentes[0]['number']
            gh_api(
                'POST',
                f'/repos/{REPO}/issues/{numero}/comments',
                {'body': 'Tudo em dia nessa checagem — fechando automaticamente. ✅'},
            )
            gh_api('PATCH', f'/repos/{REPO}/issues/{numero}', {'body': corpo, 'state': 'closed'})
            print(f'\nIssue #{numero} fechada (tudo em dia, comentário dispara e-mail).')
        else:
            print('\nTudo em dia, nenhuma issue existente para atualizar.')


if __name__ == '__main__':
    main()
