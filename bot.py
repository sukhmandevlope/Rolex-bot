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

# Load environment variables from .env file if available
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# -------------------------------------------------------------------------
# LOGGING SETUP
# -------------------------------------------------------------------------
logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s", level=logging.INFO
)
logger = logging.getLogger(__name__)

# -------------------------------------------------------------------------
# CONFIGURATIONS & CREDENTIALS
# -------------------------------------------------------------------------
TOKEN = os.getenv("BOT_TOKEN", "8785635298:AAGCGT3Df8VKrCH5fbClvSRySRQSugAZa0E")
BOT_NAME = os.getenv("BOT_NAME", "Rolex Casino BOT")
BOT_USERNAME = os.getenv("BOT_USERNAME", "@Rolex_Casino_BOT")
GROUP_LINK = os.getenv("GROUP_LINK", "https://t.me/RolexCasinos")
GROUP_ID = int(os.getenv("GROUP_ID", "-1004458883943"))
LOGS_CHANNEL_ID = int(os.getenv("LOGS_CHANNEL_ID", "-1004458883943"))

# Admin configurations
DEFAULT_ADMIN_IDS = [8860529495, 1053006219]
admin_ids_env = os.getenv("ADMIN_IDS")
if admin_ids_env:
    ADMIN_IDS = [int(i.strip()) for i in admin_ids_env.split(",") if i.strip().isdigit()]
else:
    ADMIN_IDS = DEFAULT_ADMIN_IDS

ADMIN_USERNAMES = ["@Lucifer_1209", "@luffy_rolex", "@RolexCasinoMod"]
OWNER_USERNAME = "@Lucifer_1209"

# Deposit Addresses & Wallets
UPI_ADDRESS = os.getenv("UPI_ADDRESS", "rutvik1209@fam")
CRYPTO_WALLETS = {
    "USDT (BEP20)": os.getenv("USDT_WALLET", "0xD8419224A65C3d35C10AE695562463c8445ACb15"),
    "SOLANA": os.getenv("SOLANA_WALLET", "3bKsCSR2mmconFaExejbkuGfeQNuVQPFttzj9y2MP2mE"),
    "ETHEREUM": os.getenv("ETH_WALLET", "0xD8419224A65C3d35C10AE695562463c8445ACb15"),
    "BITCOIN": os.getenv("BTC_WALLET", "bc1qsm7xzn4k8kpxwurzjsredangepvzgh70y0ypzd"),
}

# Supported PvP Game to Emoji mapping
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
# DATABASE ENGINE (SQLITE3 PERSISTENT STORAGE: rolex_casino.db)
# -------------------------------------------------------------------------
DB_FILE = os.getenv("DATABASE_PATH", "rolex_casino.db")

