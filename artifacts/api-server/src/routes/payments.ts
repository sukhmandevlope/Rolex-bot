import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { pool } from "@workspace/db";

const router = Router();
const rails = new Set(["upi", "crypto"]);
const forbiddenKeys = /private.?key|seed.?phrase|mnemonic/i;

function adminId(req: Request) {
  const id = authenticatedTelegramId(req);
  const admins = new Set((process.env["ADMIN_TELEGRAM_IDS"] ?? "").split(",").map(Number));
  return id && admins.has(id) ? id : null;
}

function playerId(req: Request) {
  return authenticatedTelegramId(req);
}

function authenticatedTelegramId(req: Request) {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  const raw = req.header("x-telegram-init-data");
  if (!token || !raw) return null;
  const params = new URLSearchParams(raw);
  const receivedHash = params.get("hash");
  const authDate = Number(params.get("auth_date"));
  const ageSeconds = Date.now() / 1000 - authDate;
  if (!receivedHash || !Number.isFinite(authDate) || ageSeconds > 300 || ageSeconds < -30) return null;
  params.delete("hash");
  const dataCheck = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const expected = createHmac("sha256", secret).update(dataCheck).digest("hex");
  if (receivedHash.length !== expected.length || !timingSafeEqual(Buffer.from(receivedHash), Buffer.from(expected))) return null;
  try {
    const user = JSON.parse(params.get("user") ?? "{}") as { id?: unknown };
    return Number.isSafeInteger(user.id) ? Number(user.id) : null;
  } catch {
    return null;
  }
}

function rejectsCustodySecrets(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, child]) => forbiddenKeys.test(key) || (typeof child === "object" && rejectsCustodySecrets(child)),
  );
}

async function activeLicense() {
  const result = await pool.query(
    `SELECT id, jurisdiction FROM operator_licenses
     WHERE status = 'verified' AND valid_from <= CURRENT_DATE AND valid_until >= CURRENT_DATE
     ORDER BY verified_at DESC LIMIT 1`,
  );
  return result.rows[0];
}

async function eligiblePlayer(telegramId: number) {
  const result = await pool.query(
    `SELECT pc.*, rgl.daily_deposit_limit, rgl.weekly_deposit_limit, rgl.monthly_deposit_limit
     FROM player_compliance pc
     LEFT JOIN responsible_gambling_limits rgl USING (telegram_id)
     WHERE pc.telegram_id = $1`,
    [telegramId],
  );
  const player = result.rows[0];
  const blocked =
    !player ||
    !player.age_verified ||
    !player.location_verified ||
    player.kyc_status !== "approved" ||
    player.aml_status !== "clear" ||
    player.risk_level === "prohibited" ||
    (player.self_excluded_until && new Date(player.self_excluded_until) > new Date()) ||
    (player.cooling_off_until && new Date(player.cooling_off_until) > new Date());
  return blocked ? null : player;
}

function fail(res: Response, status: number, error: string) {
  return res.status(status).json({ error });
}

function configuredProvider(rail: string) {
  const name = process.env["PAYMENT_PROVIDER_NAME"];
  const url = process.env["PAYMENT_PROVIDER_URL"];
  const apiKey = process.env["PAYMENT_PROVIDER_API_KEY"];
  const rails = new Set((process.env["PAYMENT_PROVIDER_RAILS"] ?? "").split(","));
  return name && url && apiKey && rails.has(rail) ? { name, url: url.replace(/\/$/, ""), apiKey } : null;
}

async function providerRequest(
  provider: { name: string; url: string; apiKey: string },
  path: string,
  body: Record<string, unknown>,
) {
  const response = await fetch(`${provider.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${provider.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Payment provider request failed with ${response.status}`);
  return (await response.json()) as { reference: string; checkoutUrl?: string; status?: string };
}

router.get("/payments/status", async (_req, res) => {
  const license = await activeLicense();
  return res.json({ enabled: Boolean(license), jurisdiction: license?.jurisdiction ?? null });
});

router.post("/operator/licenses", async (req, res) => {
  const operator = adminId(req);
  if (!operator) return fail(res, 403, "Administrator authorization required");
  const { jurisdiction, regulator, licenseNumber, licensedEntity, validFrom, validUntil } = req.body ?? {};
  if (![jurisdiction, regulator, licenseNumber, licensedEntity, validFrom, validUntil].every((v) => typeof v === "string" && v.length > 1)) {
    return fail(res, 400, "Complete jurisdiction and licensing details are required");
  }
  const result = await pool.query(
    `INSERT INTO operator_licenses
      (jurisdiction, regulator, license_number, licensed_entity, valid_from, valid_until, status)
     VALUES ($1,$2,$3,$4,$5,$6,'submitted') RETURNING id, status`,
    [jurisdiction, regulator, licenseNumber, licensedEntity, validFrom, validUntil],
  );
  return res.status(201).json(result.rows[0]);
});

