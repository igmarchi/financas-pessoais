// ============================================================
// Testes de regressão das contas críticas do Tonus Financeiro:
// saldo do mês, fatura de cartão e patrimônio líquido/reserva.
//
// Roda com Node puro, sem instalar nada: `node --test`
// (usa o test runner nativo do Node 20+, node:test / node:assert).
//
// Objetivo: travar o COMPORTAMENTO hoje validado manualmente, pra que uma
// mudança futura em finance-calc.js que quebre uma dessas contas seja
// pega aqui, antes de virar um número errado na tela de alguém.
// ============================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./finance-calc.js');
 
const {
  computeSaldoMes, computePatrimonioLiquido, computeReserva,
  incomeForMonth, nonCardExpenseTotalForMonth, fixedContributionForMonth,
  cardInstallmentForMonth, cardTotalForMonth, allCardsTotalForMonth,
  currentInvoiceMonthKey, lifetimeTotals,
  monthKey, shiftMonth, healthIndicatorsForMonth, projectBalance,
} = fc;
 
// ------------------------------------------------------------
// Saldo do mês
// ------------------------------------------------------------
test('computeSaldoMes soma receita e subtrai despesas fixas, cartão e variáveis', () => {
  assert.equal(computeSaldoMes(5000, 1200, 800, 350), 2650);
});
 
test('computeSaldoMes fica negativo quando gasto passa a receita (estouro do mês)', () => {
  assert.equal(computeSaldoMes(3000, 2000, 1500, 200), -700);
});
 
test('incomeForMonth: receita recorrente conta em qualquer mês perguntado', () => {
  const income = [{ amount: 5000, recurring: true }];
  assert.equal(incomeForMonth(income, '2026-01'), 5000);
  assert.equal(incomeForMonth(income, '2026-08'), 5000);
});
 
test('incomeForMonth: receita avulsa só conta no mês exato dela', () => {
  const income = [{ amount: 1200, recurring: false, income_date: '2026-08-15' }];
  assert.equal(incomeForMonth(income, '2026-08'), 1200);
  assert.equal(incomeForMonth(income, '2026-09'), 0);
});
 
test('nonCardExpenseTotalForMonth: exclui lançamentos pagos no cartão (quem soma esses é a aba Cartões)', () => {
  const entries = [
    { entry_date: '2026-08-05', amount: 100, payment_method: 'PIX' },
    { entry_date: '2026-08-06', amount: 300, payment_method: 'Cartão de crédito' },
    { entry_date: '2026-07-20', amount: 999, payment_method: 'PIX' }, // mês errado
  ];
  assert.equal(nonCardExpenseTotalForMonth(entries, '2026-08'), 100);
});
 
test('fixedContributionForMonth: despesa fixa sem lançamento real vira estimativa pendente', () => {
  const fixedExpenses = [{ id: 'f1', name: 'Aluguel', category: 'Moradia', payment_method: 'Boleto', amount: 1500, active: true, due_day: 10, frequency: 'mensal', created_at: '2026-01-01' }];
  const total = fixedContributionForMonth(fixedExpenses, [], '2026-08', '2026-08');
  assert.equal(total, 1500);
});
 
test('fixedContributionForMonth: uma vez lançada de verdade (linked), não soma mais como estimativa — não duplica', () => {
  const fixedExpenses = [{ id: 'f1', name: 'Aluguel', category: 'Moradia', payment_method: 'Boleto', amount: 1500, active: true, due_day: 10, frequency: 'mensal', created_at: '2026-01-01' }];
  const expenseEntries = [{ id: 'e1', fixed_expense_id: 'f1', entry_date: '2026-08-10', amount: 1500, category: 'Moradia', payment_method: 'Boleto' }];
  const total = fixedContributionForMonth(fixedExpenses, expenseEntries, '2026-08', '2026-08');
  assert.equal(total, 0);
});
 
