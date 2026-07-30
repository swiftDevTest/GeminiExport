import { emptyResponseForRequest, errorResponseForRequest, jsonResponseForRequest } from "../_shared/http.ts";
import { PRODUCT_SLUG } from "../_shared/plans.ts";
import { eventBelongsToProduct, getPaddleEventInfo, verifyPaddleSignature } from "../_shared/paddle.ts";
import { getProfileByUserId, supabaseRest, updateProfile } from "../_shared/supabase.ts";

function toTimestamp(value: unknown) {
  if (typeof value !== "string" || !value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function findUserIdByCustomer(customerId: string | null) {
  if (!customerId) {
    return null;
  }
  const rows = await supabaseRest<Record<string, unknown>[]>(
    `payment_customers?paddle_customer_id=eq.${encodeURIComponent(customerId)}&product_slug=eq.${PRODUCT_SLUG}&select=user_id&limit=1`
  );
  const customerUserId = typeof rows?.[0]?.user_id === "string" ? rows[0].user_id : null;
  if (customerUserId) {
    return customerUserId;
  }

  const profileRows = await supabaseRest<Record<string, unknown>[]>(
    `profiles?paddle_customer_id=eq.${encodeURIComponent(customerId)}&product_slug=eq.${PRODUCT_SLUG}&select=id&limit=1`
  );
  return typeof profileRows?.[0]?.id === "string" ? profileRows[0].id : null;
}

async function findUserIdByTransaction(transactionId: string | null) {
  if (!transactionId) {
    return null;
  }
  const rows = await supabaseRest<Record<string, unknown>[]>(
    `payment_transactions?paddle_transaction_id=eq.${encodeURIComponent(transactionId)}&product_slug=eq.${PRODUCT_SLUG}&select=user_id&limit=1`
  );
  return typeof rows?.[0]?.user_id === "string" ? rows[0].user_id : null;
}

async function findUserIdBySubscription(subscriptionId: string | null) {
  if (!subscriptionId) {
    return null;
  }
  const rows = await supabaseRest<Record<string, unknown>[]>(
    `payment_subscriptions?paddle_subscription_id=eq.${encodeURIComponent(subscriptionId)}&product_slug=eq.${PRODUCT_SLUG}&select=user_id&limit=1`
  );
  return typeof rows?.[0]?.user_id === "string" ? rows[0].user_id : null;
}

async function insertWebhookEvent(event: Record<string, unknown>, info: ReturnType<typeof getPaddleEventInfo>, ignored: boolean, processed: boolean) {
  await supabaseRest("payment_webhook_events?on_conflict=event_id", {
    method: "POST",
    prefer: "resolution=ignore-duplicates,return=minimal",
    body: {
      event_id: info.eventId,
      event_type: info.eventType,
      product_slug: ignored ? info.productSlug : PRODUCT_SLUG,
      paddle_customer_id: info.customerId,
      paddle_subscription_id: info.subscriptionId,
      paddle_transaction_id: info.transactionId,
      paddle_price_id: info.priceId,
      // custom_data is external input and can contain a stale/deleted user id.
      // Keep the audit insert independent from the FK until ownership is checked.
      user_id: null,
      processed,
      ignored,
      payload: event,
      processed_at: processed ? new Date().toISOString() : null
    }
  });
}

// 抢占式去重：在处理之前先尝试插入 event_id。
// 冲突即说明重复事件，调用方应跳过处理。
// 修复 TOCTOU 竞态：原实现先查询后处理，并发相同 event_id 会被重复处理。
async function tryAcquireWebhookLock(event: Record<string, unknown>, info: ReturnType<typeof getPaddleEventInfo>): Promise<{ duplicate: boolean }> {
  const response = await supabaseRest<{ event_id?: string }>("payment_webhook_events?on_conflict=event_id&select=event_id", {
    method: "POST",
    prefer: "resolution=ignore-duplicates,return=representation",
    body: {
      event_id: info.eventId,
      event_type: info.eventType,
      product_slug: PRODUCT_SLUG,
      paddle_customer_id: info.customerId,
      paddle_subscription_id: info.subscriptionId,
      paddle_transaction_id: info.transactionId,
      paddle_price_id: info.priceId,
      // User resolution is performed by the handlers after the idempotency lock.
      // A stale custom_data user id must not prevent Paddle retries from running.
      user_id: null,
      processed: false,
      ignored: false,
      payload: event,
      processed_at: null
    }
  });

  const inserted = Array.isArray(response) && response.length > 0;
  return { duplicate: !inserted };
}

async function markWebhookEventProcessed(info: ReturnType<typeof getPaddleEventInfo>, processed: boolean) {
  await supabaseRest(`payment_webhook_events?event_id=eq.${encodeURIComponent(info.eventId)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: {
      processed,
      processed_at: new Date().toISOString()
    }
  });
}

function normalizeEmail(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function getPaymentEmail(info: ReturnType<typeof getPaddleEventInfo>) {
  return normalizeEmail(info.customerEmail || info.customData.email);
}

function getTransactionStatus(info: ReturnType<typeof getPaddleEventInfo>) {
  const status = String(info.data.status || "").trim().toLowerCase();
  if (status) {
    return status;
  }
  if (info.eventType === "transaction.completed") {
    return "completed";
  }
  if (info.eventType === "transaction.paid") {
    return "paid";
  }
  return String(info.eventType || "").replace(/^transaction\./, "") || "unknown";
}

function isActiveSubscriptionStatus(status: unknown) {
  return ["active", "trialing", "past_due"].includes(String(status || "").toLowerCase());
}

async function getLatestActiveSubscription(userId: string) {
  const rows = await supabaseRest<Record<string, unknown>[]>(
    `payment_subscriptions?user_id=eq.${encodeURIComponent(userId)}&product_slug=eq.${PRODUCT_SLUG}&status=in.(active,trialing,past_due)&select=*&order=updated_at.desc&limit=1`
  );
  return rows?.[0] || null;
}

async function getValidatedCustomUserId(info: ReturnType<typeof getPaddleEventInfo>) {
  if (!info.userId) {
    return null;
  }

  const expectedEmail = getPaymentEmail(info);
  if (!expectedEmail) {
    return info.userId;
  }

  const profile = await getProfileByUserId(info.userId);
  const profileEmail = normalizeEmail(profile?.email);
  if (!profileEmail || profileEmail !== expectedEmail) {
    return null;
  }

  return info.userId;
}

async function resolveUserIdFromWebhook(info: ReturnType<typeof getPaddleEventInfo>) {
  // 安全策略：仅通过 custom_data.supabase_user_id（已邮箱校验）、
  // 历史 transaction/subscription/customer 记录反查 user_id。
  // 不再按邮箱兜底匹配 profiles，避免攻击者通过改邮箱冒领他人权益。
  return await getValidatedCustomUserId(info) ||
    await findUserIdByTransaction(info.transactionId) ||
    await findUserIdBySubscription(info.subscriptionId) ||
    await findUserIdByCustomer(info.customerId);
}

async function upsertCustomer(userId: string, customerId: string | null, email: string | null) {
  if (!customerId) {
    return;
  }
  await supabaseRest("payment_customers?on_conflict=paddle_customer_id", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      user_id: userId,
      product_slug: PRODUCT_SLUG,
      provider_id: "paddle",
      paddle_customer_id: customerId,
      email
    }
  });
}

async function handleTransaction(info: ReturnType<typeof getPaddleEventInfo>) {
  const data = info.data;
  const details = asRecord(data.details);
  const totals = asRecord(details.totals);
  const userId = await resolveUserIdFromWebhook(info);
  if (!info.transactionId || !info.plan) {
    return false;
  }

  const paymentEmail = getPaymentEmail(info) || null;
  if (userId) {
    await upsertCustomer(userId, info.customerId, paymentEmail);
  }
  await supabaseRest("payment_transactions?on_conflict=paddle_transaction_id", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      paddle_transaction_id: info.transactionId,
      user_id: userId || null,
      product_slug: PRODUCT_SLUG,
      provider_id: "paddle",
      paddle_customer_id: info.customerId,
      paddle_subscription_id: info.subscriptionId,
      paddle_price_id: info.priceId,
      plan_id: info.plan.id,
      billing_interval: info.plan.billingInterval,
      status: getTransactionStatus(info),
      total_amount: typeof totals.grand_total === "string" ? totals.grand_total : null,
      currency_code: typeof totals.currency_code === "string" ? totals.currency_code : null,
      raw: data
    }
  });

  if (userId && ["transaction.completed", "transaction.paid"].includes(info.eventType)) {
    await updateProfile(userId, {
      plan: "pro",
      product_slug: PRODUCT_SLUG,
      provider_id: "paddle",
      paddle_customer_id: info.customerId,
      paddle_subscription_id: info.subscriptionId,
      paddle_transaction_id: info.transactionId,
      paddle_price_id: info.priceId,
      billing_interval: info.plan.billingInterval,
      lifetime_access: info.plan.lifetime
    });
  }
  return Boolean(userId);
}

async function handleSubscription(info: ReturnType<typeof getPaddleEventInfo>) {
  const data = info.data;
  const currentBillingPeriod = asRecord(data.current_billing_period);
  let userId = await resolveUserIdFromWebhook(info);
  if (!userId || !info.subscriptionId || !info.plan) {
    return false;
  }

  await upsertCustomer(userId, info.customerId, getPaymentEmail(info) || null);

  // 跨产品订阅冲突检查：同一 paddle_subscription_id 不能被多个 user_id 持有。
  // 防止攻击者通过改邮箱冒领他人订阅。
  const previousSubscriptions = await supabaseRest<Record<string, unknown>[]>(
    `payment_subscriptions?paddle_subscription_id=eq.${encodeURIComponent(info.subscriptionId)}&select=user_id,status`
  );
  if ((previousSubscriptions || []).some((row) => typeof row.user_id === "string" && row.user_id !== userId)) {
    throw new Error("Conflicting Paddle subscription ownership.");
  }

  await supabaseRest("payment_subscriptions?on_conflict=paddle_subscription_id", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      paddle_subscription_id: info.subscriptionId,
      user_id: userId,
      product_slug: PRODUCT_SLUG,
      provider_id: "paddle",
      paddle_customer_id: info.customerId,
      paddle_price_id: info.priceId,
      plan_id: info.plan.id,
      billing_interval: info.plan.billingInterval,
      status: String(data.status || ""),
      current_period_start: toTimestamp(currentBillingPeriod.starts_at),
      current_period_end: toTimestamp(currentBillingPeriod.ends_at),
      canceled_at: toTimestamp(data.canceled_at),
      raw: data
    }
  });

  const active = isActiveSubscriptionStatus(data.status);
  const profile = await getProfileByUserId(userId) || {};
  const latestActiveSubscription = active ? null : await getLatestActiveSubscription(userId);
  const profileSubscription = latestActiveSubscription || null;
  await updateProfile(userId, {
    plan: active || Boolean(profileSubscription) || Boolean(profile.lifetime_access) ? "pro" : "free",
    product_slug: PRODUCT_SLUG,
    provider_id: "paddle",
    paddle_customer_id: profileSubscription?.paddle_customer_id || info.customerId,
    paddle_subscription_id: profileSubscription?.paddle_subscription_id || info.subscriptionId,
    paddle_price_id: profileSubscription?.paddle_price_id || info.priceId,
    billing_interval: profileSubscription?.billing_interval || info.plan.billingInterval,
    current_period_end: profileSubscription?.current_period_end || toTimestamp(currentBillingPeriod.ends_at)
  });
  return true;
}

async function handleAdjustment(info: ReturnType<typeof getPaddleEventInfo>) {
  // 处理 Paddle adjustment 事件（退款/撤单/争议）。
  // 关联原 transaction，若为终身交易且退款/撤单则撤销 lifetime_access。
  const data = info.data;
  const adjustmentId = String(data.id || "");
  if (!adjustmentId.startsWith("adj_") || !info.transactionId) return false;

  const transactions = await supabaseRest<Record<string, unknown>[]>(
    `payment_transactions?paddle_transaction_id=eq.${encodeURIComponent(info.transactionId)}&select=*&limit=1`
  );
  const transaction = transactions?.[0] || null;
  const userId = typeof transaction?.user_id === "string" ? transaction.user_id : null;
  if (!transaction || !userId) return false;
  info.userId = userId;

  const action = String(data.action || "").toLowerCase();
  const adjustmentType = String(data.type || "").toLowerCase();
  const status = String(data.status || "").toLowerCase();
  const isFullRefund = action === "refund" && adjustmentType === "full";
  const isChargeback = action.startsWith("chargeback");
  const isApproved = status === "approved";

  // 退款/撤单获批后，若原交易为终身交易，撤销 lifetime_access 并降级
  if (isApproved && (isFullRefund || isChargeback)) {
    const billingInterval = String(transaction.billing_interval || "").toLowerCase();
    if (billingInterval === "lifetime") {
      // 检查是否还有其他有效订阅
      const latestActiveSubscription = await getLatestActiveSubscription(userId);
      await updateProfile(userId, {
        plan: latestActiveSubscription ? "pro" : "free",
        product_slug: PRODUCT_SLUG,
        provider_id: "paddle",
        lifetime_access: false,
        ...(latestActiveSubscription ? {
          paddle_subscription_id: latestActiveSubscription.paddle_subscription_id,
          paddle_customer_id: latestActiveSubscription.paddle_customer_id,
          paddle_price_id: latestActiveSubscription.paddle_price_id,
          billing_interval: latestActiveSubscription.billing_interval
        } : {})
      });
    }
  }
  return true;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return emptyResponseForRequest(request);
  }
  if (request.method !== "POST") {
    return errorResponseForRequest(request, "Method not allowed.", 405);
  }

  try {
    const rawBody = await request.text();
    const valid = await verifyPaddleSignature(rawBody, request.headers.get("paddle-signature"));
    if (!valid) {
      return errorResponseForRequest(request, "Invalid Paddle webhook signature.", 401);
    }

    const event = JSON.parse(rawBody) as Record<string, unknown>;
    const info = getPaddleEventInfo(event);

    if (!eventBelongsToProduct(info)) {
      await insertWebhookEvent(event, info, true, false);
      return jsonResponseForRequest(request, { ok: true, ignored: true });
    }

    // 抢占式去重：处理前先尝试插入 event_id，冲突即跳过。
    // 修复 TOCTOU 竞态：原实现先查询后处理，并发请求会绕过去重检查。
    const lock = await tryAcquireWebhookLock(event, info);
    if (lock.duplicate) {
      return jsonResponseForRequest(request, { ok: true, deduplicated: true });
    }

    let processed = false;
    try {
      if (info.eventType.startsWith("transaction.")) {
        processed = await handleTransaction(info);
      } else if (info.eventType.startsWith("subscription.")) {
        processed = await handleSubscription(info);
      } else if (info.eventType.startsWith("adjustment.")) {
        processed = await handleAdjustment(info);
      }
      await markWebhookEventProcessed(info, processed);
    } catch (error) {
      // 处理失败：标记为未处理，允许后续重试
      await markWebhookEventProcessed(info, false);
      throw error;
    }

    return jsonResponseForRequest(request, { ok: true, processed });
  } catch (error) {
    return errorResponseForRequest(request, error instanceof Error ? error.message : "Payment webhook failed.", 500);
  }
});
