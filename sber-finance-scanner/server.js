import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro';
const REASONING_EFFORT = process.env.DEEPSEEK_REASONING_EFFORT || 'max';

app.use(express.json({ limit: '16mb' }));
app.use(express.static(__dirname));

const allowedCategories = new Set([
  'Кино и видео', 'Музыка', 'Книги', 'Облако', 'Софт', 'Игры',
  'Связь', 'Фитнес', 'Образование', 'Доставка', 'Финансы',
  'Рестораны и кафе', 'Продукты', 'Товары и покупки', 'Услуги',
  'Транспорт', 'Такси', 'Здоровье', 'ЖКХ', 'Другое'
]);

const roundMoney = value => Math.round((Number(value) || 0) * 100) / 100;
const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));

function sanitizeText(value, max = 300) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function sanitizeCandidate(candidate) {
  return {
    candidate_id: sanitizeText(candidate.candidate_id, 80),
    suggested_name: sanitizeText(candidate.suggested_name, 120),
    merchant_key: sanitizeText(candidate.merchant_key, 180),
    cadence: sanitizeText(candidate.cadence, 40),
    confidence: clamp(candidate.confidence, 0, 1),
    typical_amount: roundMoney(candidate.typical_amount),
    observed_total: roundMoney(candidate.observed_total),
    first_date: sanitizeText(candidate.first_date, 20),
    last_date: sanitizeText(candidate.last_date, 20),
    local_category: sanitizeText(candidate.local_category || 'Другое', 80),
    local_subscription_hint: candidate.local_subscription_hint === true,
    local_veto: candidate.local_veto === true,
    explicit_recurring_signal: candidate.explicit_recurring_signal === true,
    candidate_kind: sanitizeText(candidate.candidate_kind || 'recurring', 40),
    interval_days: Array.isArray(candidate.interval_days) ? candidate.interval_days.slice(0, 30).map(Number).filter(Number.isFinite) : [],
    median_interval_days: roundMoney(candidate.median_interval_days),
    interval_mad: roundMoney(candidate.interval_mad),
    day_of_month_consistency: clamp(candidate.day_of_month_consistency, 0, 1),
    amount_min: roundMoney(candidate.amount_min),
    amount_max: roundMoney(candidate.amount_max),
    amount_spread: Math.max(0, Number(candidate.amount_spread || 0)),
    price_change_pct: Number(candidate.price_change_pct || 0),
    recurring_signals: Array.isArray(candidate.recurring_signals) ? candidate.recurring_signals.slice(0, 12).map(x => sanitizeText(x, 60)) : [],
    evidence: Array.isArray(candidate.evidence)
      ? candidate.evidence.slice(0, 24).map((e) => ({
          transaction_id: sanitizeText(e.transaction_id, 80),
          date: sanitizeText(e.date, 20),
          amount: roundMoney(e.amount),
          merchant_name: sanitizeText(e.merchant_name, 130),
          description: sanitizeText(e.description, 320)
        }))
      : []
  };
}

function sanitizeTransaction(transaction) {
  return {
    transaction_id: sanitizeText(transaction.transaction_id, 90),
    date: sanitizeText(transaction.date, 20),
    amount: roundMoney(transaction.amount),
    direction: ['income', 'expense'].includes(transaction.direction) ? transaction.direction : 'unknown',
    category: allowedCategories.has(transaction.category) ? transaction.category : 'Другое',
    merchant_name: sanitizeText(transaction.merchant_name, 130),
    description: sanitizeText(transaction.description, 340),
    raw_source: sanitizeText(transaction.raw_source, 750)
  };
}