test('fixedContributionForMonth: despesa fixa paga no cartão não entra (quem representa isso é a fatura, não a previsibilidade)', () => {
  const fixedExpenses = [{ id: 'f1', name: 'Streaming', category: 'Assinaturas', payment_method: 'Cartão de crédito', amount: 40, active: true, due_day: 5, frequency: 'mensal', created_at: '2026-01-01' }];
  const total = fixedContributionForMonth(fixedExpenses, [], '2026-08', '2026-08');
  assert.equal(total, 0);
});
 
test('fixedContributionForMonth: despesa fixa cadastrada DEPOIS do mês perguntado não "gasta" retroativo', () => {
  const fixedExpenses = [{ id: 'f1', name: 'Academia', category: 'Saúde', payment_method: 'PIX', amount: 120, active: true, due_day: 5, frequency: 'mensal', created_at: '2026-08-01' }];
  const total = fixedContributionForMonth(fixedExpenses, [], '2026-06', '2026-08');
  assert.equal(total, 0);
});
 
test('fixedContributionForMonth: mês PASSADO usa só o realizado — não inventa estimativa pendente de um mês já fechado', () => {
  const fixedExpenses = [{ id: 'f1', name: 'Aluguel', category: 'Moradia', payment_method: 'Boleto', amount: 1500, active: true, due_day: 10, frequency: 'mensal', created_at: '2026-01-01' }];
  // Nada foi lançado em julho/2026, e hoje já é agosto/2026 — julho é passado.
  const total = fixedContributionForMonth(fixedExpenses, [], '2026-07', '2026-08');
  assert.equal(total, 0);
});
 
test('fixedContributionForMonth: despesa fixa inativa (pausada) não soma', () => {
  const fixedExpenses = [{ id: 'f1', name: 'Academia', category: 'Saúde', payment_method: 'PIX', amount: 120, active: false, due_day: 5, frequency: 'mensal', created_at: '2026-01-01' }];
  const total = fixedContributionForMonth(fixedExpenses, [], '2026-08', '2026-08');
  assert.equal(total, 0);
});
 
test('fixedContributionForMonth: despesa fixa semanal soma uma vez por ocorrência real no mês (não 1x fixo)', () => {
  // Agosto/2026: quantas terças-feiras (weekday 2) existem?
  const d = new Date(2026, 7, 1); // 1º de agosto/2026
  let terças = 0;
  for (let day = 1; day <= 31; day++) {
    if (new Date(2026, 7, day).getDay() === 2) terças++;
  }
  const fixedExpenses = [{ id: 'f1', name: 'Terapia', category: 'Saúde', payment_method: 'PIX', amount: 200, active: true, frequency: 'semanal', due_weekday: 2, created_at: '2026-01-01' }];
  const total = fixedContributionForMonth(fixedExpenses, [], '2026-08', '2026-08');
  assert.equal(total, terças * 200);
});
 
// ------------------------------------------------------------
// Fatura de cartão
// ------------------------------------------------------------
test('cardInstallmentForMonth: divide o valor igualmente pelas parcelas', () => {
  const purchase = { amount: 900, installments: 3, first_month: '2026-06-01' };
  assert.equal(cardInstallmentForMonth(purchase, '2026-06'), 300);
  assert.equal(cardInstallmentForMonth(purchase, '2026-07'), 300);
  assert.equal(cardInstallmentForMonth(purchase, '2026-08'), 300);
});
 
test('cardInstallmentForMonth: fora do intervalo de parcelas retorna 0', () => {
  const purchase = { amount: 900, installments: 3, first_month: '2026-06-01' };
  assert.equal(cardInstallmentForMonth(purchase, '2026-05'), 0); // antes da 1ª parcela
  assert.equal(cardInstallmentForMonth(purchase, '2026-09'), 0); // depois da última
});
 
test('cardInstallmentForMonth: compra à vista (1x) só conta no mês da compra', () => {
  const purchase = { amount: 250, installments: 1, first_month: '2026-08-01' };
  assert.equal(cardInstallmentForMonth(purchase, '2026-08'), 250);
  assert.equal(cardInstallmentForMonth(purchase, '2026-09'), 0);
});
 
