import os
import random
import asyncio
import logging
from datetime import datetime
from dotenv import load_dotenv

load_dotenv()

from telegram import (
    Update,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    Bot
)
from telegram.ext import (
    Application,
    CommandHandler,
    CallbackQueryHandler,
    MessageHandler,
    ContextTypes,
    filters,
    ConversationHandler
)
from sqlalchemy import BigInteger, String, Float, Boolean, Column, DateTime, Integer, select, func, desc
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession

BOT_TOKEN = os.getenv("BOT_TOKEN", "8673935058:AAGZW6DhT1jgi7y2x3uWwLqSezOl-mKiDms")
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite+aiosqlite:////data/rolex_casino.db")
GROUP_ID = int(os.getenv("GROUP_ID", "-1004458883943"))
LOG_CHANNEL_ID = int(os.getenv("LOG_CHANNEL_ID", "-1004458883943"))
GROUP_LINK = os.getenv("GROUP_LINK", "https://t.me/RolexCasinos")
BOT_USERNAME = os.getenv("BOT_USERNAME", "Rolex_C_BOT")

REFERRAL_BONUS = float(os.getenv("REFERRAL_BONUS", "5.0"))
DEFAULT_START_BALANCE = 0.0
USDT_RATE = float(os.getenv("USDT_RATE", "94.47"))
WITHDRAWAL_FEE_PCT = 0.04
MIN_BET = 10.0
MIN_TIP = 1.0

raw_admins = os.getenv("ADMIN_IDS", "8362081186,1053006219,8860529495")
ADMINS = {int(x.strip()) for x in raw_admins.split(",") if x.strip().isdigit()}

UPI_ADDRESS = os.getenv("UPI_ADDRESS", "rutvik1209@fam")
CRYPTO_WALLETS = {
    "BEP20": os.getenv("WALLET_BEP20", "0xD8419224A65C3d35C10AE695562463c8445ACb15"),
    "SOLANA": os.getenv("WALLET_SOLANA", "3bKsCSR2mmconFaExejbkuGfeQNuVQPFttzj9y2MP2mE"),
    "ETHEREUM": os.getenv("WALLET_ETHEREUM", "0xD8419224A65C3d35C10AE695562463c8445ACb15"),
    "BITCOIN": os.getenv("WALLET_BITCOIN", "bc1qsm7xzn4k8kpxwurzjsredangepvzgh70y0ypzd")
}

if DATABASE_URL.startswith("sqlite+aiosqlite:////"):
    sqlite_path = DATABASE_URL.replace("sqlite+aiosqlite:////", "/")
    os.makedirs(os.path.dirname(sqlite_path), exist_ok=True)
elif DATABASE_URL.startswith("sqlite+aiosqlite:///"):
    sqlite_rel = DATABASE_URL.replace("sqlite+aiosqlite:///", "")
    if "/" in sqlite_rel:
        os.makedirs(os.path.dirname(sqlite_rel), exist_ok=True)

if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql+asyncpg://", 1)
elif DATABASE_URL.startswith("postgresql://"):
    DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+asyncpg://", 1)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("RolexCasino")

class Base(DeclarativeBase):
    pass

class User(Base):
    __tablename__ = "users"
    telegram_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    username: Mapped[str] = mapped_column(String, nullable=True)
    first_name: Mapped[str] = mapped_column(String, nullable=True)
    balance: Mapped[float] = mapped_column(Float, default=DEFAULT_START_BALANCE)
    bank: Mapped[float] = mapped_column(Float, default=0.0)
    wager_required: Mapped[float] = mapped_column(Float, default=0.0)
    wager_completed: Mapped[float] = mapped_column(Float, default=0.0)
    currency: Mapped[str] = mapped_column(String, default="INR")
    payout_address: Mapped[str] = mapped_column(String, nullable=True)
    referred_by: Mapped[int] = mapped_column(BigInteger, nullable=True)
    referral_count: Mapped[int] = mapped_column(Integer, default=0)
    referral_earnings: Mapped[float] = mapped_column(Float, default=0.0)
    games_played: Mapped[int] = mapped_column(Integer, default=0)
    games_won: Mapped[int] = mapped_column(Integer, default=0)
    games_lost: Mapped[int] = mapped_column(Integer, default=0)
    total_wagered: Mapped[float] = mapped_column(Float, default=0.0)
    total_won: Mapped[float] = mapped_column(Float, default=0.0)
    is_banned: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

class Transaction(Base):
    __tablename__ = "transactions"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    telegram_id: Mapped[int] = mapped_column(BigInteger)
    type: Mapped[str] = mapped_column(String)
    amount: Mapped[float] = mapped_column(Float)
    method: Mapped[str] = mapped_column(String)
    proof_ref: Mapped[str] = mapped_column(String, nullable=True)
    status: Mapped[str] = mapped_column(String, default="PENDING")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

class GiftCode(Base):
    __tablename__ = "gift_codes"
    code: Mapped[str] = mapped_column(String, primary_key=True)
    amount: Mapped[float] = mapped_column(Float)
    is_claimed: Mapped[bool] = mapped_column(Boolean, default=False)
    claimed_by: Mapped[int] = mapped_column(BigInteger, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

engine = create_async_engine(DATABASE_URL, echo=False)
async_session = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

async def init_db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    logger.info("Database schema initialized successfully.")

async def get_user(session: AsyncSession, telegram_id: int, username: str = None, first_name: str = None) -> User:
    user = await session.get(User, telegram_id)
    if not user:
        user = User(
            telegram_id=telegram_id,
            username=username or "",
            first_name=first_name or "Player",
            balance=DEFAULT_START_BALANCE
        )
        session.add(user)
        await session.commit()
    else:
        updated = False
        if username and user.username != username:
            user.username = username
            updated = True
        if first_name and user.first_name != first_name:
            user.first_name = first_name
            updated = True
        if updated:
            await session.commit()
    return user

async def send_log(bot: Bot, text: str):
    try:
        await bot.send_message(LOG_CHANNEL_ID, f"📋 <b>ROLEX CASINO LOG SYSTEM</b>\n\n{text}", parse_mode="HTML")
    except Exception as e:
        logger.error(f"Failed to push log: {e}")

def fmt_money(amount: float, currency: str = "INR") -> str:
    if currency == "USD":
        return f"${amount / USDT_RATE:.2f}"
    return f"₹{amount:.2f}"

BOT_STATE = {"maintenance": False, "house_balance": 0.0}

async def cmd_maintenance(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    if not user or user.id not in ADMINS:
        return
    BOT_STATE["maintenance"] = not BOT_STATE["maintenance"]
    if BOT_STATE["maintenance"]:
        msg = "⚠️ <b>Maintenance mode is ON.</b> All chats, commands, and balances are locked. Send /maintenance again to turn it off."
    else:
        msg = "🚀 Bot maintenance mode is now OFF. All commands and games have been restarted successfully!"
    await update.message.reply_text(msg, parse_mode="HTML")

(
    DEP_AMOUNT, DEP_PROOF, DEP_PHOTO,
    WD_AMOUNT, WD_ADDRESS,
    SET_WALLET
) = range(6)

ACTIVE_CHALLENGES = {}
ACTIVE_MATCHES = {}
ACTIVE_PVB = {}
MATCH_COUNTER = 0

def get_channel_lock_kb():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton(text="📢 Join Official Group 🌐", url=GROUP_LINK)],
        [InlineKeyboardButton(text="📥 Deposit Funds 💵", url=f"https://t.me/{BOT_USERNAME}?start=deposit")]
    ])

def get_dm_redirect_kb():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton(text="🤖 Open Bot in DM 📩", url=f"https://t.me/{BOT_USERNAME}")]
    ])

def get_main_menu_kb():
    return InlineKeyboardMarkup([
        [
            InlineKeyboardButton(text="📥 Deposit 🟢", callback_data="menu_deposit"),
            InlineKeyboardButton(text="📤 Withdraw 🔴", callback_data="menu_withdraw")
        ],
        [
            InlineKeyboardButton(text="🎮 PvP Games Arena ⚔️", callback_data="menu_games"),
            InlineKeyboardButton(text="💼 My Wallet 💳", callback_data="menu_wallet")
        ],
        [
            InlineKeyboardButton(text="👥 Refer & Earn (₹5) 🎁", callback_data="menu_referral"),
            InlineKeyboardButton(text="📊 Stats & Rank 🏆", callback_data="menu_stats")
        ],
        [InlineKeyboardButton(text="📢 Official Community Group 🌐", url=GROUP_LINK)],
        [InlineKeyboardButton(text="🛟 24/7 VIP Support 🔵", callback_data="menu_support")]
    ])

