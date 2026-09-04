// ============================================================
// Testes da lógica de datas/janela de lembrete de vencimento
// (enviar-lembretes-vencimento). Roda com Deno, sem precisar de conta
// nem de rede: `deno test enviar-lembretes-vencimento.test.ts`
//
// Objetivo: travar o comportamento das duas janelas de lembrete
// ("3_dias_antes" e "no_dia") pra despesa fixa e fatura de cartão, e o
// cálculo de "hoje" no fuso de Brasília — antes que uma mudança futura
// em lembretes-logic.ts (ou uma divergência com finance-calc.js) vire
// um lembrete que não chega, ou chega no dia errado, pra alguém.
// ============================================================
import assert from "node:assert/strict";
function assertEquals<T>(actual: T, expected: T) { assert.deepStrictEqual(actual, expected); }
import {
  monthKey, shiftMonth, dueDateForMonth, toISO,
  nextFixedExpenseOccurrence, cardTotalForMonth, currentInvoiceMonthKey,
  hojeEmSaoPaulo,
} from "./lembretes-logic.ts";

// ------------------------------------------------------------
// monthKey / shiftMonth / dueDateForMonth (base pra tudo mais)
// ------------------------------------------------------------
Deno.test("monthKey formata ano-mês com zero à esquerda", () => {
  assertEquals(monthKey(new Date(2026, 0, 15)), "2026-01");
  assertEquals(monthKey(new Date(2026, 11, 3)), "2026-12");
});

Deno.test("shiftMonth vira o ano pra frente e pra trás", () => {
  assertEquals(shiftMonth("2026-12", 1), "2027-01");
  assertEquals(shiftMonth("2026-01", -1), "2025-12");
});

Deno.test("dueDateForMonth ajusta dia de vencimento 31 em mês menor (fevereiro)", () => {
  assertEquals(dueDateForMonth(31, "2026-02"), "2026-02-28");
  assertEquals(dueDateForMonth(15, "2026-02"), "2026-02-15");
});

// ------------------------------------------------------------
// nextFixedExpenseOccurrence — despesa fixa mensal: as duas janelas
// que o lembrete precisa acertar (3 dias antes / no dia)
// ------------------------------------------------------------
Deno.test("despesa mensal: cai em 'no dia' quando vence hoje", () => {
  const hoje = new Date(2026, 8, 10); // 10/set/2026
  const fx = { frequency: "mensal", due_day: 10 };
  assertEquals(nextFixedExpenseOccurrence(fx, hoje), toISO(hoje));
});

Deno.test("despesa mensal: cai em '3 dias antes' quando vence daqui a 3 dias", () => {
  const hoje = new Date(2026, 8, 10); // 10/set/2026
  const em3 = new Date(2026, 8, 13);
  const fx = { frequency: "mensal", due_day: 13 };
  assertEquals(nextFixedExpenseOccurrence(fx, hoje), toISO(em3));
});

Deno.test("despesa mensal: NÃO cai em nenhuma janela quando vence amanhã (nem hoje, nem em 3 dias)", () => {
  const hoje = new Date(2026, 8, 10);
  const amanha = toISO(new Date(2026, 8, 11));
  const fx = { frequency: "mensal", due_day: 11 };
  const resultado = nextFixedExpenseOccurrence(fx, hoje);
  assertEquals(resultado, amanha);
  // confirma que amanhã não bate com nenhuma das duas janelas do cron
  assertEquals(resultado === toISO(hoje), false);
  assertEquals(resultado === toISO(new Date(2026, 8, 13)), false);
});

Deno.test("despesa mensal: já passou o dia no mês atual → próxima ocorrência pula pro mês seguinte", () => {
  const hoje = new Date(2026, 8, 20); // 20/set, vencimento era dia 5
  const fx = { frequency: "mensal", due_day: 5 };
  assertEquals(nextFixedExpenseOccurrence(fx, hoje), "2026-10-05");
});

