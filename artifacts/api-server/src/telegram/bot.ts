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

const gameNames = {
  rps: "✊ Rock Paper Scissors",
  coin: "🪙 Coin Flip",
  dice: "🎲 Dice Duel",
  darts: "🎯 Darts",
  basket: "🏀 Basketball",
  football: "⚽ Football",
  bowling: "🎳 Bowling",
  slots: "🎰 Slots",
  towers: "🏰 Towers",
  limbo: "🚀 Limbo",
  dr: "🎲 Dice Rush",
  "7up": "7️⃣ 7 Up",
  bj: "🃏 Blackjack",
  mines: "💣 Mines",
  vault: "🔒 Vault",
  cdice: "🏏 Cricket Dice",
} as const;

type GameId = keyof typeof gameNames;

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
    `<b>🎮 𝐀𝐕𝐀𝐈𝐋𝐀𝐁𝐋𝐄 𝐆𝐀𝐌𝐄𝐒</b>\n\n${Object.values(gameNames).join("\n")}\n\n<b>Play against the bot</b>\n<code>/rps 100 rock</code> · <code>/coin 100 heads</code>\n<code>/dice 100</code> · <code>/slots 100</code> · <code>/limbo 100 2</code>\n<code>/7up 100 up</code> · <code>/towers 100 2</code> · <code>/mines 100 3</code>\n\nEvery game is a one-round, server-settled play-credit game. Use <code>/help</code> for rules.`,
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
        AND type IN ('game_win', 'game_loss', 'game_draw')
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

