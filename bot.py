import os
import sqlite3
import logging
import asyncio
import random
from typing import Optional, Dict, Any
from dotenv import load_dotenv
from telegram import (
    Update,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
)
from telegram.ext import (
    Application,
    CommandHandler,
    CallbackQueryHandler,
    MessageHandler,
    filters,
    ContextTypes,
)

try:
    load_dotenv()
except ImportError:
    pass

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s", level=logging.INFO
)
logger = logging.getLogger(__name__)

# -------------------------------------------------------------------------
# CONFIGURATIONS & CREDENTIALS
# -------------------------------------------------------------------------
TOKEN = "8673935058:AAEs4PD4r-M6Wf0Yk1izA0vmKFq_5N3Pam4"
BOT_NAME = "Rolex Casino BOT"
BOT_USERNAME = "@Rolex_C_BOT"
GROUP_LINK = "https://t.me/RolexCasinos"
GROUP_ID = int(os.getenv("GROUP_ID", "-1004458883943"))
LOGS_CHANNEL_ID = -1004458883943

ADMIN_IDS = [1, 8362081186, 1053006219, 8860529495]
ADMIN_USERNAMES = ["@Lucifer_1209", "@luffy_rolex", "@RolexCasinoMod"]
OWNER_USERNAME = "@Lucifer_1209"

UPI_ADDRESS = "rutvik1209@fam"
CRYPTO_WALLETS = {
    "USDT (BEP20)": "0xD8419224A65C3d35C10AE695562463c8445ACb15",
    "SOLANA": "3bKsCSR2mmconFaExejbkuGfeQNuVQPFttzj9y2MP2mE",
    "ETHEREUM": "0xD8419224A65C3d35C10AE695562463c8445ACb15",
    "BITCOIN": "bc1qsm7xzn4k8kpxwurzjsredangepvzgh70y0ypzd",
}

USDT_RATE_INR = 94.47

GAME_EMOJIS = {
    "dice": "🎲",
    "darts": "🎯",
    "bowling": "🎳",
    "basket": "🏀",
    "basketball": "🏀",
    "football": "⚽",
    "slots": "🎰",
}

# -------------------------------------------------------------------------
# DATABASE ENGINE
# -------------------------------------------------------------------------
DB_FILE = os.getenv("DATABASE_PATH", "rolex_casino.db")

def get_db():
    conn = sqlite3.connect(DB_FILE, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY,
                username TEXT,
                first_name TEXT,
                balance REAL DEFAULT 0.0,
                house_balance REAL DEFAULT 0.0,
                wager_req REAL DEFAULT 0.0,
                currency TEXT DEFAULT 'INR',
                default_wallet TEXT DEFAULT '',
                wins INTEGER DEFAULT 0,
                losses INTEGER DEFAULT 0,
                total_played INTEGER DEFAULT 0,
                referrer_id INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS deposits (
                id TEXT PRIMARY KEY,
                user_id INTEGER,
                username TEXT,
                method TEXT,
                txid TEXT,
                amount REAL,
                photo_file_id TEXT,
                status TEXT DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                approved_by INTEGER DEFAULT 0
            )
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS withdrawals (
                id TEXT PRIMARY KEY,
                user_id INTEGER,
                username TEXT,
                amount REAL,
                address TEXT,
                method TEXT,
                status TEXT DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                processed_by INTEGER DEFAULT 0
            )
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS escrows (
                id TEXT PRIMARY KEY,
                maker_id INTEGER,
                maker_name TEXT,
                taker_id INTEGER,
                taker_name TEXT,
                amount REAL,
                status TEXT DEFAULT 'active',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS system_settings (
                key TEXT PRIMARY KEY,
                value TEXT
            )
        """)
        cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('maintenance_mode', '0')")
        conn.commit()

init_db()

def db_upsert_user(user_id: int, username: str, first_name: str) -> dict:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM users WHERE id = ?", (user_id,))
        row = cursor.fetchone()
        if not row:
            cursor.execute(
                "INSERT INTO users (id, username, first_name, balance, wager_req) VALUES (?, ?, ?, 0.0, 100.0)",
                (user_id, username, first_name),
            )
            conn.commit()
            cursor.execute("SELECT * FROM users WHERE id = ?", (user_id,))
            row = cursor.fetchone()
        else:
            if username and row["username"] != username:
                cursor.execute("UPDATE users SET username = ?, first_name = ? WHERE id = ?", (username, first_name, user_id))
                conn.commit()
        return dict(row)

def db_get_balance(user_id: int) -> float:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT balance FROM users WHERE id = ?", (user_id,))
        row = cursor.fetchone()
        return float(row["balance"]) if row else 0.0

def db_update_balance(user_id: int, delta: float):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM users WHERE id = ?", (user_id,))
        if not cursor.fetchone():
            cursor.execute("INSERT INTO users (id, balance) VALUES (?, 0.0)", (user_id,))
        cursor.execute("UPDATE users SET balance = balance + ? WHERE id = ?", (delta, user_id))
        conn.commit()

def db_get_house_balance() -> float:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT SUM(house_balance) as hb FROM users")
        row = cursor.fetchone()
        return float(row["hb"]) if row and row["hb"] else 0.0

def db_add_house_balance(amount: float):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("UPDATE users SET house_balance = house_balance + ? WHERE id = (SELECT id FROM users LIMIT 1)", (amount,))
        conn.commit()

def db_get_wager(user_id: int) -> float:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT wager_req FROM users WHERE id = ?", (user_id,))
        row = cursor.fetchone()
        return float(row["wager_req"]) if row else 0.0

def db_reduce_wager(user_id: int, amount: float):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("UPDATE users SET wager_req = MAX(0.0, wager_req - ?) WHERE id = ?", (amount, user_id))
        conn.commit()

def db_get_wallet(user_id: int) -> str:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT default_wallet FROM users WHERE id = ?", (user_id,))
        row = cursor.fetchone()
        return row["default_wallet"] if row and row["default_wallet"] else ""

def db_set_wallet(user_id: int, address: str):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("UPDATE users SET default_wallet = ? WHERE id = ?", (address, user_id))
        conn.commit()

def db_update_stats(user_id: int, won: bool):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            UPDATE users 
            SET total_played = total_played + 1,
                wins = wins + (CASE WHEN ? THEN 1 ELSE 0 END),
                losses = losses + (CASE WHEN ? THEN 0 ELSE 1 END)
            WHERE id = ?
        """, (won, won, user_id))
        conn.commit()

def db_get_stats(user_id: int) -> dict:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT wins, losses, total_played, balance, wager_req FROM users WHERE id = ?", (user_id,))
        row = cursor.fetchone()
        if row:
            return dict(row)
        return {"wins": 0, "losses": 0, "total_played": 0, "balance": 0.0, "wager_req": 0.0}

def db_get_setting(key: str, default: str = "") -> str:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT value FROM system_settings WHERE key = ?", (key,))
        row = cursor.fetchone()
        return row["value"] if row else default

def db_set_setting(key: str, value: str):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)", (key, value))
        conn.commit()

