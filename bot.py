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
from sqlalchemy import BigInteger, String, Float, Boolean, Column, DateTime, select, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession

# --- CONFIGURATION & ENVIRONMENT (Loaded securely from Railway Environment) ---
BOT_TOKEN = os.getenv("BOT_TOKEN", "8785635298:AAGCGT3Df8VKrCH5fbClvSRySRQSugAZa0E")
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite+aiosqlite:////data/rolex_casino.db")
GROUP_ID = int(os.getenv("GROUP_ID", "-1004458883943"))
LOG_CHANNEL_ID = int(os.getenv("LOG_CHANNEL_ID", "-1004458883943"))
GROUP_LINK = os.getenv("GROUP_LINK", "https://t.me/RolexCasinos")
BOT_USERNAME = os.getenv("BOT_USERNAME", "Rolex_Casino_BOT")

# Parse Admin IDs safely from CSV or fallback
raw_admins = os.getenv("ADMIN_IDS", "8860529495,1053006219")
ADMINS = {int(x.strip()) for x in raw_admins.split(",") if x.strip().isdigit()}

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
    balance: Mapped[float] = mapped_column(Float, default=1000.0)
    bank: Mapped[float] = mapped_column(Float, default=0.0)
    wager_required: Mapped[float] = mapped_column(Float, default=0.0)
    currency: Mapped[str] = mapped_column(String, default="INR")
    is_banned: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

class Transaction(Base):
    __tablename__ = "transactions"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    telegram_id: Mapped[int] = mapped_column(BigInteger)
    type: Mapped[str] = mapped_column(String)  # DEPOSIT / WITHDRAW / TIP / ADMIN_ADD
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

# Async Engine with greenlet support
engine = create_async_engine(DATABASE_URL, echo=False)
async_session = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

async def init_db():
    """Initializes tables safely using SQLAlchemy async engine with greenlet"""
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        logger.info("Database schema initialized successfully.")
    except Exception as e:
        logger.error(f"Failed to initialize database: {e}")
        raise

async def get_user(session: AsyncSession, telegram_id: int, username: str = None) -> User:
    user = await session.get(User, telegram_id)
    if not user:
        user = User(telegram_id=telegram_id, username=username or "Unknown", balance=1000.0)
        session.add(user)
        await session.commit()
    elif username and user.username != username:
        user.username = username
        await session.commit()
    return user

async def send_log(bot: Bot, text: str):
    try:
        await bot.send_message(LOG_CHANNEL_ID, f"📋 **ROLEX CASINO LOG SYSTEM**\n\n{text}", parse_mode="Markdown")
    except Exception as e:
        logger.error(f"Failed to push log: {e}")

# --- MAINTENANCE & BOT STATE FLAGS ---
BOT_STATE = {"maintenance": False}

# --- FSM STATES ---
class DepositStates(StatesGroup):
    waiting_for_amount = State()
    waiting_for_proof = State()
    waiting_for_photo = State()

class WithdrawStates(StatesGroup):
    waiting_for_amount = State()
    waiting_for_address = State()

class AdminStates(StatesGroup):
    broadcast_text = State()
    modify_balance = State()
    modify_user_id = State()

# Active PvP storage: {challenger_id: {"amount": bet, "game": game, "msg_id": msg_id, "chat_id": chat_id}}
ACTIVE_PVPS = {}

# --- NAVIGATION KEYBOARDS ---
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
            InlineKeyboardButton(text="🎮 PvP Games Arena 🔵", callback_data="menu_games"),
            InlineKeyboardButton(text="💼 My Wallet 🟢", callback_data="menu_wallet")
        ],
        [InlineKeyboardButton(text="📢 Join Official Group 🌐", url=GROUP_LINK)],
        [InlineKeyboardButton(text="🛟 Support Center 🔵", callback_data="menu_support")]
    ])

# --- SECURITY & MIDDLEWARE ---
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

    # Check ban status
    async with async_session() as session:
        db_user = await session.get(User, user.id)
        if db_user and db_user.is_banned and not is_admin:
            if isinstance(event, types.CallbackQuery):
                return await event.answer("⛔ Your account has been suspended.", show_alert=True)
            if chat_type == "private":
                return await message.answer("⛔ Your account has been suspended by Rolex Casino Security.")
            return

    # Maintenance Mode Check
    if BOT_STATE["maintenance"] and not is_admin:
        if isinstance(event, types.CallbackQuery):
            return await event.answer("⚠️ Bot is currently under maintenance.", show_alert=True)
        if chat_type in ["group", "supergroup"]:
            return
        return await message.answer("⚠️ **Rolex Casino** is currently under scheduled maintenance. Please check back soon!", parse_mode="Markdown")

    text = message.text or message.caption or ""
    # Normalize command stripped of bot mention like /dice@Rolex_Casino_BOT
    raw_cmd = text.split()[0].lower() if text.startswith("/") else ""
    command = raw_cmd.split("@")[0]

    # Admin Commands in DM only
    admin_commands = {"/panel", "/pending", "/user", "/users", "/creategift", "/balanceadd", "/ban", "/unban", "/broadcast", "/admincommands", "/announcement", "/hb", "/maintenance", "/restart"}
    if command in admin_commands and chat_type in ["group", "supergroup"]:
        try: await message.delete()
        except Exception: pass
        return await message.answer(
            f"⛔ **{user.first_name}, administrative commands can only be executed securely inside our DM inbox!**",
            reply_markup=get_dm_redirect_kb(),
            parse_mode="Markdown"
        )

    # Deposit & Withdraw in DM only
    dm_only_commands = {"/deposit", "/withdraw"}
    if command in dm_only_commands and chat_type in ["group", "supergroup"]:
        try: await message.delete()
        except Exception: pass
        return await message.answer(
            f"⛔ **{user.first_name}, deposits & withdrawals can only be processed securely inside our DM inbox!**",
            reply_markup=get_dm_redirect_kb(),
            parse_mode="Markdown"
        )

    # Games restricted to group chat
    game_commands = {"/dice", "/basket", "/darts", "/football", "/bowling", "/slots", "/coin", "/battle"}
    if command in game_commands and chat_type == "private" and not is_admin:
        await message.answer(
            "🎲 **PvP Casino games are restricted to the official gaming group arena!** Play in our group below:",
            reply_markup=get_channel_lock_kb(),
            parse_mode="Markdown"
        )
        return

    return await handler(event, data)

