// ══════════════════════════════════════════════════════════════
//  Lógica pura (sem I/O, sem Deno.serve) usada pela Edge Function
//  enviar-lembretes-vencimento. Separada num arquivo à parte pra poder
//  ser testada isoladamente (enviar-lembretes-vencimento.test.ts) sem
//  disparar o servidor HTTP — importar um arquivo com Deno.serve no
//  topo já sobe o servidor, o que trava os testes.
//
//  IMPORTANTE — leia antes de mexer:
//  As funções de data/fatura abaixo (dueDateForMonth, cardTotalForMonth,
//  currentInvoiceMonthKey etc.) são uma cópia das equivalentes em
//  finance-calc.js / index.html — Deno não importa o UMD desse arquivo
//  diretamente, então a lógica foi replicada aqui à mão. Se um dia mudar
//  uma regra de vencimento/fatura em finance-calc.js, replique a mudança
//  aqui também (e confira se os testes em
//  enviar-lembretes-vencimento.test.ts continuam passando).
// ══════════════════════════════════════════════════════════════

export const APP_URL = "https://financas-pessoais.tonusconsultoria.workers.dev";

// ---------- datas (cópia de finance-calc.js) ----------
export function monthKey(d: Date) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); }
export function shiftMonth(key: string, delta: number) {
  let [y, m] = key.split("-").map(Number);
  m += delta;
  while (m > 12) { m -= 12; y++; }
  while (m < 1) { m += 12; y--; }
  return y + "-" + String(m).padStart(2, "0");
}
export function lastDayOfMonth(key: string) {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}
export function dueDateForMonth(dueDay: number, key: string) {
  const day = Math.min(Number(dueDay) || 1, lastDayOfMonth(key));
  return key + "-" + String(day).padStart(2, "0");
}
export function toISO(d: Date) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
// Próxima ocorrência (>= hoje) de uma despesa fixa, de acordo com a
// frequência — mesma lógica de nextFixedExpenseOccurrence em index.html.
export function nextFixedExpenseOccurrence(fx: any, today: Date): string {
  const todayISO = toISO(today);
  if (fx.frequency === "semanal") {
    for (let i = 0; i < 14; i++) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
      if (d.getDay() === Number(fx.due_weekday)) return toISO(d);
    }
    return todayISO;
  }
  if (fx.frequency === "quinzenal") {
    const ref = new Date(fx.due_date + "T00:00:00");
    for (let i = 0; i < 14; i++) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
      const diffDays = Math.round((d.getTime() - ref.getTime()) / 86400000);
      if (((diffDays % 14) + 14) % 14 === 0) return toISO(d);
    }
    return todayISO;
  }
  const key = monthKey(today);
  const thisMonthDate = dueDateForMonth(fx.due_day, key);
  return thisMonthDate >= todayISO ? thisMonthDate : dueDateForMonth(fx.due_day, shiftMonth(key, 1));
}

// ---------- cartão / fatura (cópia de finance-calc.js) ----------
export function cardInstallmentForMonth(purchase: any, key: string) {
  const install = Number(purchase.amount) / Number(purchase.installments || 1);
  const [sy, sm] = String(purchase.first_month).slice(0, 7).split("-").map(Number);
  const [ky, km] = key.split("-").map(Number);
  const idx = (ky - sy) * 12 + (km - sm);
  if (idx < 0 || idx >= Number(purchase.installments || 1)) return 0;
  if (Array.isArray(purchase.excluded_months) && purchase.excluded_months.includes(key)) return 0;
  return install;
}
export function cardTotalForMonth(purchases: any[], cardId: string, key: string) {
  return purchases.filter((p) => p.card_id === cardId).reduce((s, p) => s + cardInstallmentForMonth(p, key), 0);
}
export function currentInvoiceMonthKey(card: any, today: Date) {
  const todayKey = monthKey(today);
  const closingMonthKey = today.getDate() <= card.closing_day ? todayKey : shiftMonth(todayKey, 1);
  return card.due_day < card.closing_day ? shiftMonth(closingMonthKey, 1) : closingMonthKey;
}

// "Hoje" no fuso de Brasília, não no fuso do servidor (o mesmo tipo de bug
// de fuso horário já corrigido no site da Tonus Consultoria).
export function hojeEmSaoPaulo(): Date {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const y = Number(partes.find((p) => p.type === "year")!.value);
  const m = Number(partes.find((p) => p.type === "month")!.value);
  const d = Number(partes.find((p) => p.type === "day")!.value);
  return new Date(y, m - 1, d);
}

export function fmtBRL(v: number) {
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
export function fmtDataBR(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

export type ItemVencimento = {
  origem_tipo: "fixed_expense" | "card";
  origem_id: string;
  nome: string;
  valor: number;
  data: string;
  janela: "3_dias_antes" | "no_dia";
};

export function emailHtml(nome: string, hoje: ItemVencimento[], em3dias: ItemVencimento[]) {
  const linha = (it: ItemVencimento) =>
    `<tr><td style="padding:10px 0;border-bottom:1px solid #f0ece4;font-size:14px;color:#0D1117;">${it.nome}</td>` +
    `<td style="padding:10px 0;border-bottom:1px solid #f0ece4;font-size:14px;color:#0D1117;text-align:right;font-weight:600;">${fmtBRL(it.valor)}</td></tr>`;
  const bloco = (titulo: string, itens: ItemVencimento[]) =>
    itens.length === 0 ? "" : `
    <h2 style="font-family:Georgia,'Times New Roman',serif;font-size:16px;color:#1B3A5C;margin:24px 0 8px;">${titulo}</h2>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${itens.map(linha).join("")}</table>`;
  return `
  <div style="background-color:#F7F4EF;padding:40px 20px;font-family:'DM Sans',Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background-color:#FFFFFF;border-radius:12px;overflow:hidden;border:1px solid #E4DFD3;">
      <tr><td style="background-color:#1B3A5C;padding:24px 32px;border-top:3px solid #C8973A;">
        <span style="font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:600;color:#F7F4EF;">Tonus Financeiro</span>
        <div style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#A9BBCE;margin-top:4px;">Contas a vencer</div>
      </td></tr>
      <tr><td style="padding:32px;">
        <p style="font-size:14px;line-height:1.6;color:#3B3F47;margin:0 0 8px;">Oi! Passando pra lembrar das suas contas:</p>
        ${bloco("Vence hoje", hoje)}
        ${bloco("Vence em 3 dias", em3dias)}
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:28px;">
          <tr><td style="border-radius:8px;background-color:#1B3A5C;">
            <a href="${APP_URL}" target="_blank" style="display:inline-block;padding:13px 28px;font-size:14px;font-weight:600;color:#F7F4EF;text-decoration:none;font-family:Arial,sans-serif;">Abrir o Tonus Financeiro</a>
          </td></tr>
        </table>
        <p style="font-size:12px;line-height:1.6;color:#7A8090;margin:28px 0 0;">Você pode desligar esse lembrete a qualquer momento na aba Privacidade do app.</p>
      </td></tr>
      <tr><td style="padding:18px 32px;background-color:#F7F4EF;border-top:1px solid #E4DFD3;">
        <span style="font-family:Arial,sans-serif;font-size:11px;color:#7A8090;">Tonus Financeiro — um produto Tonus Consultoria</span>
      </td></tr>
    </table>
  </div>`;
}