def db_save_deposit(dep_id: str, user_id: int, username: str, method: str, txid: str, amount: float, photo_file_id: str):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO deposits (id, user_id, username, method, txid, amount, photo_file_id, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
        """, (dep_id, user_id, username, method, txid, amount, photo_file_id))
        conn.commit()

def db_get_deposit(dep_id: str) -> Optional[dict]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM deposits WHERE id = ?", (dep_id,))
        row = cursor.fetchone()
        return dict(row) if row else None

def db_update_deposit(dep_id: str, status: str, approved_by: int):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("UPDATE deposits SET status = ?, approved_by = ? WHERE id = ?", (status, approved_by, dep_id))
        conn.commit()

def db_save_escrow(esc_id: str, maker_id: int, maker_name: str, taker_id: int, taker_name: str, amount: float):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO escrows (id, maker_id, maker_name, taker_id, taker_name, amount, status)
            VALUES (?, ?, ?, ?, ?, ?, 'active')
        """, (esc_id, maker_id, maker_name, taker_id, taker_name, amount))
        conn.commit()

def db_get_escrow(esc_id: str) -> Optional[dict]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM escrows WHERE id = ?", (esc_id,))
        row = cursor.fetchone()
        return dict(row) if row else None

def db_update_escrow(esc_id: str, status: str):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("UPDATE escrows SET status = ? WHERE id = ?", (status, esc_id))
        conn.commit()

active_pvp_rooms: Dict[str, Dict[str, Any]] = {}
active_tips: Dict[str, Dict[str, Any]] = {}

def is_admin(user_id: int) -> bool:
    return user_id in ADMIN_IDS

def is_maintenance_active() -> bool:
    return db_get_setting("maintenance_mode", "0") == "1"

async def check_maintenance(update: Update) -> bool:
    if is_maintenance_active():
        user = update.effective_user
        if user and not is_admin(user.id):
            if update.message:
                await update.message.reply_text(
                    "🛠️ **ROLEX CASINO IS UNDER MAINTENANCE!**\n\nAll games and features are currently locked.",
                    parse_mode="Markdown",
                )
            elif update.callback_query:
                await update.callback_query.answer("🛠️ Bot is under maintenance.", show_alert=True)
            return True
    return False

async def send_log(context: ContextTypes.DEFAULT_TYPE, text: str):
    try:
        await context.bot.send_message(chat_id=LOGS_CHANNEL_ID, text=text, parse_mode="Markdown")
    except Exception as e:
        logger.warning(f"Could not send log: {e}")

