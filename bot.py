import os
import random
import asyncio
import logging
from datetime import datetime
from dotenv import load_dotenv

from aiogram import Bot, Dispatcher, Router, types, F
from aiogram.filters import Command, CommandStart
from aiogram.fsm.storage.memory import MemoryStorage
from aiogram.fsm.state import State, StatesGroup
from aiogram.fsm.context import FSMContext
from aiogram.types import (
    InlineKeyboardMarkup, InlineKeyboardButton,
    ReplyKeyboardMarkup, KeyboardButton
)
from sqlalchemy import BigInteger, String, Float, Boolean, Column, DateTime
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession

# --- CONFIGURATION & ENVIRONMENT ---
BOT_TOKEN = "8785635298:AAGCGT3Df8VKrCH5fbClvSRySRQSugAZa0E"
DATABASE_URL = "sqlite+aiosqlite:///rolex_casino.db"  # Self-contained robust async persistent storage
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")

GROUP_ID = -1004458883943
GROUP_LINK = "https://t.me/RolexCasinos"
BOT_USERNAME = "Rolex_Casino_BOT"
LOG_CHANNEL_ID = -1004458883943  # Dedicated logs channel username/id

ADMINS = {8860529495, 1053006219}
MOD_USERNAMES = {"@Lucifer_1209", "@luffy_rolex", "@RolexCasinoMod"}

UPI_ADDRESS = "rutvik1209@fam"
CRYPTO_WALLETS = {
    "BEP20": "0xD8419224A65C3d35C10AE695562463c8445ACb15",
    "SOLANA": "3bKsCSR2mmconFaExejbkuGfeQNuVQPFttzj9y2MP2mE",
    "ETHEREUM": "0xD8419224A65C3d35C10AE695562463c8445ACb15",
    "BITCOIN": "bc1qsm7xzn4k8kpxwurzjsredangepvzgh70y0ypzd"
}

logging.basicConfig(level=logging.INFO)
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
    type: Mapped[str] = mapped_column(String)  # DEPOSIT / WITHDRAW / TIP / ADMIN_ADD / ADMIN_DED
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

engine = create_async_engine(DATABASE_URL, echo=False)
async_session = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

async def init_db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

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

class WithdrawStates(StatesGroup):
    waiting_for_amount = State()
    waiting_for_address = State()

class AdminStates(StatesGroup):
    broadcast_text = State()
    modify_balance = State()
    modify_user_id = State()
    gift_code_amount = State()
    gift_code_string = State()

class PvPStates(StatesGroup):
    waiting_for_opponent = State()

# Active PvP Challenge storage: {challenger_id: {amount, game, message_id}}
ACTIVE_PVPS = {}

# --- COLORED BUTTON STYLING (Mocking color schemes using standard Telegram formatting icons) ---
def get_channel_lock_kb():
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="📢 Join Official Group 🌐", url=GROUP_LINK)],
        [InlineKeyboardButton(text="📥 Deposit Funds 💵", url=f"https://t.me/{BOT_USERNAME}?start=deposit")]
    ])

def get_dm_redirect_kb():
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="🤖 Open Bot in DM 📩", url=f"https://t.me/{BOT_USERNAME}")]
    ])

# --- SECURITY & MIDDLEWARE ---
async def security_middleware(handler, event: types.Update, data: dict):
    message = event.message or (event.callback_query.message if event.callback_query else None)
    user = event.message.from_user if event.message else (event.callback_query.from_user if event.callback_query else None)
    
    if not message or not user:
        return await handler(event, data)

    chat_type = message.chat.type
    is_admin = user.id in ADMINS

    # 1. Maintenance Mode Check
    if BOT_STATE["maintenance"] and not is_admin:
        if chat_type in ["group", "supergroup"]:
            return
        return await message.answer("⚠️ **Rolex Casino** is currently under scheduled maintenance. Please check back soon!", parse_mode="Markdown")

    text = message.text or message.caption or ""
    command = text.split()[0].lower() if text.startswith("/") else ""

    # 2. Admin Commands must ONLY work in DM
    admin_commands = {"/panel", "/pending", "/user", "/users", "/creategift", "/balanceadd", "/ban", "/unban", "/broadcast", "/admincommands", "/announcement", "/hb"}
    if command in admin_commands and chat_type in ["group", "supergroup"]:
        await message.delete()
        return await message.answer(
            f"⛔ **{user.first_name}, administrative commands can only be executed securely inside our DM inbox!**",
            reply_markup=get_dm_redirect_kb(),
            parse_mode="Markdown"
        )

    # 3. Deposit & Withdraw strictly in DM
    dm_only_commands = {"/deposit", "/withdraw"}
    if command in dm_only_commands and chat_type in ["group", "supergroup"]:
        await message.delete()
        return await message.answer(
            f"⛔ **{user.first_name}, deposits & withdrawals can only be processed securely inside our DM inbox!**",
            reply_markup=get_dm_redirect_kb(),
            parse_mode="Markdown"
        )

    # 4. Games must ONLY work in the group chat (PvP arena)
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