# --- ROUTERS ---
router = Router()

# --- START & MENU COMMANDS ---
@router.message(CommandStart())
async def cmd_start(message: types.Message, state: FSMContext):
    if message.chat.type in ["group", "supergroup"]:
        kb = InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text="💬 Open Bot in DM 🌐", url=f"https://t.me/{BOT_USERNAME}")],
            [InlineKeyboardButton(text="👥 Official Community Group 🟢", url=GROUP_LINK)]
        ])
        return await message.answer(
            "👑 **Welcome to Rolex Casino Arena!**\nThe ultimate PvP gaming hub. Click below to launch bot in private DM:",
            reply_markup=kb,
            parse_mode="Markdown"
        )
    
    args = message.text.split()
    if len(args) > 1 and args[1] == "deposit":
        return await start_deposit_flow(message, state)

    async with async_session() as session:
        user = await get_user(session, message.from_user.id, message.from_user.username)

    welcome_text = (
        f"🏆 **Welcome to Rolex Casino BOT, {message.from_user.first_name}!**\n\n"
        f"Name of the Bot: **Rolex Casino BOT** (@{BOT_USERNAME})\n"
        f"💰 **Starting Balance:** ₹{user.balance:.2f}\n\n"
        f"Explore options using the buttons below or check `/help`."
    )
    await message.answer(welcome_text, reply_markup=get_main_menu_kb(), parse_mode="Markdown")

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

@router.callback_query(F.data == "menu_support")
async def cb_menu_support(callback: types.CallbackQuery):
    await cmd_support(callback.message)
    await callback.answer()

@router.message(Command("help"))
async def cmd_help(message: types.Message):
    help_text = (
        "📜 **Rolex Casino Help & Command Directory**\n\n"
        "⚔️ **PvP Games:** `/dice <amt>`, `/basket <amt>`, `/darts <amt>`, `/football <amt>`, `/bowling <amt>`, `/slots <amt>`, `/coin <amt>`, `/battle <amt>`\n"
        "💳 **Wallet & Finance:** `/wallet`, `/deposit`, `/withdraw`, `/wagerstatus`, `/tip <amt>`, `/claim <code>`\n"
        "⚙️ **General:** `/start`, `/help`, `/games`, `/support`\n"
    )
    await message.answer(help_text, parse_mode="Markdown")

@router.message(Command("games"))
async def cmd_games(message: types.Message):
    games_text = (
        "🎲 **Rolex Casino PvP Game Arena**\n\n"
        "• `/dice <amount>` - PvP Multiplayer Dice match\n"
        "• `/basket <amount>` - PvP Basketball shootout\n"
        "• `/darts <amount>` - PvP Darts match\n"
        "• `/football <amount>` - PvP Football penalty kick\n"
        "• `/bowling <amount>` - PvP Bowling strike match\n"
        "• `/slots <amount>` - PvP High roller slots\n"
        "• `/coin <amount>` - PvP Coin flip challenge\n"
        "• `/battle <amount>` - PvP custom challenge match\n\n"
        "💡 *Note: All games are strictly PvP against real players in the group! Win multiplier: 1.92×*"
    )
    await message.answer(games_text, parse_mode="Markdown")

@router.message(Command("support"))
async def cmd_support(message: types.Message):
    kb = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="👨‍💻 Owner Support 🔵", url="https://t.me/Lucifer_1209")],
        [InlineKeyboardButton(text="📢 Official Community 🟢", url=GROUP_LINK)]
    ])
    await message.answer("🛟 **Rolex Casino Support Center**\nNeed assistance with deposits, withdrawals, or queries? Contact our team:", reply_markup=kb, parse_mode="Markdown")

# --- WALLET, DEPOSIT & WITHDRAW ---
@router.message(Command("wallet"))
async def cmd_wallet(message: types.Message):
    async with async_session() as session:
        user = await get_user(session, message.from_user.id, message.from_user.username)
    
    text = (
        f"💼 **Your Rolex Wallet Balance**\n\n"
        f"💵 **Cash Balance:** ₹{user.balance:.2f}\n"
        f"🏦 **Bank Vault:** ₹{user.bank:.2f}\n"
        f"⚠️ **Pending Wager Requirement:** ₹{user.wager_required:.2f}\n"
    )
    kb = InlineKeyboardMarkup(inline_keyboard=[
        [
            InlineKeyboardButton(text="📥 Deposit 🟢", callback_data="menu_deposit"),
            InlineKeyboardButton(text="📤 Withdraw 🔴", callback_data="menu_withdraw")
        ]
    ])
    await message.answer(text, reply_markup=kb, parse_mode="Markdown")

@router.message(Command("deposit"))
async def start_deposit_flow(message: types.Message, state: FSMContext):
    kb = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="🇮🇳 UPI Deposit (INR) 🟢", callback_data="dep_UPI")],
        [InlineKeyboardButton(text="⚡ Crypto Deposit (USDT/BTC/ETH/SOL) 🔵", callback_data="dep_CRYPTO")]
    ])
    await message.answer("💳 **Select Deposit Gateway:**\nChoose your preferred payment method below:", reply_markup=kb, parse_mode="Markdown")

@router.callback_query(F.data.startswith("dep_"))
async def choose_deposit_method(callback: types.CallbackQuery, state: FSMContext):
    method = callback.data.split("_")[1]
    await state.update_data(deposit_method=method)
    await state.set_state(DepositStates.waiting_for_amount)
    
    if method == "UPI":
        msg = f"🇮🇳 **UPI Deposit Selected**\nEnter amount to deposit (*Min: ₹70 | Max: ₹5000*):\n\nUPI Address: `{UPI_ADDRESS}`\n*(Tap address to copy)*"
    else:
        msg = (
            f"⚡ **Crypto Deposit Selected**\nEnter amount in USD ($) (*Min: $1 | Max: $50*):\n\n"
            f"• **BEP20 (USDT):** `{CRYPTO_WALLETS['BEP20']}`\n"
            f"• **Solana (SOL/USDT):** `{CRYPTO_WALLETS['SOLANA']}`\n"
            f"• **Ethereum (ETH/USDT):** `{CRYPTO_WALLETS['ETHEREUM']}`\n"
            f"• **Bitcoin (BTC):** `{CRYPTO_WALLETS['BITCOIN']}`"
        )
    await callback.message.edit_text(msg, parse_mode="Markdown")
    await callback.answer()