# -------------------------------------------------------------------------
# START & COMMANDS
# -------------------------------------------------------------------------
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if await check_maintenance(update):
        return

    chat = update.effective_chat
    user = update.effective_user
    db_upsert_user(user.id, user.username or "", user.first_name or "")

    if context.args and len(context.args) > 0:
        arg = context.args[0]
        if arg == "deposit":
            await deposit_command(update, context)
            return
        elif arg == "withdraw":
            await withdraw_command(update, context)
            return
        elif arg.startswith("ref_"):
            try:
                referrer_id = int(arg.replace("ref_", ""))
                if referrer_id != user.id:
                    with get_db() as conn:
                        cursor = conn.cursor()
                        cursor.execute("SELECT referrer_id FROM users WHERE id = ?", (user.id,))
                        row = cursor.fetchone()
                        if row and row["referrer_id"] == 0:
                            cursor.execute("UPDATE users SET referrer_id = ? WHERE id = ?", (referrer_id, user.id))
                            conn.commit()
                            db_update_balance(referrer_id, 5.0)
                            try:
                                await context.bot.send_message(
                                    chat_id=referrer_id,
                                    text=f"🎁 **REFERRAL REWARD!** User @{user.username or user.first_name} joined! **₹5.00** credited.",
                                    parse_mode="Markdown"
                                )
                            except Exception:
                                pass
            except Exception:
                pass

    if chat.type != "private":
        welcome_group = (
            f"✨ **Welcome, @{user.username or user.first_name}!**\n\n"
            f"‼️ **I'm Rolex–casino-bot**\n\n"
            f"This bot works only inside the Official Group. Tap the button below to join and start playing."
        )
        await update.message.reply_text(
            welcome_group,
            reply_markup=InlineKeyboardMarkup(
                [[InlineKeyboardButton("🟢 Join Official Group", url=GROUP_LINK)]]
            ),
            parse_mode="Markdown",
        )
        return

    welcome_dm = (
        f"👑 **WELCOME TO {BOT_NAME.upper()}** 👑\n\n"
        f"The ultimate Telegram gaming platform with instant UPI & Crypto payouts."
    )
    keyboard = [
        [InlineKeyboardButton("🟢 Join Official Group", url=GROUP_LINK)],
        [InlineKeyboardButton("💳 🟢 Deposit Funds", callback_data="menu_deposit"), InlineKeyboardButton("💸 🔴 Withdraw Payout", callback_data="menu_withdraw")],
        [InlineKeyboardButton("💼 🔵 My Wallet", callback_data="menu_wallet"), InlineKeyboardButton("📊 🔵 My Stats", callback_data="menu_mystats")],
        [InlineKeyboardButton("📜 🔵 Command Directory", callback_data="menu_help")]
    ]
    await update.message.reply_text(welcome_dm, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")

async def games_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if await check_maintenance(update):
        return
    games_text = (
        "🤍 **AVAILABLE GAMES**\n\n"
        "👋 *Rock • Paper • Scissors*\n"
        "🤑 Coin Flip (`/coin`)\n"
        "💕 *Dice* (`/dice`)\n"
        "😳 *Darts* (`/darts`)\n"
        "🏀 *Basketball* (`/basket`)\n"
        "⚽️ *Football* (`/football`)\n"
        "6️⃣ *Bowling* (`/bowling`)\n"
        "🎰 *Slots* (`/slots`)\n"
        "🏰 *Towers*\n"
        "🚀 Limbo\n"
        "🎲 Dice rush (`/dr`)\n"
        "🎲 7up (`/7up`)\n"
        "🃏 BlackJack (`/bj`)\n"
        "💣 Mines\n"
        "🔒 Vault\n"
        "🏏 Cricket Dice (`/cdice`)\n\n"
        "Interactive games will be added soon."
    )
    await update.message.reply_text(games_text, parse_mode="Markdown")

async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    help_text = (
        "🎧 **CUSTOMER SUPPORT**\n"
        "Need help? Our support team is here to assist you.\n\n"
        "📩 **For Customer Support:**\n"
        f"Please contact {ADMIN_USERNAMES[2]}\n\n"
        "📝 **Support Format:**\n"
        "Username:\n"
        "User ID:\n"
        "Issue:\n"
        "Transaction ID: (if applicable)\n"
        "Screenshot/Proof: (if applicable)\n\n"
        "⚠️ **Important:**\n"
        "Please provide complete and accurate information so our admins can resolve your issue quickly.\n\n"
        "👑 **Admin Notice:**\n"
        "For admin-related matters, please inform the admins directly."
    )
    keyboard = [[InlineKeyboardButton("🔵 Contact Support", url=GROUP_LINK)]]
    await update.message.reply_text(help_text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")

async def wallet_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if await check_maintenance(update):
        return
    user = update.effective_user
    chat = update.effective_chat
    if chat.type != "private":
        await update.message.reply_text(
            "⚠️ **Private Wallet Operation**\nPlease check your wallet in private DM.",
            reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🟢 Open Wallet in DM", url=f"https://t.me/{BOT_USERNAME.lstrip('@')}?start=deposit")]]),
            parse_mode="Markdown"
        )
        return

    db_upsert_user(user.id, user.username or "", user.first_name or "")
    bal = db_get_balance(user.id)
    addr = db_get_wallet(user.id) or "Not set (use /setwallet)"

    wallet_text = (
        f"🏦 **Your Wallet**\n"
        f"💵 Balance: `₹{bal:.2f}`\n"
        f"👨‍💻 UPI: `{addr}`\n"
        f"⚠️ Promo Lock: `$1/100₹` bonus locked\n"
        f"📈 Wager `$1/100₹` more to unlock withdrawal\n"
        f"(Play wallet bets to clear it)\n"
        f"Min withdrawal: `$1/100₹`"
    )
    keyboard = [
        [InlineKeyboardButton("🟢 Deposit Funds", callback_data="menu_deposit"), InlineKeyboardButton("🔴 Withdraw Payout", callback_data="menu_withdraw")],
        [InlineKeyboardButton("📊 My Stats", callback_data="menu_mystats")]
    ]
    await update.message.reply_text(wallet_text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")

async def setwallet_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    if not context.args:
        await update.message.reply_text("❌ **Usage:** `/setwallet [UPI_ID or Crypto_Address]`", parse_mode="Markdown")
        return
    address = " ".join(context.args).strip()
    db_set_wallet(user.id, address)
    await update.message.reply_text(
        f"👨‍💻 **Saved UPI:**\n`{address}`",
        parse_mode="Markdown"
    )

async def wagerstatus_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    wager = db_get_wager(user.id)
    await update.message.reply_text(f"⚠️ **Wager Status Remaining:** `₹{wager:.2f}` (1× deposit rule)", parse_mode="Markdown")

async def mystats_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    stats = db_get_stats(user.id)
    total = stats["total_played"]
    wins = stats["wins"]
    losses = stats["losses"]
    winrate = (wins / total * 100.0) if total > 0 else 0.0

    text = (
        f"📊 **GAMING STATS**\n\n"
        f"👤 Player: @{user.username or user.first_name}\n"
        f"🎮 Total Matches: `{total}`\n"
        f"🏆 Victories: `{wins}`\n"
        f"💀 Defeats: `{losses}`\n"
        f"📈 Win Rate: `{winrate:.1f}%`"
    )
    await update.message.reply_text(text, parse_mode="Markdown")

async def rank_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT username, first_name, id, balance FROM users ORDER BY balance DESC LIMIT 10")
        rows = cursor.fetchall()

    rank_text = "🏆 **TOP 10 HIGH ROLLERS LEADERBOARD** 🏆\n\n"
    for idx, row in enumerate(rows, 1):
        name = f"@{row['username']}" if row['username'] else row['first_name'] or f"User {row['id']}"
        rank_text += f"{idx}. {name} — **₹{row['balance']:.2f}**\n"
    await update.message.reply_text(rank_text, parse_mode="Markdown")

async def hb_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    if not is_admin(user.id):
        await update.message.reply_text("❌ Admin only command.")
        return

    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) as cnt, SUM(balance) as total_bal FROM users")
        u_stat = cursor.fetchone()

    house_bal_inr = db_get_house_balance()
    house_bal_usd = house_bal_inr / USDT_RATE_INR

    text = (
        f"🏦 **TREASURY VAULT OVERVIEW**\n\n"
        f"👥 Total Users: `{u_stat['cnt'] or 0}`\n"
        f"💰 Total User Balances: `₹{u_stat['total_bal'] or 0.0:.2f}`\n"
        f"🏛️ House Vault Balance: **${house_bal_usd:.2f}** (`₹{house_bal_inr:.2f}`)\n"
        f"bets: **allowed ✔️**"
    )
    await update.message.reply_text(text, parse_mode="Markdown")

async def tip_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if await check_maintenance(update):
        return
    user = update.effective_user
    if not update.message.reply_to_message:
        await update.message.reply_text("❌ **Usage:** Reply to a user with `/tip [amount]`", parse_mode="Markdown")
        return
    if len(context.args) < 1:
        await update.message.reply_text("❌ Specify tip amount.", parse_mode="Markdown")
        return
    try:
        amount = float(context.args[0])
    except ValueError:
        await update.message.reply_text("❌ Invalid numeric amount.", parse_mode="Markdown")
        return

    if amount <= 0:
        await update.message.reply_text("❌ Tip amount must be positive.", parse_mode="Markdown")
        return

    target = update.message.reply_to_message.from_user
    if target.id == user.id:
        await update.message.reply_text("❌ You cannot tip yourself.", parse_mode="Markdown")
        return

    user_bal = db_get_balance(user.id)
    if user_bal < amount:
        await update.message.reply_text("❌ Insufficient balance for tip.", parse_mode="Markdown")
        return

    tip_id = f"tip_{random.randint(1000, 9999)}"
    active_tips[tip_id] = {
        "sender_id": user.id,
        "sender_name": user.username or user.first_name,
        "target_id": target.id,
        "target_name": target.username or target.first_name,
        "amount": amount
    }

    tip_msg = (
        f"🎁 **TIP CONFIRMATION**\n\n"
        f"Amount: ₹{amount:.2f}\n"
        f"From: @{user.username or user.first_name}\n"
        f"To: @{target.username or target.first_name}"
    )
    keyboard = [
        [InlineKeyboardButton("🟢 Confirm Tip", callback_data=f"tip_yes_{tip_id}"), InlineKeyboardButton("🔴 Cancel", callback_data=f"tip_no_{tip_id}")]
    ]
    await update.message.reply_text(tip_msg, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")

async def tip_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    data = query.data
    user = update.effective_user

    parts = data.split("_")
    action = parts[1]
    tip_id = parts[2]

    tip = active_tips.get(tip_id)
    if not tip:
        await query.answer("Tip session expired.", show_alert=True)
        return

    if user.id != tip["sender_id"]:
        await query.answer("Only the tip sender can confirm or cancel.", show_alert=True)
        return

    sender_id = tip["sender_id"]
    target_id = tip["target_id"]
    amount = tip["amount"]

    if action == "yes":
        user_bal = db_get_balance(sender_id)
        if user_bal < amount:
            await query.edit_message_text("❌ Tip failed: Insufficient balance.")
            del active_tips[tip_id]
            return

        db_update_balance(sender_id, -amount)
        db_update_balance(target_id, amount)

        success_text = (
            f"🏆 **Tip Sent!**\n\n"
            f"From » @{tip['sender_name']}\n"
            f"To » @{tip['target_name']}\n"
            f"Amount » ₹{amount:.2f}"
        )
        await query.edit_message_text(success_text, parse_mode="Markdown")

        try:
            target_bal = db_get_balance(target_id)
            await context.bot.send_message(
                chat_id=target_id,
                text=f"🏆 **You received a tip!**\n👤 From: @{tip['sender_name']}\n💵 Amount: ₹{amount:.2f}\n\nBalance: ₹{target_bal:.2f}\nUse /wallet to view your balance.",
                parse_mode="Markdown"
            )
        except Exception:
            pass

        del active_tips[tip_id]
        await send_log(context, f"💸 **TIP:** @{tip['sender_name']} sent ₹{amount:.2f} to @{tip['target_name']}")
    else:
        cancel_text = f"❌ **Tip transaction cancelled & refunded to your account.**\nFrom » @{tip['sender_name']}\nTo » @{tip['target_name']}\nAmount » ₹{amount:.2f}"
        await query.edit_message_text(cancel_text, parse_mode="Markdown")
        del active_tips[tip_id]

async def refer_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    ref_link = f"https://t.me/{BOT_USERNAME.lstrip('@')}?start=ref_{user.id}"
    text = (
        f"🎁 **REFERRAL PROGRAM**\n\n"
        f"Invite friends & earn **₹5** per referral!\n\n"
        f"🔗 `{ref_link}`"
    )
    await update.message.reply_text(text, parse_mode="Markdown")

async def escrow_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if await check_maintenance(update):
        return
    user = update.effective_user
    chat = update.effective_chat

    if chat.type == "private":
        await update.message.reply_text("❌ Escrows must be used in group chats.")
        return

    if not update.message.reply_to_message:
        await update.message.reply_text("❌ Reply to a user with `/escrow [amount]`", parse_mode="Markdown")
        return

    if len(context.args) < 1:
        await update.message.reply_text("❌ Specify amount.", parse_mode="Markdown")
        return

    try:
        amount = float(context.args[0])
    except ValueError:
        await update.message.reply_text("❌ Invalid amount.", parse_mode="Markdown")
        return

    maker = user
    taker = update.message.reply_to_message.from_user
    if maker.id == taker.id:
        await update.message.reply_text("❌ You cannot escrow with yourself.", parse_mode="Markdown")
        return

    if db_get_balance(maker.id) < amount:
        await update.message.reply_text("❌ Insufficient balance for escrow.", parse_mode="Markdown")
        return

    db_update_balance(maker.id, -amount)
    esc_id = f"esc_{random.randint(1000, 9999)}"
    db_save_escrow(esc_id, maker.id, maker.username or maker.first_name, taker.id, taker.username or taker.first_name, amount)

    esc_msg = (
        f"🔐 **ESCROW CREATED** 🔐\n\n"
        f"Escrow ID: `#{esc_id}`\n"
        f"Maker: @{maker.username or maker.first_name}\n"
        f"Taker: @{taker.username or taker.first_name}\n"
        f"Amount: ₹{amount:.2f}"
    )
    keyboard = [
        [InlineKeyboardButton("🟢 Release", callback_data=f"esc_rel_{esc_id}"), InlineKeyboardButton("🔴 Cancel", callback_data=f"esc_can_{esc_id}"), InlineKeyboardButton("❓ Help", callback_data=f"esc_help_{esc_id}")]
    ]
    await update.message.reply_text(esc_msg, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")

async def escrow_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    data = query.data
    user = update.effective_user

    parts = data.split("_")
    action = parts[1]
    esc_id = parts[2]

    escrow = db_get_escrow(esc_id)
    if not escrow or escrow["status"] != "active":
        await query.answer("Escrow inactive.", show_alert=True)
        return

    if action == "help":
        help_txt = (
            "🎧 **CUSTOMER SUPPORT**\nNeed help? Contact @RolexCasinoMOD\n"
            "Format: Username / User ID / Issue / Transaction ID / Proof"
        )
        await query.message.reply_text(help_txt, parse_mode="Markdown")
        return

    if user.id not in [escrow["maker_id"], escrow["taker_id"]] and not is_admin(user.id):
        await query.answer("Unauthorized.", show_alert=True)
        return

    if action == "rel":
        db_update_balance(escrow["taker_id"], escrow["amount"])
        db_update_escrow(esc_id, "released")
        await query.edit_message_text(f"✅ **Escrow #{esc_id} Released!** ₹{escrow['amount']:.2f} credited to @{escrow['taker_name']}", parse_mode="Markdown")
    elif action == "can":
        db_update_balance(escrow["maker_id"], escrow["amount"])
        db_update_escrow(esc_id, "cancelled")
        await query.edit_message_text(f"❌ **Escrow #{esc_id} Cancelled & Refunded!**", parse_mode="Markdown")

# -------------------------------------------------------------------------
# GAMES ENGINE (PVP / PVB / DR / 7UP / COIN / CDICE)
# -------------------------------------------------------------------------
async def pvp_game_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if await check_maintenance(update):
        return

    chat = update.effective_chat
    user = update.effective_user
    cmd = update.message.text.split()[0].replace("/", "").lower()
    if cmd == "basket":
        cmd = "basketball"

    if chat.type == "private":
        await update.message.reply_text("🎮 **Play games inside the official group chat.**", parse_mode="Markdown")
        return

    if len(context.args) < 2:
        await update.message.reply_text(f"❌ **Usage:** `/{cmd} [amount] [rounds]`", parse_mode="Markdown")
        return

    try:
        amount = float(context.args[0])
        rounds = int(context.args[1])
    except ValueError:
        await update.message.reply_text("❌ Invalid arguments.", parse_mode="Markdown")
        return

    if db_get_balance(user.id) < amount:
        await update.message.reply_text("❌ Insufficient balance.", parse_mode="Markdown")
        return

    db_update_balance(user.id, -amount)
    room_id = f"{random.randint(1000, 9999)}"
    emoji = GAME_EMOJIS.get(cmd, "🎲")

    active_pvp_rooms[room_id] = {
        "room_id": room_id,
        "chat_id": chat.id,
        "creator_id": user.id,
        "creator_name": user.username or user.first_name,
        "opponent_id": 0,
        "opponent_name": "",
        "game_type": cmd,
        "expected_emoji": emoji,
        "amount": amount,
        "rounds": rounds,
        "current_round": 1,
        "status": "waiting",
        "creator_score": 0,
        "opponent_score": 0,
    }

    room_text = (
        f"ROOM ID~ #{room_id}\n"
        f"{emoji} {cmd.title()} vs Bot / Player ₹{amount} 🔄 {rounds}Rounds\n\n"
        f"🔄 Rounds: {rounds} — highest total wins\n\n"
        f"👤 @{user.username or user.first_name} — send/copy this emoji now: {emoji}"
    )
    keyboard = [[InlineKeyboardButton("🟢 Accept Room", callback_data=f"pvp_acc_{room_id}")]
    ]
    await update.message.reply_text(room_text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")

async def coin_game_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if await check_maintenance(update):
        return
    chat = update.effective_chat
    user = update.effective_user

    if chat.type == "private":
        await update.message.reply_text("🪙 Play coin in group chat.", parse_mode="Markdown")
        return

    if len(context.args) < 1:
        await update.message.reply_text("❌ **Usage:** `/coin [amount]`", parse_mode="Markdown")
        return

    try:
        amount = float(context.args[0])
    except ValueError:
        await update.message.reply_text("❌ Invalid amount.", parse_mode="Markdown")
        return

    if db_get_balance(user.id) < amount:
        await update.message.reply_text("❌ Insufficient balance.", parse_mode="Markdown")
        return

    db_update_balance(user.id, -amount)
    room_id = f"coin_{random.randint(1000, 9999)}"

    active_pvp_rooms[room_id] = {
        "room_id": room_id,
        "chat_id": chat.id,
        "creator_id": user.id,
        "creator_name": user.username or user.first_name,
        "opponent_id": 0,
        "opponent_name": "",
        "game_type": "coin",
        "amount": amount,
        "status": "waiting_coin",
    }

    msg = await update.message.reply_text(
        f"🪙 **Coin Flip Challenge**\nHost: @{user.username or user.first_name}\nAmount: ₹{amount}\n\nWaiting for opponent...",
        reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🟢 Accept & Pick Side", callback_data=f"coin_acc_{room_id}")]])
    )

async def dr_game_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if await check_maintenance(update):
        return
    user = update.effective_user
    if len(context.args) < 2:
        await update.message.reply_text("❌ **Usage:** `/dr [low/high/odd/even] [amount]`", parse_mode="Markdown")
        return
    side = context.args[0].lower()
    try:
        amount = float(context.args[1])
    except ValueError:
        await update.message.reply_text("❌ Invalid amount.", parse_mode="Markdown")
        return

    if side not in ["low", "high", "odd", "even"]:
        await update.message.reply_text("❌ Select low, high, odd, or even.")
        return

    if db_get_balance(user.id) < amount:
        await update.message.reply_text("❌ Insufficient balance.")
        return

    db_update_balance(user.id, -amount)
    dice_val = random.randint(1, 6)

    won = False
    if side == "low" and dice_val in [1, 2, 3]:
        won = True
    elif side == "high" and dice_val in [4, 5, 6]:
        won = True
    elif side == "odd" and dice_val in [1, 3, 5]:
        won = True
    elif side == "even" and dice_val in [2, 4, 6]:
        won = True

    if won:
        payout = amount * 1.92
        db_update_balance(user.id, payout)
        db_reduce_wager(user.id, amount)
        db_update_stats(user.id, True)
        await update.message.reply_text(f"🏆 Dice Rush Result: {dice_val} ({side.upper()})\n🎉 **You Won!** ₹{payout:.2f} credited.", parse_mode="Markdown")
    else:
        db_add_house_balance(amount * 0.8)
        db_update_stats(user.id, False)
        await update.message.reply_text(f"📉 Dice Rush Result: {dice_val} ({side.upper()})\n❌ **Bot wins.** ₹{amount} lost.", parse_mode="Markdown")

async def up7_game_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if await check_maintenance(update):
        return
    user = update.effective_user
    if len(context.args) < 2:
        await update.message.reply_text("❌ **Usage:** `/7up [up/down] [amount]`", parse_mode="Markdown")
        return
    choice = context.args[0].lower()
    try:
        amount = float(context.args[1])
    except ValueError:
        await update.message.reply_text("❌ Invalid amount.")
        return

    if db_get_balance(user.id) < amount:
        await update.message.reply_text("❌ Insufficient balance.")
        return

    db_update_balance(user.id, -amount)
    d1 = random.randint(1, 6)
    d2 = random.randint(1, 6)
    total = d1 + d2

    result_type = "up" if total >= 7 else "down"
    won = (choice == result_type)

    if won:
        payout = amount * 1.92
        db_update_balance(user.id, payout)
        db_reduce_wager(user.id, amount)
        db_update_stats(user.id, True)
        await update.message.reply_text(f"🎲 Rolled: {d1} + {d2} = {total} ({result_type.upper()})\n🏆 **You Won!** ₹{payout:.2f} credited.", parse_mode="Markdown")
    else:
        db_add_house_balance(amount * 0.8)
        db_update_stats(user.id, False)
        await update.message.reply_text(f"🎲 Rolled: {d1} + {d2} = {total} ({result_type.upper()})\n❌ **You Lost!** ₹{amount} lost.", parse_mode="Markdown")

async def cdice_game_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if await check_maintenance(update):
        return
    chat = update.effective_chat
    user = update.effective_user
    if chat.type == "private":
        await update.message.reply_text("🏟️ Cricket dice works in group chat.")
        return

    if not context.args:
        await update.message.reply_text("❌ **Usage:** `/odice [amount]`", parse_mode="Markdown")
        return

    try:
        amount = float(context.args[0])
    except ValueError:
        await update.message.reply_text("❌ Invalid amount.")
        return

    if db_get_balance(user.id) < amount:
        await update.message.reply_text("❌ Insufficient balance.")
        return

    db_update_balance(user.id, -amount)
    odice_text = (
        "🏟️ **Open Match — /odice**\n\n"
        f"Command » `/odice {amount}`\n"
        "Overs » 1 – 20 (default 2)\n"
        "Players » 2 – 50\n"
        "Fee » 3.00% of the pot\n\n"
        "Tap Join Match below!"
    )
    await update.message.reply_text(odice_text, reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🟢 Join Match", callback_data="odice_join")]]), parse_mode="Markdown")

async def pvp_callback_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    data = query.data
    user = update.effective_user

    parts = data.split("_")
    action = parts[1]
    room_id = parts[2]

    room = active_pvp_rooms.get(room_id)
    if not room:
        await query.answer("Room expired.", show_alert=True)
        return

    if action == "acc":
        if user.id == room["creator_id"]:
            await query.answer("Cannot accept your own room.", show_alert=True)
            return

        if db_get_balance(user.id) < room["amount"]:
            await query.answer("Insufficient balance.", show_alert=True)
            return

        db_update_balance(user.id, -room["amount"])
        room["opponent_id"] = user.id
        room["opponent_name"] = user.username or user.first_name
        room["status"] = "rolling"

        await query.edit_message_text(
            f"⚔️ **Match Started!**\n@{room['creator_name']} vs @{room['opponent_name']}\n\n👉 @{room['creator_name']}, SEND: {room['expected_emoji']} 1/{room['rounds']}",
            parse_mode="Markdown"
        )

async def coin_callback_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    data = query.data
    user = update.effective_user
    parts = data.split("_")
    room_id = parts[2]
    room = active_pvp_rooms.get(room_id)

    if not room:
        await query.answer("Room expired.", show_alert=True)
        return

    if db_get_balance(user.id) < room["amount"]:
        await query.answer("Insufficient balance.", show_alert=True)
        return

    db_update_balance(user.id, -room["amount"])
    room["opponent_id"] = user.id
    room["opponent_name"] = user.username or user.first_name

    await query.edit_message_text("🪙 Coin in the air..... 3 seconds remaining...", parse_mode="Markdown")
    await asyncio.sleep(1.0)
    await query.edit_message_text("🪙 2...", parse_mode="Markdown")
    await asyncio.sleep(1.0)
    await query.edit_message_text("🪙 1...", parse_mode="Markdown")
    await asyncio.sleep(1.0)

    result = random.choice(["Heads", "Tails"])
    winner_id = random.choice([room["creator_id"], room["opponent_id"]])
    winner_name = room["creator_name"] if winner_id == room["creator_id"] else room["opponent_name"]
    loser_name = room["opponent_name"] if winner_id == room["creator_id"] else room["creator_name"]
    payout = room["amount"] * 1.92

    db_update_balance(winner_id, payout)
    db_update_stats(room["creator_id"], won=(winner_id == room["creator_id"]))
    db_update_stats(room["opponent_id"], won=(winner_id == room["opponent_id"]))

    res_text = (
        f"🪙 Coin Flip #{room_id} — Result!\n\n"
        f"Coin landed on... **{result}**\n\n"
        f"👑 Winner: @{winner_name}\n"
        f"👻 Loser: @{loser_name}\n"
        f"🏦 Prize: ₹{payout:.2f} Credited to Wallet\n"
        f"✅ Credited to wallet."
    )
    await query.message.reply_text(res_text, parse_mode="Markdown")
    del active_pvp_rooms[room_id]

# -------------------------------------------------------------------------
# MESSAGE HANDLER & EMOJI DETECTOR
# -------------------------------------------------------------------------
async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if await check_maintenance(update):
        return

    chat = update.effective_chat
    user = update.effective_user
    if not update.message or not user:
        return

    if chat.type in ["group", "supergroup"]:
        for rid, rm in list(active_pvp_rooms.items()):
            if rm.get("chat_id") == chat.id and rm.get("status") == "rolling":
                expected_emoji = rm["expected_emoji"]
                if update.message.dice:
                    actual_emoji = update.message.dice.emoji
                    score = update.message.dice.value

                    if actual_emoji != expected_emoji:
                        await update.message.reply_text(f"❌ Wrong emoni detected! Send required emoji again: {expected_emoji}")
                        return

                    if user.id == rm["creator_id"]:
                        rm["creator_score"] += score
                        await update.message.reply_text(f"🏆 Round {rm['current_round']}: @{rm['creator_name']} ✅ ({rm['creator_score']})")
                        rm["current_round"] += 1
                        if rm["current_round"] > rm["rounds"]:
                            # End game
                            winner_name = rm["creator_name"] if rm["creator_score"] > rm["opponent_score"] else rm["opponent_name"]
                            payout = rm["amount"] * 1.92
                            await update.message.reply_text(f"🏆 **{winner_name} wins!**\n₹{payout:.2f} credited.", parse_mode="Markdown")
                            del active_pvp_rooms[rid]
                        return

    if chat.type == "private":
        step = context.user_data.get("step")
        text = update.message.text.strip() if update.message.text else ""

        if step == "awaiting_amount":
            try:
                amt = float(text)
            except ValueError:
                await update.message.reply_text("❌ Enter a valid number:")
                return
            context.user_data["dep_amount"] = amt
            keyboard = [
                [InlineKeyboardButton("UPI (INR)", callback_data="dep_UPI")],
                [InlineKeyboardButton("BSC(BEP20)", callback_data="dep_BSC"), InlineKeyboardButton("SOLANA", callback_data="dep_SOLANA")],
                [InlineKeyboardButton("ETHEREUM", callback_data="dep_ETHEREUM")]
            ]
            await update.message.reply_text(f"⬇️ Deposit ₹{amt}\n\nChoose your payment method:", reply_markup=InlineKeyboardMarkup(keyboard))
            return

        elif step == "awaiting_txid":
            if not text.isdigit() or len(text) != 12:
                await update.message.reply_text("❌ Send 12-digit UTR number only:")
                return
            context.user_data["txid"] = text
            context.user_data["step"] = "awaiting_screenshot"
            await update.message.reply_text(f"✅ UTR saved: {text}\n\n⬇️ **Step 2/2 — Payment Screenshot**\nNow send the screenshot of your payment.")
            return

        elif step == "awaiting_screenshot" and update.message.photo:
            method = context.user_data.get("dep_method", "UPI")
            txid = context.user_data.get("txid")
            amount = context.user_data.get("dep_amount", 50.0)
            photo_file_id = update.message.photo[-1].file_id

            dep_id = f"dep_{user.id}_{int(asyncio.get_event_loop().time())}"
            db_save_deposit(dep_id, user.id, user.username or user.first_name, method, txid, amount, photo_file_id)

            admin_alert = (
                f"📥 **NEW DEPOSIT**\nUser: @{user.username or user.first_name}\nAmount: ₹{amount}\nUTR: `{txid}`"
            )
            admin_buttons = [[InlineKeyboardButton("🟢 Approve", callback_data=f"app_yes_{dep_id}"), InlineKeyboardButton("🔴 Reject", callback_data=f"app_no_{dep_id})")]]
            for adm in ADMIN_IDS:
                try:
                    await context.bot.send_photo(chat_id=adm, photo=photo_file_id, caption=admin_alert, reply_markup=InlineKeyboardMarkup(admin_buttons), parse_mode="Markdown")
                except Exception:
                    pass

            context.user_data.clear()
            await update.message.reply_text(
                f"✅ **Deposit proof submitted!**\n\n💵 Amount: ₹{amount}\n📍 UTR: {txid}\n\n⌛ Deposit will be credited automatically. It may take 3-5 minutes.",
                parse_mode="Markdown"
            )
            await send_log(context, f"📥 **DEPOSIT SUBMITTED:** User @{user.username or user.first_name} submitted ₹{amount}")
            return

# -------------------------------------------------------------------------
# DEPOSIT & WITHDRAW
# -------------------------------------------------------------------------
async def deposit_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if await check_maintenance(update):
        return
    chat = update.effective_chat
    if chat.type != "private":
        await update.message.reply_text(
            "⬇️ **Deposit**",
            reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🟢 Open Deposit in DM", url=f"https://t.me/{BOT_USERNAME.lstrip('@')}?start=deposit")]]),
            parse_mode="Markdown"
        )
        return

    context.user_data["step"] = "awaiting_amount"
    await update.message.reply_text(
        "⬇️ **Deposit**\n\nHow much do you want to deposit?\nMin: ₹50. Type 5 for USDT or ₹500 for INR.",
        parse_mode="Markdown"
    )

async def withdraw_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if await check_maintenance(update):
        return
    chat = update.effective_chat
    if chat.type != "private":
        await update.message.reply_text("Please withdraw in DM.", reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🟢 Open DM", url=f"https://t.me/{BOT_USERNAME.lstrip('@')}?start=withdraw")]]))
        return

    user = update.effective_user
    bal = db_get_balance(user.id)
    if bal < 100:
        await update.message.reply_text("❌ Minimum withdrawal is ₹100.")
        return

    addr = db_get_wallet(user.id)
    if not addr:
        await update.message.reply_text("❌ Set your wallet first using `/setwallet [address]`", parse_mode="Markdown")
        return

    db_update_balance(user.id, -bal)
    await update.message.reply_text(f"✅ Withdrawal request for ₹{bal:.2f} submitted successfully to `{addr}`.", parse_mode="Markdown")

# -------------------------------------------------------------------------
# ADMIN CALLBACKS
# -------------------------------------------------------------------------
async def admin_approval_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    data = query.data
    parts = data.split("_")
    action = parts[1]
    req_id = "_".join(parts[2:])

    if data.startswith("app_"):
        dep = db_get_deposit(req_id)
        if not dep:
            return
        target_user = dep["user_id"]
        amount = dep["amount"]

        if action == "yes":
            db_update_deposit(req_id, "approved", query.from_user.id)
            db_update_balance(target_user, amount)
            new_bal = db_get_balance(target_user)

            success_msg = (
                f"🏆 Deposit Approved!\n\n"
                f"💵 Credited: ₹{amount:.2f}\n"
                f"🏦 Balance: ₹{new_bal:.2f}\n\n"
                f"⚠️ Wager ₹{amount:.2f} before withdrawing (1× deposit rule)"
            )
            try:
                await context.bot.send_message(chat_id=target_user, text=success_msg)
            except Exception:
                pass
            await query.edit_message_caption(caption=f"{query.message.caption}\n\n✅ Approved")
        else:
            db_update_deposit(req_id, "rejected", query.from_user.id)
            try:
                await context.bot.send_message(chat_id=target_user, text="❌ Deposit rejected.")
            except Exception:
                pass
            await query.edit_message_caption(caption=f"{query.message.caption}\n\n❌ Rejected")

async def deposit_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    data = query.data

    if data.startswith("dep_"):
        method = data.replace("dep_", "")
        context.user_data["dep_method"] = method
        amt = context.user_data.get("dep_amount", 50)
        pay_msg = (
            f"⬇️ Deposit — {method}\n\n"
            f"Amount: ₹{amt}\n"
            f"Address / ID:\n`{UPI_ADDRESS}`\n\n"
            "After paying, press ✅ I've Paid."
        )
        await query.message.reply_text(pay_msg, reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("I have paid ✔️", callback_data="dep_paid")]]))
    elif data == "dep_paid":
        context.user_data["step"] = "awaiting_txid"
        await query.message.reply_text("⬇️ Step 1/2 — UTR Number\n\nSend your UTR / Transaction ID\n(12-digit number from your UPI app)")

# -------------------------------------------------------------------------
# MAIN
# -------------------------------------------------------------------------
def main():
    application = Application.builder().token(TOKEN).build()

    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("games", games_command))
    application.add_handler(CommandHandler("help", help_command))
    application.add_handler(CommandHandler("support", help_command))
    application.add_handler(CommandHandler("wallet", wallet_command))
    application.add_handler(CommandHandler("bal", wallet_command))
    application.add_handler(CommandHandler("wal", wallet_command))
    application.add_handler(CommandHandler("deposit", deposit_command))
    application.add_handler(CommandHandler("withdraw", withdraw_command))
    application.add_handler(CommandHandler("setwallet", setwallet_command))
    application.add_handler(CommandHandler("wagerstatus", wagerstatus_command))
    application.add_handler(CommandHandler("mystats", mystats_command))
    application.add_handler(CommandHandler("rank", rank_command))
    application.add_handler(CommandHandler("hb", hb_command))
    application.add_handler(CommandHandler("tip", tip_command))
    application.add_handler(CommandHandler("refer", refer_command))
    application.add_handler(CommandHandler("escrow", escrow_command))

    application.add_handler(CommandHandler("dice", pvp_game_command))
    application.add_handler(CommandHandler("darts", pvp_game_command))
    application.add_handler(CommandHandler("bowling", pvp_game_command))
    application.add_handler(CommandHandler("basket", pvp_game_command))
    application.add_handler(CommandHandler("football", pvp_game_command))
    application.add_handler(CommandHandler("slots", pvp_game_command))
    application.add_handler(CommandHandler("coin", coin_game_command))
    application.add_handler(CommandHandler("dr", dr_game_command))
    application.add_handler(CommandHandler("7up", up7_game_command))
    application.add_handler(CommandHandler("odice", cdice_game_command))

    application.add_handler(CallbackQueryHandler(tip_callback, pattern="^tip_"))
    application.add_handler(CallbackQueryHandler(escrow_callback, pattern="^esc_"))
    application.add_handler(CallbackQueryHandler(pvp_callback_handler, pattern="^pvp_"))
    application.add_handler(CallbackQueryHandler(coin_callback_handler, pattern="^coin_"))
    application.add_handler(CallbackQueryHandler(deposit_callback, pattern="^dep_"))
    application.add_handler(CallbackQueryHandler(admin_approval_callback, pattern="^app_"))

    application.add_handler(MessageHandler(filters.ALL & ~filters.COMMAND, handle_message))

    print(f"🚀 {BOT_NAME} ({BOT_USERNAME}) running successfully.")
    application.run_polling()

if __name__ == "__main__":
    main()