# --- START & GENERAL COMMANDS ---
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
    kb = InlineKeyboardMarkup(inline_keyboard=[
        [
            InlineKeyboardButton(text="📥 Deposit 🟢", callback_data="menu_deposit"),
            InlineKeyboardButton(text="📤 Withdraw 🔴")
        ],
        [
            InlineKeyboardButton(text="🎮 PvP Games Arena 🔵", callback_data="menu_games"),
            InlineKeyboardButton(text="💼 My Wallet 🟢")
        ],
        [InlineKeyboardButton(text="📢 Join Official Group 🌐", url=GROUP_LINK)],
        [InlineKeyboardButton(text="🛟 Support Center 🔵", callback_data="menu_support")]
    ])
    await message.answer(welcome_text, reply_markup=kb, parse_mode="Markdown")

@router.message(Command("help"))
async def cmd_help(message: types.Message):
    help_text = (
        "📜 **Rolex Casino Help & Command Directory**\n\n"
        "⚔️ **PvP Games:** `/dice`, `/basket`, `/darts`, `/football`, `/bowling`, `/slots`, `/coin`, `/battle`\n"
        "💳 **Wallet & Finance:** `/wallet`, `/deposit`, `/withdraw`, `/wagerstatus`, `/mystats`, `/tip`, `/claim`\n"
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
        "• `/coin <amount> <heads/tails>` - PvP Coin flip challenge\n"
        "• `/battle <amount>` - PvP custom challenge match\n"
    )
    await message.answer(games_text, parse_mode="Markdown")

@router.message(Command("support"))
async def cmd_support(message: types.Message):
    kb = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="👨‍💻 Owner Support 🔵", url="https://t.me/Lucifer_1209")],
        [InlineKeyboardButton(text="📢 Official Community 🟢", url=GROUP_LINK)]
    ])
    await message.answer("🛟 **Rolex Casino Support Center**\nNeed assistance? Contact our team below:", reply_markup=kb, parse_mode="Markdown")

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
            InlineKeyboardButton(text="📤 Withdraw 🔴")
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
        msg = f"🇮🇳 **UPI Deposit Selected**\nEnter amount to deposit (*Min: ₹70 | Max: ₹5000*):\nUPI Address: `{UPI_ADDRESS}`"
    else:
        msg = (
            f"⚡ **Crypto Deposit Selected**\nEnter amount in USD ($) (*Min: $1 | Max: $50*):\n\n"
            f"• **BEP20:** `{CRYPTO_WALLETS['BEP20']}`\n"
            f"• **Solana:** `{CRYPTO_WALLETS['SOLANA']}`\n"
            f"• **Ethereum:** `{CRYPTO_WALLETS['ETHEREUM']}`\n"
            f"• **Bitcoin:** `{CRYPTO_WALLETS['BITCOIN']}`"
        )
    await callback.message.edit_text(msg, parse_mode="Markdown")
    await callback.answer()

