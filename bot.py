import os
import random
import asyncio
import logging
from datetime import datetime
from dotenv import load_dotenv

# Load local environment variables if available (.env file)
load_dotenv()

from aiogram import Bot, Dispatcher, Router, types, F
from aiogram.filters import Command, CommandStart
from aiogram.fsm.storage.memory import MemoryStorage
from aiogram.fsm.state import State, StatesGroup
from aiogram.fsm.context import FSMContext
from aiogram.types import (
    InlineKeyboardMarkup, InlineKeyboardButton,
    ReplyKeyboardMarkup, KeyboardButton
)
from sqlalchemy import BigInteger, String, Float, Boolean, Column, DateTime, Integer, select, func, desc
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession

# --- CONFIGURATION & ENVIRONMENT ---
BOT_TOKEN = os.getenv("BOT_TOKEN", "8673935058:AAGjyla-Im0LenfSNeyNJ5btScwcvfGI6oo")
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite+aiosqlite:////data/rolex_casino.db")
GROUP_ID = int(os.getenv("GROUP_ID", "-1004458883943"))
LOG_CHANNEL_ID = int(os.getenv("LOG_CHANNEL_ID", "-1004458883943"))
GROUP_LINK = os.getenv("GROUP_LINK", "https://t.me/RolexCasinos")
BOT_USERNAME = os.getenv("BOT_USERNAME", "Rolex_C_BOT")

# Referral bonus in INR (₹5 per user)
REFERRAL_BONUS = float(os.getenv("REFERRAL_BONUS", "5.0"))
DEFAULT_START_BALANCE = 0.0  # Starting balance is strictly 0₹ / 0$ as requested
USDT_RATE = float(os.getenv("USDT_RATE", "94.47"))
WITHDRAWAL_FEE_PCT = 0.02  # 2% fee on withdrawals

# Parse Admin IDs safely from CSV or fallback
raw_admins = os.getenv("ADMIN_IDS", "8362081186,1053006219,8860529495")
ADMINS = {int(x.strip()) for x in raw_admins.split(",") if x.strip().isdigit()}

# Payment Gateways (Rolex Casino Addresses - strictly preserved)
UPI_ADDRESS = os.getenv("UPI_ADDRESS", "rutvik1209@fam")
CRYPTO_WALLETS = {
    "BEP20": os.getenv("WALLET_BEP20", "0xD8419224A65C3d35C10AE695562463c8445ACb15"),
    "SOLANA": os.getenv("WALLET_SOLANA", "3bKsCSR2mmconFaExejbkuGfeQNuVQPFttzj9y2MP2mE"),
    "ETHEREUM": os.getenv("WALLET_ETHEREUM", "0xD8419224A65C3d35C10AE695562463c8445ACb15"),
    "BITCOIN": os.getenv("WALLET_BITCOIN", "bc1qsm7xzn4k8kpxwurzjsredangepvzgh70y0ypzd")
}

# Ensure SQLite directory exists if using persistent volume (e.g., /data)
if DATABASE_URL.startswith("sqlite+aiosqlite:////"):
    sqlite_path = DATABASE_URL.replace("sqlite+aiosqlite:////", "/")
    os.makedirs(os.path.dirname(sqlite_path), exist_ok=True)
elif DATABASE_URL.startswith("sqlite+aiosqlite:///"):
    sqlite_rel = DATABASE_URL.replace("sqlite+aiosqlite:///", "")
    if "/" in sqlite_rel:
        os.makedirs(os.path.dirname(sqlite_rel), exist_ok=True)

# Convert standard postgres URL to asyncpg driver if Railway provides standard URL
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql+asyncpg://", 1)
elif DATABASE_URL.startswith("postgresql://"):
    DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+asyncpg://", 1)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("RolexCasino")

# --- DATABASE MODELS ---
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
    currency: Mapped[str] = mapped_column(String, default="INR")  # "INR" or "USD"
    payout_address: Mapped[str] = mapped_column(String, nullable=True)
    
    # Referral System
    referred_by: Mapped[int] = mapped_column(BigInteger, nullable=True)
    referral_count: Mapped[int] = mapped_column(Integer, default=0)
    referral_earnings: Mapped[float] = mapped_column(Float, default=0.0)

    # Game Statistics
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
    type: Mapped[str] = mapped_column(String)  # DEPOSIT / WITHDRAW / TIP / REFERRAL / ADMIN_ADD
    amount: Mapped[float] = mapped_column(Float)
    method: Mapped[str] = mapped_column(String)
    proof_ref: Mapped[str] = mapped_column(String, nullable=True)
    status: Mapped[str] = mapped_column(String, default="PENDING")  # PENDING / APPROVED / REJECTED / COMPLETED
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

class GiftCode(Base):
    __tablename__ = "gift_codes"
    code: Mapped[str] = mapped_column(String, primary_key=True)
    amount: Mapped[float] = mapped_column(Float)
    is_claimed: Mapped[bool] = mapped_column(Boolean, default=False)
    claimed_by: Mapped[int] = mapped_column(BigInteger, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

# Async Engine with greenlet support
engine = create_async_engine(DATABASE_URL, echo=False)
async_session = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

async def init_db():
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        logger.info("Database schema initialized successfully.")
    except Exception as e:
        logger.error(f"Failed to initialize database: {e}")
        raise

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

class DepositStates(StatesGroup):
    waiting_for_amount = State()
    waiting_for_proof = State()
    waiting_for_photo = State()

class WithdrawStates(StatesGroup):
    waiting_for_amount = State()
    waiting_for_address = State()

class SetWalletStates(StatesGroup):
    waiting_for_address = State()

class AdminStates(StatesGroup):
    broadcast_text = State()

ACTIVE_CHALLENGES = {}
ACTIVE_MATCHES = {}
MATCH_COUNTER = 0

def get_channel_lock_kb():
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="📢 Join Official Group 🌐", url=GROUP_LINK)],
        [InlineKeyboardButton(text="📥 Deposit Funds 💵", url=f"https://t.me/{BOT_USERNAME}?start=deposit")]
    ])

def get_dm_redirect_kb():
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="🤖 Open Bot in DM 📩", url=f"https://t.me/{BOT_USERNAME}")]
    ])