@router.message(DepositStates.waiting_for_amount)
async def process_deposit_amount(message: types.Message, state: FSMContext):
    try:
        amount = float(message.text.strip())
    except ValueError:
        return await message.answer("❌ Invalid amount format. Please enter numbers only (e.g., 500).")

    data = await state.get_data()
    method = data.get("deposit_method", "UPI")

    if method == "UPI" and not (70 <= amount <= 5000):
        return await message.answer("❌ UPI Deposit limits: Min ₹70, Max ₹5000.")
    if method == "CRYPTO" and not (1 <= amount <= 50):
        return await message.answer("❌ Crypto Deposit limits: Min $1, Max $50.")

    await state.update_data(deposit_amount=amount)
    await state.set_state(DepositStates.waiting_for_proof)
    
    if method == "UPI":
        kb = InlineKeyboardMarkup(inline_keyboard=[[InlineKeyboardButton(text="I've Paid 🟢", callback_data="paid_upi")]])
        await message.answer(f"📥 **Deposit Order for ₹{amount:.2f} Initiated!**\n\nSend payment to: `{UPI_ADDRESS}`\nThen send the **12-digit UPI UTR / Ref number**:", reply_markup=kb, parse_mode="Markdown")
    else:
        kb = InlineKeyboardMarkup(inline_keyboard=[[InlineKeyboardButton(text="I've Paid 🟢", callback_data="paid_crypto")]])
        await message.answer(f"📥 **Crypto Order for ${amount:.2f} Initiated!**\n\nSend payment and then paste your **Transaction Hash / ID** (64-66 characters):", reply_markup=kb, parse_mode="Markdown")

@router.callback_query(F.data.in_(["paid_upi", "paid_crypto"]))
async def cb_paid_reminder(callback: types.CallbackQuery):
    await callback.answer("Please send the transaction reference ID in this chat.", show_alert=True)

@router.message(DepositStates.waiting_for_proof)
async def process_deposit_proof(message: types.Message, state: FSMContext):
    proof = message.text.strip()
    data = await state.get_data()
    method = data.get("deposit_method", "UPI")

    if method == "UPI":
        if not (proof.isdigit() and len(proof) == 12):
            return await message.answer("❌ Invalid UPI UTR! It must be exactly 12 numeric digits.")
    else:
        if not (64 <= len(proof) <= 66):
            return await message.answer("❌ Invalid Crypto Hash length! It must be 64 to 66 characters long.")

    await state.update_data(deposit_proof=proof)
    await state.set_state(DepositStates.waiting_for_photo)
    await message.answer("📸 Now upload/send your **payment screenshot** as receipt proof:", parse_mode="Markdown")

@router.message(F.photo, DepositStates.waiting_for_photo)
async def process_deposit_screenshot(message: types.Message, state: FSMContext):
    data = await state.get_data()
    amount = data.get("deposit_amount", 0.0)
    method = data.get("deposit_method", "UPI")
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
    await message.answer("⏳ **Deposit submitted successfully!**\nOur automated review team will verify and credit your wallet shortly.", parse_mode="Markdown")
    await send_log(message.bot, f"📥 **New Deposit Request [# {tx_id}]**\nUser: @{username} (`{user_id}`)\nAmount: ₹{amount:.2f} ({method})\nRef: `{proof}`")

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
                f"🚨 **New Deposit Request [# {tx_id}]**\nUser: @{username} (`{user_id}`)\nAmount: ₹{amount:.2f} ({method})\nRef: `{proof}`",
                reply_markup=admin_kb,
                parse_mode="Markdown"
            )
        except Exception as e:
            logger.error(f"Failed sending alert to admin {adm}: {e}")

@router.message(Command("withdraw"))
async def cmd_withdraw(message: types.Message, state: FSMContext):
    async with async_session() as session:
        user = await get_user(session, message.from_user.id)
        if user.wager_required > 0:
            return await message.answer(
                f"⛔ **Withdrawal Locked**\nYou have a pending wagering requirement of ₹{user.wager_required:.2f} to clear through PvP play before withdrawing!",
                parse_mode="Markdown"
            )
        if user.balance <= 0:
            return await message.answer("❌ You have zero available balance for withdrawal.")

    await state.set_state(WithdrawStates.waiting_for_amount)
    await message.answer(f"📤 **Withdrawal Request**\nEnter amount to withdraw (Available: ₹{user.balance:.2f}):", parse_mode="Markdown")

@router.message(WithdrawStates.waiting_for_amount)
async def process_withdraw_amount(message: types.Message, state: FSMContext):
    try:
        amount = float(message.text.strip())
        if amount <= 0: raise ValueError
    except ValueError:
        return await message.answer("❌ Invalid amount. Enter positive numeric amount.")

    async with async_session() as session:
        user = await get_user(session, message.from_user.id)
        if amount > user.balance:
            return await message.answer(f"❌ Insufficient funds! You only have ₹{user.balance:.2f} available.")

    await state.update_data(withdraw_amount=amount)
    await state.set_state(WithdrawStates.waiting_for_address)
    await message.answer("📝 Send your payout destination address (UPI ID e.g. `user@upi` or Crypto Wallet):", parse_mode="Markdown")