@router.message(DepositStates.waiting_for_amount)
async def process_deposit_amount(message: types.Message, state: FSMContext):
    try:
        amount = float(message.text.strip())
    except ValueError:
        return await message.answer("❌ Invalid amount format. Please enter numbers only.")

    data = await state.get_data()
    method = data.get("deposit_method")

    if method == "UPI" and not (70 <= amount <= 5000):
        return await message.answer("❌ UPI Deposit limits: Min ₹70, Max ₹5000.")
    if method == "CRYPTO" and not (1 <= amount <= 50):
        return await message.answer("❌ Crypto Deposit limits: Min $1, Max $50.")

    await state.update_data(deposit_amount=amount)
    await state.set_state(DepositStates.waiting_for_proof)
    
    if method == "UPI":
        kb = InlineKeyboardMarkup(inline_keyboard=[[InlineKeyboardButton(text="I've Paid 🟢", callback_data="paid_upi")]])
        await message.answer("📥 **Payment initiated!**\nSend the **12-digit UTR transaction number** (numbers only):", reply_markup=kb, parse_mode="Markdown")
    else:
        kb = InlineKeyboardMarkup(inline_keyboard=[[InlineKeyboardButton(text="I've Paid 🟢", callback_data="paid_crypto")]])
        await message.answer("📥 **Payment initiated!**\nSend your **Crypto Transaction Hash / ID** (64-66 characters):", reply_markup=kb, parse_mode="Markdown")

@router.message(DepositStates.waiting_for_proof)
async def process_deposit_proof(message: types.Message, state: FSMContext):
    proof = message.text.strip()
    data = await state.get_data()
    method = data.get("deposit_method")

    if method == "UPI":
        if not (proof.isdigit() and len(proof) == 12):
            return await message.answer("❌ Invalid UPI UTR! Must be exactly 12 numeric digits.")
    else:
        if not (64 <= len(proof) <= 66):
            return await message.answer("❌ Invalid Crypto Hash length! Must be between 64 and 66 characters.")

    await state.update_data(deposit_proof=proof)
    await message.answer("📸 Now upload/send your **payment screenshot** receipt as proof:", parse_mode="Markdown")

@router.message(F.photo, DepositStates.waiting_for_proof)
async def process_deposit_screenshot(message: types.Message, state: FSMContext):
    data = await state.get_data()
    amount = data.get("deposit_amount")
    method = data.get("deposit_method")
    proof = data.get("deposit_proof")
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
    await message.answer("⏳ **Deposit submitted!** Wait for admins approval.", parse_mode="Markdown")
    await send_log(message.bot, f"📥 **New Deposit Request [# {tx_id}]**\nUser: @{username} (`{user_id}`)\nAmount: {amount} ({method})\nRef: `{proof}`")

    admin_kb = InlineKeyboardMarkup(inline_keyboard=[
        [
            InlineKeyboardButton(text="✅ Approve 🟢", callback_data=f"adm_dep_yes_{tx_id}"),
            InlineKeyboardButton(text="❌ Reject 🔴", callback_data=f"adm_dep_no_{tx_id}")
        ]
    ])
    for adm in ADMINS:
        try:
            await message.bot.send_message(adm, f"🚨 **New Deposit Request [# {tx_id}]**\nUser: @{username}\nAmount: {amount} ({method})\nRef: `{proof}`", reply_markup=admin_kb, parse_mode="Markdown")
        except Exception:
            pass

@router.message(Command("withdraw"))
async def cmd_withdraw(message: types.Message, state: FSMContext):
    async with async_session() as session:
        user = await get_user(session, message.from_user.id)
        if user.wager_required > 0:
            return await message.answer(f"⛔ You must clear your wagering requirement of ₹{user.wager_required:.2f} before withdrawing!", parse_mode="Markdown")
        if user.balance <= 0:
            return await message.answer("❌ You have zero balance available for withdrawal.")

    await state.set_state(WithdrawStates.waiting_for_amount)
    await message.answer(f"📤 **Withdrawal Request**\nEnter amount to withdraw (Max available: ₹{user.balance:.2f}):", parse_mode="Markdown")