def get_main_menu_kb():
    return InlineKeyboardMarkup(inline_keyboard=[
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

async def security_middleware(handler, event: types.TelegramObject, data: dict):
    if isinstance(event, types.CallbackQuery):
        message = event.message
        user = event.from_user
    elif isinstance(event, types.Message):
        message = event
        user = event.from_user
    elif isinstance(event, types.Update):
        message = event.message or (event.callback_query.message if event.callback_query else None)
        user = (event.message.from_user if event.message else 
                (event.callback_query.from_user if event.callback_query else None))
    else:
        return await handler(event, data)
    
    if not message or not user:
        return await handler(event, data)

    chat_type = message.chat.type
    is_admin = user.id in ADMINS

    async with async_session() as session:
        db_user = await session.get(User, user.id)
        if db_user and db_user.is_banned and not is_admin:
            if isinstance(event, types.CallbackQuery):
                return await event.answer("⛔ Your account has been suspended by Rolex Security.", show_alert=True)
            if chat_type == "private":
                return await message.answer("⛔ <b>Your account has been suspended by Rolex Casino Security.</b>", parse_mode="HTML")
            return

    if BOT_STATE["maintenance"] and not is_admin:
        if isinstance(event, types.CallbackQuery):
            return await event.answer("⚠️ Bot is currently under maintenance. Bets are paused.", show_alert=True)
        if chat_type in ["group", "supergroup"]:
            return
        return await message.answer("⚠️ <b>Rolex Casino is currently under scheduled maintenance.</b> Please check back soon!", parse_mode="HTML")

    text = message.text or message.caption or ""
    raw_cmd = text.split()[0].lower() if text.startswith("/") else ""
    command = raw_cmd.split("@")[0]

    admin_commands = {"/panel", "/pending", "/user", "/users", "/creategift", "/balanceadd", "/ban", "/unban", "/broadcast", "/admincommands", "/announcement", "/hb", "/maintenance", "/restart"}
    if command in admin_commands and chat_type in ["group", "supergroup"]:
        try: await message.delete()
        except Exception: pass
        return await message.answer(
            f"⛔ <b>{user.first_name}, administrative commands can only be executed securely inside our DM inbox!</b>",
            reply_markup=get_dm_redirect_kb(),
            parse_mode="HTML"
        )

    dm_only_commands = {"/deposit", "/withdraw", "/setwallet", "/changecurrency"}
    if command in dm_only_commands and chat_type in ["group", "supergroup"]:
        try: await message.delete()
        except Exception: pass
        return await message.answer(
            f"⛔ <b>{user.first_name}, wallet & payment commands can only be accessed securely inside DM!</b>",
            reply_markup=get_dm_redirect_kb(),
            parse_mode="HTML"
        )

    game_commands = {"/dice", "/basket", "/darts", "/football", "/bowling", "/slots", "/coin", "/battle", "/7up", "/dr", "/odice"}
    if command in game_commands and chat_type == "private" and not is_admin:
        await message.answer(
            "🎲 <b>PvP Casino games are strictly multiplayer and restricted to our official group arena!</b>\nJoin and play against real players below:",
            reply_markup=get_channel_lock_kb(),
            parse_mode="HTML"
        )
        return

    return await handler(event, data)

async def parse_stake(user: User, raw_arg: str) -> float | None:
    raw = raw_arg.strip().lower()
    if raw == "all":
        return round(user.balance, 2)
    elif raw == "half":
        return round(user.balance / 2, 2)
    try:
        amt = float(raw)
        if user.currency == "USD":
            amt = amt * USDT_RATE
        if amt <= 0:
            return None
        return round(amt, 2)
    except ValueError:
        return None

router = Router()

@router.message(CommandStart())
async def cmd_start(message: types.Message, state: FSMContext):
    user_id = message.from_user.id
    username = message.from_user.username or ""
    first_name = message.from_user.first_name or "Player"

    if message.chat.type in ["group", "supergroup"]:
        kb = InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text="✨ Join Community", url=GROUP_LINK)],
            [InlineKeyboardButton(text="💬 Open Bot Chat", url=f"https://t.me/{BOT_USERNAME}")]
        ])
        return await message.answer(
            f"✨ <b>Welcome, {first_name}!</b>\n\n"
            f"‼️ <b>I'm Rolex–Casino-Bot</b>\n\n"
            f"This bot works only inside the Official Group. Tap the button below to join and start playing.",
            reply_markup=kb,
            parse_mode="HTML"
        )
    
    args = message.text.split()
    inviter_id = None
    if len(args) > 1:
        param = args[1].strip()
        if param == "deposit":
            return await start_deposit_flow(message, state)
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
                        await message.bot.send_message(
                            inviter_id,
                            f"🎁 <b>New Referral Joined!</b>\n\n👤 Player: @{username or first_name}\n💵 Bonus: <b>+₹{REFERRAL_BONUS:.2f}</b> added to your wallet!\n💼 New Balance: <b>₹{inviter.balance:.2f}</b>",
                            parse_mode="HTML"
                        )
                    except Exception:
                        pass
                    await send_log(message.bot, f"🎁 <b>Referral Bonus</b>: `{inviter_id}` earned ₹{REFERRAL_BONUS:.2f} from new user `{user_id}` (@{username})")

        else:
            if username and user.username != username:
                user.username = username
            if first_name and user.first_name != first_name:
                user.first_name = first_name
            await session.commit()

    welcome_text = (
        f"✨ <b>Welcome, {first_name}!</b> ✨\n\n"
        f"‼️ <b>I'm Rolex–Casino-Bot</b>\n\n"
        f"👤 <b>Player:</b> {first_name} (@{username or 'N/A'})\n"
        f"🆔 <b>User ID:</b> <code>{user_id}</code>\n"
        f"💰 <b>Main Balance:</b> {fmt_money(user.balance, user.currency)}\n"
        f"🏦 <b>Bank Vault:</b> {fmt_money(user.bank, user.currency)}\n"
        f"👥 <b>Referrals:</b> {user.referral_count} (Earned: ₹{user.referral_earnings:.2f})\n\n"
        f"⚔️ <b>100% Real PvP Multiplayer:</b> Multiplier: <b>1.92×</b>.\n\n"
        f"👇 <i>Use the control panel below to deposit, withdraw, or view games:</i>"
    )
    await message.answer(welcome_text, reply_markup=get_main_menu_kb(), parse_mode="HTML")

@router.callback_query(F.data == "menu_deposit")
async def cb_menu_deposit(callback: types.CallbackQuery, state: FSMContext):
    await start_deposit_flow(callback.message, state)
    await callback.answer()

@router.callback_query(F.data == "menu_withdraw")
async def cb_menu_withdraw(callback: types.CallbackQuery, state: FSMContext):
    await cmd_withdraw(callback.message, state)
    await callback.answer()

@router.callback_query(F.data == "menu_wallet")
async def cb_menu_wallet(callback: types.CallbackQuery):
    await cmd_wallet(callback.message)
    await callback.answer()

@router.callback_query(F.data == "menu_games")
async def cb_menu_games(callback: types.CallbackQuery):
    await cmd_games(callback.message)
    await callback.answer()

@router.callback_query(F.data == "menu_referral")
async def cb_menu_referral(callback: types.CallbackQuery):
    await cmd_refer(callback.message)
    await callback.answer()

@router.callback_query(F.data == "menu_stats")
async def cb_menu_stats(callback: types.CallbackQuery):
    await cmd_mystats(callback.message)
    await callback.answer()

@router.callback_query(F.data == "menu_support")
async def cb_menu_support(callback: types.CallbackQuery):
    await cmd_support_msg(callback.message)
    await callback.answer()