@router.message(WithdrawStates.waiting_for_address)
async def process_withdraw_address(message: types.Message, state: FSMContext):
    address = message.text.strip()
    data = await state.get_data()
    amount = data.get("withdraw_amount")
    user_id = message.from_user.id
    username = message.from_user.username or message.from_user.first_name

    async with async_session() as session:
        user = await get_user(session, user_id)
        if user.balance < amount:
            return await message.answer("❌ Insufficient balance for this withdrawal.")
        user.balance -= amount
        
        tx = Transaction(telegram_id=user_id, type="WITHDRAW", amount=amount, method="MANUAL", proof_ref=address, status="PENDING")
        session.add(tx)
        await session.commit()
        await session.refresh(tx)
        tx_id = tx.id

    await state.clear()
    await message.answer("⏳ **Withdrawal submitted!** Our payout cashier is reviewing your request.", parse_mode="Markdown")
    await send_log(message.bot, f"📤 **Withdrawal Request [# {tx_id}]**\nUser: @{username} (`{user_id}`)\nAmount: ₹{amount:.2f}\nAddress: `{address}`")

    admin_kb = InlineKeyboardMarkup(inline_keyboard=[
        [
            InlineKeyboardButton(text="✅ Approve Payout 🟢", callback_data=f"adm_wd_yes_{tx_id}"),
            InlineKeyboardButton(text="❌ Reject Payout 🔴", callback_data=f"adm_wd_no_{tx_id}")
        ]
    ])
    for adm in ADMINS:
        try:
            await message.bot.send_message(
                adm,
                f"🚨 **Withdrawal Request [# {tx_id}]**\nUser: @{username} (`{user_id}`)\nAmount: ₹{amount:.2f}\nAddress: `{address}`",
                reply_markup=admin_kb,
                parse_mode="Markdown"
            )
        except Exception:
            pass

@router.message(Command("wagerstatus"))
async def cmd_wager(message: types.Message):
    async with async_session() as session:
        user = await get_user(session, message.from_user.id)
    await message.answer(f"📊 **Wagering Status**\nPending Wager to clear: **₹{user.wager_required:.2f}**\n*Play any PvP game to clear your 1× wagering requirement.*", parse_mode="Markdown")

@router.message(Command("tip"))
async def cmd_tip(message: types.Message):
    if not message.reply_to_message:
        return await message.answer("Usage: Reply to a user's message with `/tip <amount>`", parse_mode="Markdown")
    args = message.text.split()
    if len(args) < 2:
        return await message.answer("❌ Specify amount to tip (e.g., `/tip 50`).", parse_mode="Markdown")
    try:
        amount = float(args[1])
        if amount <= 0: raise ValueError
    except ValueError:
        return await message.answer("❌ Invalid tip amount.")

    sender_id = message.from_user.id
    recipient = message.reply_to_message.from_user
    if recipient.id == sender_id:
        return await message.answer("❌ You cannot tip yourself.")

    async with async_session() as session:
        sender = await get_user(session, sender_id, message.from_user.username)
        if sender.balance < amount:
            return await message.answer(f"❌ Insufficient balance. You have ₹{sender.balance:.2f}")
        sender.balance -= amount
        
        rec_user = await get_user(session, recipient.id, recipient.username)
        rec_user.balance += amount
        
        tx = Transaction(telegram_id=sender_id, type="TIP", amount=amount, method="TIP", status="COMPLETED")
        session.add(tx)
        await session.commit()
        new_bal = rec_user.balance

    tipper_name = message.from_user.username or message.from_user.first_name
    await message.answer(f"✅ Successfully tipped ₹{amount:.2f} to @{recipient.username or recipient.first_name}!")
    
    try:
        await message.bot.send_message(
            recipient.id,
            f"🎁 **You received a tip!**\n\n👤 From: @{tipper_name}\n💵 Amount: ₹{amount:.2f}\n🏦 New Balance: ₹{new_bal:.2f}",
            parse_mode="Markdown"
        )
    except Exception:
        pass
    await send_log(message.bot, f"🎁 **Tip Sent**\nFrom: @{tipper_name} (`{sender_id}`)\nTo: @{recipient.username} (`{recipient.id}`)\nAmount: ₹{amount:.2f}")

@router.message(Command("claim"))
async def cmd_claim(message: types.Message):
    args = message.text.split()
    if len(args) < 2:
        return await message.answer("Usage: `/claim <gift_code>`", parse_mode="Markdown")
    code = args[1].strip()
    
    async with async_session() as session:
        gift = await session.get(GiftCode, code)
        if not gift or gift.is_claimed:
            return await message.answer("❌ Invalid or already claimed gift code.")
        
        gift.is_claimed = True
        user = await get_user(session, message.from_user.id, message.from_user.username)
        user.balance += gift.amount
        await session.commit()
        new_bal = user.balance

    await message.answer(f"🎉 **Gift Code Claimed!**\nCredited: ₹{gift.amount:.2f}\nNew Balance: ₹{new_bal:.2f}", parse_mode="Markdown")
    await send_log(message.bot, f"🎉 **Gift Claimed**\nCode: `{code}`\nUser: @{message.from_user.username} (`{message.from_user.id}`)\nAmount: ₹{gift.amount:.2f}")

# --- STRICT PVP MULTIPLAYER GAMES WITH CANCEL / REFUND ---
@router.message(Command("battle"))
async def game_battle(message: types.Message):
    args = message.text.split()
    if len(args) < 2:
        return await message.answer("Usage: `/battle <amount>`", parse_mode="Markdown")
    try:
        bet = float(args[1])
        if bet <= 0: raise ValueError
    except ValueError:
        return await message.answer("❌ Invalid bet amount.")

    async with async_session() as session:
        user = await get_user(session, message.from_user.id)
        if user.balance < bet:
            return await message.answer(f"❌ Insufficient balance! You have ₹{user.balance:.2f}")
        user.balance -= bet
        # Reduce wager requirement by bet played
        user.wager_required = max(0.0, user.wager_required - bet)
        await session.commit()

    ACTIVE_PVPS[message.from_user.id] = {"amount": bet, "game": "battle", "chat_id": message.chat.id}
    kb = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="⚔️ Accept Battle 🟢", callback_data=f"pvp_accept_{message.from_user.id}")],
        [InlineKeyboardButton(text="❌ Cancel & Refund 🔴", callback_data=f"pvp_cancel_{message.from_user.id}")]
    ])
    await message.answer(
        f"⚔️ **PvP Battle Challenge Created!**\n\n👤 Challenger: @{message.from_user.username or message.from_user.first_name}\n💰 Stake: ₹{bet:.2f}\n✨ Multiplier: 1.92×\n\nClick below to accept this duel:",
        reply_markup=kb,
        parse_mode="Markdown"
    )

