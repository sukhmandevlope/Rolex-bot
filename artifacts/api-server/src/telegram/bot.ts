import { randomInt } from "node:crypto";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";

type TgUser = { id: number; first_name: string; username?: string };
type TgChat = { id: number; type: string };
type TgMessage = {
  message_id: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
};
type TgCallback = {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
};
type TgUpdate = { update_id: number; message?: TgMessage; callback_query?: TgCallback };

const token = process.env["TELEGRAM_BOT_TOKEN"];
const api = token ? `https://api.telegram.org/bot${token}` : "";
const requiredChannel = "@RolexCasinos";
const requiredChannelUrl = "https://t.me/RolexCasinos";
const admins = new Set(
  (process.env["ADMIN_TELEGRAM_IDS"] ?? "")
    .split(",")
    .map(Number)
    .filter(Number.isFinite),
);
let offset = 0;
let running = false;
const dailyPlayLimit = 5000;

const games = [
  "✊ Rock • Paper • Scissors",
  "🪙 Coin Flip",
  "🎲 Dice",
  "🎯 Darts",
  "🏀 Basketball",
  "⚽ Football",
  "🎳 Bowling",
  "🎰 Slots",
  "🏰 Towers",
  "🚀 Limbo",
  "🎲 Dice Rush",
  "7️⃣ 7 Up",
  "🃏 Blackjack",
  "💣 Mines",
  "🔒 Vault",
  "🏏 Cricket Dice",
];

async function callTelegram<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${api}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as { ok: boolean; result: T; description?: string };
  if (!payload.ok) throw new Error(payload.description ?? `Telegram ${method} failed`);
  return payload.result;
}