@router.message(WithdrawStates.waiting_for_amount)
async def process_withdraw_amount(message: types.Message, state: FSMContext):
    try:
        amount = float(message.text.strip())
    except ValueError:
        return await message.answer("❌ Invalid amount.")

    async with async_session() as session:
        user = await get_user(session, message.from_user.id)
        if amount > user.balance:
            return await message.answer("❌ Insufficient balance.")

    await state.update_data(withdraw_amount=amount)
    await state.set_state(WithdrawStates.waiting_for_address)
    await message.answer("📝 Send your payout destination address (UPI ID or Crypto Address):", parse_mode="Markdown")

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
            return await message.answer("❌ Balance error.")
        user.balance -= amount
        
        tx = Transaction(telegram_id=user_id, type="WITHDRAW", amount=amount, method="MANUAL", proof_ref=address, status="PENDING")
        session.add(tx)
        await session.commit()
        await session.refresh(tx)
        tx_id = tx.id

    await state.clear()
    await message.answer("⏳ **Withdrawal submitted!** Sent to admins for verification.", parse_mode="Markdown")
    await send_log(message.bot, f"📤 **Withdrawal Request [# {tx_id}]**\nUser: @{username} (`{user_id}`)\nAmount: ₹{amount}\nAddress: `{address}`")

    admin_kb = InlineKeyboardMarkup(inline_keyboard=[
        [
            InlineKeyboardButton(text="✅ Approve Payout 🟢", callback_data=f"adm_wd_yes_{tx_id}"),
            InlineKeyboardButton(text="❌ Reject Payout 🔴", callback_data=f"adm_wd_no_{tx_id}")
        ]
    ])
    for adm in ADMINS:
        try:
            await message.bot.send_message(adm, f"🚨 **Withdrawal Request [# {tx_id}]**\nUser: @{username}\nAmount: ₹{amount}\nAddress: `{address}`", reply_markup=admin_kb, parse_mode="Markdown")
        except Exception:
            pass

@router.message(Command("wagerstatus"))
async def cmd_wager(message: types.Message):
    async with async_session() as session:
        user = await get_user(session, message.from_user.id)
    await message.answer(f"📊 **Wagering Status**\nPending Wager to clear: **₹{user.wager_required:.2f}**", parse_mode="Markdown")

@router.message(Command("tip"))
async def cmd_tip(message: types.Message):
    if not message.reply_to_message:
        return await message.answer("Usage: Reply to a user's message with `/tip <amount>`", parse_mode="Markdown")
    args = message.text.split()
    if len(args) < 2:
        return await message.answer("❌ Specify amount to tip.", parse_mode="Markdown")
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
            f"🎁 **You got a tip!**\n\n👤 From: @{tipper_name}\n💵 Amount: ₹{amount:.2f}\n🏦 Balance updated to: ₹{new_bal:.2f}",
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
    code_str = args.text if hasattr(message, "text") else args[1]
    
    async with async_session() as session:
        gift = await session.get(GiftCode, args[1])
        if not gift or gift.is_claimed:
            return await message.answer("❌ Invalid or already claimed gift code.")
        
        gift.is_claimed = True
        user = await get_user(session, message.from_user.id, message.from_user.username)
        user.balance += gift.amount
        await session.commit()
        new_bal = user.balance

    await message.answer(f"🎉 **Gift Code Claimed Successfully!**\nCredited: ₹{gift.amount:.2f}\nNew Balance: ₹{new_bal:.2f}", parse_mode="Markdown")
    await send_log(message.bot, f"🎉 **Gift Code Claimed**\nCode: `{args[1]}`\nUser: @{message.from_user.username} (`{message.from_user.id}`)\nAmount: ₹{gift.amount:.2f}")

# --- STRICT PVP MULTIPLAYER GAMES IMPLEMENTATION ---
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
        await session.commit()

    ACTIVE_PVPS[message.from_user.id] = {"amount": bet, "game": "battle"}
    kb = InlineKeyboardMarkup(inline_keyboard=[[InlineKeyboardButton(text="⚔️ Accept PvP Battle 🟢", callback_data=f"pvp_accept_{message.from_user.id}")]])
    await message.answer(
        f"⚔️ **PvP Battle Challenge Created!**\n\n👤 Challenger: @{message.from_user.username or message.from_user.first_name}\n💰 Stake: ₹{bet:.2f}\n\nClick below to accept this duel!",
        reply_markup=kb,
        parse_mode="Markdown"
    )