router.post("/operator/licenses/:id/verify", async (req, res) => {
  const operator = adminId(req);
  if (!operator) return fail(res, 403, "Administrator authorization required");
  const { verificationReference } = req.body ?? {};
  if (typeof verificationReference !== "string" || verificationReference.length < 6) {
    return fail(res, 400, "Independent verification reference is required");
  }
  const result = await pool.query(
    `UPDATE operator_licenses SET status='verified', verification_reference=$1,
       verified_by=$2, verified_at=NOW(), updated_at=NOW()
     WHERE id=$3 AND status='submitted' AND valid_until >= CURRENT_DATE
     RETURNING id, status, verified_at`,
    [verificationReference, operator, req.params.id],
  );
  if (!result.rows[0]) return fail(res, 409, "License is not eligible for verification");
  return res.json(result.rows[0]);
});

router.put("/compliance/me", async (req, res) => {
  const telegramId = playerId(req);
  if (!telegramId) return fail(res, 401, "Player authorization required");
  if (!(await activeLicense())) return fail(res, 423, "Payments remain locked until licensing is verified");
  const { dateOfBirth, countryCode, regionCode } = req.body ?? {};
  if (typeof dateOfBirth !== "string" || !/^[A-Z]{2}$/.test(countryCode) || typeof regionCode !== "string") {
    return fail(res, 400, "Valid date of birth and location are required");
  }
  await pool.query(
    `INSERT INTO player_compliance (telegram_id, date_of_birth, country_code, region_code)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (telegram_id) DO UPDATE SET date_of_birth=$2,country_code=$3,region_code=$4,updated_at=NOW()`,
    [telegramId, dateOfBirth, countryCode, regionCode],
  );
  return res.json({ status: "pending_verification" });
});

router.post("/operator/compliance/:telegramId/review", async (req, res) => {
  const operator = adminId(req);
  if (!operator) return fail(res, 403, "Administrator authorization required");
  const telegramId = Number(req.params.telegramId);
  const { ageVerified, locationVerified, kycStatus, amlStatus, riskLevel, providerCustomerRef } = req.body ?? {};
  if (
    !Number.isSafeInteger(telegramId) ||
    typeof ageVerified !== "boolean" ||
    typeof locationVerified !== "boolean" ||
    !["pending", "approved", "rejected"].includes(kycStatus) ||
    !["pending", "clear", "review", "blocked"].includes(amlStatus) ||
    !["low", "medium", "high", "prohibited"].includes(riskLevel)
  ) return fail(res, 400, "A complete compliance decision is required");
  const result = await pool.query(
    `UPDATE player_compliance SET age_verified=$1,location_verified=$2,kyc_status=$3,aml_status=$4,
       risk_level=$5,provider_customer_ref=$6,last_screened_at=NOW(),updated_at=NOW()
     WHERE telegram_id=$7 RETURNING telegram_id,age_verified,location_verified,kyc_status,aml_status,risk_level`,
    [ageVerified, locationVerified, kycStatus, amlStatus, riskLevel, providerCustomerRef ?? null, telegramId],
  );
  if (!result.rows[0]) return fail(res, 404, "Player compliance profile not found");
  return res.json(result.rows[0]);
});

router.post("/responsible-gambling/self-exclusion", async (req, res) => {
  const telegramId = playerId(req);
  if (!telegramId) return fail(res, 401, "Player authorization required");
  const days = Number(req.body?.days);
  if (!Number.isInteger(days) || days < 1 || days > 3650) return fail(res, 400, "Exclusion must be between 1 and 3650 days");
  await pool.query(
    `INSERT INTO player_compliance (telegram_id,self_excluded_until)
     VALUES ($1,NOW()+($2::text || ' days')::interval)
     ON CONFLICT (telegram_id) DO UPDATE SET
       self_excluded_until=GREATEST(player_compliance.self_excluded_until,EXCLUDED.self_excluded_until),updated_at=NOW()`,
    [telegramId, days],
  );
  return res.json({ status: "self_excluded", days });
});

