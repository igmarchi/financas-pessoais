-- ══════════════════════════════════════════════════════════════
--  TONUS FINANCEIRO — Migração: notificações de vencimento
--  (e-mail + push), 3 dias antes e no dia
--  Execute no SQL Editor do Supabase (projeto financas-pessoais,
--  hdbhoquhszehzbhtwdui.supabase.co) — pode rodar de uma vez só.
-- ══════════════════════════════════════════════════════════════

-- 1. Preferências de notificação por usuário. Ficam em `profiles` (mesma
--    tabela onde já mora `pending_deletion_at`) porque é 1 linha por
--    usuário e não precisa de tabela própria. E-mail nasce ligado por
--    padrão (já é um canal que o usuário já espera receber e-mail da
--    conta); push nasce desligado porque exige um passo explícito do
--    usuário (autorizar notificação no navegador) — não dá pra ativar
--    sozinho sem essa permissão de qualquer forma.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS notif_email_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS notif_push_enabled  boolean NOT NULL DEFAULT false;

-- 2. Inscrições de push (Web Push). Um usuário pode ter mais de uma —
--    um por navegador/aparelho onde ele autorizou notificação — por isso
--    é tabela própria, não coluna em profiles. `endpoint` é o identificador
--    único de cada inscrição (a própria API de push garante isso).
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint     text NOT NULL UNIQUE,
  p256dh       text NOT NULL,
  auth_key     text NOT NULL,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_id_idx ON push_subscriptions(user_id);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- Cada usuário só enxerga/gerencia as próprias inscrições (o app faz
-- isso com a chave anon, autenticado). A função de envio usa a
-- SERVICE_ROLE_KEY, que ignora RLS — por isso não precisa de política
-- para "ler todas as inscrições".
DROP POLICY IF EXISTS "push_subscriptions_select_own" ON push_subscriptions;
CREATE POLICY "push_subscriptions_select_own" ON push_subscriptions
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "push_subscriptions_insert_own" ON push_subscriptions;
CREATE POLICY "push_subscriptions_insert_own" ON push_subscriptions
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "push_subscriptions_delete_own" ON push_subscriptions;
CREATE POLICY "push_subscriptions_delete_own" ON push_subscriptions
  FOR DELETE USING (auth.uid() = user_id);

-- 3. Log de lembretes já enviados — evita mandar o mesmo lembrete duas
--    vezes se o cron rodar mais de uma vez no dia, ou reenviar o "3 dias
--    antes" de novo amanhã pra mesma conta. Uma linha por
--    (conta/fatura + tipo de vencimento esperado + canal + janela).
--    Só a função de envio (SERVICE_ROLE_KEY) mexe aqui — RLS fecha tudo
--    pra anon/authenticated.
CREATE TABLE IF NOT EXISTS notification_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  origem_tipo     text NOT NULL,   -- 'fixed_expense' | 'card'
  origem_id       uuid NOT NULL,   -- id em fixed_expenses ou cards
  due_date        date NOT NULL,   -- data de vencimento que gerou o lembrete
  janela          text NOT NULL,   -- '3_dias_antes' | 'no_dia'
  canal           text NOT NULL,   -- 'email' | 'push'
  enviado_em      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (origem_tipo, origem_id, due_date, janela, canal)
);
CREATE INDEX IF NOT EXISTS notification_log_user_id_idx ON notification_log(user_id);

ALTER TABLE notification_log ENABLE ROW LEVEL SECURITY;
-- Nenhuma política criada de propósito: nem anon nem authenticated leem/
-- escrevem aqui (RLS ligado sem policy = bloqueia geral). Só a função
-- via SERVICE_ROLE_KEY acessa.

-- ══════════════════════════════════════════════════════════════
--  PRONTO! Depois de rodar isso:
--  1. Defina os secrets da função (Project Settings → Edge Functions):
--     VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, RESEND_API_KEY,
--     CRON_SECRET (RESEND_API_KEY provavelmente já existe de outro uso).
--  2. Deploy: supabase functions deploy enviar-lembretes-vencimento --no-verify-jwt
--  3. Suba o novo index.html e sw.js (o toggle de notificação e o
--     recebimento do push dependem deles).
--  4. Ative o workflow do GitHub Actions que chama a função 1x/dia.
-- ══════════════════════════════════════════════════════════════