@router.callback_query(F.data.startswith("pvp_accept_"))
async def accept_pvp(callback: types.CallbackQuery):
    challenger_id = int(callback.data.split("_")[2])
    acceptor_id = callback.from_user.id

    if challenger_id == acceptor_id:
        return await callback.answer("You cannot accept your own challenge!", show_alert=True)

    if challenger_id not in ACTIVE_PVPS:
        return await callback.answer("This PvP challenge has expired or already started.", show_alert=True)

    challenge = ACTIVE_PVPS.pop(challenger_id)
    bet = challenge["amount"]

    async with async_session() as session:
        acceptor = await get_user(session, acceptor_id, callback.from_user.username)
        if acceptor.balance < bet:
            return await callback.answer(f"Insufficient funds! You need ₹{bet:.2f}", show_alert=True)
        acceptor.balance -= bet
        await session.commit()

    # Determine winner randomly
    winner_id = random.choice([challenger_id, acceptor_id])
    loser_id = acceptor_id if winner_id == challenger_id else challenger_id
    payout = bet * 1.92

    async with async_session() as session:
        winner = await get_user(session, winner_id)
        winner.balance += payout
        await session.commit()
        new_bal = winner.balance

    winner_name = (await callback.bot.get_chat(winner_id)).username or "Winner"
    loser_name = callback.from_user.username if acceptor_id == loser_id else "Challenger"

    msg = (
        f"⚔️ **ROLEX CASINO - PVP BATTLE RESULT** ⚔️\n\n"
        f"💰 **Staked Amount:** ₹{bet:.2f} each\n"
        f"✨ **Win Type:** 1.92x Multiplayer PvP\n"
        f"🏆 **Winner:** @{winner_name}\n"
        f"💵 **Total Payout:** ₹{payout:.2f}\n"
        f"🏦 **New Balance:** ₹{new_bal:.2f}"
    )
    await callback.message.edit_text(msg, parse_mode="Markdown")
    await send_log(callback.bot, f"⚔️ **PvP Battle Completed**\nWinner: `{winner_id}`\nLoser: `{loser_id}`\nPot: ₹{bet * 2:.2f}")