Deno.test("despesa mensal: dia 31 num mês de 30 dias vence no último dia do mês", () => {
  const hoje = new Date(2026, 8, 1); // setembro tem 30 dias
  const fx = { frequency: "mensal", due_day: 31 };
  assertEquals(nextFixedExpenseOccurrence(fx, hoje), "2026-09-30");
});

// ------------------------------------------------------------
// nextFixedExpenseOccurrence — frequência semanal
// ------------------------------------------------------------
Deno.test("despesa semanal: acha a próxima ocorrência do dia da semana certo", () => {
  const hoje = new Date(2026, 8, 10); // 10/set/2026 é quinta (getDay() === 4)
  assertEquals(hoje.getDay(), 4);
  const fx = { frequency: "semanal", due_weekday: 4 }; // hoje é quinta
  assertEquals(nextFixedExpenseOccurrence(fx, hoje), toISO(hoje));
  const fxSexta = { frequency: "semanal", due_weekday: 5 }; // sexta = amanhã
  assertEquals(nextFixedExpenseOccurrence(fxSexta, hoje), toISO(new Date(2026, 8, 11)));
});

// ------------------------------------------------------------
// nextFixedExpenseOccurrence — frequência quinzenal
// ------------------------------------------------------------
Deno.test("despesa quinzenal: repete a cada 14 dias a partir da data de referência", () => {
  const fx = { frequency: "quinzenal", due_date: "2026-09-03" };
  // 14 dias depois da referência
  const hoje = new Date(2026, 8, 17);
  assertEquals(nextFixedExpenseOccurrence(fx, hoje), "2026-09-17");
  // 3 dias antes de uma ocorrência (03/set + 28 = 01/out)
  const tresDiasAntes = new Date(2026, 8, 28);
  assertEquals(nextFixedExpenseOccurrence(fx, tresDiasAntes), "2026-10-01");
});

// ------------------------------------------------------------
// Fatura de cartão — currentInvoiceMonthKey + cardTotalForMonth,
// incluindo a virada de mês (fechamento vs. vencimento em meses
// diferentes, que é a parte mais fácil de errar)
// ------------------------------------------------------------
Deno.test("fatura: due_day antes do closing_day → vencimento cai no mês seguinte ao fechamento", () => {
  const card = { closing_day: 25, due_day: 5 }; // fecha dia 25, vence dia 5 do mês seguinte
  const hoje = new Date(2026, 8, 20); // 20/set, antes de fechar → fatura de setembro
  assertEquals(currentInvoiceMonthKey(card, hoje), "2026-10"); // vence em outubro
});

Deno.test("fatura: due_day depois do closing_day → vencimento no mesmo mês do fechamento", () => {
  const card = { closing_day: 5, due_day: 12 };
  const hoje = new Date(2026, 8, 20); // depois do fechamento de set (dia 5) → fatura aberta é a que fecha em out
  assertEquals(currentInvoiceMonthKey(card, hoje), "2026-10"); // fecha 5/out, vence 12/out (mesmo mês)
});

Deno.test("fatura: antes do fechamento no mês, compras entram na fatura corrente", () => {
  const compras = [
    { card_id: "c1", amount: 300, installments: 3, first_month: "2026-08" },
    { card_id: "c1", amount: 100, installments: 1, first_month: "2026-09" },
    { card_id: "c2", amount: 999, installments: 1, first_month: "2026-09" }, // outro cartão
  ];
  // parcela 2/3 de 300 (100) + a compra à vista de 100 = 200
  assertEquals(cardTotalForMonth(compras, "c1", "2026-09"), 200);
});

// ------------------------------------------------------------
// hojeEmSaoPaulo — só confere que devolve algo no formato certo
// (o teste de fuso "de verdade" já foi validado manualmente em
// produção; aqui é sanity check de que a função não quebra)
// ------------------------------------------------------------
Deno.test("hojeEmSaoPaulo devolve uma data válida (não NaN) no formato YYYY-MM-DD", () => {
  const hoje = hojeEmSaoPaulo();
  const iso = toISO(hoje);
  assertEquals(/^\d{4}-\d{2}-\d{2}$/.test(iso), true);
  assertEquals(Number.isNaN(hoje.getTime()), false);
});