router.put("/responsible-gambling/limits", async (req, res) => {
  const telegramId = playerId(req);
  if (!telegramId) return fail(res, 401, "Player authorization required");
  const values = ["dailyDepositLimit", "weeklyDepositLimit", "monthlyDepositLimit", "dailyLossLimit"] as const;
  if (values.some((key) => !Number.isFinite(Number(req.body?.[key])) || Number(req.body[key]) < 0)) {
    return fail(res, 400, "Limits must be non-negative amounts");
  }
  await pool.query(
    `INSERT INTO responsible_gambling_limits
      (telegram_id,daily_deposit_limit,weekly_deposit_limit,monthly_deposit_limit,daily_loss_limit,session_minutes_limit)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (telegram_id) DO UPDATE SET
      daily_deposit_limit=LEAST(responsible_gambling_limits.daily_deposit_limit, EXCLUDED.daily_deposit_limit),
      weekly_deposit_limit=LEAST(responsible_gambling_limits.weekly_deposit_limit, EXCLUDED.weekly_deposit_limit),
      monthly_deposit_limit=LEAST(responsible_gambling_limits.monthly_deposit_limit, EXCLUDED.monthly_deposit_limit),
      daily_loss_limit=LEAST(responsible_gambling_limits.daily_loss_limit, EXCLUDED.daily_loss_limit),
      session_minutes_limit=LEAST(responsible_gambling_limits.session_minutes_limit, EXCLUDED.session_minutes_limit),
      updated_at=NOW()`,
    [telegramId, ...values.map((key) => Number(req.body[key])), Number(req.body?.sessionMinutesLimit ?? 0)],
  );
  return res.json({ status: "active", note: "Limit increases require operator review" });
});