# Dedicated PvP Dice Game vs User
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
        await session.commit()

    ACTIVE_PVPS[message.from_user.id] = {"amount": bet, "game": "dice"}
    kb = InlineKeyboardMarkup(inline_keyboard=[[InlineKeyboardButton(text="🎲 Accept PvP Dice 🟢", callback_data=f"dice_accept_{message.from_user.id}")]])
    await message.answer(
        f"🎲 **PvP Dice Challenge Created!**\n\n👤 Challenger: @{message.from_user.username or message.from_user.first_name}\n💰 Stake: ₹{bet:.2f}\n\nClick below to match and roll 🎲!",
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
        return await callback.answer("Challenge expired.", show_alert=True)

    challenge = ACTIVE_PVPS.pop(challenger_id)
    bet = challenge["amount"]

    async with async_session() as session:
        acceptor = await get_user(session, acceptor_id, callback.from_user.username)
        if acceptor.balance < bet:
            return await callback.answer("Insufficient funds.", show_alert=True)
        acceptor.balance -= bet
        await session.commit()

    # Send telegram animated dice for both
    d1 = await callback.message.bot.send_dice(callback.message.chat.id, emoji="🎲")
    await asyncio.sleep(4)
    d2 = await callback.message.bot.send_dice(callback.message.chat.id, emoji="🎲")
    await asyncio.sleep(4)

    v1, v2 = d1.dice.value, d2.dice.value
    if v1 > v2:
        winner_id = challenger_id
    elif v2 > v1:
        winner_id = acceptor_id
    else:
        # Tie refund
        async with async_session() as session:
            c_user = await get_user(session, challenger_id)
            a_user = await get_user(session, acceptor_id)
            c_user.balance += bet
            a_user.balance += bet
            await session.commit()
        return await callback.message.answer("🤝 **It's a Tie!** Both bets refunded.", parse_mode="Markdown")

    payout = bet * 1.92
    async with async_session() as session:
        winner = await get_user(session, winner_id)
        winner.balance += payout
        await session.commit()
        new_bal = winner.balance

    msg = (
        f"🎲 **ROLEX CASINO - PVP DICE RESULT** 🎲\n\n"
        f"Challenger Rolled: {v1}\n"
        f"Acceptor Rolled: {v2}\n"
        f"✨ **1.92x Win Type**\n"
        f"🏆 **Winner ID:** `{winner_id}`\n"
        f"💵 Payout: ₹{payout:.2f}\n"
        f"🏦 New Balance: ₹{new_bal:.2f}"
    )
    await callback.message.answer(msg, parse_mode="Markdown")
    await send_log(callback.bot, f"🎲 **PvP Dice Completed**\nWinner: `{winner_id}`\nRolls: {v1} vs {v2}\nPot: ₹{bet * 2:.2f}")

# Generic wrapper for Darts, Basketball, Football, Bowling, Slots, Coin PvP
@router.message(Command("basket", "darts", "football", "bowling", "slots", "coin"))
async def pvp_generic_games(message: types.Message):
    cmd = message.text.split()[0].lower().replace("/", "")
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
        await session.commit()

    ACTIVE_PVPS[message.from_user.id] = {"amount": bet, "game": cmd}
    emoji_map = {"basket": "🏀", "darts": "🎯", "football": "⚽", "bowling": "🎳", "slots": "🎰", "coin": "🪙"}
    em = emoji_map.get(cmd, "🎮")

    kb = InlineKeyboardMarkup(inline_keyboard=[[InlineKeyboardButton(text=f"Accept PvP {cmd.capitalize()} {em} 🟢", callback_data=f"pvpgen_accept_{message.from_user.id}_{cmd}")]])
    await message.answer(
        f"{em} **PvP {cmd.capitalize()} Challenge Created!**\n\n👤 Challenger: @{message.from_user.username or message.from_user.first_name}\n💰 Stake: ₹{bet:.2f}\n\nClick below to accept!",
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
        return await callback.answer("Cannot accept your own challenge!", show_alert=True)
    if challenger_id not in ACTIVE_PVPS:
        return await callback.answer("Challenge expired.", show_alert=True)

    challenge = ACTIVE_PVPS.pop(challenger_id)
    bet = challenge["amount"]

    async with async_session() as session:
        acceptor = await get_user(session, acceptor_id, callback.from_user.username)
        if acceptor.balance < bet:
            return await callback.answer("Insufficient funds.", show_alert=True)
        acceptor.balance -= bet
        await session.commit()

    emoji_map = {"basket": "🏀", "darts": "🎯", "football": "⚽", "bowling": "🎳", "slots": "🎰", "coin": "🪙"}
    em = emoji_map.get(game, "🎲")

    d1 = await callback.message.bot.send_dice(callback.message.chat.id, emoji=em)
    await asyncio.sleep(4)
    d2 = await callback.message.bot.send_dice(callback.message.chat.id, emoji=em)
    await asyncio.sleep(4)

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
        return await callback.message.answer("🤝 **It's a Tie!** Both bets refunded.", parse_mode="Markdown")

    payout = bet * 1.92
    async with async_session() as session:
        winner = await get_user(session, winner_id)
        winner.balance += payout
        await session.commit()
        new_bal = winner.balance

    msg = (
        f"{em} **ROLEX CASINO - PVP {game.upper()} RESULT** {em}\n\n"
        f"Challenger Score: {v1}\n"
        f"Acceptor Score: {v2}\n"
        f"✨ **1.92x Win Type**\n"
        f"🏆 **Winner ID:** `{winner_id}`\n"
        f"💵 Payout: ₹{payout:.2f}\n"
        f"🏦 New Balance: ₹{new_bal:.2f}"
    )
    await callback.message.answer(msg, parse_mode="Markdown")
    await send_log(callback.bot, f"{em} **PvP {game.upper()} Completed**\nWinner: `{winner_id}`\nScores: {v1} vs {v2}\nPot: ₹{bet * 2:.2f}")

# --- ADMIN PANEL & ALL ADMIN COMMANDS ---
@router.message(Command("panel"))
async def cmd_panel(message: types.Message):
    if message.from_user.id not in ADMINS:
        return await message.answer("⛔ Access denied. Admins only.")
    
    kb = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="📋 Pending Requests 🔵", callback_data="admin_pending")],
        [InlineKeyboardButton(text="📢 Broadcast 🟢", callback_data="admin_broadcast")],
        [InlineKeyboardButton(text="👥 View Users 🔵", callback_data="admin_users")]
    ])
    status_str = "🟢 Active" if not BOT_STATE["maintenance"] else "🔴 Maintenance / Bets Off"
    await message.answer(f"🎛️ **Rolex Casino Admin Dashboard**\nBot Status: {status_str}", reply_markup=kb, parse_mode="Markdown")