@router.message(Command("help"))
async def cmd_help(message: types.Message):
    txt = (
        "🎧 <b>CUSTOMER SUPPORT</b>\n"
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
        "Please provide complete and accurate information so our admins can resolve your issue quickly.\n\n"
        "👑 Admin Notice:\n"
        "For admin-related matters, please inform the admins directly."
    )
    await message.answer(txt, parse_mode="HTML")

@router.message(Command("support"))
async def cmd_support_msg(message: types.Message):
    await cmd_help(message)

@router.message(Command("games"))
async def cmd_games(message: types.Message):
    txt = (
        "🤍 <b>AVAILABLE GAMES</b>\n\n"
        "👋 <b>Rock • Paper • Scissors</b>\n"
        "🤑 <b>Coin Flip</b> (/coin)\n"
        "💕 <b>Dice</b> (/dice)\n"
        "😳 <b>Darts</b> (/darts)\n"
        "🏀 <b>Basketball</b> (/basket)\n"
        "⚽️ <b>Football</b> (/football)\n"
        "6️⃣ <b>Bowling</b> (/bowling)\n"
        "🎰 <b>Slots</b> (/slots)\n"
        "🏰 <b>Towers</b>\n"
        "🚀 <b>Limbo</b>\n"
        "🎲 <b>Dice rush(dr)</b> (/dr)\n"
        "🎲 <b>7up</b> (/7up)\n"
        "🃏 <b>BlackJack (bj)</b>\n"
        "💣 <b>Mines</b>\n"
        "🔒 <b>Vault</b>\n"
        "🏏 <b>Cricket Dice</b> (/odice)\n\n"
        "Interactive games will be added soon."
    )
    kb = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="📢 Enter Official Game Group 🎮", url=GROUP_LINK)]
    ])
    await message.answer(txt, reply_markup=kb, parse_mode="HTML")

@router.message(Command("wallet", "bal", "wal"))
async def cmd_wallet(message: types.Message):
    async with async_session() as session:
        user = await get_user(session, message.from_user.id, message.from_user.username, message.from_user.first_name)
    
    payout_info = f"<code>{user.payout_address}</code>" if user.payout_address else "<i>Not set (use /setwallet)</i>"
    
    txt = (
        f"🏦 <b>Your Wallet</b>\n"
        f"💵 <b>Balance:</b> {fmt_money(user.balance, user.currency)}\n"
        f"👨‍💻 <b>UPI:</b> {payout_info}\n"
        f"⚠️ <b>Promo Lock:</b> {fmt_money(user.wager_required, user.currency)} bonus locked\n"
        f"📈 <b>Wager {fmt_money(user.wager_required, user.currency)}</b> more to unlock withdrawal\n"
        f"(Play wallet bets to clear it)\n"
        f"Min withdrawal: $1/100₹"
    )
    kb = InlineKeyboardMarkup(inline_keyboard=[
        [
            InlineKeyboardButton(text="📥 Deposit 🟢", callback_data="menu_deposit"),
            InlineKeyboardButton(text="📤 Withdraw 🔴", callback_data="menu_withdraw")
        ],
        [
            InlineKeyboardButton(text="💱 Toggle Currency (INR/USD)", callback_data="toggle_currency"),
            InlineKeyboardButton(text="📝 Set Payout Wallet", callback_data="btn_setwallet")
        ]
    ])
    await message.answer(txt, reply_markup=kb, parse_mode="HTML")

@router.callback_query(F.data == "toggle_currency")
async def cb_toggle_currency(callback: types.CallbackQuery):
    async with async_session() as session:
        user = await get_user(session, callback.from_user.id)
        user.currency = "USD" if user.currency == "INR" else "INR"
        await session.commit()
        new_curr = user.currency
    await callback.answer(f"Currency changed to {new_curr}!", show_alert=True)
    await cmd_wallet(callback.message)

@router.message(Command("changecurrency"))
async def cmd_changecurrency(message: types.Message):
    async with async_session() as session:
        user = await get_user(session, message.from_user.id)
        user.currency = "USD" if user.currency == "INR" else "INR"
        await session.commit()
        new_curr = user.currency
    await message.answer(f"💱 <b>Display currency successfully updated to:</b> {new_curr}", parse_mode="HTML")

@router.message(Command("setwallet"))
async def cmd_setwallet(message: types.Message, state: FSMContext):
    args = message.text.split(maxsplit=1)
    if len(args) > 1:
        address = args[1].strip()
        async with async_session() as session:
            user = await get_user(session, message.from_user.id)
            user.payout_address = address
            await session.commit()
        return await message.answer(f"👨‍💻 <b>Saved UPI:</b>\n<code>{address}</code>", parse_mode="HTML")

    kb = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="BSC (BEP20)", callback_data="set_w_bep20"), InlineKeyboardButton(text="SOLANA", callback_data="set_w_sol")],
        [InlineKeyboardButton(text="ETHEREUM", callback_data="set_w_eth"), InlineKeyboardButton(text="BITCOIN", callback_data="set_w_btc")]
    ])
    await message.answer("👨‍💻 <b>Save Your UPI</b>\nEnter your UPI ID:\nExample: <code>yourname@ybl</code> or <code>9876543210@paytm</code>", reply_markup=kb, parse_mode="HTML")
    await state.set_state(SetWalletStates.waiting_for_address)

@router.callback_query(F.data.startswith("set_w_"))
async def cb_set_crypto_wallet(callback: types.CallbackQuery, state: FSMContext):
    net = callback.data.split("_")[2].upper()
    await state.update_data(crypto_net=net)
    await callback.message.answer(f"Send your {net} crypto address:", parse_mode="HTML")
    await callback.answer()

@router.callback_query(F.data == "btn_setwallet")
async def cb_setwallet(callback: types.CallbackQuery, state: FSMContext):
    await state.set_state(SetWalletStates.waiting_for_address)
    await callback.message.answer("👨‍💻 <b>Save Your UPI</b>\nEnter your UPI ID:\nExample: <code>yourname@ybl</code>", parse_mode="HTML")
    await callback.answer()

@router.message(SetWalletStates.waiting_for_address)
async def process_setwallet_address(message: types.Message, state: FSMContext):
    address = message.text.strip()
    if len(address) < 4:
        return await message.answer("❌ Invalid wallet address. Please enter a valid UPI ID or Crypto wallet.")

    async with async_session() as session:
        user = await get_user(session, message.from_user.id)
        user.payout_address = address
        await session.commit()

    await state.clear()
    await message.answer(f"👨‍💻 <b>Saved UPI:</b>\n<code>{address}</code>", parse_mode="HTML")

@router.message(Command("saveupi"))
async def cmd_saveupi(message: types.Message):
    args = message.text.split(maxsplit=1)
    if len(args) < 2:
        return await message.answer("Usage: <code>/saveupi newupi@bank</code>", parse_mode="HTML")
    address = args[1].strip()
    async with async_session() as session:
        user = await get_user(session, message.from_user.id)
        user.payout_address = address
        await session.commit()
    await message.answer(f"👨‍💻 <b>Saved UPI:</b>\n<code>{address}</code>", parse_mode="HTML")