def get_db():
    conn = sqlite3.connect(DB_FILE, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with get_db() as conn:
        cursor = conn.cursor()
        # Users Table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY,
                username TEXT,
                first_name TEXT,
                balance REAL DEFAULT 0.0,
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
        # Deposits Table
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
        # Withdrawals Table
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
        # Escrows Table
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
        # PvP Rooms Table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS pvp_rooms (
                id TEXT PRIMARY KEY,
                chat_id INTEGER,
                creator_id INTEGER,
                creator_name TEXT,
                opponent_id INTEGER DEFAULT 0,
                opponent_name TEXT DEFAULT '',
                game_type TEXT,
                amount REAL,
                status TEXT DEFAULT 'waiting',
                creator_score INTEGER DEFAULT 0,
                opponent_score INTEGER DEFAULT 0,
                current_turn INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        # System Settings Table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS system_settings (
                key TEXT PRIMARY KEY,
                value TEXT
            )
        """)
        # Ensure default settings
        cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('maintenance_mode', '0')")
        conn.commit()
    logger.info("Persistent SQLite database initialized successfully: %s", DB_FILE)

# Initialize DB on load
init_db()

# DB Helper Functions
def db_upsert_user(user_id: int, username: str, first_name: str) -> dict:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM users WHERE id = ?", (user_id,))
        row = cursor.fetchone()
        if not row:
            cursor.execute(
                "INSERT INTO users (id, username, first_name, balance, wager_req) VALUES (?, ?, ?, 0.0, 0.0)",
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

def db_get_wager(user_id: int) -> float:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT wager_req FROM users WHERE id = ?", (user_id,))
        row = cursor.fetchone()
        return float(row["wager_req"]) if row else 0.0

def db_add_wager(user_id: int, amount: float):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("UPDATE users SET wager_req = wager_req + ? WHERE id = ?", (amount, user_id))
        conn.commit()

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

# In-memory active PVP rooms dictionary for high-frequency game interactions, backed up to DB
active_pvp_rooms: Dict[str, Dict[str, Any]] = {}

# -------------------------------------------------------------------------
# HELPER UTILITIES & AUTH
# -------------------------------------------------------------------------
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
                    "🛠️ **Rolex Casino is currently under maintenance!**\n\n"
                    "All chat commands, games, and systems are currently locked.\n"
                    "Please wait until an administrator restarts the service.",
                    parse_mode="Markdown",
                )
            elif update.callback_query:
                await update.callback_query.answer("🛠️ Bot is under maintenance. All actions locked.", show_alert=True)
            return True
    return False

async def send_log(context: ContextTypes.DEFAULT_TYPE, text: str):
    try:
        await context.bot.send_message(chat_id=LOGS_CHANNEL_ID, text=text, parse_mode="Markdown")
    except Exception as e:
        logger.warning(f"Could not forward log to logs channel: {e}")

# -------------------------------------------------------------------------
# START & WELCOME COMMAND (WITH COLOR BUTTONS)
# -------------------------------------------------------------------------
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if await check_maintenance(update):
        return

    chat = update.effective_chat
    user = update.effective_user
    db_upsert_user(user.id, user.username or "", user.first_name or "")

    # Handle parameter routing (e.g. /start deposit or /start withdraw or referral)
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
                                    text=f"🎁 **Referral Reward!** User @{user.username or user.first_name} joined using your link! ₹5.00 credited to your balance.",
                                    parse_mode="Markdown"
                                )
                            except Exception:
                                pass
            except Exception as e:
                logger.warning(f"Referral parsing error: {e}")

    # Group message: redirect to DM
    if chat.type != "private":
        await update.message.reply_text(
            f"👋 **Welcome to {BOT_NAME}!**\n\n"
            f"Please open our bot in DM inbox to access your wallet, deposits, and account settings.",
            reply_markup=InlineKeyboardMarkup(
                [
                    [InlineKeyboardButton("🟢 Open Bot Inbox (DM)", url=f"https://t.me/{BOT_USERNAME.lstrip('@')}")],
                    [InlineKeyboardButton("🔵 Official Group", url=GROUP_LINK)]
                ]
            ),
            parse_mode="Markdown",
        )
        return

    # Private DM Welcome
    welcome_text = (
        f"👑 **WELCOME TO {BOT_NAME.upper()}** 👑\n\n"
        f"The most elite Telegram gaming experience with 100% fair PvP duels & lightning fast payouts.\n\n"
        f"💎 **Platform Multiplier:** 1.92× Win Rate on all PvP Arenas\n"
        f"⚡ **Instant Deposits:** UPI (INR ₹70-₹5000) & Multi-Chain Crypto ($1-$50)\n"
        f"🛡️ **Provably Fair:** Real Telegram animated emoji dice detection\n\n"
        f"👉 Join our official group to play against live players!"
    )
    keyboard = [
        [
            InlineKeyboardButton("🟢 Join Official Group", url=GROUP_LINK),
        ],
        [
            InlineKeyboardButton("💳 🟢 Deposit Funds", callback_data="menu_deposit"),
            InlineKeyboardButton("💸 🔴 Withdraw Payout", callback_data="menu_withdraw"),
        ],
        [
            InlineKeyboardButton("💼 🔵 My Wallet", callback_data="menu_wallet"),
            InlineKeyboardButton("📊 🔵 My Stats", callback_data="menu_mystats"),
        ],
        [
            InlineKeyboardButton("🆘 🔵 24/7 Support Desk", url=GROUP_LINK),
            InlineKeyboardButton("📜 🔵 Command Directory", callback_data="menu_help"),
        ]
    ]
    await update.message.reply_text(welcome_text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")

# -------------------------------------------------------------------------
# DIRECTORY, HELP & SUPPORT
# -------------------------------------------------------------------------
async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if await check_maintenance(update):
        return
    help_text = (
        f"📜 **{BOT_NAME.upper()} COMMAND DIRECTORY** 📜\n\n"
        "🎮 **PvP Arena Games (Group Chat Only):**\n"
        "• `/dice [amount]` - 🎲 Duel using real Telegram Dice\n"
        "• `/darts [amount]` - 🎯 Duel using real Telegram Darts\n"
        "• `/bowling [amount]` - 🎳 Duel using real Telegram Bowling\n"
        "• `/basket [amount]` - 🏀 Duel using real Telegram Basketball\n"
        "• `/football [amount]` - ⚽ Duel using real Telegram Football\n"
        "• `/slots [amount]` - 🎰 Duel using real Telegram Slots 777\n"
        "• `/coin [amount]` - 🪙 Interactive PvP Coin Flip duel\n\n"
        "💼 **Wallet & Finance (DM Inbox Only):**\n"
        "• `/wallet` - View balance, wager rules, and wallet\n"
        "• `/deposit` - Deposit via UPI (₹70-₹5000) or Crypto ($1-$50)\n"
        "• `/withdraw` - Request instant withdrawal to UPI / Crypto\n"
        "• `/setwallet [address]` - Set your default payout address\n"
        "• `/wagerstatus` - Check remaining 1× deposit wagering progress\n\n"
        "🤝 **Escrow & Community:**\n"
        "• `/escrow [amount]` (reply user in group) - Create secure trade escrow\n"
        "• `/tip [amount]` (reply user) - Send instant tips to friends\n"
        "• `/refer` - Generate your personal invite reward link\n"
        "• `/rank` - View top high-roller players on leaderboard\n\n"
        "🛡️ **Admin Commands (Authorized Staff Only):**\n"
        "• `/panel` - Master admin control dashboard\n"
        "• `/maintenance` - Lock all operations for maintenance\n"
        "• `/restart` - Restore bot and lift maintenance lock\n"
        "• `/cancel [room_id]` - Force cancel any PvP duel room"
    )
    await update.message.reply_text(help_text, parse_mode="Markdown")

async def support_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    support_text = (
        f"🆘 **{BOT_NAME.upper()} OFFICIAL SUPPORT** 🆘\n\n"
        "For deposit queries, payment verification, and player assistance:\n\n"
        f"• Official Telegram Group: {GROUP_LINK}\n"
        f"• Official Owner: {OWNER_USERNAME}\n"
        f"• Designated Mods: {', '.join(ADMIN_USERNAMES)}"
    )
    keyboard = [[InlineKeyboardButton("🔵 Open Official Group", url=GROUP_LINK)]]
    await update.message.reply_text(support_text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")

# -------------------------------------------------------------------------
# WALLET, BALANCES, STATS, RANK, TIP
# -------------------------------------------------------------------------
async def wallet_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if await check_maintenance(update):
        return
    user = update.effective_user
    chat = update.effective_chat

    if chat.type != "private":
        await update.message.reply_text(
            "⚠️ **Private Wallet Operation**\n\n"
            "Your balance and wallet information can only be viewed in private DM for security.",
            reply_markup=InlineKeyboardMarkup(
                [
                    [InlineKeyboardButton("🟢 Open Wallet in DM", url=f"https://t.me/{BOT_USERNAME.lstrip('@')}?start=deposit")],
                    [InlineKeyboardButton("🔵 Official Group", url=GROUP_LINK)]
                ]
            ),
            parse_mode="Markdown"
        )
        return

    db_upsert_user(user.id, user.username or "", user.first_name or "")
    bal = db_get_balance(user.id)
    wager = db_get_wager(user.id)
    addr = db_get_wallet(user.id) or "Not set (use /setwallet)"

    wallet_text = (
        f"💼 **ROLEX CASINO SECURE VAULT** 💼\n\n"
        f"👤 **Account Holder:** @{user.username or user.first_name}\n"
        f"🆔 **Telegram ID:** `{user.id}`\n\n"
        f"💰 **Available Balance:** `₹{bal:.2f}`\n"
        f"⚠️ **Active Wager Remaining:** `₹{wager:.2f}` (1× deposit rule)\n"
        f"📍 **Payout Address:** `{addr}`\n\n"
        f"Select an operation below:"
    )
    keyboard = [
        [
            InlineKeyboardButton("🟢 Deposit Funds", callback_data="menu_deposit"),
            InlineKeyboardButton("🔴 Request Withdrawal", callback_data="menu_withdraw"),
        ],
        [
            InlineKeyboardButton("📊 View Gaming Stats", callback_data="menu_mystats"),
            InlineKeyboardButton("🔵 Go to Group", url=GROUP_LINK),
        ]
    ]
    await update.message.reply_text(wallet_text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")

async def setwallet_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if await check_maintenance(update):
        return
    user = update.effective_user
    if not context.args:
        await update.message.reply_text("❌ **Usage:** `/setwallet [UPI_ID or Crypto_Address]`", parse_mode="Markdown")
        return
    address = " ".join(context.args).strip()
    db_set_wallet(user.id, address)
    await update.message.reply_text(f"✅ **Payout Address Saved:** `{address}`", parse_mode="Markdown")

async def wagerstatus_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if await check_maintenance(update):
        return
    user = update.effective_user
    wager = db_get_wager(user.id)
    if wager <= 0.0:
        await update.message.reply_text("✅ **No active wagering requirements!** You can withdraw your balance anytime.")
    else:
        await update.message.reply_text(
            f"⚠️ **Active Wagering Requirement:** `₹{wager:.2f}` remaining.\n"
            f"Play PvP games in the group to fulfill your 1× deposit wagering requirement!",
            parse_mode="Markdown"
        )

async def mystats_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if await check_maintenance(update):
        return
    user = update.effective_user
    stats = db_get_stats(user.id)
    total = stats["total_played"]
    wins = stats["wins"]
    losses = stats["losses"]
    winrate = (wins / total * 100.0) if total > 0 else 0.0

    text = (
        f"📊 **ROLEX CASINO GAMING STATS** 📊\n\n"
        f"👤 **Player:** @{user.username or user.first_name}\n"
        f"🎮 **Total Matches:** `{total}`\n"
        f"🏆 **Victories:** `{wins}`\n"
        f"💀 **Defeats:** `{losses}`\n"
        f"📈 **Win Rate:** `{winrate:.1f}%`\n"
        f"💰 **Current Balance:** `₹{stats['balance']:.2f}`"
    )
    await update.message.reply_text(text, parse_mode="Markdown")

async def rank_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if await check_maintenance(update):
        return
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT username, first_name, id, balance FROM users ORDER BY balance DESC LIMIT 10")
        rows = cursor.fetchall()

    rank_text = "🏆 **TOP 10 HIGH ROLLERS LEADERBOARD** 🏆\n\n"
    if not rows:
        rank_text += "No records found yet."
    else:
        for idx, row in enumerate(rows, 1):
            name = f"@{row['username']}" if row['username'] else row['first_name'] or f"User {row['id']}"
            rank_text += f"{idx}. {name} — **₹{row['balance']:.2f}**\n"
    await update.message.reply_text(rank_text, parse_mode="Markdown")

async def tip_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if await check_maintenance(update):
        return
    user = update.effective_user
    if not update.message.reply_to_message:
        await update.message.reply_text("❌ **Usage:** Reply to a user with `/tip [amount]`", parse_mode="Markdown")
        return
    if len(context.args) < 1:
        await update.message.reply_text("❌ Please specify the tip amount. E.g. `/tip 50`", parse_mode="Markdown")
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
        await update.message.reply_text("❌ Insufficient balance to send tip.", parse_mode="Markdown")
        return

    db_update_balance(user.id, -amount)
    db_update_balance(target.id, amount)

    await update.message.reply_text(
        f"🎁 **Tip Sent Successfully!**\n\n"
        f"@{user.username or user.first_name} sent **₹{amount:.2f}** to @{target.username or target.first_name}!",
        parse_mode="Markdown"
    )
    await send_log(context, f"💸 **TIP:** @{user.username or user.first_name} tipped ₹{amount:.2f} to @{target.username or target.first_name}")

async def refer_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if await check_maintenance(update):
        return
    user = update.effective_user
    ref_link = f"https://t.me/{BOT_USERNAME.lstrip('@')}?start=ref_{user.id}"
    text = (
        f"🎁 **ROLEX CASINO AFFILIATE PROGRAM** 🎁\n\n"
        f"Invite friends and earn **₹5.00** credited directly to your balance for every active referral!\n\n"
        f"🔗 **Your Unique Referral Link:**\n`{ref_link}`\n\n"
        f"Share this link with your friends or groups!"
    )
    await update.message.reply_text(text, parse_mode="Markdown")

# -------------------------------------------------------------------------
# MAINTENANCE & RESTART SYSTEM
# -------------------------------------------------------------------------
async def maintenance_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    if not is_admin(user.id):
        await update.message.reply_text("❌ Unauthorized. Admin only command.")
        return

    db_set_setting("maintenance_mode", "1")
    notice = (
        "⚠️ **SYSTEM MAINTENANCE ACTIVATED** ⚠️\n\n"
        "Rolex Casino has entered maintenance mode.\n"
        "• All chat commands, games, deposits, and withdrawals are locked.\n"
        "• All database records, user balances, and states are securely saved.\n"
        "• Use `/restart` to lift maintenance and resume operations."
    )
    await update.message.reply_text(notice, parse_mode="Markdown")
    try:
        await context.bot.send_message(chat_id=GROUP_ID, text="🛠️ **Rolex Casino is currently under maintenance! All games and commands are temporarily locked.**", parse_mode="Markdown")
    except Exception:
        pass
    await send_log(context, f"🛠️ **MAINTENANCE ACTIVATED** by Admin @{user.username or user.first_name} (`{user.id}`)")

async def restart_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    if not is_admin(user.id):
        await update.message.reply_text("❌ Unauthorized. Admin only command.")
        return

    db_set_setting("maintenance_mode", "0")
    notice = (
        "🟢 **ROLEX CASINO IS BACK ONLINE!** 🟢\n\n"
        "Maintenance mode has been lifted.\n"
        "All database records are restored, PvP arenas are open, and wallet services are active."
    )
    await update.message.reply_text(notice, parse_mode="Markdown")
    try:
        await context.bot.send_message(chat_id=GROUP_ID, text="🟢 **Rolex Casino is BACK ONLINE! All games and features are now fully functional!**", parse_mode="Markdown")
    except Exception:
        pass
    await send_log(context, f"🟢 **MAINTENANCE DEACTIVATED / RESTORED** by Admin @{user.username or user.first_name} (`{user.id}`)")

async def admin_panel_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    if not is_admin(user.id):
        await update.message.reply_text("❌ Unauthorized access. Admin panel is restricted to authorized mods and owner.")
        return

    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) as cnt, SUM(balance) as total_bal FROM users")
        u_stat = cursor.fetchone()
        cursor.execute("SELECT COUNT(*) as cnt FROM deposits WHERE status = 'pending'")
        dep_stat = cursor.fetchone()
        cursor.execute("SELECT COUNT(*) as cnt FROM escrows WHERE status = 'active'")
        esc_stat = cursor.fetchone()

    is_maint = is_maintenance_active()
    panel_text = (
        f"🛡️ **ROLEX CASINO MASTER CONTROL PANEL** 🛡️\n\n"
        f"👤 **Admin:** @{user.username or user.first_name} (ID: `{user.id}`)\n"
        f"⚙️ **Maintenance Status:** {'🔒 ACTIVE (LOCKED)' if is_maint else '🟢 INACTIVE (ONLINE)'}\n\n"
        f"👥 **Total Registered Users:** `{u_stat['cnt'] or 0}`\n"
        f"🏦 **Total Platform Balances:** `₹{u_stat['total_bal'] or 0.0:.2f}`\n"
        f"📥 **Pending Deposits:** `{dep_stat['cnt'] or 0}`\n"
        f"🔒 **Active Escrows:** `{esc_stat['cnt'] or 0}`\n"
        f"⚔️ **Active PvP Rooms:** `{len(active_pvp_rooms)}`\n\n"
        f"Quick Action Controls:"
    )
    keyboard = [
        [
            InlineKeyboardButton("⚙️ Toggle Maintenance", callback_data="admin_toggle_maint"),
            InlineKeyboardButton("🔄 Refresh Panel", callback_data="admin_refresh_panel"),
        ],
        [
            InlineKeyboardButton("📥 View Pending Deposits", callback_data="admin_view_deposits"),
            InlineKeyboardButton("🔒 View Active Escrows", callback_data="admin_view_escrows"),
        ]
    ]
    await update.message.reply_text(panel_text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")

async def cancel_room_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    if not is_admin(user.id):
        await update.message.reply_text("❌ Unauthorized. Admin only command.")
        return
    if not context.args:
        await update.message.reply_text("❌ **Usage:** `/cancel [room_id]`", parse_mode="Markdown")
        return

    room_id = context.args[0].replace("#", "")
    room = active_pvp_rooms.get(room_id)
    if not room:
        await update.message.reply_text(f"❌ Room `#{room_id}` not found or already closed.")
        return

    # Refund creator and opponent if applicable
    db_update_balance(room["creator_id"], room["amount"])
    if room.get("opponent_id") and room["opponent_id"] != 0:
        db_update_balance(room["opponent_id"], room["amount"])

    del active_pvp_rooms[room_id]
    await update.message.reply_text(f"✅ **Room `#{room_id}` cancelled and refunded by Admin.**")
    await send_log(context, f"🛑 **ROOM CANCELLED BY ADMIN:** `#{room_id}` refunded by @{user.username or user.first_name}")

# -------------------------------------------------------------------------
# STRICT DEPOSIT SYSTEM (DM ONLY, VERIFIED UTR & SCREENSHOT, ADMIN APPROVAL)
# -------------------------------------------------------------------------
async def deposit_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if await check_maintenance(update):
        return

    chat = update.effective_chat
    user = update.effective_user

    # STRICT CHECK: Reject if executed in group
    if chat.type != "private":
        await update.message.reply_text(
            "⚠️ **Private Wallet Operation**\n\n"
            "Deposits can only be processed securely inside our bot's DM inbox to protect your transaction details.",
            reply_markup=InlineKeyboardMarkup(
                [
                    [InlineKeyboardButton("🟢 Deposit in DM Inbox", url=f"https://t.me/{BOT_USERNAME.lstrip('@')}?start=deposit")],
                    [InlineKeyboardButton("🔴 Withdraw in DM Inbox", url=f"https://t.me/{BOT_USERNAME.lstrip('@')}?start=withdraw")],
                    [InlineKeyboardButton("🔵 Official Group", url=GROUP_LINK)]
                ]
            ),
            parse_mode="Markdown"
        )
        return

    text = (
        "💳 **SELECT DEPOSIT GATEWAY** 💳\n\n"
        "Select your preferred funding method below:\n"
        "• **UPI (INR):** Min ₹70.00 — Max ₹5,000.00\n"
        "• **Crypto:** Min $1.00 — Max $50.00\n\n"
        "Click a payment method to proceed:"
    )
    keyboard = [
        [InlineKeyboardButton("🟢 UPI (INR ₹)", callback_data="dep_upi")],
        [InlineKeyboardButton("🪙 USDT (BEP20)", callback_data="dep_USDT (BEP20)")],
        [InlineKeyboardButton("🟣 Solana (SOL)", callback_data="dep_SOLANA")],
        [InlineKeyboardButton("🔷 Ethereum (ETH)", callback_data="dep_ETHEREUM")],
        [InlineKeyboardButton("🟠 Bitcoin (BTC)", callback_data="dep_BITCOIN")],
    ]
    await update.message.reply_text(text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")

async def withdraw_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if await check_maintenance(update):
        return
    user = update.effective_user
    chat = update.effective_chat

    # STRICT CHECK: Reject if executed in group
    if chat.type != "private":
        await update.message.reply_text(
            "⚠️ **Private Wallet Operation**\n\n"
            "Withdrawal requests must be initiated inside the bot DM inbox.",
            reply_markup=InlineKeyboardMarkup(
                [
                    [InlineKeyboardButton("🔴 Open DM Withdrawals", url=f"https://t.me/{BOT_USERNAME.lstrip('@')}?start=withdraw")],
                    [InlineKeyboardButton("🟢 Deposit", url=f"https://t.me/{BOT_USERNAME.lstrip('@')}?start=deposit")]
                ]
            ),
            parse_mode="Markdown"
        )
        return

    wager = db_get_wager(user.id)
    if wager > 0:
        await update.message.reply_text(
            f"❌ **Withdrawal Locked by Wagering Requirement:**\n\n"
            f"You have an active wagering requirement of **₹{wager:.2f}** remaining (1× deposit rule).\n"
            f"Play PvP games in the group chat to clear your wager requirement before requesting a payout!",
            parse_mode="Markdown"
        )
        return

    bal = db_get_balance(user.id)
    if bal < 50.0:
        await update.message.reply_text(f"❌ **Minimum withdrawal is ₹50.00.** Your balance: ₹{bal:.2f}")
        return

    addr = db_get_wallet(user.id)
    if not addr:
        await update.message.reply_text(
            "❌ **No payout address found!**\n\n"
            "Please configure your default UPI ID or Crypto address first using:\n`/setwallet [your_address]`",
            parse_mode="Markdown"
        )
        return

    # Lock withdrawal amount
    db_update_balance(user.id, -bal)
    wd_id = f"wd_{user.id}_{int(asyncio.get_event_loop().time())}"

    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO withdrawals (id, user_id, username, amount, address, status) VALUES (?, ?, ?, ?, ?, 'pending')",
            (wd_id, user.id, user.username or user.first_name, bal, addr)
        )
        conn.commit()

    admin_msg = (
        f"💸 **NEW WITHDRAWAL REQUEST!**\n\n"
        f"👤 User: @{user.username or user.first_name} (`{user.id}`)\n"
        f"💰 Amount: `₹{bal:.2f}`\n"
        f"📍 Payout Address: `{addr}`\n"
        f"🔖 Request ID: `#{wd_id}`"
    )
    keyboard = [
        [
            InlineKeyboardButton("🟢 Mark Paid", callback_data=f"wd_yes_{wd_id}"),
            InlineKeyboardButton("🔴 Reject / Refund", callback_data=f"wd_no_{wd_id}")
        ]
    ]
    for adm in ADMIN_IDS:
        try:
            await context.bot.send_message(chat_id=adm, text=admin_msg, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")
        except Exception as e:
            logger.warning(f"Could not forward withdrawal to admin {adm}: {e}")

    await update.message.reply_text(
        f"✅ **Withdrawal request for ₹{bal:.2f} submitted successfully!**\n"
        f"Our admin cashier team will review and process your payment shortly.",
        parse_mode="Markdown"
    )
    await send_log(context, f"💸 **WITHDRAWAL SUBMITTED:** User @{user.username or user.first_name} requested ₹{bal:.2f} to `{addr}`")

# -------------------------------------------------------------------------
# ESCROW SYSTEM (GROUP CHAT ONLY)
# -------------------------------------------------------------------------
async def escrow_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if await check_maintenance(update):
        return
    user = update.effective_user
    chat = update.effective_chat

    if chat.type == "private":
        await update.message.reply_text("❌ Escrows must be established inside the official group chat.")
        return

    if not update.message.reply_to_message:
        await update.message.reply_text("❌ **Usage:** Reply to your trade partner with `/escrow [amount]`", parse_mode="Markdown")
        return

    if len(context.args) < 1:
        await update.message.reply_text("❌ Please specify escrow amount. E.g. `/escrow 500`", parse_mode="Markdown")
        return

    try:
        amount = float(context.args[0])
    except ValueError:
        await update.message.reply_text("❌ Invalid numeric amount.", parse_mode="Markdown")
        return

    if amount <= 0:
        await update.message.reply_text("❌ Escrow amount must be positive.", parse_mode="Markdown")
        return

    maker = user
    taker = update.message.reply_to_message.from_user
    if maker.id == taker.id:
        await update.message.reply_text("❌ You cannot create an escrow with yourself.", parse_mode="Markdown")
        return

    maker_bal = db_get_balance(maker.id)
    if maker_bal < amount:
        await update.message.reply_text("❌ Insufficient balance to lock escrow amount. Deposit funds in DM first.", parse_mode="Markdown")
        return

    db_update_balance(maker.id, -amount)
    escrow_id = f"esc_{random.randint(10000, 99999)}"
    db_save_escrow(escrow_id, maker.id, maker.username or maker.first_name, taker.id, taker.username or taker.first_name, amount)

    escrow_text = (
        f"🔐 **ROLEX SECURE TRADE ESCROW** 🔐\n\n"
        f"📌 **Escrow ID:** `#{escrow_id}`\n"
        f"👤 **Maker (Payer):** @{maker.username or maker.first_name} (`{maker.id}`)\n"
        f"👤 **Taker (Recipient):** @{taker.username or taker.first_name} (`{taker.id}`)\n"
        f"💰 **Locked Amount:** `₹{amount:.2f}`\n\n"
        f"⚠️ Funds are locked securely in the Rolex Escrow Vault until released or refunded."
    )
    keyboard = [
        [
            InlineKeyboardButton("🟢 Release to Taker", callback_data=f"esc_rel_{escrow_id}"),
            InlineKeyboardButton("🔴 Refund to Maker", callback_data=f"esc_can_{escrow_id}"),
        ],
        [InlineKeyboardButton("🔵 Group Support", url=GROUP_LINK)]
    ]
    await update.message.reply_text(escrow_text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")
    await send_log(context, f"🔐 **ESCROW CREATED:** `#{escrow_id}` | Maker: @{maker.username or maker.first_name} | Amount: ₹{amount:.2f}")

async def escrow_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    data = query.data
    user = update.effective_user

    parts = data.split("_")
    if len(parts) < 3:
        return
    action = parts[1]
    escrow_id = parts[2]

    escrow = db_get_escrow(escrow_id)
    if not escrow or escrow["status"] != "active":
        await query.answer("Escrow is no longer active or already completed!", show_alert=True)
        return

    maker_id = escrow["maker_id"]
    taker_id = escrow["taker_id"]
    amount = escrow["amount"]

    if user.id not in [maker_id, taker_id] and not is_admin(user.id):
        await query.answer("Only trade participants or bot admins can resolve this escrow.", show_alert=True)
        return

    if action == "rel":
        db_update_balance(taker_id, amount)
        db_update_escrow(escrow_id, "released")
        text = (
            f"✅ **ESCROW RELEASED!**\n\n"
            f"📌 **Escrow ID:** `#{escrow_id}`\n"
            f"🏆 **Credited to:** @{escrow['taker_name']}\n"
            f"💰 **Amount:** `₹{amount:.2f}`"
        )
        await query.edit_message_text(text, parse_mode="Markdown")
        await send_log(context, f"✅ **ESCROW RELEASED:** `#{escrow_id}` released ₹{amount:.2f} to @{escrow['taker_name']}")
    elif action == "can":
        db_update_balance(maker_id, amount)
        db_update_escrow(escrow_id, "cancelled")
        text = (
            f"❌ **ESCROW CANCELLED & REFUNDED!**\n\n"
            f"📌 **Escrow ID:** `#{escrow_id}`\n"
            f"💰 **Refunded to Maker:** @{escrow['maker_name']} (`₹{amount:.2f}`)"
        )
        await query.edit_message_text(text, parse_mode="Markdown")
        await send_log(context, f"❌ **ESCROW CANCELLED:** `#{escrow_id}` refunded ₹{amount:.2f} to @{escrow['maker_name']}")

# -------------------------------------------------------------------------
# 100% PVP GAMES ENGINE & REAL TELEGRAM DICE / EMOJI DETECTION
# -------------------------------------------------------------------------
async def pvp_game_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if await check_maintenance(update):
        return

    chat = update.effective_chat
    user = update.effective_user
    cmd = update.message.text.split()[0].replace("/", "").lower()
    if cmd == "basket":
        cmd = "basketball"

    # STRICT CHECK: Only in group!
    if chat.type == "private":
        await update.message.reply_text(
            "🎮 **PvP multiplayer games can only be played inside the official group chat!**",
            reply_markup=InlineKeyboardMarkup(
                [
                    [InlineKeyboardButton("🟢 Go To Official Group", url=GROUP_LINK)],
                    [InlineKeyboardButton("🔴 Deposit in DM", url=f"https://t.me/{BOT_USERNAME.lstrip('@')}?start=deposit")]
                ]
            ),
            parse_mode="Markdown"
        )
        return

    if len(context.args) < 1:
        await update.message.reply_text(f"❌ **Usage:** `/{cmd} [amount]` (Min ₹10.00)", parse_mode="Markdown")
        return

    try:
        amount = float(context.args[0])
    except ValueError:
        await update.message.reply_text("❌ Invalid amount specified.", parse_mode="Markdown")
        return

    if amount < 10.0:
        await update.message.reply_text("❌ Minimum PvP stake is ₹10.00.", parse_mode="Markdown")
        return

    user_bal = db_get_balance(user.id)
    if user_bal < amount:
        await update.message.reply_text(
            f"❌ **Insufficient balance to create room.** Your balance: ₹{user_bal:.2f}",
            reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🟢 Deposit in DM", url=f"https://t.me/{BOT_USERNAME.lstrip('@')}?start=deposit")]]),
            parse_mode="Markdown"
        )
        return

    # Deduct stake from creator
    db_update_balance(user.id, -amount)
    room_id = f"pvp_{random.randint(1000, 9999)}"
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
        "status": "waiting",
        "creator_score": 0,
        "opponent_score": 0,
        "current_turn": 0,
    }

    win_payout = amount * 1.92
    room_text = (
        f"🎮 **ROLEX PVP {cmd.upper()} ARENA** {emoji}\n\n"
        f"👤 **Host:** @{user.username or user.first_name}\n"
        f"💰 **Staked Amount:** `₹{amount:.2f}`\n"
        f"✨ **Potential Payout (1.92x):** `₹{win_payout:.2f}`\n"
        f"📌 **Room ID:** `#{room_id}`\n\n"
        f"Click **Accept Duel** below to match this room!"
    )
    keyboard = [
        [
            InlineKeyboardButton("🟢 Accept Duel", callback_data=f"pvp_acc_{room_id}"),
            InlineKeyboardButton("🔴 Decline / Abort", callback_data=f"pvp_dec_{room_id}")
        ],
        [InlineKeyboardButton("🔵 Group Support", url=GROUP_LINK)]
    ]
    await update.message.reply_text(room_text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")
    await send_log(context, f"🎮 **PVP ROOM CREATED:** `#{room_id}` | Game: {cmd} | Host: @{user.username or user.first_name} | Amount: ₹{amount:.2f}")

async def coin_game_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if await check_maintenance(update):
        return

    chat = update.effective_chat
    user = update.effective_user

    if chat.type == "private":
        await update.message.reply_text(
            "🪙 **Coin flip duel must be played inside the official group chat.**",
            reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🟢 Open Group", url=GROUP_LINK)]]),
            parse_mode="Markdown"
        )
        return

    if len(context.args) < 1:
        await update.message.reply_text("❌ **Usage:** `/coin [amount]`", parse_mode="Markdown")
        return

    try:
        amount = float(context.args[0])
    except ValueError:
        await update.message.reply_text("❌ Invalid amount format.", parse_mode="Markdown")
        return

    if amount < 10.0:
        await update.message.reply_text("❌ Minimum coin stake is ₹10.00.", parse_mode="Markdown")
        return

    user_bal = db_get_balance(user.id)
    if user_bal < amount:
        await update.message.reply_text(
            f"❌ **Insufficient balance.** Your balance: ₹{user_bal:.2f}",
            reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🟢 Deposit in DM", url=f"https://t.me/{BOT_USERNAME.lstrip('@')}?start=deposit")]]),
            parse_mode="Markdown"
        )
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
        "expected_emoji": "🪙",
        "amount": amount,
        "status": "waiting",
    }

    win_payout = amount * 1.92
    coin_text = (
        f"🪙 **ROLEX PVP COIN FLIP DUEL** 🪙\n\n"
        f"👤 **Host:** @{user.username or user.first_name}\n"
        f"💰 **Staked Amount:** `₹{amount:.2f}`\n"
        f"✨ **Potential Payout (1.92x):** `₹{win_payout:.2f}`\n"
        f"📌 **Room ID:** `#{room_id}`\n\n"
        f"Click **Accept Coin** to match and flip the coin!"
    )
    keyboard = [
        [
            InlineKeyboardButton("🟢 Accept Coin", callback_data=f"pvp_acc_{room_id}"),
            InlineKeyboardButton("🔴 Decline / Abort", callback_data=f"pvp_dec_{room_id}")
        ]
    ]
    await update.message.reply_text(coin_text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")

async def pvp_callback_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    data = query.data
    user = update.effective_user

    parts = data.split("_")
    if len(parts) < 3:
        return
    action = parts[1]
    room_id = parts[2]

    room = active_pvp_rooms.get(room_id)
    if not room or room["status"] != "waiting":
        await query.answer("This room is no longer active, completed, or cancelled!", show_alert=True)
        return

    creator_id = room["creator_id"]
    amount = room["amount"]
    game_type = room["game_type"]
    emoji = room.get("expected_emoji", "🎲")

    if action == "dec":
        if user.id != creator_id and not is_admin(user.id):
            await query.answer("Only the room creator or admin can decline this duel.", show_alert=True)
            return
        db_update_balance(creator_id, amount)
        del active_pvp_rooms[room_id]
        await query.edit_message_text(f"❌ **Room #{room_id} cancelled.** Stake of ₹{amount:.2f} refunded to creator.")
        return

    if action == "acc":
        if user.id == creator_id:
            await query.answer("You cannot accept your own room duel!", show_alert=True)
            return

        taker_bal = db_get_balance(user.id)
        if taker_bal < amount:
            await query.answer(f"Insufficient balance! You need ₹{amount:.2f} to accept this duel.", show_alert=True)
            return

        db_update_balance(user.id, -amount)
        room["opponent_id"] = user.id
        room["opponent_name"] = user.username or user.first_name
        creator_name = room["creator_name"]
        taker_name = room["opponent_name"]

        if game_type == "coin":
            # Coin Flip Animation & Resolution
            await query.edit_message_text("🪙 **Coin Flip Accepted! Tossing the coin into the air...** 🔄", parse_mode="Markdown")
            await asyncio.sleep(2.0)

            winner_id = random.choice([creator_id, user.id])
            winner_name = creator_name if winner_id == creator_id else taker_name
            win_payout = amount * 1.92

            db_update_balance(winner_id, win_payout)
            db_reduce_wager(creator_id, amount)
            db_reduce_wager(user.id, amount)
            db_update_stats(creator_id, won=(winner_id == creator_id))
            db_update_stats(user.id, won=(winner_id == user.id))

            # PROFESSIONAL WIN MESSAGE
            win_text = (
                f"🏆 ══════════════════════ 🏆\n"
                f"👑 ROLEX CASINO PVP WINNER 👑\n"
                f"🏆 ══════════════════════ 🏆\n\n"
                f"🎮 Game Arena: Coin Flip 🪙\n"
                f"👤 Winner: @{winner_name}\n"
                f"💰 Staked Amount: ₹{amount:.2f}\n"
                f"⚡ Multiplier: 1.92×\n"
                f"💎 Payout Credited: ₹{win_payout:.2f}\n"
                f"📌 Room ID: #{room_id}\n\n"
                f"🔥 Congratulations! Payout credited instantly to your Rolex Vault."
            )
            await query.message.reply_text(win_text, parse_mode="Markdown")
            del active_pvp_rooms[room_id]
            await send_log(context, f"🪙 **COIN DUEL FINISHED:** Winner @{winner_name} won ₹{win_payout:.2f}")

        else:
            # Emoji Dice Game: Set status to rolling and await players sending the real Telegram dice!
            room["status"] = "rolling"
            room["current_turn"] = creator_id  # Host rolls first
            room["creator_score"] = 0
            room["opponent_score"] = 0

            match_text = (
                f"⚔️ **DUEL STARTED!** ⚔️\n\n"
                f"🎮 **Game Arena:** {game_type.title()} {emoji}\n"
                f"💰 **Staked Amount:** `₹{amount:.2f}` each\n"
                f"✨ **Win Payout (1.92x):** `₹{amount * 1.92:.2f}`\n\n"
                f"👤 **Host:** @{creator_name}\n"
                f"👤 **Challenger:** @{taker_name}\n\n"
                f"👉 @{creator_name}, send your official {emoji} animated dice now!\n"
                f"*(⚠️ Bot will automatically decline any other emoji or text)*"
            )
            await query.edit_message_text(match_text, parse_mode="Markdown")

# -------------------------------------------------------------------------
# REAL TELEGRAM EMOJI DICE DETECTOR & DEPOSIT PROOF MESSAGE HANDLER
# -------------------------------------------------------------------------
async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if await check_maintenance(update):
        return

    chat = update.effective_chat
    user = update.effective_user
    if not update.message or not user:
        return

    # 1. GROUP CHAT: CHECK FOR ACTIVE PVP ROOM DICE ROLLS
    if chat.type in ["group", "supergroup"]:
        # Find if this user is the active turn player in any active room in this chat
        matched_room_id = None
        matched_room = None
        for rid, rm in active_pvp_rooms.items():
            if rm.get("chat_id") == chat.id and rm.get("status") == "rolling":
                if rm.get("current_turn") == user.id:
                    matched_room_id = rid
                    matched_room = rm
                    break

        if matched_room:
            expected_emoji = matched_room["expected_emoji"]
            game_type = matched_room["game_type"]
            amount = matched_room["amount"]
            creator_id = matched_room["creator_id"]
            opponent_id = matched_room["opponent_id"]
            creator_name = matched_room["creator_name"]
            opponent_name = matched_room["opponent_name"]

            # If user sent a real Telegram dice
            if update.message.dice:
                actual_emoji = update.message.dice.emoji
                score = update.message.dice.value

                # DECLINE WRONG EMOJI
                if actual_emoji != expected_emoji:
                    await update.message.reply_text(
                        f"❌ **Invalid Emoji Detected!**\n\n"
                        f"This arena is configured for {expected_emoji}. Your {actual_emoji} roll was declined!\n"
                        f"👉 Please send the official {expected_emoji} animated dice sticker.",
                        parse_mode="Markdown"
                    )
                    return

                # Record score for the current player
                if user.id == creator_id:
                    matched_room["creator_score"] = score
                    matched_room["current_turn"] = opponent_id
                    await update.message.reply_text(
                        f"{expected_emoji} @{creator_name} rolled a **{score}**!\n\n"
                        f"👉 Now @{opponent_name}, it's your turn! Send your official {expected_emoji} animated dice!",
                        parse_mode="Markdown"
                    )
                    return
                elif user.id == opponent_id:
                    matched_room["opponent_score"] = score
                    host_score = matched_room["creator_score"]
                    challenger_score = score

                    # Check for TIE
                    if host_score == challenger_score:
                        matched_room["creator_score"] = 0
                        matched_room["opponent_score"] = 0
                        matched_room["current_turn"] = creator_id
                        await update.message.reply_text(
                            f"🔄 **IT'S A TIE!** Both players rolled **{host_score}**!\n\n"
                            f"👉 Re-rolling arena! @{creator_name}, roll your {expected_emoji} again!",
                            parse_mode="Markdown"
                        )
                        return

                    # We have a winner!
                    if host_score > challenger_score:
                        winner_id = creator_id
                        winner_name = creator_name
                    else:
                        winner_id = opponent_id
                        winner_name = opponent_name

                    win_payout = amount * 1.92
                    db_update_balance(winner_id, win_payout)
                    db_reduce_wager(creator_id, amount)
                    db_reduce_wager(opponent_id, amount)
                    db_update_stats(creator_id, won=(winner_id == creator_id))
                    db_update_stats(opponent_id, won=(winner_id == opponent_id))

                    # PROFESSIONAL WIN MESSAGE AS REQUESTED
                    win_text = (
                        f"🏆 ══════════════════════ 🏆\n"
                        f"👑 ROLEX CASINO PVP WINNER 👑\n"
                        f"🏆 ══════════════════════ 🏆\n\n"
                        f"🎮 Game Arena: {game_type.title()} {expected_emoji}\n"
                        f"👤 Winner: @{winner_name}\n"
                        f"💰 Staked Amount: ₹{amount:.2f}\n"
                        f"⚡ Multiplier: 1.92×\n"
                        f"💎 Payout Credited: ₹{win_payout:.2f}\n"
                        f"📌 Room ID: #{matched_room_id}\n\n"
                        f"🔥 Congratulations! Payout credited instantly to your Rolex Vault."
                    )
                    await update.message.reply_text(win_text, parse_mode="Markdown")
                    del active_pvp_rooms[matched_room_id]
                    await send_log(context, f"🎮 **PVP {game_type.upper()} FINISHED:** Winner @{winner_name} won ₹{win_payout:.2f}")
                    return

            else:
                # User sent text or something other than Telegram dice
                await update.message.reply_text(
                    f"❌ **Invalid Move!** Please send the official Telegram animated {expected_emoji} dice sticker, not plain text.",
                    parse_mode="Markdown"
                )
                return

    # 2. PRIVATE DM: DEPOSIT WORKFLOW (AMOUNT, UTR/HASH, SCREENSHOT)
    if chat.type == "private":
        step = context.user_data.get("step")
        text = update.message.text.strip() if update.message.text else ""

        # Step 1: User enters deposit amount
        if step == "awaiting_amount":
            method = context.user_data.get("dep_method", "upi")
            try:
                amt = float(text)
            except ValueError:
                await update.message.reply_text("❌ Please enter a valid numeric amount:")
                return

            if method == "upi":
                if amt < 70.0 or amt > 5000.0:
                    await update.message.reply_text("❌ **UPI Limit:** Min ₹70.00 — Max ₹5,000.00. Please enter a valid amount:")
                    return
            else:
                if amt < 1.0 or amt > 50.0:
                    await update.message.reply_text("❌ **Crypto Limit:** Min $1.00 — Max $50.00. Please enter a valid amount:")
                    return

            context.user_data["dep_amount"] = amt

            if method == "upi":
                details_msg = (
                    f"🇮🇳 **UPI DEPOSIT PAYMENT**\n\n"
                    f"💰 Amount to Pay: **₹{amt:.2f}**\n"
                    f"📍 UPI ID: `{UPI_ADDRESS}`\n\n"
                    f"1. Open your UPI app (GPay, PhonePe, Paytm, FamPay).\n"
                    f"2. Pay exactly **₹{amt:.2f}** to `{UPI_ADDRESS}`.\n"
                    f"3. Click **I've Paid** below once completed."
                )
            else:
                wallet = CRYPTO_WALLETS.get(method, "N/A")
                details_msg = (
                    f"🪙 **{method} DEPOSIT PAYMENT**\n\n"
                    f"💰 Amount to Pay: **${amt:.2f}**\n"
                    f"📍 Wallet Address:\n`{wallet}`\n\n"
                    f"1. Transfer exact funds from your wallet/exchange.\n"
                    f"2. Click **I've Paid** below once transferred."
                )

            keyboard = [[InlineKeyboardButton("🟢 I've Paid", callback_data="dep_paid")]]
            await update.message.reply_text(details_msg, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")
            return

        # Step 2: User enters UTR or Transaction Hash
        elif step == "awaiting_txid":
            method = context.user_data.get("dep_method", "upi")
            if method == "upi":
                # Strict 12-digit numeric validation
                if not text.isdigit() or len(text) != 12:
                    await update.message.reply_text(
                        "❌ **Invalid UTR Number!**\n\n"
                        "The UPI UTR must contain **exactly 12 numeric digits** (no letters or spaces).\n"
                        "Please check your bank/UPI transaction receipt and enter your 12-digit UTR again:"
                    )
                    return
            else:
                # Strict 64-66 alphanumeric validation
                if not (64 <= len(text) <= 66) or not text.isalnum():
                    await update.message.reply_text(
                        "❌ **Invalid Transaction Hash!**\n\n"
                        "Crypto Transaction ID / Hash must be between **64 and 66 alphanumeric characters**.\n"
                        "Please re-enter your transaction hash:"
                    )
                    return

            context.user_data["txid"] = text
            context.user_data["step"] = "awaiting_screenshot"
            await update.message.reply_text(
                "📸 **Now please upload the payment screenshot proof:**\n\n"
                "Send the photo/image from your banking or wallet app showing the completed transaction."
            )
            return

        # Step 3: User uploads screenshot photo
        elif step == "awaiting_screenshot" and update.message.photo:
            method = context.user_data.get("dep_method", "upi")
            txid = context.user_data.get("txid")
            amount = context.user_data.get("dep_amount", 50.0)
            photo_file_id = update.message.photo[-1].file_id

            dep_id = f"dep_{user.id}_{int(asyncio.get_event_loop().time())}"
            db_save_deposit(dep_id, user.id, user.username or user.first_name, method, txid, amount, photo_file_id)

            admin_alert = (
                f"📥 **NEW DEPOSIT APPROVAL REQUEST** 📥\n\n"
                f"👤 **User:** @{user.username or user.first_name} (`{user.id}`)\n"
                f"💳 **Gateway:** {method}\n"
                f"💰 **Amount:** `₹{amount:.2f}`\n"
                f"🔖 **UTR / Hash:** `{txid}`\n"
                f"📌 **Deposit ID:** `#{dep_id}`\n\n"
                f"Review the attached payment proof screenshot below:"
            )
            admin_buttons = [
                [
                    InlineKeyboardButton("🟢 Approve Deposit", callback_data=f"app_yes_{dep_id}"),
                    InlineKeyboardButton("🔴 Reject Deposit", callback_data=f"app_no_{dep_id}")
                ]
            ]
            for adm in ADMIN_IDS:
                try:
                    await context.bot.send_photo(
                        chat_id=adm,
                        photo=photo_file_id,
                        caption=admin_alert,
                        reply_markup=InlineKeyboardMarkup(admin_buttons),
                        parse_mode="Markdown"
                    )
                except Exception as e:
                    logger.warning(f"Could not forward deposit proof to admin {adm}: {e}")

            context.user_data.clear()
            await update.message.reply_text(
                f"⏳ **Deposit Submitted!**\n\n"
                f"Your deposit request `#{dep_id}` for **₹{amount:.2f}** has been recorded.\n"
                f"Our admin cashier desk is reviewing your payment. You will receive an automated notification once approved.",
                parse_mode="Markdown"
            )
            await send_log(context, f"📥 **DEPOSIT SUBMITTED:** User @{user.username or user.first_name} submitted ₹{amount:.2f} ({method}) UTR: `{txid}`")
            return

# -------------------------------------------------------------------------
# CALLBACK DISPATCHER (MENUS, DEPOSITS, ADMIN APPROVALS)
# -------------------------------------------------------------------------
async def deposit_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    data = query.data

    if data == "menu_deposit":
        await deposit_command(update, context)
        return
    elif data == "menu_withdraw":
        await withdraw_command(update, context)
        return
    elif data == "menu_wallet":
        await wallet_command(update, context)
        return
    elif data == "menu_mystats":
        await mystats_command(update, context)
        return
    elif data == "menu_help":
        await help_command(update, context)
        return
    elif data == "admin_toggle_maint":
        user = update.effective_user
        if not is_admin(user.id):
            await query.answer("Admin only!", show_alert=True)
            return
        curr = is_maintenance_active()
        new_val = "0" if curr else "1"
        db_set_setting("maintenance_mode", new_val)
        status_text = "🔒 ACTIVE (LOCKED)" if new_val == "1" else "🟢 INACTIVE (ONLINE)"
        await query.answer(f"Maintenance mode set to: {status_text}", show_alert=True)
        await admin_panel_command(update, context)
        return
    elif data == "admin_refresh_panel":
        await admin_panel_command(update, context)
        return

    # Method selected
    if data.startswith("dep_") and data != "dep_paid":
        method = data.replace("dep_", "")
        context.user_data["dep_method"] = method
        context.user_data["step"] = "awaiting_amount"

        if method == "upi":
            prompt = (
                "🇮🇳 **UPI Deposit Selected**\n\n"
                "Please enter your desired deposit amount in INR (₹):\n"
                "• **Minimum:** ₹70.00\n"
                "• **Maximum:** ₹5,000.00\n\n"
                "👉 Type the amount now (e.g. `100` or `500`):"
            )
        else:
            prompt = (
                f"🪙 **{method} Deposit Selected**\n\n"
                "Please enter your deposit amount in USD ($):\n"
                "• **Minimum:** $1.00\n"
                "• **Maximum:** $50.00\n\n"
                "👉 Type the amount now (e.g. `10` or `25`):"
            )
        await query.message.reply_text(prompt, parse_mode="Markdown")

    elif data == "dep_paid":
        method = context.user_data.get("dep_method", "upi")
        context.user_data["step"] = "awaiting_txid"
        if method == "upi":
            await query.message.reply_text(
                "🔢 **Please enter your 12-digit numeric UPI UTR number:**\n\n"
                "(Found in your payment details/receipt under UTR / UPI Ref ID):",
                parse_mode="Markdown"
            )
        else:
            await query.message.reply_text(
                "📝 **Please enter your Crypto Transaction ID / Hash (64-66 characters):**",
                parse_mode="Markdown"
            )

async def admin_approval_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    data = query.data
    user = update.effective_user

    if not is_admin(user.id):
        await query.answer("Unauthorized!", show_alert=True)
        return

    parts = data.split("_")
    action = parts[1]  # yes or no
    req_id = "_".join(parts[2:])

    if data.startswith("app_"):
        dep = db_get_deposit(req_id)
        if not dep or dep["status"] != "pending":
            await query.edit_message_caption("⚠️ Deposit request is no longer pending or already processed.")
            return

        target_user = dep["user_id"]
        amount = dep["amount"]

        if action == "yes":
            db_update_deposit(req_id, "approved", user.id)
            db_update_balance(target_user, amount)
            db_add_wager(target_user, amount)
            new_bal = db_get_balance(target_user)

            # EXACT APPROVED FORMAT AS REQUIRED BY USER
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

            await query.edit_message_caption(f"{query.message.caption}\n\n✅ **APPROVED by Admin @{user.username or user.first_name}**", parse_mode="Markdown")
            await send_log(context, f"✅ **DEPOSIT APPROVED:** Credited ₹{amount:.2f} to user ID `{target_user}` by @{user.username or user.first_name}")

        else:
            db_update_deposit(req_id, "rejected", user.id)
            try:
                await context.bot.send_message(
                    chat_id=target_user,
                    text=f"❌ **Deposit Rejected!**\n\nYour deposit request `#{req_id}` was declined by admin. If you believe this is an error, contact @RolexCasinoMod."
                )
            except Exception:
                pass

            await query.edit_message_caption(f"{query.message.caption}\n\n❌ **REJECTED by Admin @{user.username or user.first_name}**", parse_mode="Markdown")
            await send_log(context, f"❌ **DEPOSIT REJECTED:** `#{req_id}` by @{user.username or user.first_name}")

    elif data.startswith("wd_"):
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM withdrawals WHERE id = ?", (req_id,))
            wd = cursor.fetchone()

        if not wd or wd["status"] != "pending":
            await query.edit_message_text("⚠️ Withdrawal request already completed or refunded.")
            return

        target_user = wd["user_id"]
        amount = wd["amount"]

        if action == "yes":
            with get_db() as conn:
                cursor = conn.cursor()
                cursor.execute("UPDATE withdrawals SET status = 'paid', processed_by = ? WHERE id = ?", (user.id, req_id))
                conn.commit()
            try:
                await context.bot.send_message(
                    chat_id=target_user,
                    text=f"🟢 **Withdrawal Completed!**\n\nYour payout of **₹{amount:.2f}** has been sent to your address `{wd['address']}`!",
                    parse_mode="Markdown"
                )
            except Exception:
                pass
            await query.edit_message_text(f"{query.message.text}\n\n✅ **PAID & COMPLETED by Admin @{user.username or user.first_name}**", parse_mode="Markdown")
            await send_log(context, f"💸 **WITHDRAWAL PAID:** ₹{amount:.2f} to `{wd['address']}` by @{user.username or user.first_name}")
        else:
            with get_db() as conn:
                cursor = conn.cursor()
                cursor.execute("UPDATE withdrawals SET status = 'rejected', processed_by = ? WHERE id = ?", (user.id, req_id))
                conn.commit()
            # Refund user balance
            db_update_balance(target_user, amount)
            try:
                await context.bot.send_message(
                    chat_id=target_user,
                    text=f"❌ **Withdrawal Rejected & Refunded!**\n\nYour requested payout of ₹{amount:.2f} was returned to your balance.",
                    parse_mode="Markdown"
                )
            except Exception:
                pass
            await query.edit_message_text(f"{query.message.text}\n\n❌ **REJECTED & REFUNDED by Admin @{user.username or user.first_name}**", parse_mode="Markdown")
            await send_log(context, f"❌ **WITHDRAWAL REJECTED:** ₹{amount:.2f} refunded by @{user.username or user.first_name}")

# -------------------------------------------------------------------------
# BOT APPLICATION INITIALIZATION & DISPATCHER
# -------------------------------------------------------------------------
def main():
    application = Application.builder().token(TOKEN).build()

    # Core Navigation Handlers
    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("help", help_command))
    application.add_handler(CommandHandler("support", support_command))

    # Wallet & Financial Handlers
    application.add_handler(CommandHandler("wallet", wallet_command))
    application.add_handler(CommandHandler("deposit", deposit_command))
    application.add_handler(CommandHandler("withdraw", withdraw_command))
    application.add_handler(CommandHandler("setwallet", setwallet_command))
    application.add_handler(CommandHandler("wagerstatus", wagerstatus_command))
    application.add_handler(CommandHandler("refer", refer_command))
    application.add_handler(CommandHandler("mystats", mystats_command))
    application.add_handler(CommandHandler("rank", rank_command))
    application.add_handler(CommandHandler("tip", tip_command))

    # Escrow & Administration Handlers
    application.add_handler(CommandHandler("escrow", escrow_command))
    application.add_handler(CommandHandler("panel", admin_panel_command))
    application.add_handler(CommandHandler("maintenance", maintenance_command))
    application.add_handler(CommandHandler("restart", restart_command))
    application.add_handler(CommandHandler("cancel", cancel_room_command))

    # PvP Game Arena Commands
    application.add_handler(CommandHandler("dice", pvp_game_command))
    application.add_handler(CommandHandler("darts", pvp_game_command))
    application.add_handler(CommandHandler("bowling", pvp_game_command))
    application.add_handler(CommandHandler("basket", pvp_game_command))
    application.add_handler(CommandHandler("basketball", pvp_game_command))
    application.add_handler(CommandHandler("football", pvp_game_command))
    application.add_handler(CommandHandler("slots", pvp_game_command))
    application.add_handler(CommandHandler("coin", coin_game_command))

    # Callbacks
    application.add_handler(CallbackQueryHandler(deposit_callback, pattern="^(menu_|dep_|admin_)"))
    application.add_handler(CallbackQueryHandler(escrow_callback, pattern="^esc_"))
    application.add_handler(CallbackQueryHandler(pvp_callback_handler, pattern="^pvp_"))
    application.add_handler(CallbackQueryHandler(admin_approval_callback, pattern="^(app_|wd_)"))

    # Unified Message Handler for Dice Detection, Photos, and Prompts
    application.add_handler(MessageHandler(filters.ALL & ~filters.COMMAND, handle_message))

    print(f"🚀 {BOT_NAME} ({BOT_USERNAME}) initialized with SQLite persistent DB ({DB_FILE}) and active handlers.")
    application.run_polling()

if __name__ == "__main__":
    main()