@router.callback_query(F.data.startswith("pvp_cancel_"))
async def cancel_pvp(callback: types.CallbackQuery):
    challenger_id = int(callback.data.split("_")[2])
    if callback.from_user.id != challenger_id:
        return await callback.answer("Only the challenger can cancel this game!", show_alert=True)
    if challenger_id not in ACTIVE_PVPS:
        return await callback.answer("This challenge has already been resolved or expired.", show_alert=True)

    challenge = ACTIVE_PVPS.pop(challenger_id)
    bet = challenge["amount"]

    async with async_session() as session:
        user = await get_user(session, challenger_id)
        user.balance += bet
        await session.commit()

    await callback.message.edit_text(f"❌ **PvP Challenge Cancelled.** ₹{bet:.2f} has been refunded to your wallet.", parse_mode="Markdown")
    await callback.answer("Refunded!")

@router.callback_query(F.data.startswith("pvp_accept_"))
async def accept_pvp(callback: types.CallbackQuery):
    challenger_id = int(callback.data.split("_")[2])
    acceptor_id = callback.from_user.id

    if challenger_id == acceptor_id:
        return await callback.answer("You cannot play against yourself!", show_alert=True)

    if challenger_id not in ACTIVE_PVPS:
        return await callback.answer("This PvP challenge has expired or was already played.", show_alert=True)

    challenge = ACTIVE_PVPS.pop(challenger_id)
    bet = challenge["amount"]

    async with async_session() as session:
        acceptor = await get_user(session, acceptor_id, callback.from_user.username)
        if acceptor.balance < bet:
            # Restore challenger game in map if acceptor has no money
            ACTIVE_PVPS[challenger_id] = challenge
            return await callback.answer(f"Insufficient funds! You need ₹{bet:.2f}", show_alert=True)
        acceptor.balance -= bet
        acceptor.wager_required = max(0.0, acceptor.wager_required - bet)
        await session.commit()

    winner_id = random.choice([challenger_id, acceptor_id])
    loser_id = acceptor_id if winner_id == challenger_id else challenger_id
    payout = round(bet * 1.92, 2)

    async with async_session() as session:
        winner = await get_user(session, winner_id)
        winner.balance += payout
        await session.commit()
        new_bal = winner.balance

    try:
        w_user = await callback.bot.get_chat(winner_id)
        winner_name = f"@{w_user.username}" if w_user.username else w_user.first_name
    except Exception:
        winner_name = f"User {winner_id}"

    msg = (
        f"⚔️ **ROLEX CASINO - PVP BATTLE RESULT** ⚔️\n\n"
        f"💰 **Staked Amount:** ₹{bet:.2f} each\n"
        f"✨ **Multiplier:** 1.92× PvP\n"
        f"🏆 **Winner:** {winner_name}\n"
        f"💵 **Total Payout:** ₹{payout:.2f}\n"
        f"🏦 **Winner New Balance:** ₹{new_bal:.2f}"
    )
    await callback.message.edit_text(msg, parse_mode="Markdown")
    await send_log(callback.bot, f"⚔️ **PvP Battle Finished**\nWinner: `{winner_id}`\nLoser: `{loser_id}`\nStake: ₹{bet:.2f}")

# Dedicated PvP Animated Dice Game
@router.message(Command("dice"))
async def pvp_dice(message: types.Message):
    args = message.text.split()
    if len(args) < 2:
        return await message.answer("Usage: `/dice <amount>` (Strictly PvP)", parse_mode="Markdown")
    try:
        bet = float(args[1])
        if bet <= 0: raise ValueError
    except ValueError:
        return await message.answer("❌ Invalid bet amount.")

    async with async_session() as session:
        user = await get_user(session, message.from_user.id)
        if user.balance < bet:
            return await message.answer(f"❌ Insufficient balance! You have ₹{user.balance:.2f}")
        user.balance -= bet
        user.wager_required = max(0.0, user.wager_required - bet)
        await session.commit()

    ACTIVE_PVPS[message.from_user.id] = {"amount": bet, "game": "dice", "chat_id": message.chat.id}
    kb = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="🎲 Accept PvP Dice 🟢", callback_data=f"dice_accept_{message.from_user.id}")],
        [InlineKeyboardButton(text="❌ Cancel & Refund 🔴", callback_data=f"pvp_cancel_{message.from_user.id}")]
    ])
    await message.answer(
        f"🎲 **PvP Dice Challenge Created!**\n\n👤 Challenger: @{message.from_user.username or message.from_user.first_name}\n💰 Stake: ₹{bet:.2f}\n\nClick below to roll dice against each other:",
        reply_markup=kb,
        parse_mode="Markdown"
    )

@router.callback_query(F.data.startswith("dice_accept_"))
async def accept_dice(callback: types.CallbackQuery):
    challenger_id = int(callback.data.split("_")[2])
    acceptor_id = callback.from_user.id
    if challenger_id == acceptor_id:
        return await callback.answer("Cannot accept your own challenge!", show_alert=True)
    if challenger_id not in ACTIVE_PVPS:
        return await callback.answer("Challenge expired or already taken.", show_alert=True)

    challenge = ACTIVE_PVPS.pop(challenger_id)
    bet = challenge["amount"]

    async with async_session() as session:
        acceptor = await get_user(session, acceptor_id, callback.from_user.username)
        if acceptor.balance < bet:
            ACTIVE_PVPS[challenger_id] = challenge
            return await callback.answer("Insufficient funds.", show_alert=True)
        acceptor.balance -= bet
        acceptor.wager_required = max(0.0, acceptor.wager_required - bet)
        await session.commit()

    await callback.message.answer("🎲 **Rolling dice for Challenger...**")
    d1 = await callback.message.bot.send_dice(callback.message.chat.id, emoji="🎲")
    await asyncio.sleep(3.5)
    await callback.message.answer("🎲 **Rolling dice for Acceptor...**")
    d2 = await callback.message.bot.send_dice(callback.message.chat.id, emoji="🎲")
    await asyncio.sleep(3.5)

    v1, v2 = d1.dice.value, d2.dice.value
    if v1 > v2:
        winner_id = challenger_id
    elif v2 > v1:
        winner_id = acceptor_id
    else:
        # Tie - full refund to both
        async with async_session() as session:
            c_user = await get_user(session, challenger_id)
            a_user = await get_user(session, acceptor_id)
            c_user.balance += bet
            a_user.balance += bet
            await session.commit()
        return await callback.message.answer(f"🤝 **It's a Tie!** (Rolls: {v1} vs {v2}). Both players refunded ₹{bet:.2f}.", parse_mode="Markdown")

    payout = round(bet * 1.92, 2)
    async with async_session() as session:
        winner = await get_user(session, winner_id)
        winner.balance += payout
        await session.commit()
        new_bal = winner.balance

    msg = (
        f"🎲 **ROLEX CASINO - PVP DICE RESULT** 🎲\n\n"
        f"Challenger Rolled: **{v1}**\n"
        f"Acceptor Rolled: **{v2}**\n"
        f"✨ **1.92× Win Payout**\n"
        f"🏆 **Winner ID:** `{winner_id}`\n"
        f"💵 **Payout:** ₹{payout:.2f}\n"
        f"🏦 **New Balance:** ₹{new_bal:.2f}"
    )
    await callback.message.answer(msg, parse_mode="Markdown")
    await send_log(callback.bot, f"🎲 **PvP Dice Complete**\nWinner: `{winner_id}`\nScores: {v1} vs {v2}\nPot: ₹{bet * 2:.2f}")