@router.message(Command("refer", "referral", "referrals"))
async def cmd_refer(message: types.Message):
    user_id = message.from_user.id
    ref_link = f"https://t.me/{BOT_USERNAME}?start=ref_{user_id}"

    async with async_session() as session:
        user = await get_user(session, user_id, message.from_user.username, message.from_user.first_name)

    txt = (
        f"🎁 <b>Rolex Casino Referral Program</b>\n\n"
        f"Earn <b>₹{REFERRAL_BONUS:.2f}</b> instantly for every friend you invite to Rolex Casino!\n\n"
        f"🔗 <b>Your Exclusive Referral Link:</b>\n"
        f"<code>{ref_link}</code>\n\n"
        f"📊 <b>Your Referral Statistics:</b>\n"
        f"• Total Invited Players: <b>{user.referral_count}</b>\n"
        f"• Total Referral Earnings: <b>₹{user.referral_earnings:.2f}</b>"
    )
    kb = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="🚀 Share Referral Link 📲", url=f"https://t.me/share/url?url={ref_link}&text=Join%20Rolex%20Casino%20PvP%20and%20play%20live%20games!")]
    ])
    await message.answer(txt, reply_markup=kb, parse_mode="HTML")

@router.message(Command("mystats"))
async def cmd_mystats(message: types.Message):
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
    await message.answer(txt, parse_mode="HTML")

@router.message(Command("rank", "leaderboard"))
async def cmd_leaderboard(message: types.Message):
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

    await message.answer(txt, parse_mode="HTML")

@router.message(Command("wagerstatus"))
async def cmd_wager(message: types.Message):
    async with async_session() as session:
        user = await get_user(session, message.from_user.id)
    
    status_icon = "🟢 Clear" if user.wager_required <= 0 else "⚠️ Locked"
    txt = (
        f"📊 <b>Rolex Casino — 1× Wagering Status</b>\n\n"
        f"• Status: {status_icon}\n"
        f"• Pending Wager Requirement: <b>{fmt_money(user.wager_required, user.currency)}</b>\n"
        f"• Total Wager Completed: <b>{fmt_money(user.wager_completed, user.currency)}</b>"
    )
    await message.answer(txt, parse_mode="HTML")

@router.message(Command("tip"))
async def cmd_tip(message: types.Message):
    sender_id = message.from_user.id
    args = message.text.split()
    
    recipient = None
    raw_amount = None

    if message.reply_to_message:
        recipient = message.reply_to_message.from_user
        if len(args) > 1:
            raw_amount = args[1]
    elif len(args) >= 3 and args[1].startswith("@"):
        target_tag = args[1].replace("@", "").lower()
        raw_amount = args[2]
        async with async_session() as session:
            recipient = (await session.execute(select(User).where(func.lower(User.username) == target_tag))).scalar_one_or_none()
            if not recipient:
                return await message.answer(f"❌ User @{target_tag} has not registered on Rolex Casino yet.")
    else:
        return await message.answer("Usage:\n• Reply to a user: <code>/tip [amount]</code>\n• Or: <code>/tip @username [amount]</code>", parse_mode="HTML")

    if not raw_amount:
        return await message.answer("❌ Please specify the tip amount.", parse_mode="HTML")

    target_id = recipient.id if hasattr(recipient, "id") else recipient.telegram_id
    target_name = recipient.username or recipient.first_name

    if target_id == sender_id:
        return await message.answer("❌ You cannot tip yourself!")

    async with async_session() as session:
        sender = await get_user(session, sender_id, message.from_user.username, message.from_user.first_name)
        amount = await parse_stake(sender, raw_amount)
        if not amount or amount <= 0:
            return await message.answer("❌ Invalid tip amount.")
        if sender.balance < amount:
            return await message.answer(f"❌ Insufficient balance! You have {fmt_money(sender.balance, sender.currency)}.")

    kb = InlineKeyboardMarkup(inline_keyboard=[
        [
            InlineKeyboardButton(text="Confirm ✅", callback_data=f"tip_yes_{target_id}_{amount}"),
            InlineKeyboardButton(text="Cancel ❌", callback_data=f"tip_no_{target_id}_{amount}")
        ]
    ])
    await message.answer(
        f"sending a tip\nAmount: {fmt_money(amount, sender.currency)}\nFrom: @{message.from_user.username or message.from_user.first_name}\nTo: @{target_name}",
        reply_markup=kb,
        parse_mode="HTML"
    )

@router.callback_query(F.data.startswith("tip_"))
async def cb_tip_action(callback: types.CallbackQuery):
    parts = callback.data.split("_")
    action = parts[1]
    target_id = int(parts[2])
    amount = float(parts[3])
    sender_id = callback.from_user.id

    if action == "no":
        await callback.message.edit_text(
            f"Tip transaction cancel refund to your account\nFrom » @{callback.from_user.username or callback.from_user.first_name}\nTo » @{target_id}\nAmount » ₹{amount:.2f}",
            parse_mode="HTML"
        )
        return await callback.answer("Tip cancelled.")

    async with async_session() as session:
        sender = await get_user(session, sender_id)
        if sender.balance < amount:
            return await callback.answer("Insufficient balance!", show_alert=True)
        sender.balance -= amount
        
        rec_user = await get_user(session, target_id)
        rec_user.balance += amount
        await session.commit()
        new_bal = rec_user.balance

    await callback.message.edit_text(
        f"🏆 <b>Tip Sent!</b>\nFrom » @{callback.from_user.username or callback.from_user.first_name}\nTo » @{target_id}\nAmount » ₹{amount:.2f}",
        parse_mode="HTML"
    )
    try:
        await callback.bot.send_message(
            target_id,
            f"🏆 <b>You received a tip!</b>\n👤 From: @{callback.from_user.username or callback.from_user.first_name}\n💵 Amount: ₹{amount:.2f}\n\n🏦 New Balance: ₹{new_bal:.2f}\nUse /wallet to view your balance.",
            parse_mode="HTML"
        )
    except Exception:
        pass
    await callback.answer("Tip sent successfully!")

