// ══════════════════════════════════════════════════════════════
//  Edge Function: enviar-lembretes-vencimento
//  Deploy: supabase functions deploy enviar-lembretes-vencimento --no-verify-jwt
//
//  Roda 1x por dia (chamada por um cron externo — ver o workflow do
//  GitHub Actions). Para cada usuário com pelo menos uma preferência de
//  notificação ligada, verifica se alguma despesa fixa ativa ou fatura de
//  cartão vence HOJE ou daqui a 3 DIAS, e manda um lembrete por e-mail
//  e/ou push, conforme a preferência de cada um.
//
//  A lógica de datas/fatura e o HTML do e-mail moraram aqui antes; agora
//  ficam em lembretes-logic.ts (sem I/O, sem Deno.serve) pra poder ser
//  testada isoladamente — ver enviar-lembretes-vencimento.test.ts.
//
//  IMPORTANTE — leia antes de fazer deploy:
//  As funções de data/fatura em lembretes-logic.ts (dueDateForMonth,
//  cardTotalForMonth, currentInvoiceMonthKey etc.) são uma cópia das
//  equivalentes em finance-calc.js / index.html — Deno não importa o UMD
//  desse arquivo diretamente, então a lógica foi replicada à mão. Se um
//  dia mudar uma regra de vencimento/fatura em finance-calc.js, replique
//  a mudança em lembretes-logic.ts também.
//
//  SUPOSIÇÃO A CONFERIR: este código assume que `fixed_expenses` e
//  `cards` têm uma coluna `user_id` (igual a `push_subscriptions` e
//  `notification_log`, criadas na migração). Não temos como confirmar o
//  nome exato da coluna sem acesso ao painel do Supabase — confira no
//  Table Editor antes do deploy e ajuste as duas linhas marcadas com
//  "AJUSTAR SE NECESSÁRIO" abaixo, se o nome for outro.
// ══════════════════════════════════════════════════════════════
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";
import {
  APP_URL, toISO, hojeEmSaoPaulo, nextFixedExpenseOccurrence,
  currentInvoiceMonthKey, cardTotalForMonth, dueDateForMonth,
  emailHtml, type ItemVencimento,
} from "./lembretes-logic.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET")!;
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:consultoriatonus@gmail.com";
const EMAIL_FROM = Deno.env.get("LEMBRETE_EMAIL_FROM") || "Tonus Financeiro <onboarding@resend.dev>";

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