# Generic wrapper for Sports & Casino PvP
@router.message(Command("basket", "darts", "football", "bowling", "slots", "coin"))
async def pvp_generic_games(message: types.Message):
    raw_cmd = message.text.split()[0].lower().replace("/", "")
    cmd = raw_cmd.split("@")[0]
    args = message.text.split()
    if len(args) < 2:
        return await message.answer(f"Usage: `/{cmd} <amount>` (Strictly PvP)", parse_mode="Markdown")
    try:
        bet = float(args[1])
        if bet <= 0: raise ValueError
    except ValueError:
        return await message.answer("❌ Invalid bet amount.")

    async with async_session() as session:
        user = await get_user(session, message.from_user.id)
        if user.balance < bet:
            return await message.answer(f"❌ Insufficient balance! You have ₹{user.balance:.2f}")
        user.balance -= bet
        user.wager_required = max(0.0, user.wager_required - bet)
        await session.commit()

    ACTIVE_PVPS[message.from_user.id] = {"amount": bet, "game": cmd, "chat_id": message.chat.id}
    emoji_map = {"basket": "🏀", "darts": "🎯", "football": "⚽", "bowling": "🎳", "slots": "🎰", "coin": "🪙"}
    em = emoji_map.get(cmd, "🎮")

    kb = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=f"Accept PvP {cmd.capitalize()} {em} 🟢", callback_data=f"pvpgen_accept_{message.from_user.id}_{cmd}")],
        [InlineKeyboardButton(text="❌ Cancel & Refund 🔴", callback_data=f"pvp_cancel_{message.from_user.id}")]
    ])
    await message.answer(
        f"{em} **PvP {cmd.capitalize()} Challenge Created!**\n\n👤 Challenger: @{message.from_user.username or message.from_user.first_name}\n💰 Stake: ₹{bet:.2f}\n\nClick below to accept this duel:",
        reply_markup=kb,
        parse_mode="Markdown"
    )

@router.callback_query(F.data.startswith("pvpgen_accept_"))
async def accept_pvp_gen(callback: types.CallbackQuery):
    parts = callback.data.split("_")
    challenger_id = int(parts[2])
    game = parts[3]
    acceptor_id = callback.from_user.id

    if challenger_id == acceptor_id:
        return await callback.answer("Cannot play against yourself!", show_alert=True)
    if challenger_id not in ACTIVE_PVPS:
        return await callback.answer("Challenge expired.", show_alert=True)

    challenge = ACTIVE_PVPS.pop(challenger_id)
    bet = challenge["amount"]

    async with async_session() as session:
        acceptor = await get_user(session, acceptor_id, callback.from_user.username)
        if acceptor.balance < bet:
            ACTIVE_PVPS[challenger_id] = challenge
            return await callback.answer("Insufficient funds.", show_alert=True)
        acceptor.balance -= bet
        acceptor.wager_required = max(0.0, acceptor.wager_required - bet)
        await session.commit()

    emoji_map = {"basket": "🏀", "darts": "🎯", "football": "⚽", "bowling": "🎳", "slots": "🎰", "coin": "🎲"}
    em = emoji_map.get(game, "🎲")

    d1 = await callback.message.bot.send_dice(callback.message.chat.id, emoji=em)
    await asyncio.sleep(3.5)
    d2 = await callback.message.bot.send_dice(callback.message.chat.id, emoji=em)
    await asyncio.sleep(3.5)

    v1, v2 = d1.dice.value, d2.dice.value
    if v1 > v2:
        winner_id = challenger_id
    elif v2 > v1:
        winner_id = acceptor_id
    else:
        async with async_session() as session:
            c_user = await get_user(session, challenger_id)
            a_user = await get_user(session, acceptor_id)
            c_user.balance += bet
            a_user.balance += bet
            await session.commit()
        return await callback.message.answer(f"🤝 **It's a Tie!** Both bets refunded: ₹{bet:.2f}", parse_mode="Markdown")

    payout = round(bet * 1.92, 2)
    async with async_session() as session:
        winner = await get_user(session, winner_id)
        winner.balance += payout
        await session.commit()
        new_bal = winner.balance

    msg = (
        f"{em} **ROLEX CASINO - PVP {game.upper()} RESULT** {em}\n\n"
        f"Challenger: **{v1}**\n"
        f"Acceptor: **{v2}**\n"
        f"✨ **1.92× Win Multiplier**\n"
        f"🏆 **Winner ID:** `{winner_id}`\n"
        f"💵 Payout: ₹{payout:.2f}\n"
        f"🏦 New Balance: ₹{new_bal:.2f}"
    )
    await callback.message.answer(msg, parse_mode="Markdown")
    await send_log(callback.bot, f"{em} **PvP {game.upper()} Finished**\nWinner: `{winner_id}`\nScores: {v1} vs {v2}\nStake: ₹{bet:.2f}")

# --- ADMIN PANEL & ALL ADMIN COMMANDS ---
@router.message(Command("panel"))
async def cmd_panel(message: types.Message):
    if message.from_user.id not in ADMINS:
        return await message.answer("⛔ Access denied. Admins only.")
    
    kb = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="📋 Pending Requests 🔵", callback_data="admin_pending")],
        [InlineKeyboardButton(text="📢 Broadcast Message 🟢", callback_data="admin_broadcast")],
        [InlineKeyboardButton(text="👥 View Users 🔵", callback_data="admin_users")]
    ])
    status_str = "🟢 Active" if not BOT_STATE["maintenance"] else "🔴 Maintenance / Bets Off"
    await message.answer(f"🎛️ **Rolex Casino Admin Dashboard**\nBot Status: {status_str}", reply_markup=kb, parse_mode="Markdown")