async function deepSeekJson(system, user, maxTokens = 8000) {
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify({
      model: MODEL,
      thinking: { type: 'enabled' },
      reasoning_effort: REASONING_EFFORT,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`DeepSeek ${response.status}: ${body.slice(0, 500)}`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content || '{}';
  let parsed;
  try { parsed = JSON.parse(content); } catch { parsed = {}; }
  return { parsed, model: payload?.model || MODEL };
}

function rawContainsDate(raw, isoDate) {
  const m = String(isoDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const [, y, mo, d] = m;
  const variants = [
    `${y}-${mo}-${d}`, `${y}.${mo}.${d}`, `${y}/${mo}/${d}`,
    `${d}.${mo}.${y}`, `${d}/${mo}/${y}`, `${d}-${mo}-${y}`,
    `${d}.${mo}.${y.slice(-2)}`, `${d}/${mo}/${y.slice(-2)}`, `${d}-${mo}-${y.slice(-2)}`
  ];
  return variants.some(v => String(raw).includes(v));
}

function parseLooseMoney(value) {
  let s = String(value || '').replace(/\u00a0/g, ' ').replace(/[₽$€£]/g, '').replace(/\b(RUB|RUR|руб\.?)/gi, '').trim().replace(/−/g, '-');
  const neg = /^-|\(.*\)/.test(s);
  s = s.replace(/[()]/g, '').replace(/\s/g, '');
  if (s.includes(',') && s.includes('.')) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (s.includes(',')) s = s.replace(',', '.');
  else if (/^\d{1,3}(?:\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = parseFloat(s.replace(/[^\d.+-]/g, ''));
  return Number.isFinite(n) ? (neg ? -Math.abs(n) : n) : NaN;
}

function rawContainsAmount(raw, target) {
  const text = String(raw || '');
  const tokens = [...text.matchAll(/[+\-−]?\s*\d{1,3}(?:[ \u00a0]\d{3})*(?:[.,]\d{1,2})|[+\-−]?\s*\d{1,9}(?:[.,]\d{1,2})?/g)].map(m => m[0]);
  const wanted = Math.abs(Number(target));
  return tokens.some(token => {
    const n = parseLooseMoney(token);
    return Number.isFinite(n) && Math.abs(Math.abs(n) - wanted) < 0.005;
  });
}

function rawSupportsDirection(raw, direction) {
  const text = String(raw || '').toLowerCase();
  if (direction === 'income') return /зачислен|приход|кредит|поступлен|пополн|зарплат|refund|возврат|cashback|кэшбэк|перевод\s+от|сбп\s+от/.test(text);
  if (direction === 'expense') return /списан|расход|дебет|оплата|покупк|purchase|payment|снятие|перевод\s+(?:на|для|кому)|сбп\s+(?:на|для)/.test(text) || /(?:^|\s)[−-]\s*\d/.test(text);
  return false;
}

function merchantSupported(raw, value) {
  const normalize = s => String(s || '').toLowerCase().replace(/[^a-zа-яё0-9]+/gi, ' ').replace(/\s+/g, ' ').trim();
  const r = normalize(raw), v = normalize(value);
  if (v.length < 2) return false;
  const tokens = v.split(' ').filter(x => x.length >= 3);
  return tokens.length ? tokens.some(token => r.includes(token)) : r.includes(v);
}

function markSafeAuditIssue(issue, source) {
  const field = String(issue?.field || '');
  const confidence = clamp(issue?.confidence, 0, 1);
  const suggested = issue?.suggested_value;
  let safe = false;
  if (confidence >= 0.97) {
    if (field === 'date') safe = rawContainsDate(source.raw_source, suggested);
    else if (field === 'amount') safe = Number(suggested) > 0 && rawContainsAmount(source.raw_source, suggested);
    else if (field === 'direction') safe = ['income', 'expense'].includes(suggested) && rawSupportsDirection(source.raw_source, suggested);
    else if (field === 'merchant_name') safe = merchantSupported(source.raw_source, suggested);
  }
  return {
    transaction_id: source.transaction_id,
    field: ['date', 'amount', 'merchant_name', 'description', 'direction', 'category'].includes(field) ? field : 'description',
    suggested_value: typeof suggested === 'number' ? roundMoney(suggested) : sanitizeText(suggested, 160),
    confidence,
    reason: sanitizeText(issue?.reason, 300),
    safe_to_apply: safe
  };
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    deepseekConfigured: Boolean(process.env.DEEPSEEK_API_KEY),
    model: MODEL,
    thinking: true,
    reasoningEffort: REASONING_EFFORT
  });
});

app.post('/api/deepseek/audit', async (req, res) => {
  try {
    const raw = Array.isArray(req.body?.transactions) ? req.body.transactions : [];
    const transactions = raw.slice(0, 260).map(sanitizeTransaction).filter(t => t.transaction_id && t.raw_source);
    if (!transactions.length) return res.json({ mode: 'deterministic', checked_count: 0, coverage: 0, issues: [], message: 'Нет строк для AI-аудита.' });
    if (!process.env.DEEPSEEK_API_KEY) return res.json({ mode: 'deterministic', checked_count: 0, coverage: 0, issues: [], message: 'DeepSeek не настроен.' });

    const system = `Ты — аудитор банковской выписки. Работай предельно строго и с thinking/reasoning. Тебе передают уже распознанные транзакции вместе с raw_source — исходной строкой из файла.\n\nОБЯЗАТЕЛЬНО для КАЖДОЙ транзакции сравни с raw_source четыре поля: date, amount, merchant_name и description. Дополнительно проверь direction, если исходная строка явно содержит признак списания/зачисления.\n\nПРАВИЛА:\n1. Ничего не придумывай. Единственный источник истины — raw_source.\n2. checked_ids должен содержать КАЖДЫЙ transaction_id из входа ровно один раз, даже если строка полностью корректна.\n3. В issues добавляй только реальную проблему, которую можно объяснить содержимым raw_source.\n4. suggested_value для date/amount давай только когда правильное значение явно присутствует в raw_source.\n5. Не исправляй обычное описание стилистически. description — проблема только если распознанный текст потерял важную часть или явно не соответствует raw_source.\n6. merchant_name можно нормализовать только из слов raw_source.\n7. Не считай повторяющиеся одинаковые операции дублями автоматически.\n8. Выведи только JSON.\n\nФормат: {"checked_ids":["..."],"issues":[{"transaction_id":"...","field":"date|amount|merchant_name|description|direction|category","suggested_value":"...","confidence":0.0,"reason":"кратко"}],"batch_summary":"кратко"}.`;

    const { parsed, model } = await deepSeekJson(system, `Проверь все строки пакета ${Number(req.body?.batch_index || 1)} из ${Number(req.body?.total_batches || 1)}. JSON:\n${JSON.stringify({ summary: req.body?.summary || {}, transactions })}`, 9000);
    const validIds = new Set(transactions.map(t => t.transaction_id));
    const checkedIds = [...new Set((Array.isArray(parsed.checked_ids) ? parsed.checked_ids : []).map(String).filter(id => validIds.has(id)))];
    const byId = new Map(transactions.map(t => [t.transaction_id, t]));
    const issues = [];
    for (const issue of Array.isArray(parsed.issues) ? parsed.issues : []) {
      const source = byId.get(String(issue?.transaction_id || ''));
      if (!source) continue;
      issues.push(markSafeAuditIssue(issue, source));
    }
    const coverage = transactions.length ? checkedIds.length / transactions.length : 0;
    res.json({ mode: 'deepseek', model, checked_count: checkedIds.length, coverage, issues: issues.slice(0, 160), batch_summary: sanitizeText(parsed.batch_summary, 500) });
  } catch (error) {
    console.error(error);
    res.status(502).json({ error: 'AI statement audit failed', details: sanitizeText(error.message || error, 500) });
  }
});


const allowedClassifications = new Set([
  'digital_subscription', 'membership', 'telecom_plan', 'cloud_or_software',
  'media_subscription', 'fitness_membership', 'recurring_bill', 'insurance_or_finance',
  'education_subscription', 'possible_subscription', 'not_subscription'
]);

function safeCandidateName(source, proposed) {
  const fallback = source.suggested_name || source.merchant_key || 'Регулярный платёж';
  const name = sanitizeText(proposed, 120);
  if (!name) return fallback;
  const evidenceText = source.evidence.map(e => `${e.merchant_name} ${e.description}`).join(' ');
  return merchantSupported(evidenceText, name) ? name : fallback;
}

function normalizeAiCandidateResult(item, source, pass = 1) {
  const aiConfidence = clamp(item?.ai_confidence, 0, 1);
  const classification = allowedClassifications.has(item?.classification) ? item.classification : (item?.is_subscription === true ? 'possible_subscription' : 'not_subscription');
  const isSubscription = item?.is_subscription === true && classification !== 'not_subscription';
  const adjustment = isSubscription ? clamp((aiConfidence - 0.62) * 0.24, -0.12, 0.12) : clamp(-0.08 - (aiConfidence * 0.08), -0.22, -0.04);
  return {
    candidate_id: source.candidate_id,
    is_subscription: isSubscription,
    name: safeCandidateName(source, item?.name),
    category: allowedCategories.has(item?.category) ? item.category : (allowedCategories.has(source.local_category) ? source.local_category : 'Другое'),
    classification,
    billing_cycle: sanitizeText(item?.billing_cycle || source.cadence, 60),
    ai_confidence: aiConfidence,
    confidence_adjustment: adjustment,
    price_change_detected: item?.price_change_detected === true || Math.abs(source.price_change_pct) >= 12,
    needs_second_pass: item?.needs_second_pass === true,
    reason: sanitizeText(item?.reason, 520),
    review_passes: pass,
    evidence_count: source.evidence.length,
    source_guard: true
  };
}

async function classifySubscriptionBatch(batch) {
  const system = `Ты — старший финансовый аналитик подписок. Используй thinking/reasoning=max. На входе кандидаты из банковской выписки, уже найденные локальным алгоритмом. Твоя задача — повысить ПОЛНОТУ поиска подписок, но не придумывать их.\n\nДЛЯ КАЖДОГО candidate_id обязательно разберись отдельно и верни ровно один результат. Анализируй не только одинаковую цену: подписки могут дорожать, иметь пробный период, скидку, налог, валютную конвертацию или годовой/квартальный цикл.\n\nОБЯЗАТЕЛЬНО УЧТИ:\n1. Все даты evidence и interval_days; месячная подписка может сдвигаться из-за длины месяца/выходных.\n2. day_of_month_consistency и median_interval_days.\n3. typical_amount, amount_min/max, amount_spread и price_change_pct — изменение цены само по себе НЕ отменяет подписку.\n4. merchant_name, merchant_key, suggested_name и КАЖДОЕ description.\n5. recurring_signals и explicit_recurring_signal. Один платёж разрешено признать подпиской ТОЛЬКО при явном тексте subscription/подписка/автосписание/абонентская плата/тариф или столь же прямом доказательстве.\n6. Отличай подписку/членство/тариф/регулярный счёт от повторяющихся покупок. Рестораны, продукты, маркетплейсы, такси, переводы людям, снятие наличных и обычные покупки — false.\n7. Если merchant агрегирует разные покупки (например магазин приложений), опирайся на description и суммы, не на бренд в одиночку.\n8. Если цена изменилась, укажи price_change_detected=true и проверь, сохраняются ли merchant + цикл + смысл описания.\n9. Не добавляй candidate_id, которого нет во входе. Ничего не придумывай.\n10. Если случай сложный, needs_second_pass=true.\n\nclassification только: digital_subscription, membership, telecom_plan, cloud_or_software, media_subscription, fitness_membership, recurring_bill, insurance_or_finance, education_subscription, possible_subscription, not_subscription.\n\nВерни только JSON: {"results":[{"candidate_id":"...","is_subscription":true,"name":"...","category":"Другое","classification":"digital_subscription","billing_cycle":"ежемесячно","ai_confidence":0.0,"price_change_detected":false,"needs_second_pass":false,"reason":"опора на даты, суммы, merchant и описания"}]}.`;
  const { parsed, model } = await deepSeekJson(system, `Проверь ВСЕ ${batch.length} кандидатов. JSON:\n${JSON.stringify({ candidates: batch })}`, 16000);
  const byId = new Map(batch.map(c => [c.candidate_id, c]));
  const rawResults = new Map();
  for (const item of Array.isArray(parsed.results) ? parsed.results : []) {
    const id = String(item?.candidate_id || '');
    if (byId.has(id) && !rawResults.has(id)) rawResults.set(id, item);
  }
  const first = batch.map(source => normalizeAiCandidateResult(rawResults.get(source.candidate_id) || { is_subscription: false, ai_confidence: 0, needs_second_pass: true, reason: 'AI не вернул результат в первом проходе.' }, source, 1));
  return { first, model };
}

async function adjudicateSubscriptionBatch(batch, firstOpinions) {
  if (!batch.length) return new Map();
  const system = `Ты — независимый арбитр по подпискам. Это ВТОРОЙ проход. Используй reasoning=max и не доверяй автоматически первому мнению. Для каждого кандидата заново сопоставь даты, интервалы, merchant, каждое описание, изменение цены и явные признаки регулярного платежа. Твоя цель — исправить и ложные срабатывания, и пропущенные реальные подписки. Нельзя придумывать данные. Один evidence допустим только при прямом тексте подписки/автосписания/абонентской платы/тарифа. Повторяющиеся бытовые покупки не подписки. Верни каждый переданный candidate_id ровно один раз. Только JSON: {"results":[{"candidate_id":"...","is_subscription":true,"classification":"possible_subscription","billing_cycle":"...","ai_confidence":0.0,"price_change_detected":false,"reason":"..."}]}.`;
  const { parsed } = await deepSeekJson(system, `Кандидаты для арбитража и первое мнение:\n${JSON.stringify({ candidates: batch, first_pass: firstOpinions })}`, 12000);
  const byId = new Map(batch.map(c => [c.candidate_id, c]));
  const out = new Map();
  for (const item of Array.isArray(parsed.results) ? parsed.results : []) {
    const source = byId.get(String(item?.candidate_id || ''));
    if (!source || out.has(source.candidate_id)) continue;
    out.set(source.candidate_id, normalizeAiCandidateResult({ ...item, needs_second_pass: false }, source, 2));
  }
  return out;
}

app.post('/api/deepseek/validate', async (req, res) => {
  try {
    const raw = Array.isArray(req.body?.candidates) ? req.body.candidates : [];
    const candidates = raw
      .map(sanitizeCandidate)
      .filter(c => c.candidate_id && !c.local_veto && (c.evidence.length >= 2 || (c.evidence.length === 1 && c.local_subscription_hint && c.explicit_recurring_signal)));

    if (!candidates.length) return res.json({ mode: 'deterministic', subscriptions: [], reviewed_count: 0, message: 'Нет безопасных кандидатов для AI-проверки.' });

    if (!process.env.DEEPSEEK_API_KEY) {
      return res.json({
        mode: 'deterministic',
        reviewed_count: candidates.length,
        subscriptions: candidates
          .filter(c => c.local_subscription_hint && (c.evidence.length >= 2 || c.explicit_recurring_signal))
          .map(c => ({
            candidate_id: c.candidate_id,
            is_subscription: true,
            name: c.suggested_name || c.merchant_key || 'Регулярный платёж',
            category: allowedCategories.has(c.local_category) ? c.local_category : 'Другое',
            classification: c.candidate_kind === 'single_explicit' ? 'possible_subscription' : 'recurring_bill',
            billing_cycle: c.cadence,
            ai_confidence: 0,
            confidence_adjustment: -0.05,
            price_change_detected: Math.abs(c.price_change_pct) >= 12,
            review_passes: 0,
            reason: c.evidence.length === 1 ? 'DeepSeek не настроен. Есть явный текстовый признак подписки, но только одно списание.' : 'DeepSeek не настроен. Локальный алгоритм видит регулярный сервис по датам, merchant и описаниям.'
          })),
        message: 'DeepSeek не настроен: используется консервативный локальный режим.'
      });
    }

    const batchSize = 30;
    const finalResults = [];
    let model = MODEL;
    let secondPassCount = 0;

    for (let offset = 0; offset < candidates.length; offset += batchSize) {
      const batch = candidates.slice(offset, offset + batchSize);
      const { first, model: batchModel } = await classifySubscriptionBatch(batch);
      model = batchModel || model;
      const sourceById = new Map(batch.map(c => [c.candidate_id, c]));
      const firstById = new Map(first.map(x => [x.candidate_id, x]));
      const ambiguousIds = first.filter(opinion => {
        const source = sourceById.get(opinion.candidate_id);
        if (!source) return false;
        return opinion.needs_second_pass || opinion.ai_confidence < 0.78 || source.evidence.length <= 2 || Math.abs(source.price_change_pct) >= 18 || (source.local_subscription_hint && !opinion.is_subscription);
      }).map(x => x.candidate_id);
      const adjudicationBatch = batch.filter(c => ambiguousIds.includes(c.candidate_id));
      let second = new Map();
      if (adjudicationBatch.length) {
        try {
          second = await adjudicateSubscriptionBatch(adjudicationBatch, adjudicationBatch.map(c => firstById.get(c.candidate_id)));
          secondPassCount += second.size;
        } catch (error) {
          console.warn('Second-pass subscription adjudication failed:', error?.message || error);
        }
      }
      for (const source of batch) finalResults.push(second.get(source.candidate_id) || firstById.get(source.candidate_id));
    }

    res.json({
      mode: 'deepseek',
      subscriptions: finalResults.filter(Boolean),
      reviewed_count: finalResults.length,
      second_pass_count: secondPassCount,
      model,
      message: `AI проверил ${finalResults.length} кандидатов; второй проход: ${secondPassCount}.`
    });
  } catch (error) {
    console.error(error);
    res.status(502).json({ error: 'AI validation failed', details: sanitizeText(error.message || error, 500) });
  }
});

app.listen(PORT, () => {
  console.log(`Sber Finance Scanner: http://localhost:${PORT}`);
});