@router.message(Command("hb"))
async def cmd_hb(message: types.Message):
    if message.from_user.id not in ADMINS:
        return await message.answer("⛔ Admins only.")
    
    status_str = "🟢 Active (Bets ON)" if not BOT_STATE["maintenance"] else "🔴 Maintenance (Bets OFF)"
    async with async_session() as session:
        # Calculate total vault liquidity
        import sqlalchemy as sa
        total_bal = (await session.execute(sa.select(sa.func.sum(User.balance)))).scalar() or 0.0

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
    
    code, amt = args[1], float(args[2])
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
    cmd = message.text.split()[0].lower()
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
    import sqlalchemy as sa
    async with async_session() as session:
        txs = (await session.execute(sa.select(Transaction).where(Transaction.status == "PENDING"))).scalars().all()
    if not txs:
        return await message.answer("📋 No pending deposit or withdrawal requests.")
    
    for tx in txs[:10]:
        kb = InlineKeyboardMarkup(inline_keyboard=[[
            InlineKeyboardButton(text="✅ Approve 🟢", callback_data=f"adm_dep_yes_{tx.id}" if tx.type=="DEPOSIT" else f"adm_wd_yes_{tx.id}"),
            InlineKeyboardButton(text="❌ Reject 🔴", callback_data=f"adm_dep_no_{tx.id}" if tx.type=="DEPOSIT" else f"adm_wd_no_{tx.id}")
        ]])
        await message.answer(f"🆔 **TX ID:** `{tx.id}`\n👤 User: `{tx.telegram_id}`\nType: **{tx.type}**\nAmount: ₹{tx.amount}\nMethod: {tx.method}", reply_markup=kb, parse_mode="Markdown")

@router.message(Command("users"))
async def cmd_users(message: types.Message):
    if message.from_user.id not in ADMINS:
        return await message.answer("⛔ Admins only.")
    import sqlalchemy as sa
    async with async_session() as session:
        count = (await session.execute(sa.select(sa.func.count(User.telegram_id)))).scalar() or 0
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
    await message.answer("🛠️ **Rolex Casino is now in Maintenance Mode / Bets OFF.** All non-admin commands and chats are locked.", parse_mode="Markdown")
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
            return await callback.message.edit_text("⚠️ Transaction already processed or missing.")
        
        user = await session.get(User, tx.telegram_id)
        
        if status_decision == "yes":
            tx.status = "APPROVED"
            if tx.type == "DEPOSIT":
                user.balance += tx.amount
                user.wager_required += tx.amount
                await session.commit()
                try:
                    await callback.bot.send_message(
                        tx.telegram_id,
                        f"🏆 **Deposit Approved!**\n\n💵 Credited: ₹{tx.amount:.2f}\n🏦 Balance: ₹{user.balance:.2f}\n\n⚠️ Wager ₹{tx.amount:.2f} before withdrawing (1× rule).",
                        parse_mode="Markdown"
                    )
                except Exception:
                    pass
            elif tx.type == "WITHDRAW":
                await session.commit()
                try:
                    await callback.bot.send_message(tx.telegram_id, f"🏆 **Withdrawal Approved & Processed!** Payout of ₹{tx.amount:.2f} sent.", parse_mode="Markdown")
                except Exception:
                    pass
            await callback.message.edit_text(f"✅ Transaction #{tx_id} **APPROVED**.")
            await send_log(callback.bot, f"✅ **Transaction #{tx_id} ({tx.type}) Approved** for User `{tx.telegram_id}` (Amount: ₹{tx.amount})")
        else:
            tx.status = "REJECTED"
            if tx.type == "WITHDRAW":
                user.balance += tx.amount
            await session.commit()
            try:
                await callback.bot.send_message(tx.telegram_id, f"❌ **Request #{tx_id} Rejected by Admin.**", parse_mode="Markdown")
            except Exception:
                pass
            await callback.message.edit_text(f"❌ Transaction #{tx_id} **REJECTED**.")
            await send_log(callback.bot, f"❌ **Transaction #{tx_id} ({tx.type}) Rejected** for User `{tx.telegram_id}`")
    await callback.answer()

# --- MAIN ENTRY POINT ---
async def main():
    await init_db()
    bot = Bot(token=BOT_TOKEN)
    storage = MemoryStorage()
    dp = Dispatcher(storage=storage)

    dp.message.middleware(security_middleware)
    dp.callback_query.middleware(security_middleware)

    dp.include_router(router)

    logger.info("Rolex Casino PvP Bot starting polling...")
    await bot.delete_webhook(drop_pending_updates=True)
    await dp.start_polling(bot)

if __name__ == "__main__":
    asyncio.run(main())