@router.callback_query(F.data == "admin_pending")
async def cb_admin_pending(callback: types.CallbackQuery):
    if callback.from_user.id not in ADMINS:
        return await callback.answer("Access denied.")
    await cmd_pending(callback.message)
    await callback.answer()

@router.callback_query(F.data == "admin_users")
async def cb_admin_users(callback: types.CallbackQuery):
    if callback.from_user.id not in ADMINS:
        return await callback.answer("Access denied.")
    await cmd_users(callback.message)
    await callback.answer()

@router.callback_query(F.data == "admin_broadcast")
async def cb_admin_broadcast(callback: types.CallbackQuery, state: FSMContext):
    if callback.from_user.id not in ADMINS:
        return await callback.answer("Access denied.")
    await state.set_state(AdminStates.broadcast_text)
    await callback.message.answer("📢 Send the broadcast message to deliver to all players:")
    await callback.answer()

@router.message(AdminStates.broadcast_text)
async def process_broadcast(message: types.Message, state: FSMContext):
    if message.from_user.id not in ADMINS:
        return
    text = message.text
    await state.clear()
    
    async with async_session() as session:
        users = (await session.execute(select(User.telegram_id))).scalars().all()

    success, failed = 0, 0
    await message.answer(f"⏳ Broadcasting to {len(users)} users...")
    for uid in users:
        try:
            await message.bot.send_message(uid, f"📢 **Rolex Casino Announcement**\n\n{text}", parse_mode="Markdown")
            success += 1
            await asyncio.sleep(0.05)
        except Exception:
            failed += 1

    await message.answer(f"✅ Broadcast finished! Sent: {success} | Failed/Blocked: {failed}")

@router.message(Command("hb"))
async def cmd_hb(message: types.Message):
    if message.from_user.id not in ADMINS:
        return await message.answer("⛔ Admins only.")
    
    status_str = "🟢 Active (Bets ON)" if not BOT_STATE["maintenance"] else "🔴 Maintenance (Bets OFF)"
    async with async_session() as session:
        total_bal = (await session.execute(select(func.sum(User.balance)))).scalar() or 0.0

    await message.answer(
        f"🏦 **Rolex Casino Bot Treasury Vault (/hb)**\n\n"
        f"💵 Total User Liquid Balances: **₹{total_bal:.2f}**\n"
        f"⚡ Bot Operational Status: **{status_str}**",
        parse_mode="Markdown"
    )

@router.message(Command("announcement"))
async def cmd_announcement(message: types.Message):
    if message.from_user.id not in ADMINS:
        return await message.answer("⛔ Admins only.")
    text = message.text.replace("/announcement", "").strip()
    if not text:
        return await message.answer("Usage: `/announcement <text>`", parse_mode="Markdown")
    
    try:
        await message.bot.send_message(GROUP_ID, f"🚨 **ROLEX CASINO ANNOUNCEMENT** 🚨\n\n{text}", parse_mode="Markdown")
        await message.answer("✅ Announcement sent successfully to the official group!")
    except Exception as e:
        await message.answer(f"❌ Failed to send announcement: {e}")

@router.message(Command("creategift"))
async def cmd_creategift(message: types.Message):
    if message.from_user.id not in ADMINS:
        return await message.answer("⛔ Admins only.")
    args = message.text.split()
    if len(args) < 3:
        return await message.answer("Usage: `/creategift <code> <amount>`", parse_mode="Markdown")
    
    code, amt = args[1].strip(), float(args[2])
    async with async_session() as session:
        g = GiftCode(code=code, amount=amt, is_claimed=False)
        session.add(g)
        await session.commit()

    await message.answer(f"✅ Gift Code `{code}` created with value ₹{amt:.2f}!", parse_mode="Markdown")
    await send_log(message.bot, f"🎟️ **Gift Code Created**\nCode: `{code}`\nAmount: ₹{amt:.2f}\nAdmin: @{message.from_user.username}")

@router.message(Command("balanceadd"))
async def cmd_balanceadd(message: types.Message):
    if message.from_user.id not in ADMINS:
        return await message.answer("⛔ Admins only.")
    args = message.text.split()
    if len(args) < 3:
        return await message.answer("Usage: `/balanceadd <user_id> <amount>`", parse_mode="Markdown")
    
    uid, amt = int(args[1]), float(args[2])
    async with async_session() as session:
        u = await get_user(session, uid)
        u.balance += amt
        await session.commit()
        new_b = u.balance

    await message.answer(f"✅ Added ₹{amt:.2f} to user `{uid}`. New balance: ₹{new_b:.2f}")
    await send_log(message.bot, f"➕ **Admin Credit Balance**\nUser: `{uid}`\nAmount: ₹{amt:.2f}\nNew Balance: ₹{new_b:.2f}")

@router.message(Command("ban", "unban"))
async def cmd_ban_unban(message: types.Message):
    if message.from_user.id not in ADMINS:
        return await message.answer("⛔ Admins only.")
    cmd = message.text.split()[0].lower().split("@")[0]
    args = message.text.split()
    if len(args) < 2:
        return await message.answer(f"Usage: `{cmd} <user_id>`")
    
    uid = int(args[1])
    async with async_session() as session:
        u = await get_user(session, uid)
        u.is_banned = (cmd == "/ban")
        await session.commit()

    await message.answer(f"✅ User `{uid}` status updated: Banned={u.is_banned}")

@router.message(Command("pending"))
async def cmd_pending(message: types.Message):
    if message.from_user.id not in ADMINS:
        return await message.answer("⛔ Admins only.")
    async with async_session() as session:
        txs = (await session.execute(select(Transaction).where(Transaction.status == "PENDING"))).scalars().all()
    if not txs:
        return await message.answer("📋 No pending deposit or withdrawal requests.")
    
    for tx in txs[:10]:
        kb = InlineKeyboardMarkup(inline_keyboard=[[
            InlineKeyboardButton(text="✅ Approve 🟢", callback_data=f"adm_dep_yes_{tx.id}" if tx.type=="DEPOSIT" else f"adm_wd_yes_{tx.id}"),
            InlineKeyboardButton(text="❌ Reject 🔴", callback_data=f"adm_dep_no_{tx.id}" if tx.type=="DEPOSIT" else f"adm_wd_no_{tx.id}")
        ]])
        await message.answer(f"🆔 **TX ID:** `#{tx.id}`\n👤 User ID: `{tx.telegram_id}`\nType: **{tx.type}**\nAmount: ₹{tx.amount:.2f}\nMethod: {tx.method}\nRef: `{tx.proof_ref}`", reply_markup=kb, parse_mode="Markdown")

