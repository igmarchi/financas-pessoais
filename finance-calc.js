// ============================================================
// Tonus Financeiro — motor de cálculo puro (sem React, sem DOM,
// sem Supabase). Fonte única de verdade para as contas críticas:
// saldo do mês, fatura de cartão e patrimônio líquido/reserva.
//
// Extraído de index.html pra poder ser testado de verdade (node --test,
// sem precisar de navegador) e pra parar de ter a mesma fórmula de
// patrimônio líquido escrita duas vezes em lugares diferentes do app
// (Dashboard e Patrimônio já tinham cada um a sua cópia).
//
// Carregado por index.html como <script src="finance-calc.js"></script>
// ANTES do bloco React/Babel — o bloco React lê tudo isso via
// `const { ... } = window.FinanceCalc;` logo no início, então cada
// função aqui dentro é chamada exatamente pelo mesmo nome de sempre em
// qualquer lugar do app. Nenhuma lógica foi reescrita nesta extração —
// só movida pra um arquivo que também pode ser testado isoladamente.
// ============================================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FinanceCalc = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
 
  // ---------- datas / chaves de mês ----------
  function monthKey(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
 
  function shiftMonth(key, delta) {
    let [y, m] = key.split('-').map(Number);
    m += delta;
    while (m > 12) { m -= 12; y++; }
    while (m < 1) { m += 12; y--; }
    return y + '-' + String(m).padStart(2, '0');
  }
 
  function toMonthKey(dateStr) { return dateStr ? dateStr.slice(0, 7) : null; }
 
  function lastDayOfMonth(key) {
    const [y, m] = key.split('-').map(Number);
    return new Date(y, m, 0).getDate();
  }
 
  function dueDateForMonth(dueDay, key) {
    const day = Math.min(Number(dueDay) || 1, lastDayOfMonth(key));
    return key + '-' + String(day).padStart(2, '0');
  }
 
  function weekdayOfDate(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d).getDay();
  }
 
  // Todas as datas (YYYY-MM-DD) dentro do mês `key` em que cai um determinado
  // dia da semana — ex.: todas as terças de agosto/2026.
  function weeklyOccurrencesInMonth(weekday, key) {
    const days = lastDayOfMonth(key);
    const out = [];
    for (let d = 1; d <= days; d++) {
      const dateStr = key + '-' + String(d).padStart(2, '0');
      if (weekdayOfDate(dateStr) === Number(weekday)) out.push(dateStr);
    }
    return out;
  }
 
  // Todas as datas dentro do mês `key` que caem a cada 14 dias a partir de
  // uma data de referência (funciona nos dois sentidos, passado ou futuro).
  function biweeklyOccurrencesInMonth(referenceDate, key) {
    const ref = new Date(referenceDate + 'T00:00:00');
    const monthStart = new Date(key + '-01T00:00:00');
    const monthEnd = new Date(key + '-' + String(lastDayOfMonth(key)).padStart(2, '0') + 'T00:00:00');
    const diffDays = Math.round((monthStart - ref) / 86400000);
    let k = Math.ceil(diffDays / 14);
    const out = [];
    while (true) {
      const d = new Date(ref.getTime() + k * 14 * 86400000);
      if (d > monthEnd) break;
      if (d >= monthStart) out.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'));
      k++;
    }
    return out;
  }
 
  // Datas esperadas de uma despesa fixa dentro do mês `key`, de acordo com a
  // frequência cadastrada (mensal / semanal / quinzenal).
  function fixedExpenseOccurrencesInMonth(fx, key) {
    if (fx.frequency === 'semanal') return weeklyOccurrencesInMonth(fx.due_weekday, key);
    if (fx.frequency === 'quinzenal') return biweeklyOccurrencesInMonth(fx.due_date, key);
    return [dueDateForMonth(fx.due_day, key)];
  }
 
  function monthsBetween(startKey, endKey) {
    const out = [];
    let cur = startKey;
    while (true) {
      out.push(cur);
      if (cur === endKey) break;
      cur = shiftMonth(cur, 1);
    }
    return out;
  }
 
  // ---------- receitas ----------
  function incomeForMonth(incomeList, key) {
    let total = 0;
    incomeList.forEach((inc) => {
      if (inc.recurring) total += Number(inc.amount);
      else if (inc.income_date && inc.income_date.slice(0, 7) === key) total += Number(inc.amount);
    });
    return total;
  }
 
  // ---------- despesas fixas (não pagas no cartão) ----------
  // Despesas fixas pagas no cartão não contam na previsibilidade (Saldo
  // geral, Fluxo de Caixa) — quem representa gasto de cartão nos totais é a
  // aba Cartões.
  function nonCardFixedList(fixedList) {
    return fixedList.filter((e) => e.active && e.payment_method !== 'Cartão de crédito');
  }
 
  function descriptionsMatch(description, fixedName) {
    const a = (description || '').trim().toLowerCase();
    const b = (fixedName || '').trim().toLowerCase();
    if (!a || !b) return false;
    return a === b || a.includes(b) || b.includes(a);
  }
 
  function daysBetween(a, b) {
    const da = new Date(a + 'T00:00:00');
    const db = new Date(b + 'T00:00:00');
    return Math.round((db - da) / 86400000);
  }
 
  const FIXED_MATCH_WINDOW_DAYS = 3;
 
  // Monta a lista de ocorrências esperadas este mês pra cada despesa fixa
  // (não paga no cartão) — cada ocorrência é classificada como:
  //   'linked'    — já existe um lançamento real ligado a esta despesa fixa.
  //   'suggested' — exatamente 1 lançamento não-ligado bate como candidato.
  //   'ambiguous' — 2+ lançamentos candidatos.
  //   'pending'   — nenhum candidato — ainda vira estimativa no saldo do mês.
  function planFixedExpenseReview(fixedExpenses, expenseEntries, key) {
    const inMonth = (expenseEntries || []).filter((e) => e.entry_date && e.entry_date.slice(0, 7) === key);
    const claimed = new Set();
    const occurrences = [];
    nonCardFixedList(fixedExpenses).forEach((fx) => {
      // Não gera ocorrência nenhuma (nem "pending") pra um mês ANTES da
      // despesa fixa existir no app (created_at).
      if (fx.created_at && key < fx.created_at.slice(0, 7)) return;
      const dates = fixedExpenseOccurrencesInMonth(fx, key);
      // Ocorrências já vinculadas (fixed_expense_id === fx.id) precisam ser
      // casadas com a data esperada mais PRÓXIMA (casamento guloso por menor
      // distância), não com "a primeira data ainda não usada".
      const linkedEntries = inMonth.filter((e) => e.fixed_expense_id === fx.id);
      const pairs = [];
      dates.forEach((expectedDate, di) => {
        linkedEntries.forEach((e) => { pairs.push({ di, entry: e, dist: Math.abs(daysBetween(expectedDate, e.entry_date)) }); });
      });
      pairs.sort((a, b) => a.dist - b.dist);
      const assignment = new Array(dates.length).fill(null);
      const entryClaimed = new Set();
      pairs.forEach((p) => {
        if (assignment[p.di] || entryClaimed.has(p.entry.id)) return;
        assignment[p.di] = p.entry;
        entryClaimed.add(p.entry.id);
      });
      dates.forEach((expectedDate, di) => {
        const base = { fixedExpenseId: fx.id, name: fx.name, category: fx.category, paymentMethod: fx.payment_method, estimatedAmount: Number(fx.amount), expectedDate };
        const linked = assignment[di];
        if (linked) {
          claimed.add(linked.id);
          occurrences.push({ ...base, status: 'linked', entry: linked });
          return;
        }
        const candidates = inMonth.filter((e) => !e.fixed_expense_id && !claimed.has(e.id) && e.category === fx.category && e.payment_method === fx.payment_method && descriptionsMatch(e.description, fx.name) && Math.abs(daysBetween(expectedDate, e.entry_date)) <= FIXED_MATCH_WINDOW_DAYS);
        if (candidates.length === 1) {
          occurrences.push({ ...base, status: 'suggested', candidate: candidates[0] });
        } else if (candidates.length > 1) {
          occurrences.push({ ...base, status: 'ambiguous', candidates });
        } else {
          occurrences.push({ ...base, status: 'pending' });
        }
      });
    });
    return occurrences.sort((a, b) => a.expectedDate < b.expectedDate ? -1 : a.expectedDate > b.expectedDate ? 1 : 0);
  }
 
  // Ocorrências de despesa fixa ainda "pendentes" (sem lançamento real que já
  // as represente), só pro mês atual em diante — regime de competência só
  // faz sentido pra um período ainda ABERTO; mês passado usa só o realizado.
  // `todayKey` é opcional (default: mês atual de verdade) — existe só pra
  // permitir teste determinístico sem depender do relógio da máquina; todo
  // chamador dentro do app (que não passa esse 4º argumento) continua se
  // comportando exatamente como antes da extração.
  function pendingFixedOccurrencesForMonth(fixedList, expenseEntries, key, todayKey) {
    const tk = todayKey || monthKey(new Date());
    if (key < tk) return [];
    return planFixedExpenseReview(fixedList, expenseEntries, key).filter((occ) => occ.status === 'pending');
  }
 
  function fixedContributionForMonth(fixedList, expenseEntries, key, todayKey) {
    return pendingFixedOccurrencesForMonth(fixedList, expenseEntries, key, todayKey)
      .reduce((s, occ) => s + occ.estimatedAmount, 0);
  }
 
  // ---------- cartões / fatura ----------
  function cardInstallmentForMonth(purchase, key) {
    const install = Number(purchase.amount) / Number(purchase.installments || 1);
    const [sy, sm] = toMonthKey(purchase.first_month).split('-').map(Number);
    const [ky, km] = key.split('-').map(Number);
    const idx = (ky - sy) * 12 + (km - sm);
    if (idx < 0 || idx >= Number(purchase.installments || 1)) return 0;
    // excluded_months: meses em que essa parcela específica foi removida "de
    // forma desintegrada" (só aquele mês) pelo botão "Remover parcela".
    if (Array.isArray(purchase.excluded_months) && purchase.excluded_months.includes(key)) return 0;
    return install;
  }
 
  function cardTotalForMonth(purchases, cardId, key) {
    return purchases.filter((p) => p.card_id === cardId).reduce((s, p) => s + cardInstallmentForMonth(p, key), 0);
  }
 
  function allCardsTotalForMonth(purchases, key) {
    return purchases.reduce((s, p) => s + cardInstallmentForMonth(p, key), 0);
  }
 
  // Qual fatura (identificada pelo mês de VENCIMENTO) está em aberto agora,
  // acumulando novas compras, pra um cartão específico — baseado no dia de
  // fechamento e vencimento dele, não no mês do calendário.
  function currentInvoiceMonthKey(card, today) {
    today = today || new Date();
    const todayKey = monthKey(today);
    const closingMonthKey = today.getDate() <= card.closing_day ? todayKey : shiftMonth(todayKey, 1);
    return card.due_day < card.closing_day ? shiftMonth(closingMonthKey, 1) : closingMonthKey;
  }
 
  // ---------- despesas variáveis (Despesas, não pagas no cartão) ----------
  // Lançamentos cuja forma de pagamento NÃO é cartão de crédito — esses somam
  // no saldo/fluxo de caixa. Os pagos no cartão ficam de fora de propósito:
  // quem os representa nos totais é a aba Cartões, pra nunca contar 2x.
  function nonCardExpenseEntriesForMonth(expenseEntries, key) {
    return (expenseEntries || []).filter((e) => e.entry_date && e.entry_date.slice(0, 7) === key && e.payment_method !== 'Cartão de crédito');
  }
 
  function nonCardExpenseTotalForMonth(expenseEntries, key) {
    return nonCardExpenseEntriesForMonth(expenseEntries, key).reduce((s, e) => s + Number(e.amount), 0);
  }
 
  // ---------- saldo do mês ----------
  // Mesma fórmula usada no Dashboard: receitas menos despesas fixas
  // (estimativa do que ainda falta lançar) menos fatura de cartão do mês
  // menos despesas variáveis já lançadas.
  function computeSaldoMes(inc, fixed, cardsTotal, variableTotal) {
    return inc - fixed - cardsTotal - variableTotal;
  }
 
  // ---------- "desde o início" ----------
  function allMonthsSinceStart(data) {
    const dated = [];
    (data.income || []).forEach((i) => { if (!i.recurring && i.income_date) dated.push(i.income_date.slice(0, 7)); });
    (data.expenseEntries || []).forEach((e) => { if (e.entry_date) dated.push(e.entry_date.slice(0, 7)); });
    (data.purchases || []).forEach((p) => { if (p.first_month) dated.push(toMonthKey(p.first_month)); });
    const endKey = monthKey(new Date());
    const startKey = dated.length ? dated.sort()[0] : endKey;
    return monthsBetween(startKey, endKey);
  }
 
  // Total recebido e total gasto desde o primeiro lançamento até hoje.
  // totalGasto conta só o que foi REALMENTE lançado (cartão + despesas em
  // Despesas > Lançamentos) — nunca a estimativa de despesa fixa pendente.
  function lifetimeTotals(data) {
    const months = allMonthsSinceStart(data);
    let totalRecebido = 0, totalGasto = 0;
    months.forEach((m) => {
      totalRecebido += incomeForMonth(data.income, m);
      totalGasto += allCardsTotalForMonth(data.purchases, m) + nonCardExpenseTotalForMonth(data.expenseEntries, m);
    });
    return { totalRecebido, totalGasto, months };
  }
 
  // ---------- patrimônio líquido ----------
  // Única fonte de verdade pro cálculo — antes existia uma cópia quase
  // idêntica no Dashboard e outra na aba Patrimônio, com risco real de uma
  // ser corrigida e a outra não.
  function computePatrimonioLiquido(assets, investTotal, debtTotal) {
    const totalAtivos = assets.filter((a) => a.kind === 'ativo').reduce((s, a) => s + Number(a.value), 0) + Number(investTotal || 0);
    const totalPassivos = assets.filter((a) => a.kind === 'passivo').reduce((s, a) => s + Number(a.value), 0) + Number(debtTotal || 0);
    return { totalAtivos, totalPassivos, patrimonioLiquido: totalAtivos - totalPassivos };
  }
 
  // ---------- reserva de emergência ----------
  // "0.0x" sem contexto (quando ninguém lançou nada em Patrimônio como
  // "Reserva de emergência" ainda) é diferente de "reserva insuficiente"
  // — `semReservaLancada` deixa a tela distinguir os dois casos.
  function computeReserva(assets, despesaHoje) {
    const reservaAtual = assets.filter((a) => a.kind === 'ativo' && a.category === 'Reserva de emergência').reduce((s, a) => s + Number(a.value), 0);
    const mesesReserva = despesaHoje > 0 ? reservaAtual / despesaHoje : null;
    return { reservaAtual, mesesReserva, semReservaLancada: reservaAtual === 0 };
  }
 
  return {
    monthKey, shiftMonth, toMonthKey, lastDayOfMonth, dueDateForMonth, weekdayOfDate,
    weeklyOccurrencesInMonth, biweeklyOccurrencesInMonth, fixedExpenseOccurrencesInMonth,
    monthsBetween, incomeForMonth, nonCardFixedList, descriptionsMatch, daysBetween,
    FIXED_MATCH_WINDOW_DAYS, planFixedExpenseReview, pendingFixedOccurrencesForMonth,
    fixedContributionForMonth, cardInstallmentForMonth, cardTotalForMonth, allCardsTotalForMonth,
    currentInvoiceMonthKey, nonCardExpenseEntriesForMonth, nonCardExpenseTotalForMonth,
    computeSaldoMes, allMonthsSinceStart, lifetimeTotals, computePatrimonioLiquido, computeReserva,
  };
});