@router.message(Command("escrow"))
async def cmd_escrow(message: types.Message):
    if not message.reply_to_message:
        return await message.answer("Usage: Reply to a user with <code>/escrow [amount]</code>", parse_mode="HTML")
    args = message.text.split()
    if len(args) < 2:
        return await message.answer("Please specify escrow amount.", parse_mode="HTML")
    
    sender_id = message.from_user.id
    target_user = message.reply_to_message.from_user
    if target_user.id == sender_id:
        return await message.answer("❌ You cannot escrow with yourself.")

    async with async_session() as session:
        sender = await get_user(session, sender_id)
        amount = await parse_stake(sender, args[1])
        if not amount or amount <= 0 or sender.balance < amount:
            return await message.answer("❌ Insufficient balance for escrow.", parse_mode="HTML")
        sender.balance -= amount
        await session.commit()

    kb = InlineKeyboardMarkup(inline_keyboard=[
        [
            InlineKeyboardButton(text="Release 🟢", callback_data=f"esc_rel_{target_user.id}_{amount}"),
            InlineKeyboardButton(text="Cancel 🔴", callback_data=f"esc_can_{sender_id}_{target_user.id}_{amount}"),
            InlineKeyboardButton(text="Help 🔵", callback_data="esc_help")
        ]
    ])
    await message.answer(
        f"🛡️ <b>Escrow Created</b>\nMaker: @{message.from_user.username or message.from_user.first_name}\nReceiver: @{target_user.username or target_user.first_name}\nAmount: ₹{amount:.2f}\n\nFunds held securely by Rolex Casino.",
        reply_markup=kb,
        parse_mode="HTML"
    )

@router.callback_query(F.data.startswith("esc_"))
async def cb_escrow(callback: types.CallbackQuery):
    parts = callback.data.split("_")
    action = parts[1]
    if action == "help":
        return await callback.answer("Escrow holds funds securely between two players until released.", show_alert=True)
    
    if action == "rel":
        target_id = int(parts[2])
        amount = float(parts[3])
        async with async_session() as session:
            target = await get_user(session, target_id)
            target.balance += amount
            await session.commit()
        await callback.message.edit_text(f"✅ Escrow released! ₹{amount:.2f} credited to @{target.username or target.first_name}.", parse_mode="HTML")
        await callback.answer("Released!")
    elif action == "can":
        maker_id = int(parts[2])
        amount = float(parts[4])
        if callback.from_user.id not in [maker_id, int(parts[3])] and callback.from_user.id not in ADMINS:
            return await callback.answer("Unauthorized.", show_alert=True)
        async with async_session() as session:
            maker = await get_user(session, maker_id)
            maker.balance += amount
            await session.commit()
        await callback.message.edit_text(f"❌ Escrow cancelled. ₹{amount:.2f} refunded to maker.", parse_mode="HTML")
        await callback.answer("Cancelled.")

@router.message(Command("claim"))
async def cmd_claim(message: types.Message):
    args = message.text.split()
    if len(args) < 2:
        return await message.answer("Usage: <code>/claim [GIFT_CODE]</code>", parse_mode="HTML")
    code = args[1].strip()

    async with async_session() as session:
        gift = await session.get(GiftCode, code)
        if not gift or gift.is_claimed:
            return await message.answer("❌ Invalid or already claimed gift code.")
        
        gift.is_claimed = True
        gift.claimed_by = message.from_user.id
        user = await get_user(session, message.from_user.id, message.from_user.username, message.from_user.first_name)
        user.balance += gift.amount
        await session.commit()
        new_bal = user.balance

    await message.answer(f"🎉 <b>Gift Code Claimed!</b>\n\n💵 Amount Credited: <b>₹{gift.amount:.2f}</b>\n🏦 Your New Balance: <b>₹{new_bal:.2f}</b>", parse_mode="HTML")
    await send_log(message.bot, f"🎟️ <b>Gift Claimed</b>: Code <code>{code}</code> claimed by @{message.from_user.username} for ₹{gift.amount:.2f}")

@router.message(Command("deposit"))
async def start_deposit_flow(message: types.Message, state: FSMContext):
    kb = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="INR ₹", callback_data="dep_INR"), InlineKeyboardButton(text="BSC (BEP20)", callback_data="dep_BEP20")],
        [InlineKeyboardButton(text="SOLANA", callback_data="dep_SOLANA"), InlineKeyboardButton(text="ETHERIUM", callback_data="dep_ETHEREUM")]
    ])
    await message.answer("⬇️ <b>Deposit</b>\n\nHow much do you want to deposit?\nMin: ₹50. Type 5 for USDT or ₹500 for INR.", reply_markup=kb, parse_mode="HTML")
    await state.set_state(DepositStates.waiting_for_amount)

@router.callback_query(F.data.startswith("dep_"), DepositStates.waiting_for_amount)
async def choose_deposit_gateway(callback: types.CallbackQuery, state: FSMContext):
    method = callback.data.split("_")[1]
    await state.update_data(deposit_method=method)
    await callback.message.answer(f"Enter deposit amount for {method}:", parse_mode="HTML")
    await callback.answer()

@router.message(DepositStates.waiting_for_amount)
async def process_deposit_amount(message: types.Message, state: FSMContext):
    try:
        amount = float(message.text.strip())
    except ValueError:
        return await message.answer("❌ Invalid amount format.", parse_mode="HTML")

    data = await state.get_data()
    method = data.get("deposit_method", "INR")

    await state.update_data(deposit_amount=amount)
    await state.set_state(DepositStates.waiting_for_proof)

    kb = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="I have paid ✔️", callback_data="dep_paid_confirm")]
    ])
    await message.answer(
        f"⬇️ Deposit — {method}\n\nAmount: ₹{amount}\nAddress / ID:\n<code>{UPI_ADDRESS}</code>\n\nAfter paying, press ✅ I've Paid.",
        reply_markup=kb,
        parse_mode="HTML"
    )

@router.callback_query(F.data == "dep_paid_confirm")
async def cb_dep_paid(callback: types.CallbackQuery, state: FSMContext):
    await state.set_state(DepositStates.waiting_for_proof)
    await callback.message.answer("⬇️ <b>Step 1/2 — UTR Number</b>\n\nSend your UTR / Transaction ID\n(12-digit number from your UPI app)", parse_mode="HTML")
    await callback.answer()

@router.message(DepositStates.waiting_for_proof)
async def process_deposit_utr(message: types.Message, state: FSMContext):
    utr = message.text.strip()
    if not (utr.isdigit() and len(utr) == 12):
        return await message.answer("❌ Please send a valid 12-digit UTR number.")
    
    await state.update_data(deposit_proof=utr)
    await state.set_state(DepositStates.waiting_for_photo)
    await message.answer(f"✅ UTR saved: {utr}\n\n⬇️ <b>Step 2/2 — Payment Screenshot</b>\n\nNow send the screenshot of your payment.", parse_mode="HTML")