test('cardInstallmentForMonth: parcela removida individualmente (excluded_months) some só naquele mês', () => {
  const purchase = { amount: 900, installments: 3, first_month: '2026-06-01', excluded_months: ['2026-07'] };
  assert.equal(cardInstallmentForMonth(purchase, '2026-06'), 300);
  assert.equal(cardInstallmentForMonth(purchase, '2026-07'), 0); // removida
  assert.equal(cardInstallmentForMonth(purchase, '2026-08'), 300); // as outras continuam
});
 
test('cardTotalForMonth: soma só as compras do cartão pedido, ignora os outros cartões', () => {
  const purchases = [
    { card_id: 'nubank', amount: 300, installments: 1, first_month: '2026-08-01' },
    { card_id: 'itau', amount: 500, installments: 1, first_month: '2026-08-01' },
  ];
  assert.equal(cardTotalForMonth(purchases, 'nubank', '2026-08'), 300);
});
 
test('allCardsTotalForMonth: soma as parcelas de todos os cartões que caem no mês', () => {
  const purchases = [
    { card_id: 'nubank', amount: 300, installments: 1, first_month: '2026-08-01' },
    { card_id: 'itau', amount: 600, installments: 3, first_month: '2026-07-01' }, // 200/mês, jul-set
  ];
  assert.equal(allCardsTotalForMonth(purchases, '2026-08'), 500);
});
 
test('currentInvoiceMonthKey: cartão vence no mês seguinte ao fechamento (ex.: fecha 25, vence 5) — antes de fechar, fatura aberta vence 2 meses à frente', () => {
  const card = { closing_day: 25, due_day: 5 };
  const today = new Date(2026, 7, 10); // 10/ago, ainda antes do fechamento de 25/ago
  // fecha 25/ago → vence 05/set; essa é a fatura que ainda está "em aberto" acumulando compras novas
  assert.equal(currentInvoiceMonthKey(card, today), '2026-09');
});
 
test('currentInvoiceMonthKey: mesmo cartão (fecha 25, vence 5), depois de fechar o mês avança mais um', () => {
  const card = { closing_day: 25, due_day: 5 };
  const today = new Date(2026, 7, 26); // 26/ago, já passou do fechamento de 25/ago
  // fatura de 25/ago já fechou (vence 05/set) — a que está aberta agora fecha 25/set, vence 05/out
  assert.equal(currentInvoiceMonthKey(card, today), '2026-10');
});
 
test('currentInvoiceMonthKey: cartão vence no mesmo mês do fechamento (ex.: fecha 5, vence 15), depois de fechar', () => {
  const card = { closing_day: 5, due_day: 15 };
  const today = new Date(2026, 7, 10); // 10/ago, já passou do fechamento (05/ago)
  assert.equal(currentInvoiceMonthKey(card, today), '2026-09');
});
 
test('currentInvoiceMonthKey: cartão vence no mesmo mês do fechamento, antes de fechar — fatura aberta vence este mês', () => {
  const card = { closing_day: 20, due_day: 28 };
  const today = new Date(2026, 7, 10); // 10/ago, antes do fechamento de 20/ago
  assert.equal(currentInvoiceMonthKey(card, today), '2026-08');
});
 
// ------------------------------------------------------------
// Patrimônio líquido
// ------------------------------------------------------------
test('computePatrimonioLiquido: ativos + investimentos - passivos - dívidas', () => {
  const assets = [
    { kind: 'ativo', category: 'Conta corrente / poupança', value: 10000 },
    { kind: 'ativo', category: 'Imóvel', value: 300000 },
    { kind: 'passivo', category: 'Financiamento', value: 50000 },
  ];
  const { totalAtivos, totalPassivos, patrimonioLiquido } = computePatrimonioLiquido(assets, 20000, 5000);
  assert.equal(totalAtivos, 330000); // 10000 + 300000 + 20000 (investimentos)
  assert.equal(totalPassivos, 55000); // 50000 + 5000 (dívidas)
  assert.equal(patrimonioLiquido, 275000);
});
 
