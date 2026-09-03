import json
import os
import urllib.request

REPO = os.environ['GITHUB_REPOSITORY']  # ex: "igmarchi/financas-pessoais"
TOKEN = os.environ['GITHUB_TOKEN']
MARKER = '<!-- verificacao-dependencias-vendor -->'
LABEL = 'dependencias-cdn'  # nome do label mantido para não perder o histórico da issue já existente
TITLE = 'Bibliotecas em /vendor — verificação de versões'


def read_pinned_versions():
    # As bibliotecas ficam hospedadas localmente em /vendor; a versão de cada
    # uma continua travada aqui no package.json (mesmo manifesto usado pelo
    # Dependabot), não mais em URLs de CDN dentro do index.html.
    with open('package.json', encoding='utf-8') as f:
        manifesto = json.load(f)
    return manifesto.get('dependencies', {})


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
    pinned = read_pinned_versions()

    linhas = []
    algum_desatualizado = False
    for nome, versao_travada in sorted(pinned.items()):
        try:
            versao_mais_recente = npm_latest(nome)
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
        'Checagem semanal e automática das bibliotecas de terceiros hospedadas localmente em '
        '`/vendor` (versão travada em `package.json`). Isso **não atualiza nada sozinho** — é só '
        'um aviso, pra você decidir com calma se quer atualizar: baixar os arquivos da nova versão, '
        'substituir em `/vendor`, testar e só então atualizar a versão travada no `package.json`.\n\n'
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
