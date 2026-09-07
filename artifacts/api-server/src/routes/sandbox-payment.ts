import { Router, type IRouter, type Request, type Response } from "express";
import { sandboxDeposit } from "../lib/rolex-casino";

const router: IRouter = Router();
const supportedCurrencies = new Set(["INR", "USD"]);

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character] ?? character;
  });
}

function parseAmountMinor(value: unknown): number | null {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) return null;
  const amountMinor = Math.round(amount * 100);
  return Number.isSafeInteger(amountMinor) && amountMinor > 0 ? amountMinor : null;
}

function currencyLabel(value: unknown): "INR" | "USD" | null {
  const currency = String(value ?? "").toUpperCase();
  return supportedCurrencies.has(currency) ? (currency as "INR" | "USD") : null;
}

function formatMoney(amountMinor: number, currency: "INR" | "USD"): string {
  return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(amountMinor / 100);
}

function gatewayPage(options: {
  amountMinor: number;
  currency: "INR" | "USD";
  playerId: number;
  orderId: string;
  completed?: { requestId: number; balanceMinor: number };
  error?: string;
}): string {
  const amount = formatMoney(options.amountMinor, options.currency);
  const title = options.completed ? "Virtual Payment Complete" : "Virtual Payment Gateway";
  const status = options.completed
    ? `Sandbox credit added. Request #${options.completed.requestId}. New balance: ${formatMoney(options.completed.balanceMinor, options.currency)}.`
    : options.error ?? "Ready to simulate a payment.";
  const action = options.completed
    ? `<a class="button secondary" href="/sandbox-payment?player_id=${options.playerId}&amount=${options.amountMinor / 100}&currency=${options.currency}">Create another test payment</a>`
    : `<form method="post" action="/sandbox-payment/complete">
        <input type="hidden" name="player_id" value="${options.playerId}">
        <input type="hidden" name="amount_minor" value="${options.amountMinor}">
        <input type="hidden" name="currency" value="${options.currency}">
        <button class="button" type="submit">Simulate payment</button>
      </form>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; color: #f8fafc; background: #0f172a; }
    .glow { position: fixed; width: 320px; height: 320px; border-radius: 50%; filter: blur(110px); opacity: .28; pointer-events: none; }
    .glow.one { top: -100px; left: -80px; background: #f97316; }
    .glow.two { right: -100px; bottom: -100px; background: #3b82f6; }
    .card { position: relative; width: min(100%, 420px); padding: 32px; text-align: center; border: 1px solid rgba(255,255,255,.14); border-radius: 24px; background: rgba(15,23,42,.82); box-shadow: 0 24px 80px rgba(0,0,0,.35); }
    .eyebrow { color: #fdba74; font-size: 12px; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; }
    h1 { margin: 12px 0 6px; font-size: 27px; }
    .subtitle { margin: 0 0 24px; color: #94a3b8; font-size: 14px; line-height: 1.5; }
    .amount { margin: 20px 0 24px; color: #fed7aa; font-size: 48px; font-weight: 850; letter-spacing: -.04em; }
    .status { margin-bottom: 22px; padding: 14px; border: 1px solid rgba(74,222,128,.35); border-radius: 14px; color: #bbf7d0; background: rgba(22,101,52,.25); font-size: 14px; line-height: 1.45; }
    .button { display: block; width: 100%; padding: 14px 18px; border: 0; border-radius: 13px; color: #111827; background: #fb923c; font: inherit; font-weight: 800; cursor: pointer; text-decoration: none; }
    .button:hover { background: #fdba74; }
    .button.secondary { color: #e2e8f0; background: rgba(255,255,255,.1); }
    .fine-print { margin: 22px 0 0; color: #64748b; font-size: 12px; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="glow one"></div><div class="glow two"></div>
  <main class="card">
    <div class="eyebrow">RolexCasino · Sandbox</div>
    <h1>${escapeHtml(title)}</h1>
    <p class="subtitle">A virtual payment screen for testing the casino wallet.</p>
    <div class="amount">${escapeHtml(amount)}</div>
    <div class="status">${escapeHtml(status)}</div>
    ${action}
    <p class="fine-print">No bank, UPI, crypto wallet, payment provider, or real currency is connected to this page.</p>
  </main>
</body>
</html>`;
}

function renderGateway(req: Request, res: Response): void {
  const playerId = Number(req.query.player_id);
  const amountMinor = parseAmountMinor(req.query.amount);
  const currency = currencyLabel(req.query.currency);
  if (!Number.isSafeInteger(playerId) || playerId <= 0 || !amountMinor || !currency) {
    res.status(400).type("html").send("<h1>Invalid sandbox payment link</h1>");
    return;
  }
  res.type("html").send(
    gatewayPage({ playerId, amountMinor, currency, orderId: `SANDBOX_${Date.now()}` }),
  );
}

router.get("/sandbox-payment", renderGateway);

router.post("/sandbox-payment/complete", async (req: Request, res: Response) => {
  const playerId = Number(req.body?.player_id);
  const amountMinor = Number(req.body?.amount_minor);
  const currency = currencyLabel(req.body?.currency);
  if (
    !Number.isSafeInteger(playerId) ||
    playerId <= 0 ||
    !Number.isSafeInteger(amountMinor) ||
    amountMinor <= 0 ||
    amountMinor > 100_000_000 ||
    !currency
  ) {
    res.status(400).type("html").send("<h1>Invalid sandbox payment request</h1>");
    return;
  }

  try {
    const completed = await sandboxDeposit({ playerId, amountMinor, currency });
    res.type("html").send(
      gatewayPage({
        playerId,
        amountMinor,
        currency,
        orderId: `SANDBOX_${Date.now()}`,
        completed,
      }),
    );
  } catch {
    res.status(500).type("html").send("<h1>Sandbox payment could not be completed</h1>");
  }
});

export default router;