# Lembretes de vencimento (e-mail + push) — roteiro de deploy

Sistema pronto: lembra o usuário de cada despesa fixa ativa ou fatura de
cartão que vence **hoje** ou **em 3 dias**, por e-mail e/ou push conforme
a preferência de cada um (liga/desliga na aba Privacidade do app). Roda
1x por dia sozinho, via GitHub Actions.

Siga os passos nesta ordem — cada um depende do anterior.

## 1. Rodar a migração no banco

No painel do Supabase do projeto **financas-pessoais**
(`hdbhoquhszehzbhtwdui`) → SQL Editor → cole e rode o arquivo
`migracao-notificacoes-vencimento.sql` inteiro, de uma vez.

Isso cria: as duas colunas de preferência em `profiles`
(`notif_email_enabled`, `notif_push_enabled`), a tabela
`push_subscriptions` (inscrições de push, uma por navegador/aparelho) e a
tabela `notification_log` (controla o que já foi enviado, pra nunca
mandar o mesmo lembrete duas vezes).

**Antes de seguir**, confira uma coisa no Table Editor: as tabelas
`fixed_expenses` e `cards` precisam ter uma coluna chamada `user_id`. É o
padrão do Supabase e é bem provável que seja esse o nome, mas não tenho
como confirmar sem acesso ao painel — se for outro nome, me avise que eu
ajusto o código antes do deploy (são só duas linhas, marcadas com
"AJUSTAR SE NECESSÁRIO" em `enviar-lembretes-vencimento.ts`).

## 2. Configurar os secrets da Edge Function

Painel do Supabase → Project Settings → Edge Functions → Secrets. Adicione:

| Secret | Valor |
|---|---|
| `VAPID_PUBLIC_KEY` | `BGb6QLwvG49qEBjpOzi1swjPf4tm-3uvlWON-pa70BT-z0HR9f7AFNS2dfQFYiZ9jlJ6GR9BcCT1AasiOlZHBw0` |
| `VAPID_PRIVATE_KEY` | `nPr9TXJjeu8dgQfjTyJLZSVSSlsTg80hoknzfxep8Mg` |
| `VAPID_SUBJECT` | `mailto:consultoriatonus@gmail.com` |
| `CRON_SECRET` | `b525a66aeeecad1d443dc7baa8d5b66fbd680f86853a459b92d5f1c9769d0aa3` |
| `RESEND_API_KEY` | (o mesmo que já existe hoje, se a função de e-mail de confirmação de cadastro já usa Resend) |
| `SERVICE_ROLE_KEY` | (a service role key do projeto — Project Settings → API — mesmo nome de secret já usado por outras funções, como `salvar-diagnostico`) |
| `SUPABASE_URL` | `https://hdbhoquhszehzbhtwdui.supabase.co` |

**Trate `VAPID_PRIVATE_KEY` e `CRON_SECRET` como senha** — não coloque em
nenhum arquivo que vá pro GitHub. Eles só devem existir no painel do
Supabase (secret da função) e, no caso do `CRON_SECRET`, também como
secret do repositório no GitHub (passo 5). O `VAPID_PUBLIC_KEY` já foi
inserido no `index.html` novo abaixo — esse é público por natureza (faz
parte do protocolo Web Push), pode ficar exposto no código do app sem
problema.

## 3. Deploy da Edge Function

Dois arquivos novos precisam subir juntos, porque um importa o outro:
`lembretes-logic.ts` e `enviar-lembretes-vencimento.ts`. Copie os dois
para a pasta `supabase/functions/enviar-lembretes-vencimento/` do seu
projeto local (mantendo os dois nomes de arquivo) e rode:

```
supabase functions deploy enviar-lembretes-vencimento --no-verify-jwt
```

`--no-verify-jwt` é necessário porque quem chama essa função é o cron do
GitHub Actions (com o `CRON_SECRET`, verificado dentro da própria
função), não um usuário logado do app.

## 4. Subir o novo `index.html` e `sw.js`

Os dois arquivos anexados aqui já têm tudo: o card "Notificações" (aba
Privacidade, liga/desliga e-mail e push, pede permissão do navegador e
guarda a inscrição) e os handlers `push`/`notificationclick` no service
worker (mostram a notificação e abrem o app ao clicar). Suba os dois
substituindo os atuais no repositório/Cloudflare Pages, do jeito que você
já costuma fazer.

## 5. Ativar o agendamento (GitHub Actions)

O arquivo `.github/workflows/lembretes-vencimento.yml` já está pronto e
roda todo dia às 8h (horário de Brasília) — só chama a Edge Function.
Falta:

1. Subir esse arquivo pro repositório (mesma pasta `.github/workflows/`
   onde já está o `verificar-versoes-cdn.yml`).
2. Cadastrar o secret do repositório: GitHub → Settings → Secrets and
   variables → Actions → New repository secret → nome `CRON_SECRET`,
   valor o mesmo da tabela acima.

Sem esse secret cadastrado no GitHub, o workflow roda mas a função
responde "não autorizado" — vale testar depois de configurar, rodando
manualmente (aba Actions → o workflow → "Run workflow") e conferindo se
retorna sucesso.

## 6. Testar de ponta a ponta

Depois dos passos acima:
1. Entre no app, aba Privacidade, ligue "Receber por notificação push" —
   o navegador vai pedir permissão. Confirme.
2. Cadastre (ou use) uma despesa fixa com vencimento pra hoje ou daqui a
   3 dias.
3. Rode o workflow manualmente (Actions → Run workflow) em vez de esperar
   o horário agendado.
4. Confira: chegou o e-mail? Chegou a notificação push? Apareceu uma
   linha nova em `notification_log`? Rodando de novo na sequência, o
   e-mail/push NÃO deve ser reenviado (é o teste da idempotência).

Quando terminar de testar, seria bom apagar as linhas de teste que
sobrarem em `notification_log` (e me avisar se quiser ajuda com o SQL
pra isso, como fizemos das outras vezes).

## O que ficou pra depois (combinado)

WhatsApp como terceiro canal — deixamos pra uma próxima etapa, porque
exige configurar a API oficial do WhatsApp Business (conta Meta,
aprovação de número, etc.), algo que só você consegue fazer, com sua
conta. Quando quiser seguir com isso, começamos por aí.