Deno.serve(async (req) => {
  const auth = req.headers.get("authorization") || "";
  if (auth !== `Bearer ${CRON_SECRET}`) {
    return new Response(JSON.stringify({ error: "não autorizado" }), { status: 401 });
  }

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const hoje = hojeEmSaoPaulo();
  const hojeISO = toISO(hoje);
  const em3dias = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() + 3);
  const em3diasISO = toISO(em3dias);

  const resumo = { usuarios_com_pendencia: 0, emails_enviados: 0, pushes_enviados: 0, erros: [] as string[] };

  const { data: profiles, error: errProfiles } = await sb
    .from("profiles")
    .select("id, notif_email_enabled, notif_push_enabled")
    .or("notif_email_enabled.eq.true,notif_push_enabled.eq.true");
  if (errProfiles) return new Response(JSON.stringify({ error: errProfiles.message }), { status: 500 });
  if (!profiles || profiles.length === 0) return new Response(JSON.stringify(resumo), { status: 200 });

  const userIds = profiles.map((p) => p.id);

  const [{ data: fixedExpenses }, { data: cards }, { data: purchases }, { data: pushSubs }] = await Promise.all([
    sb.from("fixed_expenses").select("*").eq("active", true).in("user_id", userIds), // AJUSTAR SE NECESSÁRIO (nome da coluna)
    sb.from("cards").select("*").in("user_id", userIds),                              // AJUSTAR SE NECESSÁRIO (nome da coluna)
    sb.from("card_purchases").select("*"),
    sb.from("push_subscriptions").select("*").in("user_id", userIds),
  ]);

  for (const perfil of profiles) {
    const itensHoje: ItemVencimento[] = [];
    const itensEm3: ItemVencimento[] = [];

    for (const fx of (fixedExpenses || []).filter((f) => f.user_id === perfil.id)) {
      const data = nextFixedExpenseOccurrence(fx, hoje);
      if (data === hojeISO) itensHoje.push({ origem_tipo: "fixed_expense", origem_id: fx.id, nome: fx.name, valor: Number(fx.amount), data, janela: "no_dia" });
      else if (data === em3diasISO) itensEm3.push({ origem_tipo: "fixed_expense", origem_id: fx.id, nome: fx.name, valor: Number(fx.amount), data, janela: "3_dias_antes" });
    }

    for (const card of (cards || []).filter((c) => c.user_id === perfil.id)) {
      const invoiceKey = currentInvoiceMonthKey(card, hoje);
      const total = cardTotalForMonth(purchases || [], card.id, invoiceKey);
      if (total <= 0.005) continue;
      const data = dueDateForMonth(card.due_day, invoiceKey);
      const item = { origem_tipo: "card" as const, origem_id: card.id, nome: "Fatura " + card.name, valor: total, data, janela: "no_dia" as const };
      if (data === hojeISO) itensHoje.push(item);
      else if (data === em3diasISO) itensEm3.push({ ...item, janela: "3_dias_antes" });
    }

    const todosItens = [...itensHoje, ...itensEm3];
    if (todosItens.length === 0) continue;
    resumo.usuarios_com_pendencia++;

    // Monta as linhas candidatas do log (uma por item x canal habilitado) e
    // faz upsert ignorando duplicata — só sobra no retorno o que ainda não
    // tinha sido enviado antes (idempotência do cron rodando todo dia).
    const candidatos: any[] = [];
    for (const it of todosItens) {
      if (perfil.notif_email_enabled) candidatos.push({ user_id: perfil.id, origem_tipo: it.origem_tipo, origem_id: it.origem_id, due_date: it.data, janela: it.janela, canal: "email" });
      if (perfil.notif_push_enabled) candidatos.push({ user_id: perfil.id, origem_tipo: it.origem_tipo, origem_id: it.origem_id, due_date: it.data, janela: it.janela, canal: "push" });
    }
    if (candidatos.length === 0) continue;
    const { data: novos, error: errLog } = await sb
      .from("notification_log")
      .upsert(candidatos, { onConflict: "origem_tipo,origem_id,due_date,janela,canal", ignoreDuplicates: true })
      .select();
    if (errLog) { resumo.erros.push(`log usuário ${perfil.id}: ${errLog.message}`); continue; }

    const novosSet = new Set((novos || []).map((n) => `${n.origem_tipo}|${n.origem_id}|${n.due_date}|${n.janela}|${n.canal}`));
    const temEmailNovo = todosItens.some((it) => novosSet.has(`${it.origem_tipo}|${it.origem_id}|${it.data}|${it.janela}|email`));
    const temPushNovo = todosItens.some((it) => novosSet.has(`${it.origem_tipo}|${it.origem_id}|${it.data}|${it.janela}|push`));

    if (perfil.notif_email_enabled && temEmailNovo) {
      try {
        const { data: userData } = await sb.auth.admin.getUserById(perfil.id);
        const email = userData?.user?.email;
        if (email) {
          const html = emailHtml(email, itensHoje, itensEm3);
          const r = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({ from: EMAIL_FROM, to: [email], subject: "🔔 Contas a vencer — Tonus Financeiro", html }),
          });
          if (r.ok) resumo.emails_enviados++;
          else resumo.erros.push(`email usuário ${perfil.id}: ${await r.text()}`);
        }
      } catch (e) {
        resumo.erros.push(`email usuário ${perfil.id}: ${String(e)}`);
      }
    }

    if (perfil.notif_push_enabled && temPushNovo) {
      const subs = (pushSubs || []).filter((s) => s.user_id === perfil.id);
      const corpo = itensHoje.length > 0
        ? `${itensHoje.length} conta(s) vencendo hoje${itensEm3.length ? ` e ${itensEm3.length} em 3 dias` : ""}.`
        : `${itensEm3.length} conta(s) vencendo em 3 dias.`;
      const payload = JSON.stringify({ title: "🔔 Contas a vencer", body: corpo, url: APP_URL });
      for (const sub of subs) {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_key } },
            payload,
          );
          resumo.pushes_enviados++;
        } catch (e: any) {
          // Inscrição expirada/inválida (usuário desinstalou, trocou de
          // navegador etc.) — limpa pra não tentar de novo pra sempre.
          if (e?.statusCode === 404 || e?.statusCode === 410) {
            await sb.from("push_subscriptions").delete().eq("id", sub.id);
          } else {
            resumo.erros.push(`push usuário ${perfil.id}: ${String(e)}`);
          }
        }
      }
    }
  }

  return new Response(JSON.stringify(resumo), { status: 200, headers: { "Content-Type": "application/json" } });
});