router.post("/payments/deposits", async (req, res) => {
  const telegramId = playerId(req);
  if (!telegramId) return fail(res, 401, "Player authorization required");
  if (rejectsCustodySecrets(req.body)) return fail(res, 400, "Private keys and seed phrases are never accepted");
  const license = await activeLicense();
  const player = await eligiblePlayer(telegramId);
  if (!license) return fail(res, 423, "Payments remain locked until licensing is verified");
  if (!player) return fail(res, 403, "Age, location, KYC, AML, and responsible-gambling checks are required");
  const amount = Number(req.body?.amount);
  const rail = req.body?.rail;
  const provider = configuredProvider(rail);
  const idempotencyKey = req.header("idempotency-key");
  if (!Number.isFinite(amount) || amount <= 0 || !rails.has(rail) || !idempotencyKey) {
    return fail(res, 400, "Amount, supported rail, provider, and idempotency key are required");
  }
  if (!provider) return fail(res, 503, "No approved provider is configured for this payment rail");
  const publicId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [telegramId]);
    const totals = await client.query<{ daily: string; weekly: string; monthly: string }>(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE created_at >= CURRENT_DATE),0)::text daily,
        COALESCE(SUM(amount) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'),0)::text weekly,
        COALESCE(SUM(amount) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'),0)::text monthly
       FROM payment_transactions WHERE telegram_id=$1 AND direction='deposit' AND status IN ('pending','confirmed')`,
      [telegramId],
    );
    const t = totals.rows[0]!;
    if (Number(player.daily_deposit_limit) <= 0 || Number(t.daily) + amount > Number(player.daily_deposit_limit) ||
      Number(t.weekly) + amount > Number(player.weekly_deposit_limit) || Number(t.monthly) + amount > Number(player.monthly_deposit_limit)) {
      await client.query("ROLLBACK");
      return fail(res, 409, "Deposit exceeds responsible-gambling limits");
    }
    const providerResult = await providerRequest(provider, "/deposits", {
      transactionId: publicId, telegramId, rail, amount, currency: req.body?.currency ?? "INR", idempotencyKey,
    });
    const result = await client.query(
      `INSERT INTO payment_transactions
        (public_id,telegram_id,direction,rail,provider,amount,currency,status,idempotency_key,provider_reference)
       VALUES ($1,$2,'deposit',$3,$4,$5,$6,'pending',$7,$8)
       ON CONFLICT (idempotency_key) DO UPDATE SET updated_at=payment_transactions.updated_at
       RETURNING public_id,status,provider,rail,amount,currency`,
      [publicId, telegramId, rail, provider.name, amount, req.body?.currency ?? "INR", idempotencyKey, providerResult.reference],
    );
    await client.query("COMMIT");
    return res.status(202).json({ ...result.rows[0], nextAction: "complete_with_provider", checkoutUrl: providerResult.checkoutUrl });
  } catch (error) {
    await client.query("ROLLBACK");
    req.log.error({ err: error }, "Deposit provider initiation failed");
    return fail(res, 502, "Payment provider unavailable");
  } finally {
    client.release();
  }
});

router.post("/payments/withdrawals", async (req, res) => {
  const telegramId = playerId(req);
  if (!telegramId) return fail(res, 401, "Player authorization required");
  if (rejectsCustodySecrets(req.body)) return fail(res, 400, "Private keys and seed phrases are never accepted");
  if (!(await activeLicense())) return fail(res, 423, "Payments remain locked until licensing is verified");
  if (!(await eligiblePlayer(telegramId))) return fail(res, 403, "Compliance checks are incomplete");
  const amount = Number(req.body?.amount);
  const { rail, destinationReference } = req.body ?? {};
  const provider = configuredProvider(rail);
  const idempotencyKey = req.header("idempotency-key");
  if (!Number.isFinite(amount) || amount <= 0 || !rails.has(rail) || typeof destinationReference !== "string" || !idempotencyKey) {
    return fail(res, 400, "Valid amount, rail, provider, destination reference, and idempotency key are required");
  }
  if (!provider) return fail(res, 503, "No approved provider is configured for this payment rail");
  const publicId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [telegramId]);
    const balance = await client.query<{ available: string }>(
      `SELECT COALESCE(SUM(CASE WHEN side='credit' THEN amount ELSE -amount END),0)::text available
       FROM financial_ledger WHERE telegram_id=$1 AND account='player_funds'`,
      [telegramId],
    );
    if (Number(balance.rows[0]?.available ?? 0) < amount) {
      await client.query("ROLLBACK");
      return fail(res, 409, "Insufficient available funds");
    }
    const result = await client.query(
      `INSERT INTO payment_transactions
        (public_id,telegram_id,direction,rail,provider,amount,currency,status,destination_reference,idempotency_key,risk_decision)
       VALUES ($1,$2,'withdrawal',$3,$4,$5,$6,'review_required',$7,$8,'manual_review')
       ON CONFLICT (idempotency_key) DO UPDATE SET updated_at=payment_transactions.updated_at
       RETURNING public_id,status,amount,currency`,
      [publicId, telegramId, rail, provider.name, amount, req.body?.currency ?? "INR", destinationReference, idempotencyKey],
    );
    await client.query(
      `INSERT INTO financial_ledger(entry_id,transaction_public_id,telegram_id,account,side,amount,currency)
       VALUES ($1,$2,$3,'player_funds','debit',$4,$5),($6,$2,$3,'withdrawals_reserved','credit',$4,$5)`,
      [randomUUID(), `${publicId}:reserve`, telegramId, amount, req.body?.currency ?? "INR", randomUUID()],
    );
    await client.query("COMMIT");
    return res.status(202).json(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

router.post("/operator/withdrawals/:id/review", async (req, res) => {
  const operator = adminId(req);
  if (!operator) return fail(res, 403, "Administrator authorization required");
  const decision = req.body?.decision;
  if (!["approved", "rejected"].includes(decision)) return fail(res, 400, "Decision must be approved or rejected");
  const lookup = decision === "approved"
    ? await pool.query(
        `UPDATE payment_transactions SET status='provider_submitting',review_reason=$1,reviewed_by=$2,reviewed_at=NOW(),updated_at=NOW()
         WHERE public_id=$3 AND direction='withdrawal' AND status='review_required'
         RETURNING public_id,telegram_id,provider,rail,amount,currency,destination_reference`,
        [req.body?.reason ?? null, operator, req.params.id],
      )
    : await pool.query(
        `SELECT public_id,telegram_id,provider,rail,amount,currency,destination_reference
         FROM payment_transactions WHERE public_id=$1 AND direction='withdrawal' AND status='review_required'`,
        [req.params.id],
      );
  const withdrawal = lookup.rows[0];
  if (!withdrawal) return fail(res, 409, "Withdrawal is not awaiting review");
  const provider = configuredProvider(withdrawal.rail);
  if (!provider || provider.name !== withdrawal.provider) return fail(res, 503, "Approved provider is unavailable");
  if (decision === "approved") {
    try {
      const payout = await providerRequest(provider, "/withdrawals", {
        transactionId: withdrawal.public_id,
        idempotencyKey: `withdrawal:${withdrawal.public_id}`,
        amount: withdrawal.amount,
        currency: withdrawal.currency,
        destinationReference: withdrawal.destination_reference,
      });
      const result = await pool.query(
        `UPDATE payment_transactions SET status='provider_pending',provider_reference=$1,updated_at=NOW()
         WHERE public_id=$2 AND status='provider_submitting' RETURNING public_id,status`,
        [payout.reference, req.params.id],
      );
      return res.json(result.rows[0]);
    } catch (error) {
      await pool.query(
        `UPDATE payment_transactions SET status='provider_unknown',review_reason='Provider response unknown; reconciliation required',updated_at=NOW()
         WHERE public_id=$1 AND status='provider_submitting'`,
        [req.params.id],
      );
      req.log.error({ err: error, transactionId: req.params.id }, "Withdrawal provider submission outcome unknown");
      return fail(res, 502, "Provider outcome requires reconciliation; funds remain reserved");
    }
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE payment_transactions SET status='rejected',review_reason=$1,reviewed_by=$2,reviewed_at=NOW(),updated_at=NOW()
       WHERE public_id=$3 AND status='review_required' RETURNING public_id,status`,
      [req.body?.reason ?? null, operator, req.params.id],
    );
    await client.query(
      `INSERT INTO financial_ledger(entry_id,transaction_public_id,telegram_id,account,side,amount,currency)
       VALUES ($1,$2,$3,'withdrawals_reserved','debit',$4,$5),($6,$2,$3,'player_funds','credit',$4,$5)`,
      [randomUUID(), `${withdrawal.public_id}:release`, withdrawal.telegram_id, withdrawal.amount, withdrawal.currency, randomUUID()],
    );
    await client.query("COMMIT");
    return res.json(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

router.post("/payments/providers/:provider/webhook", async (req, res) => {
  const configuredName = process.env["PAYMENT_PROVIDER_NAME"];
  const secret = process.env["PAYMENT_PROVIDER_WEBHOOK_SECRET"];
  const signature = req.header("x-provider-signature");
  const raw = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from("");
  const expected = secret ? createHmac("sha256", secret).update(raw).digest("hex") : "";
  if (!configuredName || configuredName !== req.params.provider || !signature || signature.length !== expected.length ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return fail(res, 401, "Invalid provider signature");
  }
  const { transactionId, providerReference, status } = req.body ?? {};
  if (!["confirmed", "failed"].includes(status) || typeof transactionId !== "string" || typeof providerReference !== "string") {
    return fail(res, 400, "Invalid provider event");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query<{ telegram_id: string; direction: string; amount: string; currency: string }>(
      `UPDATE payment_transactions SET status=$1,provider_reference=$2,confirmed_at=CASE WHEN $1='confirmed' THEN NOW() END,updated_at=NOW()
       WHERE public_id=$3 AND provider=$4 AND status IN ('pending','provider_pending','provider_unknown')
       RETURNING telegram_id,direction,amount,currency`,
      [status, providerReference, transactionId, req.params.provider],
    );
    const tx = updated.rows[0];
    if (tx && status === "confirmed") {
      const debitAccount = tx.direction === "deposit" ? "provider_clearing" : "withdrawals_reserved";
      const creditAccount = tx.direction === "deposit" ? "player_funds" : "provider_clearing";
      await client.query(
        `INSERT INTO financial_ledger
          (entry_id,transaction_public_id,telegram_id,account,side,amount,currency,provider_reference)
         VALUES ($1,$2,$3,$4,'debit',$6,$7,$8),($5,$2,$3,$9,'credit',$6,$7,$8)`,
        [randomUUID(), transactionId, tx.telegram_id, debitAccount, randomUUID(), tx.amount, tx.currency, providerReference, creditAccount],
      );
    } else if (tx && status === "failed" && tx.direction === "withdrawal") {
      await client.query(
        `INSERT INTO financial_ledger
          (entry_id,transaction_public_id,telegram_id,account,side,amount,currency,provider_reference)
         VALUES ($1,$2,$3,'withdrawals_reserved','debit',$4,$5,$6),
                ($7,$2,$3,'player_funds','credit',$4,$5,$6)`,
        [randomUUID(), `${transactionId}:provider-failed`, tx.telegram_id, tx.amount, tx.currency, providerReference, randomUUID()],
      );
    }
    await client.query("COMMIT");
    return res.json({ accepted: true });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

export default router;