@router.message(F.photo, DepositStates.waiting_for_photo)
async def process_deposit_screenshot(message: types.Message, state: FSMContext):
    data = await state.get_data()
    amount = data.get("deposit_amount", 0.0)
    method = data.get("deposit_method", "INR")
    proof = data.get("deposit_proof", "N/A")
    user_id = message.from_user.id
    username = message.from_user.username or message.from_user.first_name

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

    await state.clear()
    await message.answer(
        f"✅ <b>Deposit proof submitted!</b>\n\n💵 Amount: ₹{amount}\n📍 UTR: {proof}\n\n⌛ Deposit will be credited automatically. It may take 3-5 minutes.",
        parse_mode="HTML"
    )
    await send_log(message.bot, f"📥 <b>New Deposit #{tx_id}</b>\nUser: @{username} (`{user_id}`)\nAmount: ₹{amount} ({method})\nRef: `{proof}`")

    admin_kb = InlineKeyboardMarkup(inline_keyboard=[
        [
            InlineKeyboardButton(text="✅ Approve 🟢", callback_data=f"adm_dep_yes_{tx_id}"),
            InlineKeyboardButton(text="❌ Reject 🔴", callback_data=f"adm_dep_no_{tx_id}")
        ]
    ])
    for adm in ADMINS:
        try:
            await message.bot.send_message(
                adm,
                f"🚨 <b>New Deposit Request [#{tx_id}]</b>\nUser: @{username} (`{user_id}`)\nAmount: ₹{amount}\nRef: `{proof}`",
                reply_markup=admin_kb,
                parse_mode="HTML"
            )
        except Exception:
            pass

@router.message(Command("withdraw"))
async def cmd_withdraw(message: types.Message, state: FSMContext):
    user_id = message.from_user.id
    async with async_session() as session:
        user = await get_user(session, user_id)
        if user.balance <= 0:
            return await message.answer("❌ You have zero available balance for withdrawal.")

    args = message.text.split()
    if len(args) > 1:
        req_amount = await parse_stake(user, args[1])
        if req_amount and 0 < req_amount <= user.balance:
            await execute_withdrawal(message, state, message.from_user, req_amount, user.payout_address or "Not Set")
            return

    await state.set_state(WithdrawStates.waiting_for_amount)
    await message.answer("📤 Enter amount to withdraw:", parse_mode="HTML")

@router.message(WithdrawStates.waiting_for_amount)
async def process_withdraw_amount(message: types.Message, state: FSMContext):
    async with async_session() as session:
        user = await get_user(session, message.from_user.id)
        amount = await parse_stake(user, message.text)
        if not amount or amount <= 0 or amount > user.balance:
            return await message.answer("❌ Invalid or insufficient amount.")
    
    await state.update_data(withdraw_amount=amount)
    await state.set_state(WithdrawStates.waiting_for_address)
    await message.answer("Send your payout address / UPI ID:", parse_mode="HTML")

@router.message(WithdrawStates.waiting_for_address)
async def process_withdraw_address(message: types.Message, state: FSMContext):
    address = message.text.strip()
    data = await state.get_data()
    amount = data.get("withdraw_amount")
    await execute_withdrawal(message, state, message.from_user, amount, address)

async def execute_withdrawal(message: types.Message, state: FSMContext, user_obj: types.User, amount: float, address: str):
    user_id = user_obj.id
    username = user_obj.username or user_obj.first_name
    fee = amount * WITHDRAWAL_FEE_PCT
    net_amount = amount - fee

    async with async_session() as session:
        user = await get_user(session, user_id)
        if user.balance < amount:
            return await message.answer("❌ Insufficient balance.")
        user.balance -= amount
        BOT_STATE["house_balance"] += fee

        tx = Transaction(
            telegram_id=user_id,
            type="WITHDRAW",
            amount=net_amount,
            method="MANUAL",
            proof_ref=address,
            status="PENDING"
        )
        session.add(tx)
        await session.commit()
        tx_id = tx.id

    await state.clear()
    await message.answer(f"⏳ Withdrawal request #{tx_id} submitted. 2% fee applied.", parse_mode="HTML")
    await send_log(message.bot, f"📤 <b>Withdrawal Request [#{tx_id}]</b>\nUser: @{username}\nAmount: ₹{net_amount:.2f} (Fee: ₹{fee:.2f})")

    admin_kb = InlineKeyboardMarkup(inline_keyboard=[
        [
            InlineKeyboardButton(text="✅ Approve 🟢", callback_data=f"adm_wd_yes_{tx_id}"),
            InlineKeyboardButton(text="❌ Reject 🔴", callback_data=f"adm_wd_no_{tx_id}")
        ]
    ])
    for adm in ADMINS:
        try:
            await message.bot.send_message(adm, f"🚨 Withdrawal #{tx_id} from @{username} for ₹{net_amount:.2f}", reply_markup=admin_kb, parse_mode="HTML")
        except Exception:
            pass

async def create_pvp_challenge(message: types.Message, game: str, emoji: str):
    if message.chat.type not in ["group", "supergroup"]:
        return await message.answer(f"{emoji} PvP games are restricted to the official group!", reply_markup=get_channel_lock_kb(), parse_mode="HTML")

    args = message.text.split()
    if len(args) < 2:
        return await message.answer(f"Usage: <code>/{game} [amount] [rounds]</code>", parse_mode="HTML")

    raw_amount = args[1]
    rounds = int(args[2]) if len(args) > 2 and args[2].isdigit() else 1

    async with async_session() as session:
        user = await get_user(session, message.from_user.id, message.from_user.username, message.from_user.first_name)
        bet = await parse_stake(user, raw_amount)
        if not bet or bet <= 0 or user.balance < bet:
            return await message.answer("❌ Invalid or insufficient bet amount.")
        
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

    kb = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=f"⚔️ Accept ({fmt_money(bet, 'INR')}) 🟢", callback_data=f"pvp_acc_{c_id}")],
        [InlineKeyboardButton(text="❌ Cancel 🔴", callback_data=f"pvp_can_{c_id}")]
    ])

    await message.answer(
        f"ROOM ID~ #{c_id:04d}\n"
        f"{emoji} PvP {game.upper()} — ₹{bet:.2f} 🔄 {rounds}Rounds\n\n"
        f"👤 @{message.from_user.username or message.from_user.first_name} — send/copy this emoji now: {emoji}",
        reply_markup=kb,
        parse_mode="HTML"
    )

@router.message(Command("dice"))
async def cmd_dice(message: types.Message):
    await create_pvp_challenge(message, "dice", "🎲")

@router.message(Command("darts"))
async def cmd_darts(message: types.Message):
    await create_pvp_challenge(message, "darts", "🎯")

@router.message(Command("bowling"))
async def cmd_bowling(message: types.Message):
    await create_pvp_challenge(message, "bowling", "🎳")

@router.message(Command("basket"))
async def cmd_basket(message: types.Message):
    await create_pvp_challenge(message, "basket", "🏀")

@router.message(Command("football"))
async def cmd_football(message: types.Message):
    await create_pvp_challenge(message, "football", "⚽")

@router.message(Command("slots"))
async def cmd_slots(message: types.Message):
    await create_pvp_challenge(message, "slots", "🎰")

@router.message(Command("coin"))
async def cmd_coin(message: types.Message):
    await create_pvp_challenge(message, "coin", "🪙")