test('computePatrimonioLiquido: sem nenhum ativo/passivo lançado, tudo zero', () => {
  const { totalAtivos, totalPassivos, patrimonioLiquido } = computePatrimonioLiquido([], 0, 0);
  assert.equal(totalAtivos, 0);
  assert.equal(totalPassivos, 0);
  assert.equal(patrimonioLiquido, 0);
});
 
test('computePatrimonioLiquido: patrimônio pode ficar negativo (mais dívida do que bem)', () => {
  const assets = [{ kind: 'passivo', category: 'Empréstimo', value: 8000 }];
  const { patrimonioLiquido } = computePatrimonioLiquido(assets, 0, 0);
  assert.equal(patrimonioLiquido, -8000);
});
 
// ------------------------------------------------------------
// Reserva de emergência
// ------------------------------------------------------------
test('computeReserva: nada lançado como "Reserva de emergência" — sinaliza semReservaLancada, não é null', () => {
  const assets = [{ kind: 'ativo', category: 'Conta corrente / poupança', value: 75000 }]; // dinheiro existe, mas não está na categoria certa
  const { reservaAtual, mesesReserva, semReservaLancada } = computeReserva(assets, 5000);
  assert.equal(reservaAtual, 0);
  assert.equal(mesesReserva, 0);
  assert.equal(semReservaLancada, true);
});
 
test('computeReserva: com reserva lançada, calcula quantos meses de despesa ela cobre', () => {
  const assets = [{ kind: 'ativo', category: 'Reserva de emergência', value: 15000 }];
  const { reservaAtual, mesesReserva, semReservaLancada } = computeReserva(assets, 5000);
  assert.equal(reservaAtual, 15000);
  assert.equal(mesesReserva, 3);
  assert.equal(semReservaLancada, false);
});
 
test('computeReserva: sem nenhuma despesa no mês (despesaHoje = 0), não dá pra dividir — mesesReserva é null', () => {
  const assets = [{ kind: 'ativo', category: 'Reserva de emergência', value: 15000 }];
  const { mesesReserva } = computeReserva(assets, 0);
  assert.equal(mesesReserva, null);
});
 
test('computeReserva: ignora ativo de "Reserva de emergência" classificado como passivo (kind errado)', () => {
  const assets = [{ kind: 'passivo', category: 'Reserva de emergência', value: 15000 }];
  const { reservaAtual } = computeReserva(assets, 5000);
  assert.equal(reservaAtual, 0);
});
 
// ------------------------------------------------------------
// Indicadores de saúde financeira (comprometimento de renda / poupança)
// ------------------------------------------------------------
test('healthIndicatorsForMonth: comprometimento + poupança somam 100% da renda', () => {
  const key = monthKey(new Date()); // usa o mês atual pra não esbarrar no "mês passado usa só o realizado" de fixedContributionForMonth
  const data = {
    income: [{ amount: 5000, recurring: true }],
    fixedExpenses: [{ id: 'f1', name: 'Aluguel', category: 'Moradia', payment_method: 'Boleto', amount: 1500, active: true, due_day: 10, frequency: 'mensal', created_at: '2020-01-01' }],
    expenseEntries: [{ entry_date: key + '-05', amount: 500, payment_method: 'PIX' }],
    purchases: [],
  };
  const { comprometimento, poupanca } = healthIndicatorsForMonth(data, key);
  // despMes = 1500 (fixa estimada, sem lançamento vinculado) + 0 (cartão) + 500 (variável) = 2000
  assert.equal(comprometimento, 40); // 2000 / 5000 * 100
  assert.equal(poupanca, 60); // (5000 - 2000) / 5000 * 100
});
 
test('healthIndicatorsForMonth: sem renda no mês, indicadores ficam null (não dá pra calcular % de uma base zero)', () => {
  const data = { income: [], fixedExpenses: [], expenseEntries: [], purchases: [] };
  const { comprometimento, poupanca } = healthIndicatorsForMonth(data, '2026-08');
  assert.equal(comprometimento, null);
  assert.equal(poupanca, null);
});
 