async def security_middleware(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    message = update.message or (query.message if query else None)
    user = update.effective_user
    
    if not message or not user:
        return True

    chat_type = message.chat.type
    is_admin = user.id in ADMINS

    text = message.text or message.caption or ""
    raw_cmd = text.split()[0].lower() if text.startswith("/") else ""
    command = raw_cmd.split("@")[0]

    if command == "/maintenance" and is_admin:
        return True

    async with async_session() as session:
        db_user = await session.get(User, user.id)
        if db_user and db_user.is_banned and not is_admin:
            if query:
                await query.answer("⛔ Your account has been suspended by Rolex Security.", show_alert=True)
                return False
            if chat_type == "private":
                await message.reply_text("⛔ <b>Your account has been suspended by Rolex Casino Security.</b>", parse_mode="HTML")
                return False
            return False

    if BOT_STATE["maintenance"] and not is_admin:
        if query:
            await query.answer("⚠️ Bot is currently under maintenance. Bets are paused.", show_alert=True)
            return False
        if chat_type in ["group", "supergroup"]:
            return False
        await message.reply_text("⚠️ <b>Rolex Casino is currently under scheduled maintenance.</b> Please check back soon!", parse_mode="HTML")
        return False

    admin_commands = {"/panel", "/pending", "/users", "/user", "/creategift", "/balanceadd", "/balancededuct", "/ban", "/unban", "/broadcast", "/admincommands", "/announcement", "/hb", "/maintenance", "/restart", "/rain"}
    if command in admin_commands and chat_type in ["group", "supergroup"]:
        try: await message.delete()
        except Exception: pass
        await message.reply_text(
            f"⛔ <b>{user.first_name}, administrative commands can only be executed securely inside our DM inbox!</b>",
            reply_markup=get_dm_redirect_kb(),
            parse_mode="HTML"
        )
        return False

    dm_only_commands = {"/deposit", "/withdraw", "/setwallet", "/changecurrency"}
    if command in dm_only_commands and chat_type in ["group", "supergroup"]:
        try: await message.delete()
        except Exception: pass
        await message.reply_text(
            f"⛔ <b>{user.first_name}, wallet & payment commands can only be accessed securely inside DM!</b>",
            reply_markup=get_dm_redirect_kb(),
            parse_mode="HTML"
        )
        return False

    return True

async def parse_stake(user: User, raw_arg: str) -> float | None:
    raw = raw_arg.strip().lower()
    if raw == "all":
        amt = round(user.balance, 2)
    elif raw == "half":
        amt = round(user.balance / 2, 2)
    else:
        try:
            amt = float(raw)
            if user.currency == "USD":
                amt = amt * USDT_RATE
        except ValueError:
            return None
    if amt < MIN_BET:
        return None
    return round(amt, 2)

async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await security_middleware(update, context):
        return
    message = update.message
    user_id = message.from_user.id
    username = message.from_user.username or ""
    first_name = message.from_user.first_name or "Player"

    if message.chat.type in ["group", "supergroup"]:
        kb = InlineKeyboardMarkup([
            [InlineKeyboardButton(text="✨ Join Community", url=GROUP_LINK)],
            [InlineKeyboardButton(text="💬 Open Bot Chat", url=f"https://t.me/{BOT_USERNAME}?start=start")]
        ])
        return await message.reply_text(
            f"✨ Welcome, {first_name}!\n\n"
            f"🤖 I'm Rolex–Casino-Bot\n\n"
            f"This bot works only inside the Official Group. Tap the button below to join and start playing.",
            reply_markup=kb,
            parse_mode="HTML"
        )
    
    args = context.args
    inviter_id = None
    if args:
        param = args[0].strip()
        if param == "deposit":
            return await cmd_deposit(update, context)
        elif param.startswith("ref_"):
            try:
                ref_cand = int(param.replace("ref_", ""))
                if ref_cand != user_id:
                    inviter_id = ref_cand
            except ValueError:
                pass

    async with async_session() as session:
        user = await session.get(User, user_id)
        if not user:
            user = User(
                telegram_id=user_id,
                username=username,
                first_name=first_name,
                balance=DEFAULT_START_BALANCE,
                referred_by=inviter_id
            )
            session.add(user)
            await session.commit()

            if inviter_id:
                inviter = await session.get(User, inviter_id)
                if inviter:
                    inviter.balance += REFERRAL_BONUS
                    inviter.referral_count += 1
                    inviter.referral_earnings += REFERRAL_BONUS
                    
                    tx = Transaction(
                        telegram_id=inviter_id,
                        type="REFERRAL",
                        amount=REFERRAL_BONUS,
                        method="SYSTEM",
                        status="COMPLETED"
                    )
                    session.add(tx)
                    await session.commit()
                    
                    try:
                        await context.bot.send_message(
                            inviter_id,
                            f"🎁 <b>New Referral Joined!</b>\n\n👤 Player: @{username or first_name}\n💵 Bonus: <b>+₹{REFERRAL_BONUS:.2f}</b> added to your wallet!\n💼 New Balance: <b>₹{inviter.balance:.2f}</b>",
                            parse_mode="HTML"
                        )
                    except Exception:
                        pass
                    await send_log(context.bot, f"🎁 <b>Referral Bonus</b>: `{inviter_id}` earned ₹{REFERRAL_BONUS:.2f} from new user `{user_id}` (@{username})")
        else:
            if username and user.username != username:
                user.username = username
            if first_name and user.first_name != first_name:
                user.first_name = first_name
            await session.commit()

    welcome_text = (
        f"✨ <b>Welcome, {first_name}!</b>\n\n"
        f"🤖 <b>I'm Rolex–Casino-Bot</b>\n\n"
        f"👤 <b>Player:</b> {first_name} (@{username or 'N/A'})\n"
        f"🆔 <b>User ID:</b> <code>{user_id}</code>\n"
        f"💰 <b>Main Balance:</b> {fmt_money(user.balance, user.currency)}\n"
        f"🏦 <b>Bank Vault:</b> {fmt_money(user.bank, user.currency)}\n"
        f"👥 <b>Referrals:</b> {user.referral_count} (Earned: ₹{user.referral_earnings:.2f})\n\n"
        f"⚔️ <b>100% Real PvP Multiplayer:</b> Multiplier: <b>1.92×</b>.\n\n"
        f"👇 <i>Use the control panel below to deposit, withdraw, or view games:</i>"
    )
    await message.reply_text(welcome_text, reply_markup=get_main_menu_kb(), parse_mode="HTML")

async def cb_menu_deposit(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    await cmd_deposit(update, context)

async def cb_menu_withdraw(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    await cmd_withdraw(update, context)

async def cb_menu_wallet(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    await cmd_wallet(update, context)

async def cb_menu_games(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    await cmd_games(update, context)

async def cb_menu_referral(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    await cmd_refer(update, context)

async def cb_menu_stats(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    await cmd_mystats(update, context)

async def cb_menu_support(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    await cmd_help(update, context)

async def cmd_help(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await security_middleware(update, context):
        return
    txt = (
        "🔵 <b>CUSTOMER SUPPORT</b>\n"
        "Need help? Our support team is here to assist you.\n\n"
        "📩 For Customer Support:\n"
        "Please contact @RolexCasinoMOD\n\n"
        "📝 Support Format:\n"
        "Username:\n"
        "User ID:\n"
        "Issue:\n"
        "Transaction ID: (if applicable)\n"
        "Screenshot/Proof: (if applicable)\n\n"
        "⚠️ Important:\n"
        "Please provide complete and accurate information so our admins can resolve your issue quickly."
    )
    await update.message.reply_text(txt, parse_mode="HTML")

async def cmd_games(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await security_middleware(update, context):
        return
    txt = (
        "🎯 <b>AVAILABLE GAMES</b>\n\n"
        "🎲 <b>Dice</b> (/dice [amount] [rounds])\n"
        "🎯 <b>Darts</b> (/darts [amount] [rounds])\n"
        "🏀 <b>Basketball</b> (/basket [amount] [rounds])\n"
        "⚽️ <b>Football</b> (/football [amount] [rounds])\n"
        "🎳 <b>Bowling</b> (/bowling [amount] [rounds])\n"
        "🎰 <b>Slots</b> (/slots [amount] [rounds])\n"
        "🪙 <b>Coin Flip</b> (/coin [amount])\n"
        "🎲 <b>Dice Rush</b> (/dr [high/low/odd/even] [amount])\n"
        "6️⃣ <b>7UP</b> (/7up [up/down] [amount])\n"
        "🏏 <b>Cricket Toss</b> (/odice [amount])\n\n"
        "<i>PvP or PvB modes available in the official group arena! Min bet: ₹10</i>"
    )
    kb = InlineKeyboardMarkup([
        [InlineKeyboardButton(text="📢 Enter Official Game Group 🎮", url=GROUP_LINK)]
    ])
    await update.message.reply_text(txt, reply_markup=kb, parse_mode="HTML")

async def cmd_wallet(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await security_middleware(update, context):
        return
    message = update.message
    async with async_session() as session:
        user = await get_user(session, message.from_user.id, message.from_user.username, message.from_user.first_name)
    
    payout_info = f"<code>{user.payout_address}</code>" if user.payout_address else "<i>Not set (use /setwallet)</i>"
    
    txt = (
        f"💼 <b>Your Wallet</b>\n\n"
        f"💵 <b>Balance:</b> {fmt_money(user.balance, user.currency)}\n"
        f"👨‍💻 <b>UPI/CRYPTO WALLET:</b> {payout_info}\n\n"
        f"⚠️ <b>Promo Lock:</b> {fmt_money(user.wager_required, user.currency)} bonus locked\n"
        f"📈 <b>Wager {fmt_money(user.wager_required, user.currency)}</b> more to unlock withdrawal\n"
        f"(Play wallet bets to clear it)\n\n"
        f"Min withdrawal: $1/100₹"
    )
    kb = InlineKeyboardMarkup([
        [
            InlineKeyboardButton(text="📥 Deposit 🟢", callback_data="menu_deposit"),
            InlineKeyboardButton(text="📤 Withdraw 🔴", callback_data="menu_withdraw")
        ],
        [
            InlineKeyboardButton(text="💱 Toggle Currency", callback_data="toggle_currency"),
            InlineKeyboardButton(text="📝 Set Payout Wallet", callback_data="btn_setwallet")
        ]
    ])
    await message.reply_text(txt, reply_markup=kb, parse_mode="HTML")

async def cb_toggle_currency(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    async with async_session() as session:
        user = await get_user(session, query.from_user.id)
        user.currency = "USD" if user.currency == "INR" else "INR"
        await session.commit()
        new_curr = user.currency
    await query.answer(f"Currency changed to {new_curr}!", show_alert=True)
    update.message = query.message
    await cmd_wallet(update, context)

async def cmd_changecurrency(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await security_middleware(update, context):
        return
    async with async_session() as session:
        user = await get_user(session, update.message.from_user.id)
        user.currency = "USD" if user.currency == "INR" else "INR"
        await session.commit()
        new_curr = user.currency
    kb = InlineKeyboardMarkup([
        [InlineKeyboardButton(text="INR ₹", callback_data="toggle_currency"), InlineKeyboardButton(text="USD $", callback_data="toggle_currency")]
    ])
    await update.message.reply_text(f"💼 <b>Display Currency — {new_curr}</b>", reply_markup=kb, parse_mode="HTML")

async def cmd_setwallet(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await security_middleware(update, context):
        return
    message = update.message
    args = context.args
    if args:
        address = " ".join(args).strip()
        async with async_session() as session:
            user = await get_user(session, message.from_user.id)
            user.payout_address = address
            await session.commit()
        return await message.reply_text(f"👨‍💻 <b>Saved Payout Address:</b>\n<code>{address}</code>", parse_mode="HTML")

    kb = InlineKeyboardMarkup([
        [InlineKeyboardButton(text="USDT (BEP20)", callback_data="set_w_bep20"), InlineKeyboardButton(text="SOLANA", callback_data="set_w_sol")],
        [InlineKeyboardButton(text="ETHEREUM", callback_data="set_w_eth"), InlineKeyboardButton(text="BITCOIN", callback_data="set_w_btc")]
    ])
    await message.reply_text("💼 <b>Save Your Payout Wallet / UPI ID</b>\nEnter your UPI ID or Crypto Address:", reply_markup=kb, parse_mode="HTML")
    return SET_WALLET

async def cb_set_crypto_wallet(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    net = query.data.split("_")[2].upper()
    context.user_data["crypto_net"] = net
    await query.message.reply_text(f"Send your {net} crypto address:", parse_mode="HTML")
    await query.answer()

async def cb_setwallet(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.message.reply_text("💼 <b>Save Your UPI ID</b>\nEnter your UPI ID:\nExample: <code>rahul@ybl</code>", parse_mode="HTML")
    await query.answer()

async def process_setwallet_address(update: Update, context: ContextTypes.DEFAULT_TYPE):
    address = update.message.text.strip()
    if len(address) < 4:
        await update.message.reply_text("❌ Invalid wallet address. Please enter a valid UPI ID or Crypto wallet.")
        return SET_WALLET

    async with async_session() as session:
        user = await get_user(session, update.message.from_user.id)
        user.payout_address = address
        await session.commit()

    await update.message.reply_text(f"👨‍💻 <b>Saved Payout Address:</b>\n<code>{address}</code>", parse_mode="HTML")
    return ConversationHandler.END

async def cmd_saveupi(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await security_middleware(update, context):
        return
    args = context.args
    if not args:
        return await update.message.reply_text("Usage: <code>/saveupi newupi@bank</code>", parse_mode="HTML")
    address = " ".join(args).strip()
    async with async_session() as session:
        user = await get_user(session, update.message.from_user.id)
        user.payout_address = address
        await session.commit()
    await update.message.reply_text(f"👨‍💻 <b>Saved UPI:</b>\n<code>{address}</code>", parse_mode="HTML")

async def cmd_refer(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await security_middleware(update, context):
        return
    user_id = update.message.from_user.id
    ref_link = f"https://t.me/{BOT_USERNAME}?start=ref_{user_id}"

    async with async_session() as session:
        user = await get_user(session, user_id, update.message.from_user.username, update.message.from_user.first_name)

    txt = (
        f"🎁 <b>Rolex Casino Referral Program</b>\n\n"
        f"Earn <b>₹{REFERRAL_BONUS:.2f}</b> instantly for every friend you invite!\n\n"
        f"🔗 <b>Your Exclusive Referral Link:</b>\n"
        f"<code>{ref_link}</code>\n\n"
        f"📊 <b>Your Referral Statistics:</b>\n"
        f"• Total Invited Players: <b>{user.referral_count}</b>\n"
        f"• Total Referral Earnings: <b>₹{user.referral_earnings:.2f}</b>"
    )
    kb = InlineKeyboardMarkup([
        [InlineKeyboardButton(text="🚀 Share Referral Link 📲", url=f"https://t.me/share/url?url={ref_link}&text=Join%20Rolex%20Casino%20PvP%20and%20play%20live%20games!")]
    ])
    await update.message.reply_text(txt, reply_markup=kb, parse_mode="HTML")

async def cmd_mystats(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await security_middleware(update, context):
        return
    message = update.message
    async with async_session() as session:
        user = await get_user(session, message.from_user.id, message.from_user.username, message.from_user.first_name)
        rank_query = select(func.count(User.telegram_id)).where(User.total_wagered > user.total_wagered)
        rank_above = (await session.execute(rank_query)).scalar() or 0
        user_rank = rank_above + 1

    winrate = (user.games_won / user.games_played * 100) if user.games_played > 0 else 0.0
    net_profit = user.total_won - user.total_wagered

    txt = (
        f"📊 <b>Personal Gaming Statistics — {user.first_name}</b>\n\n"
        f"🏆 <b>Casino Rank:</b> #{user_rank}\n"
        f"🎮 <b>Total Matches Played:</b> {user.games_played}\n"
        f"🟢 <b>Matches Won:</b> {user.games_won}\n"
        f"🔴 <b>Matches Lost:</b> {user.games_lost}\n"
        f"🎯 <b>Winrate:</b> {winrate:.1f}%\n"
        f"💵 <b>Total Wagered:</b> {fmt_money(user.total_wagered, user.currency)}\n"
        f"💰 <b>Total Payouts Won:</b> {fmt_money(user.total_won, user.currency)}\n"
        f"📈 <b>Net Profit:</b> {fmt_money(net_profit, user.currency)}"
    )
    await message.reply_text(txt, parse_mode="HTML")

async def cmd_leaderboard(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await security_middleware(update, context):
        return
    async with async_session() as session:
        top_players = (await session.execute(
            select(User).order_by(desc(User.total_wagered)).limit(10)
        )).scalars().all()

    txt = "🏆 <b>Top 10 High Rollers Leaderboard</b>\n\n"
    if not top_players:
        txt += "<i>No player records found yet.</i>"
    else:
        medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"]
        for idx, u in enumerate(top_players):
            name = u.first_name or u.username or f"Player {u.telegram_id}"
            badge = medals[idx] if idx < len(medals) else f"#{idx+1}"
            txt += f"{badge} <b>{name}</b> — Wagered: ₹{u.total_wagered:.2f} | Won: {u.games_won}W\n"

    await update.message.reply_text(txt, parse_mode="HTML")

async def cmd_wager(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await security_middleware(update, context):
        return
    async with async_session() as session:
        user = await get_user(session, update.message.from_user.id)
    
    status_icon = "🟢 Clear" if user.wager_required <= 0 else "⚠️ Locked"
    txt = (
        f"💼 <b>Rolex Casino — Wagering Status</b>\n\n"
        f"• Status: {status_icon}\n"
        f"• Pending Wager Requirement: <b>{fmt_money(user.wager_required, user.currency)}</b>\n"
        f"• Total Wager Completed: <b>{fmt_money(user.wager_completed, user.currency)}</b>"
    )
    await update.message.reply_text(txt, parse_mode="HTML")

async def cmd_tip(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await security_middleware(update, context):
        return
    message = update.message
    sender_id = message.from_user.id
    args = context.args
    
    recipient = None
    raw_amount = None

    if message.reply_to_message:
        recipient = message.reply_to_message.from_user
        if args:
            raw_amount = args[0]
    elif len(args) >= 2 and args[0].startswith("@"):
        target_tag = args[0].replace("@", "").lower()
        raw_amount = args[1]
        async with async_session() as session:
            recipient = (await session.execute(select(User).where(func.lower(User.username) == target_tag))).scalar_one_or_none()
            if not recipient:
                return await message.reply_text(f"❌ User @{target_tag} has not registered on Rolex Casino yet.")
    else:
        return await message.reply_text("Usage:\n• Reply to a user: <code>/tip [amount]</code>\n• Or: <code>/tip @username [amount]</code>", parse_mode="HTML")

    if not raw_amount:
        return await message.reply_text("❌ Please specify the tip amount.", parse_mode="HTML")

    target_id = recipient.id if hasattr(recipient, "id") else recipient.telegram_id
    target_name = recipient.username or recipient.first_name

    if target_id == sender_id:
        return await message.reply_text("❌ You cannot tip yourself!")

    async with async_session() as session:
        sender = await get_user(session, sender_id, message.from_user.username, message.from_user.first_name)
        try:
            amount = float(raw_amount)
            if sender.currency == "USD":
                amount = amount * USDT_RATE
        except ValueError:
            return await message.reply_text("❌ Invalid tip amount.")
        
        if amount < MIN_TIP:
            return await message.reply_text(f"❌ Minimum tip amount is ₹{MIN_TIP} / $0.01.")
        if sender.balance < amount:
            return await message.reply_text(f"❌ Insufficient balance! You have {fmt_money(sender.balance, sender.currency)}.")

    kb = InlineKeyboardMarkup([
        [
            InlineKeyboardButton(text="Confirm ✅", callback_data=f"tip_yes_{target_id}_{amount}"),
            InlineKeyboardButton(text="Cancel ❌", callback_data=f"tip_no_{target_id}_{amount}")
        ]
    ])
    await message.reply_text(
        f"<b>Confirm Tip</b>\nAmount: {fmt_money(amount, sender.currency)}\nFrom: @{message.from_user.username or message.from_user.first_name}\nTo: @{target_name}",
        reply_markup=kb,
        parse_mode="HTML"
    )

async def cb_tip_action(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    parts = query.data.split("_")
    action = parts[1]
    target_id = int(parts[2])
    amount = float(parts[3])
    sender_id = query.from_user.id

    if query.from_user.id != sender_id and query.from_user.id not in ADMINS:
        return await query.answer("This action is not for you!", show_alert=True)

    if action == "no":
        await query.message.edit_text("Tip cancelled.", parse_mode="HTML")
        return await query.answer("Tip cancelled.")

    async with async_session() as session:
        sender = await get_user(session, sender_id)
        if sender.balance < amount:
            return await query.answer("Insufficient balance!", show_alert=True)
        sender.balance -= amount
        
        rec_user = await get_user(session, target_id)
        rec_user.balance += amount
        await session.commit()
        new_bal = rec_user.balance

    sender_name = query.from_user.username or query.from_user.first_name
    await query.message.edit_text(f"🏆 <b>Tip Sent Successfully!</b>\nAmount: ₹{amount:.2f}", parse_mode="HTML")
    try:
        await context.bot.send_message(
            target_id,
            f"🏆 <b>You received a tip!</b>\n\n👤 From: @{sender_name}\n💵 Amount: ₹{amount:.2f} added to your wallet!\n🏦 New Balance: ₹{new_bal:.2f}\n\nUse /wallet to view your balance.",
            parse_mode="HTML"
        )
    except Exception:
        pass
    await query.answer("Tip sent successfully!")

async def cmd_claim(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await security_middleware(update, context):
        return
    args = context.args
    if not args:
        return await update.message.reply_text("Usage: <code>/claim [GIFT_CODE]</code>", parse_mode="HTML")
    code = args[0].strip()

    async with async_session() as session:
        gift = await session.get(GiftCode, code)
        if not gift or gift.is_claimed:
            return await update.message.reply_text("❌ Invalid or already claimed gift code.")
        
        gift.is_claimed = True
        gift.claimed_by = update.message.from_user.id
        user = await get_user(session, update.message.from_user.id, update.message.from_user.username, update.message.from_user.first_name)
        user.balance += gift.amount
        await session.commit()
        new_bal = user.balance

    await update.message.reply_text(f"🎉 <b>Gift Code Claimed!</b>\n\n💵 Amount Credited: <b>₹{gift.amount:.2f}</b>\n🏦 Your New Balance: <b>₹{new_bal:.2f}</b>", parse_mode="HTML")
    await send_log(context.bot, f"🎟️ <b>Gift Claimed</b>: Code <code>{code}</code> claimed by @{update.message.from_user.username} for ₹{gift.amount:.2f}")

async def cmd_deposit(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await security_middleware(update, context):
        return
    kb = InlineKeyboardMarkup([
        [InlineKeyboardButton(text="INR ₹ (UPI)", callback_data="dep_INR"), InlineKeyboardButton(text="USDT (BEP20)", callback_data="dep_BEP20")],
        [InlineKeyboardButton(text="SOLANA", callback_data="dep_SOLANA"), InlineKeyboardButton(text="ETHEREUM", callback_data="dep_ETHEREUM")]
    ])
    await update.message.reply_text("📥 <b>Deposit Funds</b>\n\nSelect your deposit payment gateway:", reply_markup=kb, parse_mode="HTML")
    return DEP_AMOUNT

async def choose_deposit_gateway(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    method = query.data.split("_")[1]
    context.user_data["deposit_method"] = method
    await query.message.reply_text(f"Enter deposit amount for {method} (Min ₹50 / $1):", parse_mode="HTML")
    await query.answer()
    return DEP_AMOUNT

async def process_deposit_amount(update: Update, context: ContextTypes.DEFAULT_TYPE):
    try:
        amount = float(update.message.text.strip())
    except ValueError:
        await update.message.reply_text("❌ Invalid amount format.", parse_mode="HTML")
        return DEP_AMOUNT

    if amount < 50:
        await update.message.reply_text("❌ Minimum deposit amount is ₹50 / $1.", parse_mode="HTML")
        return DEP_AMOUNT

    method = context.user_data.get("deposit_method", "INR")
    context.user_data["deposit_amount"] = amount

    wallet_address = CRYPTO_WALLETS.get(method, UPI_ADDRESS)
    kb = InlineKeyboardMarkup([
        [InlineKeyboardButton(text="I have paid ✔️", callback_data="dep_paid_confirm")]
    ])
    await update.message.reply_text(
        f"⬇️ <b>Deposit — {method}</b>\n\nAmount: ₹{amount}\nSend payment to address/UPI:\n<code>{wallet_address}</code>\n\nAfter paying, press ✅ I have paid below.",
        reply_markup=kb,
        parse_mode="HTML"
    )
    return DEP_PROOF

async def cb_dep_paid(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.message.reply_text("⬇️ <b>Step 1/2 — UTR / Reference Number</b>\n\nSend your UTR / Transaction ID or TXID:", parse_mode="HTML")
    await query.answer()
    return DEP_PROOF

async def process_deposit_utr(update: Update, context: ContextTypes.DEFAULT_TYPE):
    utr = update.message.text.strip()
    if len(utr) < 6:
        await update.message.reply_text("❌ Please send a valid UTR or Transaction reference number.")
        return DEP_PROOF
    
    context.user_data["deposit_proof"] = utr
    await update.message.reply_text(f"✅ UTR saved: {utr}\n\n⬇️ <b>Step 2/2 — Payment Screenshot</b>\n\nNow send the screenshot of your payment.", parse_mode="HTML")
    return DEP_PHOTO

async def process_deposit_screenshot(update: Update, context: ContextTypes.DEFAULT_TYPE):
    amount = context.user_data.get("deposit_amount", 0.0)
    method = context.user_data.get("deposit_method", "INR")
    proof = context.user_data.get("deposit_proof", "N/A")
    user_id = update.message.from_user.id
    username = update.message.from_user.username or update.message.from_user.first_name

    async with async_session() as session:
        tx = Transaction(
            telegram_id=user_id,
            type="DEPOSIT",
            amount=amount,
            method=method,
            proof_ref=proof,
            status="PENDING"
        )
        session.add(tx)
        await session.commit()
        await session.refresh(tx)
        tx_id = tx.id

    await update.message.reply_text(
        f"✅ <b>Deposit proof submitted!</b>\n\n"
        f"Amount: ₹{amount}\n"
        f"UTR: {proof}\n\n"
        f"Deposit will be credited automatically. It may take 3-5 minutes.",
        parse_mode="HTML"
    )
    await send_log(context.bot, f"📥 <b>New Deposit #{tx_id}</b>\nUser: @{username} (`{user_id}`)\nAmount: ₹{amount} ({method})\nRef: `{proof}`")

    admin_kb = InlineKeyboardMarkup([
        [
            InlineKeyboardButton(text="✅ Approve 🟢", callback_data=f"adm_dep_yes_{tx_id}"),
            InlineKeyboardButton(text="❌ Reject 🔴", callback_data=f"adm_dep_no_{tx_id}")
        ]
    ])
    for adm in ADMINS:
        try:
            await context.bot.send_message(
                adm,
                f"🚨 <b>New Deposit Request [#{tx_id}]</b>\nUser: @{username} (`{user_id}`)\nAmount: ₹{amount}\nRef: `{proof}`",
                reply_markup=admin_kb,
                parse_mode="HTML"
            )
        except Exception:
            pass
    return ConversationHandler.END

async def cmd_withdraw(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await security_middleware(update, context):
        return
    message = update.message
    user_id = message.from_user.id
    async with async_session() as session:
        user = await get_user(session, user_id)
        if user.balance <= 0:
            await message.reply_text("❌ You have zero available balance for withdrawal.")
            return ConversationHandler.END

    args = context.args
    if args:
        req_amount = await parse_stake(user, args[0])
        if req_amount and 0 < req_amount <= user.balance:
            context.user_data["withdraw_amount"] = req_amount
            return await execute_withdrawal_prompt(message, context, user)

    await message.reply_text(
        f"📤 <b>Withdraw</b>\n\n"
        f"Balance: {fmt_money(user.balance, user.currency)}\n\n"
        f"Enter amount to withdraw (e.g. 100, or 5 for USD):",
        parse_mode="HTML"
    )
    return WD_AMOUNT

async def process_withdraw_amount(update: Update, context: ContextTypes.DEFAULT_TYPE):
    async with async_session() as session:
        user = await get_user(session, update.message.from_user.id)
        amount = await parse_stake(user, update.message.text)
        if not amount or amount <= 0 or amount > user.balance:
            await update.message.reply_text("❌ Invalid or insufficient amount.")
            return WD_AMOUNT
    
    context.user_data["withdraw_amount"] = amount
    await update.message.reply_text(
        f"📤 <b>Withdraw via UPI/Crypto</b>\n\n"
        f"Amount: ₹{amount}\n\n"
        f"Enter your payout UPI ID or Crypto Address (e.g., rahul@ybl):",
        parse_mode="HTML"
    )
    return WD_ADDRESS

async def process_withdraw_address(update: Update, context: ContextTypes.DEFAULT_TYPE):
    address = update.message.text.strip()
    amount = context.user_data.get("withdraw_amount")
    async with async_session() as session:
        user = await get_user(session, update.message.from_user.id)
        user.payout_address = address
        await session.commit()
    
    fee = amount * WITHDRAWAL_FEE_PCT
    net_receive = amount - fee

    kb = InlineKeyboardMarkup([
        [
            InlineKeyboardButton(text="Confirm ✅", callback_data=f"wd_confirm_{amount}"),
            InlineKeyboardButton(text="Cancel ❌", callback_data="wd_cancel")
        ]
    ])
    await update.message.reply_text(
        f"🧾 <b>Withdrawal Summary</b>\n\n"
        f"Currency: {user.currency}\n"
        f"Requested Amount: ₹{amount}\n"
        f"Fee (4%): ₹{fee:.2f}\n"
        f"You Will Receive: ₹{net_receive:.2f}\n"
        f"👨‍💻 To: <code>{address}</code>",
        reply_markup=kb,
        parse_mode="HTML"
    )
    return ConversationHandler.END

async def cb_withdraw_action(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    data = query.data
    if data == "wd_cancel":
        await query.message.edit_text("❌ Withdrawal cancelled.", parse_mode="HTML")
        return await query.answer("Cancelled.")
    
    if data.startswith("wd_confirm_"):
        amount = float(data.split("_")[2])
        user_id = query.from_user.id
        username = query.from_user.username or query.from_user.first_name
        
        async with async_session() as session:
            user = await get_user(session, user_id)
            if user.balance < amount:
                return await query.answer("Insufficient balance!", show_alert=True)
            if user.wager_required > 0:
                return await query.answer(f"Complete wagering requirement first! Pending: ₹{user.wager_required}", show_alert=True)
            
            user.balance -= amount
            fee = amount * WITHDRAWAL_FEE_PCT
            net_receive = amount - fee
            BOT_STATE["house_balance"] += fee
            address = user.payout_address or "Not Set"

            tx = Transaction(
                telegram_id=user_id,
                type="WITHDRAW",
                amount=net_receive,
                method="MANUAL",
                proof_ref=address,
                status="PENDING"
            )
            session.add(tx)
            await session.commit()
            tx_id = tx.id

        await query.message.edit_text(
            f"✅ <b>Withdrawal #{tx_id} Submitted</b>\n\n"
            f"Amount: ₹{amount}\n"
            f"Fee: ₹{fee:.2f}\n"
            f"You'll Receive: ₹{net_receive:.2f}\n"
            f"Network: UPI/Crypto\n"
            f"Address: {address}\n\n"
            f"Your withdrawal request is being processed...",
            parse_mode="HTML"
        )
        await send_log(context.bot, f"📤 <b>Withdrawal Request [#{tx_id}]</b>\nUser: @{username}\nAmount: ₹{net_receive:.2f} (Fee: ₹{fee:.2f})")

        admin_kb = InlineKeyboardMarkup([
            [
                InlineKeyboardButton(text="✅ Approve 🟢", callback_data=f"adm_wd_yes_{tx_id}"),
                InlineKeyboardButton(text="❌ Reject 🔴", callback_data=f"adm_wd_no_{tx_id}")
            ]
        ])
        for adm in ADMINS:
            try:
                await context.bot.send_message(adm, f"🚨 Withdrawal #{tx_id} from @{username} for ₹{net_receive:.2f}", reply_markup=admin_kb, parse_mode="HTML")
            except Exception:
                pass
        await query.answer("Submitted!")

async def execute_withdrawal_prompt(message, context, user):
    pass

async def create_pvp_challenge(update: Update, context: ContextTypes.DEFAULT_TYPE, game: str, emoji: str):
    if not await security_middleware(update, context):
        return
    message = update.message
    if message.chat.type not in ["group", "supergroup"]:
        await message.reply_text(f"{emoji} PvP games are restricted to the official group!", reply_markup=get_channel_lock_kb(), parse_mode="HTML")
        return

    args = context.args
    if not args:
        await message.reply_text(
            f"Choose rounds below for {game.upper()}",
            reply_markup=InlineKeyboardMarkup([
                [
                    InlineKeyboardButton(text="1 Round", callback_data=f"pvp_rnd_{game}_1"),
                    InlineKeyboardButton(text="2 Rounds", callback_data=f"pvp_rnd_{game}_2"),
                    InlineKeyboardButton(text="3 Rounds", callback_data=f"pvp_rnd_{game}_3")
                ],
                [InlineKeyboardButton(text="Cancel ❌", callback_data="pvp_rnd_cancel")]
            ]),
            parse_mode="HTML"
        )
        return

    raw_amount = args[0]
    rounds = int(args[1]) if len(args) > 1 and args[1].isdigit() else 1
    if rounds < 1 or rounds > 3:
        rounds = 1

    async with async_session() as session:
        user = await get_user(session, message.from_user.id, message.from_user.username, message.from_user.first_name)
        bet = await parse_stake(user, raw_amount)
        if not bet or bet <= 0 or user.balance < bet:
            await message.reply_text("❌ Invalid or insufficient bet amount. Minimum is ₹10.")
            return
        
        user.balance -= bet
        user.total_wagered += bet
        user.games_played += 1
        await session.commit()

    global MATCH_COUNTER
    MATCH_COUNTER += 1
    c_id = MATCH_COUNTER

    ACTIVE_CHALLENGES[c_id] = {
        "challenger_id": message.from_user.id,
        "challenger_name": message.from_user.username or message.from_user.first_name,
        "game": game,
        "emoji": emoji,
        "amount": bet,
        "rounds": rounds,
        "chat_id": message.chat.id
    }

    kb = InlineKeyboardMarkup([
        [InlineKeyboardButton(text=f"⚔️ Accept ({fmt_money(bet, 'INR')}) 🟢", callback_data=f"pvp_acc_{c_id}")],
        [InlineKeyboardButton(text="❌ Cancel 🔴", callback_data=f"pvp_can_{c_id}")]
    ])

    await message.reply_text(
        f"<b>ROOM ID~ #{game[:2].upper()}{random.randint(100000, 999999)}</b>\n"
        f"{emoji} PvP {game.upper()} — ₹{bet:.2f} 🔄 {rounds} Rounds\n\n"
        f"👤 @{message.from_user.username or message.from_user.first_name} created challenge!",
        reply_markup=kb,
        parse_mode="HTML"
    )

async def cb_pvp_rounds(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    data = query.data
    if data == "pvp_rnd_cancel":
        return await query.message.edit_text("Cancelled.", parse_mode="HTML")
    parts = data.split("_")
    game = parts[2]
    rounds = int(parts[3])
    await query.message.edit_text(f"Selected {rounds} rounds for {game}. Now send command with amount, e.g. <code>/{game} 50 {rounds}</code>", parse_mode="HTML")
    await query.answer()

async def cmd_dice(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await create_pvp_challenge(update, context, "dice", "🎲")

async def cmd_darts(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await create_pvp_challenge(update, context, "darts", "🎯")

async def cmd_bowling(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await create_pvp_challenge(update, context, "bowling", "🎳")

async def cmd_basket(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await create_pvp_challenge(update, context, "basket", "🏀")

async def cmd_football(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await create_pvp_challenge(update, context, "football", "⚽")

async def cmd_slots(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await create_pvp_challenge(update, context, "slots", "🎰")

async def cmd_coin(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await security_middleware(update, context):
        return
    message = update.message
    if message.chat.type not in ["group", "supergroup"]:
        return await message.reply_text("🪙 Coin flip is restricted to the official group!", reply_markup=get_channel_lock_kb(), parse_mode="HTML")
    args = context.args
    if not args:
        return await message.reply_text("Usage: <code>/coin [amount]</code>", parse_mode="HTML")
    
    async with async_session() as session:
        user = await get_user(session, message.from_user.id, message.from_user.username, message.from_user.first_name)
        bet = await parse_stake(user, args[0])
        if not bet or user.balance < bet:
            return await message.reply_text("❌ Invalid or insufficient bet amount.")
        user.balance -= bet
        user.total_wagered += bet
        user.games_played += 1
        await session.commit()

    global MATCH_COUNTER
    MATCH_COUNTER += 1
    c_id = MATCH_COUNTER

    ACTIVE_CHALLENGES[c_id] = {
        "challenger_id": message.from_user.id,
        "challenger_name": message.from_user.username or message.from_user.first_name,
        "game": "coin",
        "emoji": "🪙",
        "amount": bet,
        "chat_id": message.chat.id
    }

    kb = InlineKeyboardMarkup([
        [InlineKeyboardButton(text=f"⚔️ Accept Coin Flip ({fmt_money(bet)})", callback_data=f"pvp_acc_{c_id}")],
        [InlineKeyboardButton(text="❌ Cancel", callback_data=f"pvp_can_{c_id}")]
    ])
    await message.reply_text(
        f"<b>Coin Flip Challenge #{c_id}</b>\n"
        f"Challenger: @{message.from_user.username or message.from_user.first_name}\n"
        f"Staked: ₹{bet:.2f}\n"
        f"Win: 1.92x",
        reply_markup=kb,
        parse_mode="HTML"
    )

async def cmd_7up(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await security_middleware(update, context):
        return
    args = context.args
    if len(args) < 2:
        return await update.message.reply_text("Usage: <code>/7up [up/down] [amount]</code>", parse_mode="HTML")
    choice = args[0].lower()
    if choice not in ["up", "down"]:
        return await update.message.reply_text("Choose 'up' (7-12) or 'down' (1-6).")
    
    async with async_session() as session:
        user = await get_user(session, update.message.from_user.id)
        bet = await parse_stake(user, args[1])
        if not bet or user.balance < bet:
            return await message.reply_text("❌ Invalid bet.")
        user.balance -= bet
        user.total_wagered += bet
        user.games_played += 1
        await session.commit()

    msg1 = await update.message.reply_dice(emoji="🎲")
    await asyncio.sleep(1)
    msg2 = await update.message.reply_dice(emoji="🎲")
    await asyncio.sleep(2)

    val1 = msg1.dice.value
    val2 = msg2.dice.value
    total = val1 + val2
    res = "up" if total >= 7 else "down"
    won = (choice == res)

    if won:
        payout = bet * 1.92
        async with async_session() as session:
            u = await get_user(session, update.message.from_user.id)
            u.balance += payout
            u.total_won += payout
            u.games_won += 1
            await session.commit()
            new_b = u.balance
        await update.message.reply_text(f"🎲 <b>7UP Win!</b>\nRolled: {val1} + {val2} = {total} ({res.upper()}).\nYou won ₹{payout:.2f}!\nBalance: ₹{new_b:.2f}", parse_mode="HTML")
    else:
        BOT_STATE["house_balance"] += bet
        async with async_session() as session:
            u = await get_user(session, update.message.from_user.id)
            u.games_lost += 1
            await session.commit()
        await update.message.reply_text(f"🎲 <b>7UP Loss</b>\nRolled: {val1} + {val2} = {total} ({res.upper()}).\nYou lost ₹{bet:.2f}.", parse_mode="HTML")

async def cmd_dr(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await security_middleware(update, context):
        return
    args = context.args
    if len(args) < 2:
        return await update.message.reply_text("Usage: <code>/dr [high/low/odd/even] [amount]</code>", parse_mode="HTML")
    choice = args[0].lower()
    if choice not in ["high", "low", "odd", "even"]:
        return await update.message.reply_text("Choose high, low, odd, or even.")

    async with async_session() as session:
        user = await get_user(session, update.message.from_user.id)
        bet = await parse_stake(user, args[1])
        if not bet or user.balance < bet:
            return await message.reply_text("❌ Invalid bet.")
        user.balance -= bet
        user.total_wagered += bet
        user.games_played += 1
        await session.commit()

    dice_msg = await update.message.reply_dice(emoji="🎲")
    await asyncio.sleep(2)
    val = dice_msg.dice.value

    won = False
    if choice == "low" and val in [1, 2, 3]: won = True
    elif choice == "high" and val in [4, 5, 6]: won = True
    elif choice == "odd" and val % 2 != 0: won = True
    elif choice == "even" and val % 2 == 0: won = True

    if won:
        payout = bet * 1.92
        async with async_session() as session:
            u = await get_user(session, update.message.from_user.id)
            u.balance += payout
            u.total_won += payout
            u.games_won += 1
            await session.commit()
            new_b = u.balance
        await update.message.reply_text(f"🎲 Dice Rush landed on {val} ({choice.upper()}). You won ₹{payout:.2f}!\nBalance: ₹{new_b:.2f}", parse_mode="HTML")
    else:
        BOT_STATE["house_balance"] += bet
        async with async_session() as session:
            u = await get_user(session, update.message.from_user.id)
            u.games_lost += 1
            await session.commit()
        await update.message.reply_text(f"📉 Dice Rush landed on {val}. ₹{bet:.2f} lost.", parse_mode="HTML")

async def cmd_odice(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await security_middleware(update, context):
        return
    args = context.args
    if not args:
        return await update.message.reply_text("Usage: <code>/odice [amount]</code>", parse_mode="HTML")
    async with async_session() as session:
        user = await get_user(session, update.message.from_user.id)
        bet = await parse_stake(user, args[0])
        if not bet or user.balance < bet:
            return await message.reply_text("❌ Invalid bet.")
        user.balance -= bet
        user.total_wagered += bet
        user.games_played += 1
        await session.commit()
    
    kb = InlineKeyboardMarkup([
        [InlineKeyboardButton(text="Heads 🪙", callback_data=f"odice_h_{bet}"), InlineKeyboardButton(text="Tails 🪙", callback_data=f"odice_t_{bet}")]
    ])
    await update.message.reply_text("🏟️ Open Match Toss — Pick side:", reply_markup=kb, parse_mode="HTML")

async def cb_odice(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    parts = query.data.split("_")
    bet = float(parts[2])
    side = parts[1]
    toss = random.choice(["h", "t"])
    won = (side == toss)

    if won:
        payout = bet * 1.92 * 0.96
        async with async_session() as session:
            u = await get_user(session, query.from_user.id)
            u.balance += payout
            u.total_won += payout
            u.games_won += 1
            await session.commit()
        await query.message.edit_text(f"🏏 Toss won! You batted and won ₹{payout:.2f}.", parse_mode="HTML")
    else:
        BOT_STATE["house_balance"] += bet * 0.96
        async with async_session() as session:
            u = await get_user(session, query.from_user.id)
            u.games_lost += 1
            await session.commit()
        await query.message.edit_text("🏏 Toss lost! Bowled out.", parse_mode="HTML")
    await query.answer()

async def cb_cancel_pvp(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    c_id = int(query.data.split("_")[2])
    if c_id not in ACTIVE_CHALLENGES:
        return await query.answer("Expired.", show_alert=True)
    challenge = ACTIVE_CHALLENGES.pop(c_id)
    if query.from_user.id != challenge["challenger_id"] and query.from_user.id not in ADMINS:
        return await query.answer("Only challenger can cancel.", show_alert=True)
    async with async_session() as session:
        user = await get_user(session, challenge["challenger_id"])
        user.balance += challenge["amount"]
        await session.commit()
    await query.message.edit_text("❌ Challenge cancelled & refunded.", parse_mode="HTML")
    await query.answer("Cancelled.")

async def cb_accept_pvp(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    c_id = int(query.data.split("_")[2])
    if c_id not in ACTIVE_CHALLENGES:
        return await query.answer("Challenge no longer available.", show_alert=True)
    challenge = ACTIVE_CHALLENGES.pop(c_id)
    acceptor_id = query.from_user.id
    if challenge["challenger_id"] == acceptor_id:
        return await query.answer("Cannot play against yourself.", show_alert=True)

    bet = challenge["amount"]
    async with async_session() as session:
        acc = await get_user(session, acceptor_id, query.from_user.username, query.from_user.first_name)
        if acc.balance < bet:
            return await query.answer("Insufficient balance.", show_alert=True)
        acc.balance -= bet
        acc.total_wagered += bet
        acc.games_played += 1
        await session.commit()

    if challenge["game"] == "coin":
        kb = InlineKeyboardMarkup([
            [InlineKeyboardButton(text="Heads 🪙", callback_data=f"coin_pick_{c_id}_heads"), InlineKeyboardButton(text="Tails 🪙", callback_data=f"coin_pick_{c_id}_tails")]
        ])
        ACTIVE_MATCHES[c_id] = {
            **challenge,
            "acceptor_id": acceptor_id,
            "acceptor_name": query.from_user.username or query.from_user.first_name,
        }
        await query.message.edit_text(
            f"<b>Coin Flip</b>\n"
            f"👤 @{challenge['challenger_name']} vs @{query.from_user.username or query.from_user.first_name}\n\n"
            f"@{query.from_user.username or query.from_user.first_name}, pick your side below:",
            reply_markup=kb,
            parse_mode="HTML"
        )
        return await query.answer()

    ACTIVE_MATCHES[c_id] = {
        **challenge,
        "acceptor_id": acceptor_id,
        "acceptor_name": query.from_user.username or query.from_user.first_name,
        "p1_scores": [], "p2_scores": [], "round": 1, "turn": challenge["challenger_id"]
    }

    await query.message.edit_text(
        f"<b>Match Started!</b>\n"
        f"Challenger: @{challenge['challenger_name']}\n"
        f"Opponent: @{query.from_user.username or query.from_user.first_name}\n\n"
        f"@{challenge['challenger_name']} send <b>{challenge['emoji']}</b> now (Round 1/{challenge['rounds']})",
        parse_mode="HTML"
    )
    await query.answer()

async def cb_coin_pick(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    parts = query.data.split("_")
    c_id = int(parts[2])
    pick = parts[3]
    if c_id not in ACTIVE_MATCHES:
        return await query.answer("Match expired.", show_alert=True)
    match = ACTIVE_MATCHES.pop(c_id)
    if query.from_user.id != match["acceptor_id"]:
        return await query.answer("Only opponent can pick side!", show_alert=True)

    opp_pick = pick
    chal_pick = "tails" if opp_pick == "heads" else "heads"

    await query.message.edit_text("🪙 Flipping the coin... coin in the air..... ⏳", parse_mode="HTML")
    await asyncio.sleep(2)

    result = random.choice(["heads", "tails"])
    won_chal = (chal_pick == result)
    winner_id = match["challenger_id"] if won_chal else match["acceptor_id"]
    loser_id = match["acceptor_id"] if won_chal else match["challenger_id"]
    winner_name = match["challenger_name"] if won_chal else match["acceptor_name"]
    loser_name = match["acceptor_name"] if won_chal else match["challenger_name"]

    payout = match["amount"] * 1.92
    async with async_session() as session:
        w = await get_user(session, winner_id)
        w.balance += payout
        w.total_won += payout
        w.games_won += 1
        l = await get_user(session, loser_id)
        l.games_lost += 1
        await session.commit()

    await query.message.reply_text(
        f"🪙 <b>Coin Flip Result!</b>\n\n"
        f"Coin landed on... <b>{result.upper()}</b>\n\n"
        f"@{match['challenger_name']}: {chal_pick}\n"
        f"@{match['acceptor_name']}: {opp_pick}\n\n"
        f"🏆 Winner: @{winner_name}\n"
        f"👻 Loser: @{loser_name}\n"
        f"🏦 Prize: ₹{payout:.2f} credited to wallet.",
        parse_mode="HTML"
    )
    await query.answer()

async def handle_native_dice(update: Update, context: ContextTypes.DEFAULT_TYPE):
    message = update.message
    if not message.dice:
        return
    chat_id = message.chat.id
    user_id = message.from_user.id
    val = message.dice.value
    emoji_sent = message.dice.emoji

    for m_id, m in ACTIVE_MATCHES.items():
        if m["chat_id"] == chat_id and (m["challenger_id"] == user_id or m["acceptor_id"] == user_id):
            if emoji_sent != m["emoji"]:
                return await message.reply_text(f"❌ Please send the correct game emoji: {m['emoji']}")
            if user_id != m["turn"]:
                return await message.reply_text("❌ Not your turn!")

            is_p1 = (user_id == m["challenger_id"])
            if is_p1:
                m["p1_scores"].append(val)
                m["turn"] = m["acceptor_id"]
                await message.reply_text(f"🏆 Round {m['round']}: @{m['challenger_name']} scored {val} ✔️\nNow @{m['acceptor_name']} turn to send {m['emoji']}", parse_mode="HTML")
            else:
                m["p2_scores"].append(val)
                if m["round"] < m["rounds"]:
                    m["round"] += 1
                    m["turn"] = m["challenger_id"]
                    await message.reply_text(f"🏆 Round {m['round']-1} finished!\nNow @{m['challenger_name']} send {m['emoji']} for Round {m['round']}", parse_mode="HTML")
                else:
                    ACTIVE_MATCHES.pop(m_id)
                    p1_tot = sum(m["p1_scores"])
                    p2_tot = sum(m["p2_scores"])
                    bet = m["amount"]
                    payout = bet * 1.92

                    if p1_tot > p2_tot:
                        winner_id = m["challenger_id"]
                        winner_name = m["challenger_name"]
                    elif p2_tot > p1_tot:
                        winner_id = m["acceptor_id"]
                        winner_name = m["acceptor_name"]
                    else:
                        async with async_session() as session:
                            u1 = await get_user(session, m["challenger_id"])
                            u2 = await get_user(session, m["acceptor_id"])
                            u1.balance += bet
                            u2.balance += bet
                            await session.commit()
                        return await message.reply_text("🤝 <b>IT'S A TIE!</b> Both rolled same score. Stakes refunded.", parse_mode="HTML")

                    loser_id = m["acceptor_id"] if winner_id == m["challenger_id"] else m["challenger_id"]
                    async with async_session() as session:
                        w = await get_user(session, winner_id)
                        w.balance += payout
                        w.total_won += payout
                        w.games_won += 1
                        l = await get_user(session, loser_id)
                        l.games_lost += 1
                        await session.commit()
                        new_b = w.balance

                    BOT_STATE["house_balance"] += bet * 0.08
                    await message.reply_text(
                        f"🏆 <b>Match Finished!</b>\n"
                        f"@{m['challenger_name']}: {p1_tot} pts\n"
                        f"@{m['acceptor_name']}: {p2_tot} pts\n\n"
                        f"🏆 Winner: <b>{winner_name}</b>\n"
                        f"₹{payout:.2f} credited to wallet!\nBalance: ₹{new_b:.2f}",
                        parse_mode="HTML"
                    )
            return

    for pvb_id, pvb in ACTIVE_PVB.items():
        if pvb["chat_id"] == chat_id and pvb["user_id"] == user_id:
            if emoji_sent != pvb["emoji"]:
                return await message.reply_text(f"❌ Send correct emoji: {pvb['emoji']}")
            bot_val = random.randint(1, 6)
            bot_msg = await message.reply_dice(emoji=pvb["emoji"])
            await asyncio.sleep(2)
            bot_score = bot_msg.dice.value

            won = val > bot_score
            tie = val == bot_score
            bet = pvb["amount"]

            if tie:
                async with async_session() as session:
                    u = await get_user(session, user_id)
                    u.balance += bet
                    await session.commit()
                ACTIVE_PVB.pop(pvb_id)
                return await message.reply_text(f"🤝 Tie! You rolled {val}, Bot rolled {bot_score}. Bet refunded.", parse_mode="HTML")

            ACTIVE_PVB.pop(pvb_id)
            if won:
                payout = bet * 1.92
                async with async_session() as session:
                    u = await get_user(session, user_id)
                    u.balance += payout
                    u.total_won += payout
                    u.games_won += 1
                    await session.commit()
                    new_b = u.balance
                await message.reply_text(f"🏆 <b>PvB Win!</b>\nYou: {val} | Bot: {bot_score}\nYou won ₹{payout:.2f}!\nBalance: ₹{new_b:.2f}", parse_mode="HTML")
            else:
                BOT_STATE["house_balance"] += bet
                async with async_session() as session:
                    u = await get_user(session, user_id)
                    u.games_lost += 1
                    await session.commit()
                await message.reply_text(f"❌ <b>PvB Loss</b>\nYou: {val} | Bot: {bot_score}\nYou lost ₹{bet:.2f}.", parse_mode="HTML")
            return

async def cmd_users(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.message.from_user.id not in ADMINS:
        return await update.message.reply_text("⛔ Admins only.")
    async with async_session() as session:
        total = (await session.execute(select(func.count(User.telegram_id)))).scalar() or 0
    await update.message.reply_text(f"👥 Total registered users: <b>{total}</b>", parse_mode="HTML")

async def cmd_user_info(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.message.from_user.id not in ADMINS:
        return await update.message.reply_text("⛔ Admins only.")
    args = context.args
    if not args:
        return await update.message.reply_text("Usage: <code>/user [user_id]</code>", parse_mode="HTML")
    uid = int(args[0])
    async with async_session() as session:
        u = await session.get(User, uid)
        if not u:
            return await update.message.reply_text("User not found.")
    await update.message.reply_text(
        f"👤 <b>User Info: {uid}</b>\nName: {u.first_name}\nUsername: @{u.username}\nBalance: ₹{u.balance:.2f}\nWager Req: ₹{u.wager_required:.2f}",
        parse_mode="HTML"
    )

async def cmd_balancededuct(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.message.from_user.id not in ADMINS:
        return
    args = context.args
    if len(args) < 2:
        return await update.message.reply_text("Usage: <code>/balancededuct [user_id] [amount]</code>", parse_mode="HTML")
    uid, amt = int(args[0]), float(args[1])
    async with async_session() as session:
        u = await get_user(session, uid)
        u.balance = max(0.0, u.balance - amt)
        await session.commit()
    await update.message.reply_text(f"✅ Deducted ₹{amt} from user {uid}.")

async def cmd_rain(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.message.from_user.id not in ADMINS:
        return
    args = context.args
    if not args:
        return await update.message.reply_text("Usage: <code>/rain [amount]</code>", parse_mode="HTML")
    total_amt = float(args[0])
    async with async_session() as session:
        users = (await session.execute(select(User))).scalars().all()
        if not users:
            return await update.message.reply_text("No users found to rain.")
        share = total_amt / len(users)
        for u in users:
            u.balance += share
        await session.commit()
    await update.message.reply_text(f"🌧️ Rained ₹{total_amt} across {len(users)} users (₹{share:.2f} each).")

async def cmd_hb(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.message.from_user.id not in ADMINS:
        return await update.message.reply_text("⛔ Admins only.")
    async with async_session() as session:
        total_users = (await session.execute(select(func.count(User.telegram_id)))).scalar() or 0
        total_bal = (await session.execute(select(func.sum(User.balance)))).scalar() or 0.0
    await update.message.reply_text(
        f"🏦 House Balance: ₹{BOT_STATE['house_balance']:.2f}\n"
        f"Total Users: {total_users}\n"
        f"Total Balances: ₹{total_bal:.2f}",
        parse_mode="HTML"
    )

async def cmd_panel(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.message.from_user.id not in ADMINS:
        return await update.message.reply_text("⛔ Admins only.")
    kb = InlineKeyboardMarkup([
        [InlineKeyboardButton(text="Pending Requests", callback_data="adm_pending"), InlineKeyboardButton(text="Users Count", callback_data="adm_users")]
    ])
    await update.message.reply_text("👑 Admin Control Panel", reply_markup=kb, parse_mode="HTML")

async def cb_adm_pending(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    if query.from_user.id not in ADMINS:
        return
    async with async_session() as session:
        txs = (await session.execute(select(Transaction).where(Transaction.status == "PENDING"))).scalars().all()
    if not txs:
        return await query.message.edit_text("No pending requests.")
    for tx in txs[:5]:
        kb = InlineKeyboardMarkup([
            [InlineKeyboardButton(text="Approve", callback_data=f"adm_dep_yes_{tx.id}"), InlineKeyboardButton(text="Reject", callback_data=f"adm_dep_no_{tx.id}")]
        ])
        await query.message.reply_text(f"TX #{tx.id} | Type: {tx.type} | Amt: ₹{tx.amount}", reply_markup=kb)
    await query.answer()

async def cb_approve_dep(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    if query.from_user.id not in ADMINS:
        return
    tx_id = int(query.data.split("_")[3])
    async with async_session() as session:
        tx = await session.get(Transaction, tx_id)
        if not tx: return await query.answer("Not found.")
        tx.status = "APPROVED"
        user = await get_user(session, tx.telegram_id)
        user.balance += tx.amount
        user.wager_required += tx.amount
        await session.commit()
        new_b = user.balance
        uid = tx.telegram_id
        amt = tx.amount

    try:
        if tx.type == "DEPOSIT":
            await context.bot.send_message(
                uid,
                f"✅ <b>Deposit Approved!</b>\n\n"
                f"Credited: ₹{amt}\n"
                f"Balance: ₹{new_b:.2f}\n\n"
                f"Wager ₹{amt} before withdrawing (1x deposit rule)\nPlay any game to clear it — /wagerstatus to track",
                parse_mode="HTML"
            )
        else:
            await context.bot.send_message(
                uid,
                "✅ Your withdrawal request has been successfully sent/processed! Check your wallet or contact /support",
                parse_mode="HTML"
            )
    except Exception:
        pass
    await query.message.edit_text(f"✅ Transaction #{tx_id} approved.")
    await query.answer("Approved!")

async def cb_reject_dep(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    if query.from_user.id not in ADMINS:
        return
    tx_id = int(query.data.split("_")[3])
    async with async_session() as session:
        tx = await session.get(Transaction, tx_id)
        if tx:
            tx.status = "REJECTED"
            uid = tx.telegram_id
            await session.commit()
    try:
        await context.bot.send_message(
            uid,
            "❌ Your withdrawal/deposit is rejected. Kindly contact support by sending /support or /help below",
            parse_mode="HTML"
        )
    except Exception:
        pass
    await query.message.edit_text(f"❌ Transaction #{tx_id} rejected.")
    await query.answer("Rejected.")

async def cmd_balanceadd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.message.from_user.id not in ADMINS: return
    args = context.args
    if len(args) < 2: return await update.message.reply_text("Usage: /balanceadd [user_id] [amount]")
    uid, amt = int(args[0]), float(args[1])
    async with async_session() as session:
        u = await get_user(session, uid)
        u.balance += amt
        await session.commit()
    await update.message.reply_text(f"✅ Credited ₹{amt} to {uid}.")

async def cmd_creategift(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.message.from_user.id not in ADMINS: return
    args = context.args
    if len(args) < 2: return await update.message.reply_text("Usage: /creategift [code] [amount]")
    code, amt = args[0], float(args[1])
    async with async_session() as session:
        session.add(GiftCode(code=code, amount=amt))
        await session.commit()
    await update.message.reply_text(f"✅ Gift code {code} created for ₹{amt}.")

async def cmd_broadcast(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.message.from_user.id not in ADMINS: return
    text = " ".join(context.args)
    if not text:
        return await update.message.reply_text("Please provide message to broadcast.")
    async with async_session() as session:
        users = (await session.execute(select(User.telegram_id))).scalars().all()
    for uid in users:
        try: await context.bot.send_message(uid, text, parse_mode="HTML")
        except Exception: pass
    await update.message.reply_text("✅ Broadcast sent.")

def main():
    asyncio.run(init_db())
    app = Application.builder().token(BOT_TOKEN).build()

    deposit_conv = ConversationHandler(
        entry_points=[CommandHandler("deposit", cmd_deposit), CallbackQueryHandler(choose_deposit_gateway, pattern="^dep_")],
        states={
            DEP_AMOUNT: [MessageHandler(filters.TEXT & ~filters.COMMAND, process_deposit_amount)],
            DEP_PROOF: [
                CallbackQueryHandler(cb_dep_paid, pattern="^dep_paid_confirm$"),
                MessageHandler(filters.TEXT & ~filters.COMMAND, process_deposit_utr)
            ],
            DEP_PHOTO: [MessageHandler(filters.PHOTO, process_deposit_screenshot)]
        },
        fallbacks=[]
    )

    withdraw_conv = ConversationHandler(
        entry_points=[CommandHandler("withdraw", cmd_withdraw)],
        states={
            WD_AMOUNT: [MessageHandler(filters.TEXT & ~filters.COMMAND, process_withdraw_amount)],
            WD_ADDRESS: [MessageHandler(filters.TEXT & ~filters.COMMAND, process_withdraw_address)]
        },
        fallbacks=[]
    )

    wallet_conv = ConversationHandler(
        entry_points=[CommandHandler("setwallet", cmd_setwallet)],
        states={
            SET_WALLET: [MessageHandler(filters.TEXT & ~filters.COMMAND, process_setwallet_address)]
        },
        fallbacks=[]
    )

    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("help", cmd_help))
    app.add_handler(CommandHandler("support", cmd_help))
    app.add_handler(CommandHandler("games", cmd_games))
    app.add_handler(CommandHandler("wallet", cmd_wallet))
    app.add_handler(CommandHandler("bal", cmd_wallet))
    app.add_handler(CommandHandler("wal", cmd_wallet))
    app.add_handler(CommandHandler("changecurrency", cmd_changecurrency))
    app.add_handler(CommandHandler("saveupi", cmd_saveupi))
    app.add_handler(CommandHandler("refer", cmd_refer))
    app.add_handler(CommandHandler("referral", cmd_refer))
    app.add_handler(CommandHandler("referrals", cmd_refer))
    app.add_handler(CommandHandler("mystats", cmd_mystats))
    app.add_handler(CommandHandler("rank", cmd_leaderboard))
    app.add_handler(CommandHandler("leaderboard", cmd_leaderboard))
    app.add_handler(CommandHandler("wagerstatus", cmd_wager))
    app.add_handler(CommandHandler("tip", cmd_tip))
    app.add_handler(CommandHandler("claim", cmd_claim))
    app.add_handler(CommandHandler("dice", cmd_dice))
    app.add_handler(CommandHandler("darts", cmd_darts))
    app.add_handler(CommandHandler("bowling", cmd_bowling))
    app.add_handler(CommandHandler("basket", cmd_basket))
    app.add_handler(CommandHandler("football", cmd_football))
    app.add_handler(CommandHandler("slots", cmd_slots))
    app.add_handler(CommandHandler("coin", cmd_coin))
    app.add_handler(CommandHandler("7up", cmd_7up))
    app.add_handler(CommandHandler("dr", cmd_dr))
    app.add_handler(CommandHandler("odice", cmd_odice))
    app.add_handler(CommandHandler("hb", cmd_hb))
    app.add_handler(CommandHandler("panel", cmd_panel))
    app.add_handler(CommandHandler("admincommands", cmd_panel))
    app.add_handler(CommandHandler("balanceadd", cmd_balanceadd))
    app.add_handler(CommandHandler("balancededuct", cmd_balancededuct))
    app.add_handler(CommandHandler("users", cmd_users))
    app.add_handler(CommandHandler("user", cmd_user_info))
    app.add_handler(CommandHandler("rain", cmd_rain))
    app.add_handler(CommandHandler("creategift", cmd_creategift))
    app.add_handler(CommandHandler("broadcast", cmd_broadcast))
    app.add_handler(CommandHandler("maintenance", cmd_maintenance))

    app.add_handler(deposit_conv)
    app.add_handler(withdraw_conv)
    app.add_handler(wallet_conv)

    app.add_handler(CallbackQueryHandler(cb_menu_deposit, pattern="^menu_deposit$"))
    app.add_handler(CallbackQueryHandler(cb_menu_withdraw, pattern="^menu_withdraw$"))
    app.add_handler(CallbackQueryHandler(cb_menu_wallet, pattern="^menu_wallet$"))
    app.add_handler(CallbackQueryHandler(cb_menu_games, pattern="^menu_games$"))
    app.add_handler(CallbackQueryHandler(cb_menu_referral, pattern="^menu_referral$"))
    app.add_handler(CallbackQueryHandler(cb_menu_stats, pattern="^menu_stats$"))
    app.add_handler(CallbackQueryHandler(cb_menu_support, pattern="^menu_support$"))
    app.add_handler(CallbackQueryHandler(cb_toggle_currency, pattern="^toggle_currency$"))
    app.add_handler(CallbackQueryHandler(cb_setwallet, pattern="^btn_setwallet$"))
    app.add_handler(CallbackQueryHandler(cb_set_crypto_wallet, pattern="^set_w_"))
    app.add_handler(CallbackQueryHandler(cb_tip_action, pattern="^tip_"))
    app.add_handler(CallbackQueryHandler(cb_odice, pattern="^odice_"))
    app.add_handler(CallbackQueryHandler(cb_coin_pick, pattern="^coin_pick_"))
    app.add_handler(CallbackQueryHandler(cb_cancel_pvp, pattern="^pvp_can_"))
    app.add_handler(CallbackQueryHandler(cb_accept_pvp, pattern="^pvp_acc_"))
    app.add_handler(CallbackQueryHandler(cb_pvp_rounds, pattern="^pvp_rnd_"))
    app.add_handler(CallbackQueryHandler(cb_adm_pending, pattern="^adm_pending$"))
    app.add_handler(CallbackQueryHandler(cb_approve_dep, pattern="^adm_dep_yes_"))
    app.add_handler(CallbackQueryHandler(cb_reject_dep, pattern="^adm_dep_no_"))
    app.add_handler(CallbackQueryHandler(cb_approve_dep, pattern="^adm_wd_yes_"))
    app.add_handler(CallbackQueryHandler(cb_reject_dep, pattern="^adm_wd_no_"))

    app.add_handler(MessageHandler(filters.Dice.ALL, handle_native_dice))

    logger.info("Rolex Casino Bot updated & started successfully with custom premium emojis cleaned.")
    app.run_polling()

if __name__ == "__main__":
    main()