@router.message(Command("7up"))
async def cmd_7up(message: types.Message):
    args = message.text.split()
    if len(args) < 3:
        return await message.answer("Usage: <code>/7up [up/down] [amount]</code>", parse_mode="HTML")
    choice = args[1].lower()
    async with async_session() as session:
        user = await get_user(session, message.from_user.id)
        bet = await parse_stake(user, args[2])
        if not bet or user.balance < bet:
            return await message.answer("❌ Invalid bet.")
        user.balance -= bet
        await session.commit()
    
    roll1, roll2 = random.randint(1, 6), random.randint(1, 6)
    total = roll1 + roll2
    res = "up" if total >= 7 else "down"
    won = (choice == res)

    if won:
        payout = bet * 1.92
        async with async_session() as session:
            u = await get_user(session, message.from_user.id)
            u.balance += payout
            await session.commit()
        await message.answer(f"🎲 7UP Result: {roll1} + {roll2} = {total} ({res.upper()}). You WON ₹{payout:.2f}!", parse_mode="HTML")
    else:
        BOT_STATE["house_balance"] += bet
        await message.answer(f"🎲 7UP Result: {roll1} + {roll2} = {total} ({res.upper()}). You lost ₹{bet:.2f}.", parse_mode="HTML")

@router.message(Command("dr"))
async def cmd_dr(message: types.Message):
    args = message.text.split()
    if len(args) < 3:
        return await message.answer("Usage: <code>/dr [low/high/odd/even] [amount]</code>", parse_mode="HTML")
    choice = args[1].lower()
    async with async_session() as session:
        user = await get_user(session, message.from_user.id)
        bet = await parse_stake(user, args[2])
        if not bet or user.balance < bet:
            return await message.answer("❌ Invalid bet.")
        user.balance -= bet
        await session.commit()

    val = random.randint(1, 6)
    won = False
    if choice == "low" and val in [1, 2, 3]: won = True
    elif choice == "high" and val in [4, 5, 6]: won = True
    elif choice == "odd" and val % 2 != 0: won = True
    elif choice == "even" and val % 2 == 0: won = True

    if won:
        payout = bet * 1.92
        async with async_session() as session:
            u = await get_user(session, message.from_user.id)
            u.balance += payout
            await session.commit()
        await message.answer(f"🎲 Dice Rush landed on {val}. You won ₹{payout:.2f}!", parse_mode="HTML")
    else:
        BOT_STATE["house_balance"] += bet
        await message.answer(f"📉 Dice Rush landed on {val}. ₹{bet:.2f} lost.", parse_mode="HTML")

@router.message(Command("odice"))
async def cmd_odice(message: types.Message):
    args = message.text.split()
    if len(args) < 2:
        return await message.answer("Usage: <code>/odice [amount]</code>", parse_mode="HTML")
    async with async_session() as session:
        user = await get_user(session, message.from_user.id)
        bet = await parse_stake(user, args[1])
        if not bet or user.balance < bet:
            return await message.answer("❌ Invalid bet.")
        user.balance -= bet
        await session.commit()
    
    kb = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="Heads 🪙", callback_data=f"odice_h_{bet}"), InlineKeyboardButton(text="Tails 🪙", callback_data=f"odice_t_{bet}")]
    ])
    await message.answer("🏟️ Open Match — /odice\nPick side for toss:", reply_markup=kb, parse_mode="HTML")

@router.callback_query(F.data.startswith("odice_"))
async def cb_odice(callback: types.CallbackQuery):
    parts = callback.data.split("_")
    bet = float(parts[2])
    side = parts[1]
    toss = random.choice(["h", "t"])
    won = (side == toss)

    if won:
        payout = bet * 1.92 * 0.97  # 3% fee
        async with async_session() as session:
            u = await get_user(session, callback.from_user.id)
            u.balance += payout
            await session.commit()
        await callback.message.edit_text(f"🏏 Toss won! You batted and won ₹{payout:.2f}.", parse_mode="HTML")
    else:
        BOT_STATE["house_balance"] += bet * 0.97
        await callback.message.edit_text("🏏 Toss lost! Bowled out.", parse_mode="HTML")
    await callback.answer()

@router.callback_query(F.data.startswith("pvp_can_"))
async def cb_cancel_pvp(callback: types.CallbackQuery):
    c_id = int(callback.data.split("_")[2])
    if c_id not in ACTIVE_CHALLENGES:
        return await callback.answer("Expired.", show_alert=True)
    challenge = ACTIVE_CHALLENGES.pop(c_id)
    async with async_session() as session:
        user = await get_user(session, challenge["challenger_id"])
        user.balance += challenge["amount"]
        await session.commit()
    await callback.message.edit_text("❌ Challenge cancelled & refunded.", parse_mode="HTML")
    await callback.answer("Cancelled.")

@router.callback_query(F.data.startswith("pvp_acc_"))
async def cb_accept_pvp(callback: types.CallbackQuery):
    c_id = int(callback.data.split("_")[2])
    if c_id not in ACTIVE_CHALLENGES:
        return await callback.answer("Challenge no longer available.", show_alert=True)
    challenge = ACTIVE_CHALLENGES.pop(c_id)
    acceptor_id = callback.from_user.id
    if challenge["challenger_id"] == acceptor_id:
        return await callback.answer("Cannot play against yourself.", show_alert=True)

    bet = challenge["amount"]
    async with async_session() as session:
        acc = await get_user(session, acceptor_id, callback.from_user.username, callback.from_user.first_name)
        if acc.balance < bet:
            return await callback.answer("Insufficient balance.", show_alert=True)
        acc.balance -= bet
        await session.commit()

    ACTIVE_MATCHES[c_id] = {
        **challenge,
        "acceptor_id": acceptor_id,
        "acceptor_name": callback.from_user.username or callback.from_user.first_name,
        "p1_score": 0, "p2_score": 0, "round": 1
    }

    await callback.message.edit_text(
        f"ROOM ID~ #{c_id:04d}\n"
        f"Match commenced! @{challenge['challenger_name']} vs @{callback.from_user.username or callback.from_user.first_name}\n\n"
        f"@{challenge['challenger_name']} SEND: {challenge['emoji']} 1/{challenge['rounds']}",
        parse_mode="HTML"
    )
    await callback.answer()