@router.message(Command("users"))
async def cmd_users(message: types.Message):
    if message.from_user.id not in ADMINS:
        return await message.answer("⛔ Admins only.")
    async with async_session() as session:
        count = (await session.execute(select(func.count(User.telegram_id)))).scalar() or 0
    await message.answer(f"👥 **Total Registered Users in Rolex Database:** `{count}`", parse_mode="Markdown")

@router.message(Command("admincommands"))
async def cmd_admincommands(message: types.Message):
    if message.from_user.id not in ADMINS:
        return await message.answer("⛔ Admins only.")
    txt = (
        "🛠️ **Rolex Casino Full Admin Directory**\n\n"
        "• `/panel` - Open management dashboard\n"
        "• `/hb` - Treasury vault & status overview\n"
        "• `/pending` - View pending deposits/withdrawals\n"
        "• `/users` - Total registered database records\n"
        "• `/balanceadd <user_id> <amount>` - Credit user balance\n"
        "• `/creategift <code> <amount>` - Create gift code\n"
        "• `/announcement <text>` - Send group announcement\n"
        "• `/maintenance` - Lock bot & pause bets\n"
        "• `/restart` - Resume normal operations\n"
        "• `/ban <user_id>` / `/unban <user_id>` - Ban/Unban user\n"
    )
    await message.answer(txt, parse_mode="Markdown")

@router.message(Command("maintenance"))
async def cmd_maintenance(message: types.Message):
    if message.from_user.id not in ADMINS:
        return await message.answer("⛔ Admins only.")
    BOT_STATE["maintenance"] = True
    await message.answer("🛠️ **Rolex Casino is now in Maintenance Mode / Bets OFF.** All non-admin commands are locked.", parse_mode="Markdown")
    await send_log(message.bot, "🛠️ **Bot Maintenance Enabled / Bets OFF by Admin**")

@router.message(Command("restart"))
async def cmd_restart(message: types.Message):
    if message.from_user.id not in ADMINS:
        return await message.answer("⛔ Admins only.")
    BOT_STATE["maintenance"] = False
    await message.answer("🚀 **Rolex Casino restarted successfully!** All systems and bets operational.", parse_mode="Markdown")
    await send_log(message.bot, "🚀 **Bot Restarted & Bets Resumed by Admin**")

@router.callback_query(F.data.startswith("adm_"))
async def handle_admin_approval(callback: types.CallbackQuery):
    if callback.from_user.id not in ADMINS:
        return await callback.answer("Unauthorized!", show_alert=True)
    
    parts = callback.data.split("_")
    status_decision = parts[2] # yes or no
    tx_id = int(parts[3])

    async with async_session() as session:
        tx = await session.get(Transaction, tx_id)
        if not tx or tx.status != "PENDING":
            return await callback.message.edit_text("⚠️ Transaction already processed or does not exist.")
        
        user = await session.get(User, tx.telegram_id)
        if not user:
            return await callback.message.edit_text("⚠️ Target user not found in database.")
        
        if status_decision == "yes":
            tx.status = "APPROVED"
            if tx.type == "DEPOSIT":
                user.balance += tx.amount
                user.wager_required += tx.amount
                await session.commit()
                try:
                    await callback.bot.send_message(
                        tx.telegram_id,
                        f"🏆 **Deposit Approved!**\n\n💵 Credited: ₹{tx.amount:.2f}\n🏦 Balance: ₹{user.balance:.2f}\n\n⚠️ Wager ₹{tx.amount:.2f} before withdrawing (1× wagering rule).",
                        parse_mode="Markdown"
                    )
                except Exception:
                    pass
            elif tx.type == "WITHDRAW":
                await session.commit()
                try:
                    await callback.bot.send_message(
                        tx.telegram_id,
                        f"🏆 **Withdrawal Approved & Processed!**\n\nPayout of ₹{tx.amount:.2f} has been dispatched to your destination account.",
                        parse_mode="Markdown"
                    )
                except Exception:
                    pass
            await callback.message.edit_text(f"✅ Transaction #{tx_id} **APPROVED** by @{callback.from_user.username}.")
            await send_log(callback.bot, f"✅ **Transaction #{tx_id} ({tx.type}) Approved** for User `{tx.telegram_id}` (Amount: ₹{tx.amount:.2f})")
        else:
            tx.status = "REJECTED"
            if tx.type == "WITHDRAW":
                user.balance += tx.amount  # Refund balance back to user
            await session.commit()
            try:
                await callback.bot.send_message(tx.telegram_id, f"❌ **Request #{tx_id} Rejected by Admin.** Funds returned if withdrawal.", parse_mode="Markdown")
            except Exception:
                pass
            await callback.message.edit_text(f"❌ Transaction #{tx_id} **REJECTED** by @{callback.from_user.username}.")
            await send_log(callback.bot, f"❌ **Transaction #{tx_id} ({tx.type}) Rejected** for User `{tx.telegram_id}`")
    await callback.answer()

# --- MAIN ENTRY POINT ---
async def main():
    logger.info("Initializing Rolex Casino Database...")
    await init_db()
    
    bot = Bot(token=BOT_TOKEN)
    storage = MemoryStorage()
    dp = Dispatcher(storage=storage)

    # Attach security middleware
    dp.message.middleware(security_middleware)
    dp.callback_query.middleware(security_middleware)

    # Register all handlers
    dp.include_router(router)

    logger.info(f"Rolex Casino PvP Bot starting polling as @{BOT_USERNAME}...")
    await bot.delete_webhook(drop_pending_updates=True)
    await dp.start_polling(bot)

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except (KeyboardInterrupt, SystemExit):
        logger.info("Bot stopped gracefully.")