async function send(chatId: number, text: string, extra: Record<string, unknown> = {}) {
  return callTelegram<TgMessage>("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

async function ensureUser(user: TgUser) {
  await pool.query(
    `INSERT INTO casino_users (telegram_id, username, first_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (telegram_id) DO UPDATE
     SET username = EXCLUDED.username, first_name = EXCLUDED.first_name, updated_at = NOW()`,
    [user.id, user.username ?? null, user.first_name],
  );
}

async function getUser(id: number) {
  const result = await pool.query<{
    balance: string;
    games_played: number;
    wins: number;
    total_wagered: string;
    banned: boolean;
  }>(
    `SELECT balance, games_played, wins, total_wagered, banned
     FROM casino_users WHERE telegram_id = $1`,
    [id],
  );
  return result.rows[0];
}

async function isMember(userId: number) {
  try {
    const member = await callTelegram<{ status: string }>("getChatMember", {
      chat_id: requiredChannel,
      user_id: userId,
    });
    return !["left", "kicked"].includes(member.status);
  } catch (err) {
    logger.warn({ err }, "Channel membership check unavailable");
    return false;
  }
}

const joinKeyboard = {
  inline_keyboard: [
    [{ text: "✦ Join Rolex Casino", url: requiredChannelUrl, style: "success" }],
    [{ text: "✓ I Have Joined", callback_data: "verify_join", style: "success" }],
  ],
};

const mainKeyboard = {
  inline_keyboard: [
    [
      { text: "🎮 Games", callback_data: "games", style: "success" },
      { text: "💎 Wallet", callback_data: "wallet", style: "success" },
    ],
    [
      { text: "🏆 Leaderboard", callback_data: "leaderboard", style: "success" },
      { text: "📊 My Stats", callback_data: "stats", style: "success" },
    ],
    [
      { text: "🎁 Refer & Earn", callback_data: "refer", style: "success" },
      { text: "🛟 Support", callback_data: "support", style: "success" },
    ],
  ],
};

async function welcome(chatId: number, user: TgUser) {
  const member = await isMember(user.id);
  if (!member) {
    await send(
      chatId,
      `<b>♛ 𝐑𝐎𝐋𝐄𝐗 𝐂𝐀𝐒𝐈𝐍𝐎 ♛</b>\n\nWelcome, <b>${escapeHtml(user.first_name)}</b>.\nJoin our official community to unlock the private gaming lounge.`,
      { reply_markup: joinKeyboard },
    );
    return;
  }
  await send(
    chatId,
    `<b>♛ 𝐑𝐎𝐋𝐄𝐗 𝐂𝐀𝐒𝐈𝐍𝐎 ♛</b>\n\nWelcome back, <b>${escapeHtml(user.first_name)}</b>.\n\n<i>Premium PvP entertainment • Instant play credits • Provably fair-ready architecture</i>\n\n⚠️ <b>Prototype mode:</b> credits have no cash value.`,
    { reply_markup: mainKeyboard },
  );
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function showGames(chatId: number) {
  await send(
    chatId,
    `<b>🎮 𝐀𝐕𝐀𝐈𝐋𝐀𝐁𝐋𝐄 𝐆𝐀𝐌𝐄𝐒</b>\n\n${games.join("\n")}\n\n<b>Quick play</b>\n<code>/coin 100</code> — play vs bot\n<code>/dice 100</code> — roll vs bot\n<code>/battle 100</code> — create a PvP challenge\n\nAll balances are play credits in this prototype.`,
  );
}

async function showWallet(chatId: number, userId: number) {
  const user = await getUser(userId);
  if (!user) return;
  const playedToday = await getDailyWagered(userId);
  await send(
    chatId,
    `<b>💎 𝐏𝐑𝐈𝐕𝐀𝐓𝐄 𝐕𝐀𝐔𝐋𝐓</b>\n\nAvailable: <b>${Number(user.balance).toFixed(2)} RC</b>\nToday's play: <b>${playedToday.toFixed(2)} / ${dailyPlayLimit.toFixed(2)} RC</b>\nTotal wagered: ${Number(user.total_wagered).toFixed(2)} RC\nGames played: ${user.games_played}\n\n⚠️ Play credits cannot be deposited, withdrawn, traded, or redeemed.`,
  );
}

async function getDailyWagered(
  userId: number,
  client: { query: (...args: any[]) => Promise<any> } = pool,
) {
  const result = (await client.query(
    `SELECT COALESCE(SUM((metadata->>'stake')::numeric), 0)::text AS wagered
     FROM casino_ledger
     WHERE telegram_id = $1
       AND type IN ('game_win', 'game_loss')
       AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`,
    [userId],
  )) as { rows: Array<{ wagered: string }> };
  return Number(result.rows[0]?.wagered ?? 0);
}

async function showStats(chatId: number, userId: number) {
  const user = await getUser(userId);
  if (!user) return;
  const rate = user.games_played ? ((user.wins / user.games_played) * 100).toFixed(1) : "0.0";
  await send(
    chatId,
    `<b>📊 𝐏𝐋𝐀𝐘𝐄𝐑 𝐒𝐓𝐀𝐓𝐒</b>\n\nMatches: <b>${user.games_played}</b>\nVictories: <b>${user.wins}</b>\nWin rate: <b>${rate}%</b>\nVolume: <b>${Number(user.total_wagered).toFixed(2)} RC</b>`,
  );
}

async function leaderboard(chatId: number) {
  const result = await pool.query<{ first_name: string; username: string | null; balance: string }>(
    `SELECT first_name, username, balance FROM casino_users
     WHERE banned = FALSE ORDER BY balance DESC LIMIT 10`,
  );
  const rows = result.rows.map((u, i) => {
    const name = u.username ? `@${escapeHtml(u.username)}` : escapeHtml(u.first_name);
    return `${i + 1}. ${name} — <b>${Number(u.balance).toFixed(2)} RC</b>`;
  });
  await send(chatId, `<b>🏆 𝐇𝐈𝐆𝐇 𝐑𝐎𝐋𝐋𝐄𝐑𝐒</b>\n\n${rows.join("\n") || "No players yet."}`);
}

async function playVsBot(chatId: number, userId: number, game: "coin" | "dice", stake: number) {
  if (!Number.isFinite(stake) || stake < 1 || stake > dailyPlayLimit) {
    await send(chatId, `Use <code>/${game} 100</code>. Stake must be 1–${dailyPlayLimit.toLocaleString("en-IN")} RC.`);
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{ balance: string }>(
      `SELECT balance FROM casino_users WHERE telegram_id = $1 AND banned = FALSE FOR UPDATE`,
      [userId],
    );
    if (!locked.rows[0] || Number(locked.rows[0].balance) < stake) {
      await client.query("ROLLBACK");
      await send(chatId, "Insufficient play-credit balance.");
      return;
    }
    const playedToday = await getDailyWagered(userId, client);
    if (playedToday + stake > dailyPlayLimit) {
      await client.query("ROLLBACK");
      await send(
        chatId,
        `<b>🛡 DAILY PLAY LIMIT</b>\n\nYou have played ${playedToday.toFixed(2)} RC today.\nRemaining: <b>${Math.max(0, dailyPlayLimit - playedToday).toFixed(2)} RC</b>\n\nThe limit resets at midnight IST.`,
      );
      return;
    }
    const won = randomInt(0, 2) === 1;
    const delta = won ? stake : -stake;
    await client.query(
      `UPDATE casino_users SET balance = balance + $1, games_played = games_played + 1,
       wins = wins + $2, total_wagered = total_wagered + $3, updated_at = NOW()
       WHERE telegram_id = $4`,
      [delta, won ? 1 : 0, stake, userId],
    );
    await client.query(
      `INSERT INTO casino_ledger (telegram_id, amount, type, reference, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, delta, won ? "game_win" : "game_loss", game, JSON.stringify({ stake })],
    );
    await client.query("COMMIT");
    await send(
      chatId,
      `${game === "coin" ? "🪙" : "🎲"} <b>${game.toUpperCase()} RESULT</b>\n\n${won ? "✦ <b>YOU WIN</b>" : "◇ <b>HOUSE WINS</b>"}\nStake: ${stake.toFixed(2)} RC\nNet: ${delta > 0 ? "+" : ""}${delta.toFixed(2)} RC`,
      { reply_markup: { inline_keyboard: [[{ text: "Play Again", callback_data: `replay_${game}_${stake}`, style: "success" }]] } },
    );
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function createBattle(chatId: number, userId: number, stake: number) {
  if (!Number.isFinite(stake) || stake < 1 || stake > dailyPlayLimit) {
    await send(chatId, `Use <code>/battle 100</code>. Stake must be 1–${dailyPlayLimit.toLocaleString("en-IN")} RC.`);
    return;
  }
  const playedToday = await getDailyWagered(userId);
  if (playedToday + stake > dailyPlayLimit) {
    await send(
      chatId,
      `<b>🛡 DAILY PLAY LIMIT</b>\n\nRemaining today: <b>${Math.max(0, dailyPlayLimit - playedToday).toFixed(2)} RC</b>\nThe limit resets at midnight IST.`,
    );
    return;
  }
  const result = await pool.query<{ id: number }>(
    `INSERT INTO casino_matches (creator_id, game, stake, status)
     SELECT $1, 'dice', $2, 'waiting'
     WHERE EXISTS (SELECT 1 FROM casino_users WHERE telegram_id = $1 AND balance >= $2 AND banned = FALSE)
     RETURNING id`,
    [userId, stake],
  );
  if (!result.rows[0]) {
    await send(chatId, "Insufficient play-credit balance.");
    return;
  }
  await send(
    chatId,
    `<b>⚔️ PvP CHALLENGE #${result.rows[0].id}</b>\n\nGame: Dice Duel\nStake: <b>${stake.toFixed(2)} RC each</b>\n\nChallenge created. Full acceptance and settlement arrives in the next milestone.`,
  );
}

async function handleAdmin(chatId: number, userId: number, command: string, args: string[]) {
  if (!admins.has(userId)) {
    await send(chatId, "This command is restricted.");
    return;
  }
  if (command === "admin") {
    const result = await pool.query<{ users: string; volume: string }>(
      `SELECT COUNT(*)::text AS users, COALESCE(SUM(total_wagered), 0)::text AS volume FROM casino_users`,
    );
    await send(
      chatId,
      `<b>🛡 ADMIN CONTROL</b>\n\nUsers: ${result.rows[0]?.users}\nPlay volume: ${Number(result.rows[0]?.volume).toFixed(2)} RC\n\n<code>/ban user_id</code>\n<code>/unban user_id</code>\n<code>/setbalance user_id amount</code>`,
    );
    return;
  }
  const target = Number(args[0]);
  if (!Number.isSafeInteger(target)) {
    await send(chatId, "A valid Telegram user ID is required.");
    return;
  }
  if (command === "ban" || command === "unban") {
    await pool.query(`UPDATE casino_users SET banned = $1, updated_at = NOW() WHERE telegram_id = $2`, [
      command === "ban",
      target,
    ]);
    await send(chatId, `User ${target} ${command === "ban" ? "banned" : "restored"}.`);
  } else if (command === "setbalance") {
    const amount = Number(args[1]);
    if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000) {
      await send(chatId, "Balance must be between 0 and 1,000,000 RC.");
      return;
    }
    await pool.query(`UPDATE casino_users SET balance = $1, updated_at = NOW() WHERE telegram_id = $2`, [
      amount,
      target,
    ]);
    await send(chatId, `User ${target} balance set to ${amount.toFixed(2)} RC.`);
  }
}

async function handleMessage(message: TgMessage) {
  const user = message.from;
  const text = message.text?.trim();
  if (!user || !text) return;
  await ensureUser(user);
  const record = await getUser(user.id);
  if (record?.banned) {
    await send(message.chat.id, "Your access is restricted. Contact support.");
    return;
  }
  const [raw, ...args] = text.split(/\s+/);
  const command = (raw ?? "").split("@")[0]?.replace(/^\//, "").toLowerCase();
  if (!command) return;
  if (["admin", "ban", "unban", "setbalance"].includes(command)) {
    await handleAdmin(message.chat.id, user.id, command, args);
    return;
  }
  switch (command) {
    case "start":
      await welcome(message.chat.id, user);
      break;
    case "games":
    case "play":
      await showGames(message.chat.id);
      break;
    case "wallet":
    case "balance":
      await showWallet(message.chat.id, user.id);
      break;
    case "mystats":
    case "profile":
    case "stats":
      await showStats(message.chat.id, user.id);
      break;
    case "rank":
    case "leaderboard":
    case "top":
      await leaderboard(message.chat.id);
      break;
    case "coin":
    case "dice":
      await playVsBot(message.chat.id, user.id, command, Number(args[0]));
      break;
    case "battle":
      await createBattle(message.chat.id, user.id, Number(args[0]));
      break;
    case "deposit":
    case "withdraw":
    case "setwallet":
      await send(
        message.chat.id,
        "<b>🔒 PAYMENTS LOCKED</b>\n\nReal-money and crypto transactions are disabled in this unlicensed prototype. Never send funds or private keys to anyone claiming to represent this bot.",
      );
      break;
    case "support":
      await send(
        message.chat.id,
        `<b>🛟 VIP SUPPORT DESK</b>\n\nFor prototype support, contact the administrators in ${requiredChannel}.\n\nStaff will never request your password, seed phrase, or private key.`,
      );
      break;
    case "refer":
      await send(
        message.chat.id,
        `<b>🎁 REFER & EARN</b>\n\nYour private invite link:\n<code>https://t.me/RolexCasinoBot?start=${user.id}</code>\n\nReferral rewards will activate after the bot username is confirmed.`,
      );
      break;
    case "escrow":
      await send(
        message.chat.id,
        "<b>🔐 ESCROW</b>\n\nEscrow is limited to in-bot play credits. Real-money escrow is disabled.\nUse <code>/battle amount</code> to create a protected PvP challenge.",
      );
      break;
    case "help":
      await send(
        message.chat.id,
        "<b>📚 COMMAND DIRECTORY</b>\n\n/start — premium dashboard\n/games — game arena\n/wallet — play-credit vault\n/coin 100 — coin game\n/dice 100 — dice game\n/battle 100 — PvP challenge\n/mystats — player record\n/rank — leaderboard\n/refer — invite link\n/escrow — protected matches\n/support — support desk\n\n⚠️ Prototype credits have no monetary value.",
      );
      break;
    default:
      if (text.startsWith("/")) await send(message.chat.id, "Unknown command. Use /help.");
  }
}

async function handleCallback(callback: TgCallback) {
  const chatId = callback.message?.chat.id;
  if (!chatId) return;
  await callTelegram("answerCallbackQuery", { callback_query_id: callback.id });
  await ensureUser(callback.from);
  const data = callback.data ?? "";
  if (data === "verify_join") await welcome(chatId, callback.from);
  else if (data === "games") await showGames(chatId);
  else if (data === "wallet") await showWallet(chatId, callback.from.id);
  else if (data === "stats") await showStats(chatId, callback.from.id);
  else if (data === "leaderboard") await leaderboard(chatId);
  else if (data === "refer") {
    await send(chatId, `Your prototype referral code: <code>${callback.from.id}</code>`);
  } else if (data === "support") {
    await send(chatId, `<b>🛟 SUPPORT</b>\nContact administrators through ${requiredChannel}.`);
  } else if (data.startsWith("replay_")) {
    const [, game, amount] = data.split("_");
    if (game === "coin" || game === "dice") {
      await playVsBot(chatId, callback.from.id, game, Number(amount));
    }
  }
}

async function poll() {
  while (running) {
    try {
      const updates = await callTelegram<TgUpdate[]>("getUpdates", {
        offset,
        timeout: 25,
        allowed_updates: ["message", "callback_query"],
      });
      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.message) await handleMessage(update.message);
        if (update.callback_query) await handleCallback(update.callback_query);
      }
    } catch (err) {
      logger.error({ err }, "Telegram polling error");
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

export async function startTelegramBot() {
  if (!token) {
    logger.warn("TELEGRAM_BOT_TOKEN is not configured; bot is disabled");
    return;
  }
  await callTelegram("deleteWebhook", { drop_pending_updates: false });
  await callTelegram("setMyCommands", {
    commands: [
      { command: "start", description: "Open the Rolex Casino dashboard" },
      { command: "games", description: "Browse the game arena" },
      { command: "wallet", description: "View your play-credit vault" },
      { command: "mystats", description: "View your gaming record" },
      { command: "rank", description: "View the leaderboard" },
      { command: "help", description: "Open the command directory" },
      { command: "support", description: "Contact support" },
    ],
  });
  running = true;
  void poll();
  logger.info("Telegram bot polling started");
}