@router.message(F.dice)
async def handle_native_dice(message: types.Message):
    chat_id = message.chat.id
    user_id = message.from_user.id
    val = message.dice.value

    matched_id = None
    for m_id, m in ACTIVE_MATCHES.items():
        if m["chat_id"] == chat_id and (m["challenger_id"] == user_id or m["acceptor_id"] == user_id):
            matched_id = m_id
            break

    if not matched_id:
        return

    match = ACTIVE_MATCHES[matched_id]
    is_p1 = (user_id == match["challenger_id"])
    
    if is_p1:
        match["p1_score"] += val
        await message.reply(f"🏆 Round {match['round']}: @{match['challenger_name']} ✅ ({val})", parse_mode="HTML")
        match["turn"] = match["acceptor_id"]
    else:
        match["p2_score"] += val
        await message.reply(f"🏆 Round {match['round']}: @{match['acceptor_name']} ✅ ({val})", parse_mode="HTML")

        if match["round"] < match["rounds"]:
            match["round"] += 1
            match["turn"] = match["challenger_id"]
        else:
            ACTIVE_MATCHES.pop(matched_id)
            p1_s = match["p1_score"]
            p2_s = match["p2_score"]
            bet = match["amount"]
            payout = bet * 1.92

            if p1_s > p2_s:
                winner_id = match["challenger_id"]
                winner_name = match["challenger_name"]
            elif p2_s > p1_s:
                winner_id = match["acceptor_id"]
                winner_name = match["acceptor_name"]
            else:
                async with async_session() as session:
                    u1 = await get_user(session, match["challenger_id"])
                    u2 = await get_user(session, match["acceptor_id"])
                    u1.balance += bet
                    u2.balance += bet
                    await session.commit()
                return await message.reply("🤝 IT'S A TIE!\nBoth rolled the same value.\nThrow the required emoji again.", parse_mode="HTML")

            async with async_session() as session:
                w = await get_user(session, winner_id)
                w.balance += payout
                await session.commit()
                new_b = w.balance

            BOT_STATE["house_balance"] += bet * 0.08
            await message.reply(f"🏆 {winner_name} wins {match['round']}-{match['round']}!\n₹{payout:.2f} (1.92x) credited.\nNew Balance: ₹{new_b:.2f}", parse_mode="HTML")

@router.message(Command("hb"))
async def cmd_hb(message: types.Message):
    if message.from_user.id not in ADMINS:
        return await message.answer("⛔ Admins only.")
    async with async_session() as session:
        total_users = (await session.execute(select(func.count(User.telegram_id)))).scalar() or 0
        total_bal = (await session.execute(select(func.sum(User.balance)))).scalar() or 0.0
        total_wagered = (await session.execute(select(func.sum(User.total_wagered)))).scalar() or 0.0

    await message.answer(
        f"🏦 House Balance: ${BOT_STATE['house_balance']:.2f}\n"
        f"Bets: allowed ✔️\n"
        f"Total Users: {total_users}\n"
        f"Total Balances: ₹{total_bal:.2f}\n"
        f"Total Wagered: ₹{total_wagered:.2f}",
        parse_mode="HTML"
    )

@router.message(Command("panel", "admincommands"))
async def cmd_panel(message: types.Message):
    if message.from_user.id not in ADMINS:
        return await message.answer("⛔ Admins only.")
    kb = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="Pending Requests", callback_data="adm_pending"), InlineKeyboardButton(text="Users", callback_data="adm_users")]
    ])
    await message.answer("👑 Admin Control Panel", reply_markup=kb, parse_mode="HTML")

@router.callback_query(F.data == "adm_pending")
async def cb_adm_pending(callback: types.CallbackQuery):
    if callback.from_user.id not in ADMINS:
        return
    async with async_session() as session:
        txs = (await session.execute(select(Transaction).where(Transaction.status == "PENDING"))).scalars().all()
    if not txs:
        return await callback.message.edit_text("No pending requests.")
    for tx in txs[:5]:
        kb = InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text="Approve", callback_data=f"adm_dep_yes_{tx.id}"), InlineKeyboardButton(text="Reject", callback_data=f"adm_dep_no_{tx.id}")]
        ])
        await callback.message.answer(f"TX #{tx.id} | Type: {tx.type} | Amt: ₹{tx.amount}", reply_markup=kb)
    await callback.answer()

@router.callback_query(F.data.startswith("adm_dep_yes_"))
async def cb_approve_dep(callback: types.CallbackQuery):
    if callback.from_user.id not in ADMINS:
        return
    tx_id = int(callback.data.split("_")[3])
    async with async_session() as session:
        tx = await session.get(Transaction, tx_id)
        if not tx: return await callback.answer("Not found.")
        tx.status = "APPROVED"
        user = await get_user(session, tx.telegram_id)
        user.balance += tx.amount
        user.wager_required += tx.amount
        await session.commit()
        new_b = user.balance
        uid = tx.telegram_id
        amt = tx.amount

    try:
        await callback.bot.send_message(
            uid,
            f"🏆 Deposit Approved!\n\n💵 Credited: ₹{amt}\n🏦 Balance: ₹{new_b:.2f}\n\n⚠️ Wager ₹{amt} more before withdrawing (1x deposit rule)\nPlay any game to clear it — /wagerstatus to track",
            parse_mode="HTML"
        )
    except Exception:
        pass
    await callback.message.edit_text(f"✅ Deposit #{tx_id} approved.")
    await callback.answer("Approved!")

@router.callback_query(F.data.startswith("adm_dep_no_"))
async def cb_reject_dep(callback: types.CallbackQuery):
    if callback.from_user.id not in ADMINS:
        return
    tx_id = int(callback.data.split("_")[3])
    async with async_session() as session:
        tx = await session.get(Transaction, tx_id)
        if tx:
            tx.status = "REJECTED"
            await session.commit()
    await callback.message.edit_text(f"❌ Deposit #{tx_id} rejected.")
    await callback.answer("Rejected.")

@router.message(Command("balanceadd"))
async def cmd_balanceadd(message: types.Message):
    if message.from_user.id not in ADMINS: return
    args = message.text.split()
    if len(args) < 3: return await message.answer("Usage: /balanceadd [user_id] [amount]")
    uid, amt = int(args[1]), float(args[2])
    async with async_session() as session:
        u = await get_user(session, uid)
        u.balance += amt
        await session.commit()
    await message.answer(f"✅ Credited ₹{amt} to {uid}.")

@router.message(Command("creategift"))
async def cmd_creategift(message: types.Message):
    if message.from_user.id not in ADMINS: return
    args = message.text.split()
    if len(args) < 3: return await message.answer("Usage: /creategift [code] [amount]")
    code, amt = args[1], float(args[2])
    async with async_session() as session:
        session.add(GiftCode(code=code, amount=amt))
        await session.commit()
    await message.answer(f"✅ Gift code {code} created for ₹{amt}.")

@router.message(Command("broadcast"))
async def cmd_broadcast(message: types.Message):
    if message.from_user.id not in ADMINS: return
    text = message.text.replace("/broadcast", "").strip()
    async with async_session() as session:
        users = (await session.execute(select(User.telegram_id))).scalars().all()
    for uid in users:
        try: await message.bot.send_message(uid, text, parse_mode="HTML")
        except Exception: pass
    await message.answer("✅ Broadcast sent.")

async def main():
    await init_db()
    bot = Bot(token=BOT_TOKEN)
    dp = Dispatcher(storage=MemoryStorage())
    dp.message.middleware(security_middleware)
    dp.callback_query.middleware(security_middleware)
    dp.include_router(router)
    
    logger.info("Rolex Casino Bot started successfully.")
    await dp.start_polling(bot)

if __name__ == "__main__":
    asyncio.run(main())