function parseStake(value: string | undefined) {
  if (!value || !/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const stake = Number(value);
  return Number.isFinite(stake) && stake >= 1 && stake <= dailyPlayLimit ? stake : null;
}

type Outcome = { delta: number; detail: string };

function roll(max: number) {
  return randomInt(1, max + 1);
}

function resolveGame(game: GameId, stake: number, option?: string): Outcome | string {
  const choice = option?.toLowerCase();
  const net = (multiplier: number) => Math.round(stake * multiplier * 100) / 100;
  const duel = (label: string, max: number, multiplier: number): Outcome => {
    const player = roll(max);
    const bot = roll(max);
    return player === bot
      ? { delta: 0, detail: `${label}: you ${player}, bot ${bot}. Draw — stake returned.` }
      : { delta: player > bot ? net(multiplier) : -stake, detail: `${label}: you ${player}, bot ${bot}.` };
  };
  switch (game) {
    case "rps": {
      if (!["rock", "paper", "scissors"].includes(choice ?? "")) return "Choose rock, paper, or scissors: <code>/rps 100 rock</code>.";
      const bot = ["rock", "paper", "scissors"][randomInt(0, 3)]!;
      const win = (choice === "rock" && bot === "scissors") || (choice === "paper" && bot === "rock") || (choice === "scissors" && bot === "paper");
      return { delta: choice === bot ? 0 : win ? stake : -stake, detail: `You chose ${choice}; bot chose ${bot}.` };
    }
    case "coin": {
      if (!["heads", "tails"].includes(choice ?? "")) return "Choose heads or tails: <code>/coin 100 heads</code>.";
      const landed = randomInt(0, 2) ? "heads" : "tails";
      return { delta: choice === landed ? stake : -stake, detail: `Coin landed <b>${landed}</b>.` };
    }
    case "dice": return duel("Dice", 6, 1);
    case "darts": return duel("Bullseye score", 6, 0.9);
    case "basket": return duel("Baskets", 4, 1.2);
    case "football": return duel("Goals", 5, 1.1);
    case "bowling": return duel("Pins", 10, 0.95);
    case "dr": return duel("Three-roll total", 18, 1.5);
    case "cdice": return duel("Cricket runs", 6, 1);
    case "slots": {
      const symbols = ["🍒", "🍋", "🔔", "💎"];
      const reels = [symbols[randomInt(0, 4)]!, symbols[randomInt(0, 4)]!, symbols[randomInt(0, 4)]!];
      const matches = reels.filter((symbol) => symbol === reels[0]).length;
      const multiplier = matches === 3 ? 8 : matches === 2 ? 0.5 : -1;
      return { delta: multiplier < 0 ? -stake : net(multiplier), detail: `Reels: ${reels.join(" ")}. ${matches === 3 ? "Three of a kind!" : matches === 2 ? "Pair landed!" : "No matching reels."}` };
    }
    case "towers": {
      const floor = Number(choice);
      if (!Number.isInteger(floor) || floor < 1 || floor > 3) return "Choose a safe floor from 1–3: <code>/towers 100 2</code>.";
      const safe = roll(3);
      return { delta: floor === safe ? net(2) : -stake, detail: `You chose floor ${floor}; the safe floor was ${safe}.` };
    }
    case "limbo": {
      const target = Number(choice);
      if (!Number.isFinite(target) || target < 1.1 || target > 10) return "Choose a target from 1.1x–10x: <code>/limbo 100 2</code>.";
      const crash = randomInt(100, 1001) / 100;
      return { delta: crash >= target ? net(target - 1) : -stake, detail: `Crash point: <b>${crash.toFixed(2)}x</b>; your target: ${target.toFixed(2)}x.` };
    }
    case "7up": {
      if (!["up", "down", "7"].includes(choice ?? "")) return "Choose up, down, or 7: <code>/7up 100 up</code>.";
      const total = roll(6) + roll(6);
      const result = total === 7 ? "7" : total > 7 ? "up" : "down";
      return { delta: choice === result ? net(result === "7" ? 4 : 0.9) : -stake, detail: `Dice total: ${total} (${result}).` };
    }
    case "bj": {
      const player = roll(10) + roll(10);
      const bot = roll(10) + roll(10);
      const playerScore = player > 21 ? 0 : player;
      const botScore = bot > 21 ? 0 : bot;
      return { delta: playerScore === botScore ? 0 : playerScore > botScore ? stake : -stake, detail: `Your hand: ${player}; bot hand: ${bot}. Scores over 21 bust.` };
    }
    case "mines": {
      const tile = Number(choice);
      if (!Number.isInteger(tile) || tile < 1 || tile > 5) return "Pick a tile from 1–5: <code>/mines 100 3</code>.";
      const mine = roll(5);
      return { delta: tile === mine ? -stake : net(0.2), detail: `You picked tile ${tile}; mine was on tile ${mine}.` };
    }
    case "vault": {
      const code = Number(choice);
      if (!Number.isInteger(code) || code < 1 || code > 5) return "Guess a vault code from 1–5: <code>/vault 100 4</code>.";
      const secret = roll(5);
      return { delta: code === secret ? net(4) : -stake, detail: `Vault code was ${secret}.` };
    }
  }
  throw new Error(`Unsupported game: ${game}`);
}

async function playVsBot(chatId: number, userId: number, game: GameId, stake: number, option?: string) {
  if (!Number.isFinite(stake) || stake < 1 || stake > dailyPlayLimit) {
    await send(chatId, `Use <code>/${game} 100</code>. Stake must be 1–${dailyPlayLimit.toLocaleString("en-IN")} RC.`);
    return;
  }
  const outcome = resolveGame(game, stake, option);
  if (typeof outcome === "string") {
    await send(chatId, outcome);
    return;
  }
  if (!(await isMember(userId))) {
    await send(chatId, "Join the official community before playing.", { reply_markup: joinKeyboard });
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
    const won = outcome.delta > 0;
    const settledAs = outcome.delta === 0 ? "game_draw" : won ? "game_win" : "game_loss";
    await client.query(
      `UPDATE casino_users SET balance = balance + $1, games_played = games_played + 1,
       wins = wins + $2, total_wagered = total_wagered + $3, updated_at = NOW()
       WHERE telegram_id = $4`,
       [outcome.delta, won ? 1 : 0, stake, userId],
    );
    await client.query(
      `INSERT INTO casino_ledger (telegram_id, amount, type, reference, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
       [userId, outcome.delta, settledAs, game, JSON.stringify({ stake, option: option ?? null, net: outcome.delta, outcome: outcome.detail })],
    );
    await client.query("COMMIT");
    await send(
      chatId,
      `<b>${gameNames[game].toUpperCase()} RESULT</b>\n\n${outcome.detail}\n\n${won ? "✦ <b>YOU WIN</b>" : outcome.delta === 0 ? "◇ <b>DRAW</b>" : "◇ <b>BOT WINS</b>"}\nStake: ${stake.toFixed(2)} RC\nNet: ${outcome.delta > 0 ? "+" : ""}${outcome.delta.toFixed(2)} RC`,
      { reply_markup: { inline_keyboard: [[{ text: "Play Again", callback_data: `replay_${game}_${stake}_${option ?? ""}`, style: "success" }]] } },
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
  if (!(await isMember(userId))) {
    await send(chatId, "Join the official community before creating a challenge.", { reply_markup: joinKeyboard });
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
    case "rps":
    case "coin":
    case "dice":
    case "darts":
    case "basket":
    case "football":
    case "bowling":
    case "slots":
    case "towers":
    case "limbo":
    case "dr":
    case "7up":
    case "bj":
    case "mines":
    case "vault":
    case "cdice": {
      const stake = parseStake(args[0]);
      if (stake === null) {
        await send(message.chat.id, `Use <code>/${command} 100</code>. Stake must be a whole or two-decimal amount from 1–${dailyPlayLimit.toLocaleString("en-IN")} RC.`);
        break;
      }
      await playVsBot(message.chat.id, user.id, command, stake, args[1]);
      break;
    }
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
        "<b>📚 COMMAND DIRECTORY</b>\n\n<b>Bot games (stake in RC)</b>\n/rps 100 rock — win +1x; tie returned\n/coin 100 heads — correct call +1x\n/dice 100 · /darts 100 · /basket 100 · /football 100 · /bowling 100 — beat bot; ties returned\n/slots 100 — 2 matching +0.5x, 3 +8x\n/towers 100 2 — find safe floor 1–3 for +2x\n/limbo 100 2 — reach target 1.1x–10x\n/dr 100 — Dice Rush, beat bot for +1.5x\n/7up 100 up — up/down +0.9x, exact 7 +4x\n/bj 100 — blackjack duel, +1x\n/mines 100 3 — safe tile 1–5 for +0.2x\n/vault 100 4 — guess code 1–5 for +4x\n/cdice 100 — cricket dice duel, +1x\n\n/games — game arena\n/wallet — play-credit vault\n/mystats — player record\n/rank — leaderboard\n/battle 100 — PvP challenge\n/support — support desk\n\nDaily game stakes are capped at 5,000 RC and reset at midnight IST. ⚠️ Prototype credits have no monetary value.",
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
  const record = await getUser(callback.from.id);
  if (record?.banned) {
    await send(chatId, "Your access is restricted. Contact support.");
    return;
  }
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
    const [, game, amount, option] = data.split("_");
    if (game && game in gameNames) {
      const stake = parseStake(amount);
      if (stake !== null) await playVsBot(chatId, callback.from.id, game as GameId, stake, option || undefined);
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
      { command: "play", description: "Alias for the game arena" },
      { command: "wallet", description: "View your play-credit vault" },
      { command: "balance", description: "Alias for your play-credit vault" },
      { command: "mystats", description: "View your gaming record" },
      { command: "stats", description: "Alias for your gaming record" },
      { command: "profile", description: "Alias for your gaming record" },
      { command: "rank", description: "View the leaderboard" },
      { command: "leaderboard", description: "Alias for the leaderboard" },
      { command: "top", description: "Alias for the leaderboard" },
      { command: "help", description: "Open the command directory" },
      { command: "rps", description: "Rock paper scissors: /rps stake rock" },
      { command: "coin", description: "Coin flip: /coin stake heads" },
      { command: "dice", description: "Dice duel against the bot" },
      { command: "darts", description: "Darts score duel" },
      { command: "basket", description: "Basketball score duel" },
      { command: "football", description: "Football score duel" },
      { command: "bowling", description: "Bowling pins duel" },
      { command: "slots", description: "Spin three slot reels" },
      { command: "towers", description: "Choose a safe tower floor" },
      { command: "limbo", description: "Set a limbo multiplier target" },
      { command: "dr", description: "Play Dice Rush" },
      { command: "7up", description: "Predict up, down, or seven" },
      { command: "bj", description: "Play one-round blackjack" },
      { command: "mines", description: "Choose a mine-free tile" },
      { command: "vault", description: "Guess the vault code" },
      { command: "cdice", description: "Play cricket dice" },
      { command: "support", description: "Contact support" },
    ],
  });
  running = true;
  void poll();
  logger.info("Telegram bot polling started");
}