test('healthIndicatorsForMonth: mês estourado passa de 100% de comprometimento e poupança fica negativa', () => {
  const data = {
    income: [{ amount: 2000, recurring: true }],
    fixedExpenses: [],
    expenseEntries: [{ entry_date: '2026-08-05', amount: 2500, payment_method: 'PIX' }],
    purchases: [],
  };
  const { comprometimento, poupanca } = healthIndicatorsForMonth(data, '2026-08');
  assert.equal(comprometimento, 125); // 2500 / 2000 * 100
  assert.equal(poupanca, -25);
});
 
// ------------------------------------------------------------
// Projeção de saldo (próximos meses)
// ------------------------------------------------------------
test('projectBalance: renda recorrente menos despesas fixas estimadas, sem cartão nem histórico variável', () => {
  const nowKey = monthKey(new Date());
  const data = {
    income: [{ amount: 5000, recurring: true }],
    fixedExpenses: [{ id: 'f1', name: 'Aluguel', category: 'Moradia', payment_method: 'Boleto', amount: 1500, active: true, due_day: 10, frequency: 'mensal', created_at: '2020-01-01' }],
    expenseEntries: [], // nenhum gasto variável nos últimos 3 meses -> média = 0
    purchases: [],
  };
  const projection = projectBalance(data, 1);
  assert.equal(projection.length, 1);
  assert.equal(projection[0].m, shiftMonth(nowKey, 1));
  assert.equal(projection[0].saldo, 3500); // 5000 - 1500
});
 
test('projectBalance: estima despesa variável futura pela média dos últimos 3 meses realizados', () => {
  const nowKey = monthKey(new Date());
  const mPrev2 = shiftMonth(nowKey, -2);
  const mPrev1 = shiftMonth(nowKey, -1);
  const data = {
    income: [{ amount: 4000, recurring: true }],
    fixedExpenses: [],
    expenseEntries: [
      { entry_date: mPrev2 + '-05', amount: 300, payment_method: 'PIX' },
      { entry_date: mPrev1 + '-05', amount: 600, payment_method: 'PIX' },
      { entry_date: nowKey + '-05', amount: 900, payment_method: 'PIX' },
    ],
    purchases: [],
  };
  // média = (300 + 600 + 900) / 3 = 600
  const projection = projectBalance(data, 2);
  assert.equal(projection[0].saldo, 3400); // 4000 - 600
  assert.equal(projection[1].saldo, 3400);
});
 
test('projectBalance: parcela de cartão já lançada entra na despesa projetada (não é estimativa)', () => {
  const nowKey = monthKey(new Date());
  const m1 = shiftMonth(nowKey, 1);
  const data = {
    income: [{ amount: 3000, recurring: true }],
    fixedExpenses: [],
    expenseEntries: [],
    purchases: [{ card_id: 'c1', amount: 900, installments: 3, first_month: nowKey + '-01' }], // 300/mês, cobre nowKey..nowKey+2
  };
  const projection = projectBalance(data, 1);
  assert.equal(projection[0].m, m1);
  assert.equal(projection[0].saldo, 2700); // 3000 - 300 (parcela do cartão em m1)
});
 
// ------------------------------------------------------------
// "Desde o início" (lifetime) — usado ao lado do patrimônio no Dashboard
// ------------------------------------------------------------
test('lifetimeTotals: soma receitas avulsas e gastos reais (cartão + variável) por todos os meses com lançamento', () => {
  const data = {
    income: [{ amount: 1000, recurring: false, income_date: '2026-06-15' }],
    expenseEntries: [{ entry_date: '2026-06-20', amount: 200, payment_method: 'PIX' }],
    purchases: [{ card_id: 'c1', amount: 300, installments: 1, first_month: '2026-06-01' }],
  };
  const { totalRecebido, totalGasto } = lifetimeTotals(data);
  assert.equal(totalRecebido, 1000);
  assert.equal(totalGasto, 500); // 200 (variável) + 300 (cartão)
});
