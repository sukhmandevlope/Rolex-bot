import os
import logging
import asyncio
import random
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

# -------------------------------------------------------------------------
# LOGGING SETUP (FIXED TO LOGS CHANNEL & CONSOLE)
# -------------------------------------------------------------------------
logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s", level=logging.INFO
)
logger = logging.getLogger(__name__)

# -------------------------------------------------------------------------
# CONFIGURATIONS & CONSTANTS
# -------------------------------------------------------------------------
TOKEN = "8673935058:AAFfWmN-JwfN-6bG300maSL4W-AE5QCUOb4"
BOT_NAME = "Rolex Casino BOT"
BOT_USERNAME = "@Rolex_C_BOT"
GROUP_LINK = "https://t.me/RolexCasinos"
GROUP_ID = -1004458883943
LOGS_CHANNEL_ID = -1004458883943  # Linked logs channel: https://t.me/RolexCasinoLOGS

ADMIN_IDS = [8860529495, 1053006219]
ADMIN_USERNAMES = ["@Lucifer_1209", "@luffy_rolex", "@RolexCasinoMod"]

UPI_ADDRESS = "rutvik1209@fam"
CRYPTO_WALLETS = {
    "USDT (BEP20)": "0xD8419224A65C3d35C10AE695562463c8445ACb15",
    "SOLANA": "3bKsCSR2mmconFaExejbkuGfeQNuVQPFttzj9y2MP2mE",
    "ETHEREUM": "0xD8419224A65C3d35C10AE695562463c8445ACb15",
    "BITCOIN": "bc1qsm7xzn4k8kpxwurzjsredangepvzgh70y0ypzd",
}

# -------------------------------------------------------------------------
# IN-MEMORY DATABASE SIMULATION & STATE
# -------------------------------------------------------------------------
user_balances = {}       # user_id -> balance (INR base)
user_wager = {}          # user_id -> wager requirement tracker
user_currency = {}       # user_id -> "INR" or "USD"
user_addresses = {}      # user_id -> default payout address
user_stats = {}          # user_id -> {"wins": 0, "losses": 0, "total_played": 0}
referrals = {}           # user_id -> count of referred users
escrow_vault = {}        # escrow_id -> escrow data dictionary
active_pvp_rooms = {}    # room_id -> room game details
pending_deposits = {}    # req_id -> deposit request data
maintenance_mode = False

# -------------------------------------------------------------------------
# HELPER UTILITIES
# -------------------------------------------------------------------------
def is_admin(user_id: int) -> bool:
    return user_id in ADMIN_IDS

def get_curr_symbol(user_id: int) -> str:
    return "$" if user_currency.get(user_id, "INR") == "USD" else "₹"

async def send_log(context: ContextTypes.DEFAULT_TYPE, text: str):
    try:
        await context.bot.send_message(chat_id=LOGS_CHANNEL_ID, text=text, parse_mode="Markdown")
    except Exception as e:
        logger.error(f"Failed to push log to channel: {e}")

async def check_maintenance(update: Update) -> bool:
    global maintenance_mode
    if maintenance_mode:
        if update.effective_user and not is_admin(update.effective_user.id):
            if update.message:
                await update.message.reply_text(
                    "🛠️ **Rolex Casino is currently under maintenance! All systems & chats are locked.** Please check back later.",
                    parse_mode="Markdown",
                )
            return True
    return False

# -------------------------------------------------------------------------
# START & CORE COMMANDS
# -------------------------------------------------------------------------
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if await check_maintenance(update):
        return

    chat = update.effective_chat
    if chat.type != "private":
        await update.message.reply_text(
            "👋 **Welcome to Rolex Casino!**\n\nPlease open our bot in DM to manage your wallet securely.",
            reply_markup=InlineKeyboardMarkup(
                [[InlineKeyboardButton("🤖 Open Bot DM", url=f"https://t.me/{BOT_USERNAME[1:]}")]]
            ),
            parse_mode="Markdown",
        )
        return

    welcome_text = (
        "🏆 **WELCOME TO ROLEX–PLAY** 🏆\n\n"
        "The ultimate destination for elite crypto & INR wagering.\n"
        "• Fast Automated Verification & Payouts\n"
        "• Fair 100% PvP Multiplayer & Emoji Battles\n\n"
        "If you want to play games send **/help** command below and for support **/support**."
    )
    keyboard = [
        [InlineKeyboardButton("🟢 Join Official Group", url=GROUP_LINK)],
        [
            InlineKeyboardButton("💳 Deposit", callback_data="menu_deposit"),
            InlineKeyboardButton("💸 Withdraw", callback_data="menu_withdraw"),
        ],
        [InlineKeyboardButton("🆘 Support & Help", url=GROUP_LINK)],
    ]
    await update.message.reply_text(welcome_text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")

async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if await check_maintenance(update):
        return
    help_text = (
        "📜 **ROLEX CASINO COMMAND DIRECTORY & RULES** 📜\n\n"
        "🎮 **PvP Arena & Multiplayer Games:**\n"
        "• `/dice [amount] [rounds]` - 🎲 PvP Dice duel\n"
        "• `/darts [amount] [rounds]` - 🎯 PvP Darts target match\n"
        "• `/bowling [amount] [rounds]` - 🎳 PvP Bowling match\n"
        "• `/basket [amount] [rounds]` - 🏀 PvP Basketball shootout\n"
        "• `/football [amount] [rounds]` - ⚽ PvP Football penalty kick\n"
        "• `/slots [amount] [rounds]` - 🎰 PvP Slots 777 duel\n"
        "• `/coin [amount]` - 🪙 PvP Coin flip challenge\n"
        "• `/battle [amount]` - ⚔️ Choose any PvP duel\n\n"
        "💼 **Wallet & Finance (DM Only):**\n"
        "• `/wallet` - View balance, bank vault & stats\n"
        "• `/deposit` - Add funds instantly (UPI ₹70-₹5000 / Crypto $1-$50)\n"
        "• `/withdraw` - Request payout to UPI or Crypto\n"
        "• `/setwallet [address]` - Save default payout address\n"
        "• `/changecurrency` - Toggle INR (₹) and USD ($)\n"
        "• `/wagerstatus` - Check 1x deposit wagering progress\n\n"
        "🤝 **Escrow & Social:**\n"
        "• `/escrow [amount]` (reply user) - Create a secure trade escrow\n"
        "• `/tip [amount]` (reply user) - Send funds instantly to a player\n"
        "• `/refer` - Invite friends & earn ₹5 per referral\n"
        "• `/mystats` - View personal gaming stats & winrate\n"
        "• `/rank` - Top 10 High Rollers leaderboard\n\n"
        "🛠️ **Support & Admin:**\n"
        "• `/support` - 24/7 VIP cashier & admin desk\n"
        "• `/panel` - Admin panel (Admins Only)\n"
        "• `/maintenance` - Toggle maintenance mode (Admins Only)\n"
        "• `/cancel [room_id]` - Admin command to abort a room round"
    )
    await update.message.reply_text(help_text, parse_mode="Markdown")

async def support_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    support_text = (
        "🆘 **ROLEX CASINO SUPPORT DESK** 🆘\n\n"
        "Need help with deposits, withdrawals, or escrow trades? Our official team is available 24/7.\n\n"
        f"• Official Community Group: [Click Here]({GROUP_LINK})\n"
        "• Designated Admin Desks: `@Lucifer_1209`, `@luffy_rolex`, `@RolexCasinoMod`"
    )
    keyboard = [[InlineKeyboardButton("💬 Open Support Group", url=GROUP_LINK)]]
    await update.message.reply_text(support_text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")

# -------------------------------------------------------------------------
# MAINTENANCE & ADMIN PANEL COMMANDS
# -------------------------------------------------------------------------
async def maintenance_toggle(update: Update, context: ContextTypes.DEFAULT_TYPE):
    global maintenance_mode
    user = update.effective_user
    if not is_admin(user.id):
        await update.message.reply_text("❌ Unauthorized. Admin only command.")
        return

    maintenance_mode = not maintenance_mode
        status = "activated 🔒 (All chats & commands locked)" if maintenance_mode else "deactivated 🟢 (Fully operational)"
    await update.message.reply_text(f"⚠️ **Maintenance mode has been {status}.**", parse_mode="Markdown")
    await send_log(context, f"🛠️ **MAINTENANCE TOGGLED:** Status -> {status} by @{user.username}")

async def admin_panel(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    if not is_admin(user.id):
        await update.message.reply_text("❌ Unauthorized access. Admins only.")
        return

    panel_text = (
        f"🛡️ **{BOT_NAME} ADMIN PANEL** 🛡️\n\n"
        f"Welcome Admin @{user.username}!\n"
        f"Use buttons below to manage system settings or review pending requests."
    )
    keyboard = [
        [InlineKeyboardButton("⚙️ Toggle Maintenance", callback_data="admin_toggle_maint")],
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

    room_id = context.args[0]
    room = active_pvp_rooms.get(room_id)
    if not room:
        await update.message.reply_text(f"❌ Room ID `{room_id}` not found or already closed.", parse_mode="Markdown")
        return

    creator_id = room["creator_id"]
    amount = room["amount"]
    user_balances[creator_id] = user_balances.get(creator_id, 0.0) + amount
    del active_pvp_rooms[room_id]

    await update.message.reply_text(f"✅ **Room {room_id} cancelled by admin.** Refunded ₹{amount:.2f} to creator.", parse_mode="Markdown")
    await send_log(context, f"🛠️ **ADMIN CANCEL:** Room `{room_id}` aborted by Admin @{user.username}")

# -------------------------------------------------------------------------
# WALLET & FINANCE COMMANDS (DM ONLY)
# -------------------------------------------------------------------------
async def wallet_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if await check_maintenance(update):
        return
    user = update.effective_user
    chat = update.effective_chat
    if chat.type != "private":
        await update.message.reply_text(
            "⚠️ Wallet management can **only** be accessed inside the bot's DM inbox.",
            reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🤖 Open Wallet in DM", url=f"https://t.me/{BOT_USERNAME[1:]}?start=wallet")]]))
        return

    bal = user_balances.get(user.id, 0.0)
    wager = user_wager.get(user.id, 0.0)
    sym = get_curr_symbol(user.id)
    
    wallet_text = (
        f"🏦 **ROLEX USER WALLET & VAULT** 🏦\n\n"
        f"👤 **Account:** @{user.username or user.first_name} (`{user.id}`)\n"
        f"💰 **Available Balance:** {sym}{bal:.2f}\n"
        f"🔒 **Pending Wagering Req:** {sym}{wager:.2f}\n"
        f"📍 **Default Payout Address:** `{user_addresses.get(user.id, 'Not Set')}`"
    )
    keyboard = [
        [
            InlineKeyboardButton("🟢 Deposit", callback_data="menu_deposit"),
            InlineKeyboardButton("🔴 Withdraw", callback_data="menu_withdraw")
        ],
        [InlineKeyboardButton("🔵 My Stats", callback_data="menu_mystats")]
    ]
    await update.message.reply_text(wallet_text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")

async def setwallet_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    if not context.args:
        await update.message.reply_text("❌ **Usage:** `/setwallet [Your UPI ID or Crypto Address]`", parse_mode="Markdown")
        return
    addr = " ".join(context.args)
    user_addresses[user.id] = addr
    await update.message.reply_text(f"✅ **Default wallet address successfully updated to:** `{addr}`", parse_mode="Markdown")

async def changecurrency_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    curr = user_currency.get(user.id, "INR")
    new_curr = "USD" if curr == "INR" else "INR"
    user_currency[user.id] = new_curr
    sym = "$" if new_curr == "USD" else "₹"
    await update.message.reply_text(f"💱 **Currency display successfully changed to:** `{new_curr} ({sym})`", parse_mode="Markdown")

async def wagerstatus_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    wager = user_wager.get(user.id, 0.0)
    sym = get_curr_symbol(user.id)
    await update.message.reply_text(
        f"📊 **Wagering Status:**\n\nYou must wager **{sym}{wager:.2f}** more in PvP games before submitting a withdrawal request (1x rule).",
        parse_mode="Markdown"
    )

async def refer_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    ref_link = f"https://t.me/{BOT_USERNAME[1:]}?start=ref_{user.id}"
    refs_count = len(referrals.get(user.id, set()))
    refer_text = (
        f"🎁 **ROLEX REFERRAL PROGRAM** 🎁\n\n"
        f"Invite friends and earn **₹5.00** instantly per referral once they join!\n\n"
        f"🔗 **Your Referral Link:**\n`{ref_link}`\n\n"
        f"👥 **Total Friends Referred:** `{refs_count}`"
    )
    await update.message.reply_text(refer_text, parse_mode="Markdown")

async def mystats_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    stats = user_stats.get(user.id, {"wins": 0, "losses": 0, "total_played": 0})
    wins = stats["wins"]
    losses = stats["losses"]
    total = stats["total_played"]
    winrate = (wins / total * 100) if total > 0 else 0.0

    stats_text = (
        f"📊 **PERSONAL GAMING STATISTICS** 📊\n\n"
        f"👤 **Player:** @{user.username or user.first_name}\n"
        f"🎮 **Total Matches Played:** `{total}`\n"
        f"🏆 **Wins:** `{wins}` | ❌ **Losses:** `{losses}`\n"
        f"🎯 **Overall Winrate:** `{winrate:.1f}%`"
    )
    await update.message.reply_text(stats_text, parse_mode="Markdown")

async def rank_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    sorted_users = sorted(user_balances.items(), key=lambda x: x[1], reverse=True)[:10]
    rank_text = "🏆 **TOP 10 HIGH ROLLERS LEADERBOARD** 🏆\n\n"
    if not sorted_users:
        rank_text += "No high rollers recorded yet."
    else:
        for idx, (uid, bal) in enumerate(sorted_users, 1):
            rank_text += f"{idx}. User ID `{uid}` — **₹{bal:.2f}**\n"
    await update.message.reply_text(rank_text, parse_mode="Markdown")

async def tip_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    if not update.message.reply_to_message:
        await update.message.reply_text("❌ **Usage:** Reply to a user's message with `/tip [amount]`", parse_mode="Markdown")
        return
    if len(context.args) < 1:
        await update.message.reply_text("❌ Please specify the tip amount. E.g., `/tip 100`", parse_mode="Markdown")
        return
    
    try:
        amount = float(context.args[0])
    except ValueError:
        await update.message.reply_text("❌ Invalid amount format.", parse_mode="Markdown")
        return

    target_user = update.message.reply_to_message.from_user
    if target_user.id == user.id:
        await update.message.reply_text("❌ You cannot tip yourself.", parse_mode="Markdown")
        return

    sender_bal = user_balances.get(user.id, 0.0)
    if sender_bal < amount:
        await update.message.reply_text("❌ Insufficient balance to send tip.", parse_mode="Markdown")
        return

    user_balances[user.id] = sender_bal - amount
    user_balances[target_user.id] = user_balances.get(target_user.id, 0.0) + amount

    await update.message.reply_text(
        f"🎁 **Tip Successful!**\n\n@{user.username or user.first_name} tipped **₹{amount:.2f}** to @{target_user.username or target_user.first_name}!",
        parse_mode="Markdown"
    )
    await send_log(context, f"💸 **TIP LOG:** @{user.username} tipped ₹{amount:.2f} to @{target_user.username}")

# -------------------------------------------------------------------------
| STRICT DEPOSIT & WITHDRAW SYSTEM (DM ONLY WITH COLOR BUTTONS)
# -------------------------------------------------------------------------
async def deposit_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if await check_maintenance(update):
        return

    chat = update.effective_chat
    if chat.type != "private":
        await update.message.reply_text(
            "⚠️ **Deposits can only be made inside the bot's DM inbox for security reasons.**",
            reply_markup=InlineKeyboardMarkup(
                [
                    [InlineKeyboardButton("🟢 Deposit in DM", url=f"https://t.me/{BOT_USERNAME[1:]}?start=deposit")],
                    [InlineKeyboardButton("🔴 Withdraw in DM", url=f"https://t.me/{BOT_USERNAME[1:]}?start=withdraw")],
                    [InlineKeyboardButton("🔵 Open Group", url=GROUP_LINK)]
                ]
            ),
            parse_mode="Markdown"
        )
        return

    text = "💳 **SELECT DEPOSIT METHOD:**\n\nChoose your preferred currency or gateway below:\n• **UPI (INR):** Min ₹70 — Max ₹5,000\n• **Crypto:** Min $1 — Max $50"
    keyboard = [
        [InlineKeyboardButton("🟢 UPI (INR)", callback_data="dep_upi")],
        [InlineKeyboardButton("🪙 USDT (BEP20)", callback_data="dep_USDT (BEP20)")],
        [InlineKeyboardButton("⚡ Solana", callback_data="dep_SOLANA")],
        [InlineKeyboardButton("💎 Ethereum", callback_data="dep_ETHEREUM")],
        [InlineKeyboardButton("₿ Bitcoin", callback_data="dep_BITCOIN")],
    ]
    await update.message.reply_text(text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")

async def withdraw_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if await check_maintenance(update):
        return
    user = update.effective_user
    chat = update.effective_chat
    if chat.type != "private":
        await update.message.reply_text(
            "⚠️ **Withdrawals must be requested inside bot DM for security.**",
            reply_markup=InlineKeyboardMarkup(
                [
                    [InlineKeyboardButton("🔴 Open DM Payouts", url=f"https://t.me/{BOT_USERNAME[1:]}?start=withdraw")],
                    [InlineKeyboardButton("🟢 Deposit", url=f"https://t.me/{BOT_USERNAME[1:]}?start=deposit")]
                ]
            ),
            parse_mode="Markdown"
        )
        return

    wager = user_wager.get(user.id, 0.0)
    if wager > 0:
        await update.message.reply_text(f"❌ **Withdrawal Locked:** You have an active wagering requirement of ₹{wager:.2f} remaining.")
        return

    bal = user_balances.get(user.id, 0.0)
    if bal < 50.0:
        await update.message.reply_text("❌ Minimum withdrawal amount is ₹50.00.")
        return

    addr = user_addresses.get(user.id)
    if not addr:
        await update.message.reply_text("❌ Please set your default payout address first using `/setwallet [address]`.", parse_mode="Markdown")
        return

    user_balances[user.id] = 0.0
    req_id = f"wd_{user.id}_{int(asyncio.get_event_loop().time())}"
    
    admin_msg = (
        f"💸 **NEW WITHDRAWAL REQUEST!**\n\n"
        f"👤 User: @{user.username} (`{user.id}`)\n"
        f"💰 Amount: ₹{bal:.2f}\n"
        f"📍 Destination Address: `{addr}`"
    )
    keyboard = [[
        InlineKeyboardButton("🟢 Paid / Complete", callback_data=f"wd_yes_{req_id}"),
        InlineKeyboardButton("🔴 Reject / Refund", callback_data=f"wd_no_{req_id}")
    ]]
    for adm in ADMIN_IDS:
        try:
            await context.bot.send_message(chat_id=adm, text=admin_msg, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")
        except Exception:
            pass

    await update.message.reply_text(f"✅ **Withdrawal request for ₹{bal:.2f} submitted successfully!** Sent to payout queue.", parse_mode="Markdown")
    await send_log(context, f"💸 **WITHDRAWAL PENDING:** User @{user.username} requested payout of ₹{bal:.2f} to `{addr}`")

# -------------------------------------------------------------------------
# SECURE ESCROW SYSTEM (WITH IMAGE, 3 COLOR BUTTONS & HELD ESCROW)
# -------------------------------------------------------------------------
async def escrow_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if await check_maintenance(update):
        return
    user = update.effective_user
    chat = update.effective_chat
    if chat.type == "private":
        await update.message.reply_text("❌ Escrow trading must be initiated inside the official group chat.")
        return

    if not update.message.reply_to_message:
        await update.message.reply_text("❌ **Usage:** Reply to trade partner with `/escrow [amount]`", parse_mode="Markdown")
        return
    if len(context.args) < 1:
        await update.message.reply_text("❌ Please specify escrow amount. E.g., `/escrow 500`", parse_mode="Markdown")
        return

    try:
        amount = float(context.args[0])
    except ValueError:
        await update.message.reply_text("❌ Invalid numeric amount.", parse_mode="Markdown")
        return

    maker = user
    taker = update.message.reply_to_message.from_user

    if maker.id == taker.id:
        await update.message.reply_text("❌ You cannot create an escrow with yourself.", parse_mode="Markdown")
        return

    maker_bal = user_balances.get(maker.id, 0.0)
    if maker_bal < amount:
        await update.message.reply_text("❌ Insufficient balance to lock escrow amount.", parse_mode="Markdown")
        return

    user_balances[maker.id] = maker_bal - amount
    escrow_id = f"esc_{random.randint(10000, 99999)}"

    escrow_vault[escrow_id] = {
        "maker_id": maker.id,
        "maker_name": maker.username or maker.first_name,
        "taker_id": taker.id,
        "taker_name": taker.username or taker.first_name,
        "amount": amount,
        "status": "active"
    }

    escrow_text = (
        f"🔐 **ROLEX SECURE TRADE ESCROW** 🔐\n\n"
        f"📌 **Escrow ID:** `#{escrow_id}`\n"
        f"👤 **Maker (Holder):** @{maker.username or maker.first_name} (`{maker.id}`)\n"
        f"👤 **Taker (Partner):** @{taker.username or taker.first_name} (`{taker.id}`)\n"
        f"💰 **Escrow Amount Held:** `₹{amount:.2f}`\n\n"
        f"⚠️ Funds are locked securely inside Rolex Vault until released or cancelled."
    )

    # 3 Color-coded Inline Buttons: Green (Release), Red (Cancel), Blue (Support)
    keyboard = [
        [
            InlineKeyboardButton("🟢 Release", callback_data=f"esc_rel_{escrow_id}"),
            InlineKeyboardButton("🔴 Cancel", callback_data=f"esc_can_{escrow_id}")
        ],
        [InlineKeyboardButton("🔵 Support Desk", url=GROUP_LINK)]
    ]

    await update.message.reply_text(escrow_text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")
    await send_log(context, f"🔐 **ESCROW CREATED:** ID `#{escrow_id}` | Maker: @{maker.username} | Taker: @{taker.username} | Amount: ₹{amount:.2f}")

async def escrow_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    data = query.data
    user_id = update.effective_user.id

    parts = data.split("_")
    action = parts[1] # rel or can
    escrow_id = parts[2]

    escrow = escrow_vault.get(escrow_id)
    if not escrow or escrow["status"] != "active":
        await query.answer("Escrow is invalid, completed, or already cancelled!", show_alert=True)
        return

    maker_id = escrow["maker_id"]
    taker_id = escrow["taker_id"]
    amount = escrow["amount"]

    if user_id not in [maker_id, taker_id] and not is_admin(user_id):
        await query.answer("Unauthorized! Only trade participants or admins can control this escrow.", show_alert=True)
        return

    if action == "rel":
        user_balances[taker_id] = user_balances.get(taker_id, 0.0) + amount
        escrow["status"] = "released"
        
        success_text = (
            f"✅ **ESCROW SUCCESSFULLY RELEASED!**\n\n"
            f"📌 **ID:** `#{escrow_id}`\n"
            f"🏆 **Recipient:** @{escrow['taker_name']}\n"
            f"💰 **Released Amount:** `₹{amount:.2f}`\n\n"
            f"🟢 **Status:** Completed & Credited."
        )
        await query.edit_message_text(success_text, parse_mode="Markdown")
        await send_log(context, f"✅ **ESCROW RELEASED:** ID `#{escrow_id}` released ₹{amount:.2f} to @{escrow['taker_name']}")

    elif action == "can":
        user_balances[maker_id] = user_balances.get(maker_id, 0.0) + amount
        escrow["status"] = "cancelled"

        cancel_text = (
            f"❌ **ESCROW CANCELLED & REFUNDED!**\n\n"
            f"📌 **ID:** `#{escrow_id}`\n"
            f"💰 **Refunded to Maker (@{escrow['maker_name']}):** `₹{amount:.2f}`\n\n"
            f"🔴 **Status:** Cancelled."
        )
        await query.edit_message_text(cancel_text, parse_mode="Markdown")
        await send_log(context, f"❌ **ESCROW CANCELLED:** ID `#{escrow_id}` refunded ₹{amount:.2f} to @{escrow['maker_name']}")

# -------------------------------------------------------------------------
# 100% PVP GAMES ENGINE (DICE, DARTS, BOWLING, BASKETBALL, FOOTBALL, SLOTS, COIN)
# -------------------------------------------------------------------------
async def pvp_game_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if await check_maintenance(update):
        return
    chat = update.effective_chat
    user = update.effective_user
    command = update.message.text.split()[0].replace("/", "")

    if chat.type == "private":
        await update.message.reply_text(
            "🎮 **PvP multiplayer games can only be played inside the official group chat!**",
            reply_markup=InlineKeyboardMarkup(
                [
                    [InlineKeyboardButton("🟢 Go To Group", url=GROUP_LINK)],
                    [InlineKeyboardButton("🔴 Deposit Balance", url=f"https://t.me/{BOT_USERNAME[1:]}?start=deposit")]
                ]
            ),
            parse_mode="Markdown"
        )
        return

    if len(context.args) < 1:
        await update.message.reply_text(f"❌ **Usage:** `/{command} [amount] [rounds]` (Min ₹10 / $0.10)", parse_mode="Markdown")
        return

    try:
        amount = float(context.args[0])
    except ValueError:
        await update.message.reply_text("❌ Invalid amount format.", parse_mode="Markdown")
        return

    if amount < 10.0:
        await update.message.reply_text("❌ Minimum PvP stake is ₹10.00 ($0.10).", parse_mode="Markdown")
        return

    user_bal = user_balances.get(user.id, 0.0)
    if user_bal < amount:
        await update.message.reply_text(
            "❌ **Insufficient balance to create PvP room.** Please deposit in DM.",
            reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🟢 Deposit in DM", url=f"https://t.me/{BOT_USERNAME[1:]}?start=deposit")]]),
            parse_mode="Markdown"
        )
        return

    user_balances[user.id] = user_bal - amount
    room_id = f"room_{random.randint(1000,9999)}"

    active_pvp_rooms[room_id] = {
        "creator_id": user.id,
        "creator_name": user.username or user.first_name,
        "game_type": command,
        "amount": amount,
        "status": "waiting"
    }

    win_amount = amount * 1.92
    room_text = (
        f"🎮 **ROLEX PVP {command.upper()} DUEL ARENA** 🎮\n\n"
        f"👤 **Host:** @{user.username or user.first_name}\n"
        f"💰 **Staked Amount:** `₹{amount:.2f}`\n"
        f"🏆 **Potential Payout (1.92x):** `₹{win_amount:.2f}`\n"
        f"📌 **Room ID:** `#{room_id}`\n\n"
        f"Click **Accept** below to match this duel!"
    )
    keyboard = [
        [
            InlineKeyboardButton("🟢 Accept Duel", callback_data=f"pvp_acc_{room_id}"),
            InlineKeyboardButton("🔴 Decline", callback_data=f"pvp_dec_{room_id}")
        ],
        [InlineKeyboardButton("🔵 Group Support", url=GROUP_LINK)]
    ]
    await update.message.reply_text(room_text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")
    await send_log(context, f"🎮 **PVP ROOM CREATED:** `#{room_id}` | Game: {command} | Host: @{user.username} | Stake: ₹{amount:.2f}")

async def coin_game_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if await check_maintenance(update):
        return
    chat = update.effective_chat
    user = update.effective_user

    if chat.type == "private":
        await update.message.reply_text(
            "🎮 **Coin flip duel must be played in the group chat.**",
            reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🟢 Go To Group", url=GROUP_LINK)]]),
            parse_mode="Markdown"
        )
        return

    if len(context.args) < 1:
        await update.message.reply_text("❌ **Usage:** `/coin [amount]`", parse_mode="Markdown")
        return

    try:
        amount = float(context.args[0])
    except ValueError:
        await update.message.reply_text("❌ Invalid amount specified.", parse_mode="Markdown")
        return

    if amount < 10.0:
        await update.message.reply_text("❌ Minimum coin stake is ₹10.00 ($0.10).", parse_mode="Markdown")
        return

    user_bal = user_balances.get(user.id, 0.0)
    if user_bal < amount:
        await update.message.reply_text("❌ Insufficient balance.", parse_mode="Markdown")
        return

    user_balances[user.id] = user_bal - amount
    room_id = f"coin_{random.randint(1000,9999)}"

    active_pvp_rooms[room_id] = {
        "creator_id": user.id,
        "creator_name": user.username or user.first_name,
        "game_type": "coin",
        "amount": amount,
        "status": "waiting"
    }

    win_amount = amount * 1.92
    coin_text = (
        f"🪙 **ROLEX COIN FLIP CHALLENGE** 🪙\n\n"
        f"👤 **Challenger:** @{user.username or user.first_name}\n"
        f"💰 **Staked Amount:** `₹{amount:.2f}`\n"
        f"✨ **Win Amount (1.92x):** `₹{win_amount:.2f}`\n"
        f"📌 **Room ID:** `#{room_id}`\n\n"
        f"Click Accept to flip the coin!"
    )
    keyboard = [
        [
            InlineKeyboardButton("🟢 Accept Coin", callback_data=f"pvp_acc_{room_id}"),
            InlineKeyboardButton("🔴 Decline", callback_data=f"pvp_dec_{room_id}")
        ]
    ]
    await update.message.reply_text(coin_text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")

async def pvp_callback_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    data = query.data
    user = update.effective_user

    parts = data.split("_")
    action = parts[1] # acc or dec
    room_id = parts[2]

    room = active_pvp_rooms.get(room_id)
    if not room or room["status"] != "waiting":
        await query.answer("This duel room is no longer active or already completed!", show_alert=True)
        return

    creator_id = room["creator_id"]
    amount = room["amount"]
    game_type = room["game_type"]

    if action == "dec":
        if user.id != creator_id and not is_admin(user.id):
            await query.answer("Only room creator or admin can decline/abort this room.", show_alert=True)
            return
        user_balances[creator_id] = user_balances.get(creator_id, 0.0) + amount
        room["status"] = "cancelled"
        del active_pvp_rooms[room_id]
        await query.edit_message_text(f"❌ **Duel Room #{room_id} cancelled.** Stake refunded to creator.")
        return

    if action == "acc":
        if user.id == creator_id:
            await query.answer("You cannot accept your own duel room!", show_alert=True)
            return

        taker_bal = user_balances.get(user.id, 0.0)
        if taker_bal < amount:
            await query.answer("You have insufficient balance to accept this duel!", show_alert=True)
            return

        user_balances[user.id] = taker_bal - amount
        room["status"] = "playing"
        taker_id = user.id
        taker_name = user.username or user.first_name
        creator_name = room["creator_name"]

        if game_type == "coin":
            await query.edit_message_text("🪙 **Coin is spinning in the air...** 🔄", parse_mode="Markdown")
            await asyncio.sleep(1.5)
            
            winner_id = random.choice([creator_id, taker_id])
            winner_name = creator_name if winner_id == creator_id else taker_name
            total_pot = amount * 2.0
            win_payout = amount * 1.92

            user_balances[winner_id] = user_balances.get(winner_id, 0.0) + win_payout

            for uid in [creator_id, taker_id]:
                st = user_stats.setdefault(uid, {"wins": 0, "losses": 0, "total_played": 0})
                st["total_played"] += 1
                if uid == winner_id:
                    st["wins"] += 1
                else:
                    st["losses"] += 1

            user_wager[creator_id] = max(0.0, user_wager.get(creator_id, 0.0) - amount)
            user_wager[taker_id] = max(0.0, user_wager.get(taker_id, 0.0) - amount)

            result_text = (
                f"🪙 **ROLEX COIN FLIP RESULT** 🪙\n\n"
                f"🏆 **Winner:** @{winner_name}\n"
                f"💰 **Total Pot:** `₹{total_pot:.2f}`\n"
                f"✨ **Payout (1.92x):** `₹{win_payout:.2f}` credited successfully!"
            )
            await query.message.edit_text(result_text, parse_mode="Markdown")
            del active_pvp_rooms[room_id]
            await send_log(context, f"🪙 **COIN DUEL FINISHED:** Winner @{winner_name} won ₹{win_payout:.2f}")

        else:
            await query.edit_message_text(f"🎲 **Duel accepted! Rolling {game_type.upper()} arena outcome...**", parse_mode="Markdown")
            await asyncio.sleep(1.0)

            winner_id = random.choice([creator_id, taker_id])
            winner_name = creator_name if winner_id == creator_id else taker_name
            win_payout = amount * 1.92

            user_balances[winner_id] = user_balances.get(winner_id, 0.0) + win_payout

            for uid in [creator_id, taker_id]:
                st = user_stats.setdefault(uid, {"wins": 0, "losses": 0, "total_played": 0})
                st["total_played"] += 1
                if uid == winner_id:
                    st["wins"] += 1
                else:
                    st["losses"] += 1

            user_wager[creator_id] = max(0.0, user_wager.get(creator_id, 0.0) - amount)
            user_wager[taker_id] = max(0.0, user_wager.get(taker_id, 0.0) - amount)

            game_result_text = (
                f"🎮 **ROLEX PVP {game_type.upper()} ARENA RESULT** 🎮\n\n"
                f"🏆 **Winner:** @{winner_name}\n"
                f"🎯 **Game Type:** {game_type.capitalize()}\n"
                f"💰 **Winning Payout (1.92x):** `₹{win_payout:.2f}` credited!"
            )
            await query.message.edit_text(game_result_text, parse_mode="Markdown")
            del active_pvp_rooms[room_id]
            await send_log(context, f"🎮 **PVP {game_type.upper()} FINISHED:** Winner @{winner_name} won ₹{win_payout:.2f}")

# -------------------------------------------------------------------------
# MESSAGE ROUTER FOR DEPOSIT VERIFICATION (UTR/HASH & SCREENSHOT)
# -------------------------------------------------------------------------
async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if await check_maintenance(update):
        return
    chat = update.effective_chat
    user = update.effective_user
    text = update.message.text if update.message else ""
    step = context.user_data.get("step")

    if chat.type == "private" and step:
        if step == "awaiting_txid":
            method = context.user_data.get("dep_method")
            if method == "upi":
                if not text.isdigit() or len(text) != 12:
                    await update.message.reply_text("❌ Invalid UTR. Must be exactly 12 numeric digits only. Try again:")
                    return
            else:
                if not (64 <= len(text) <= 66):
                    await update.message.reply_text("❌ Invalid transaction ID length. Must be 64-66 characters. Try again:")
                    return

            context.user_data["txid"] = text
            context.user_data["step"] = "awaiting_screenshot"
            await update.message.reply_text("📸 Now please send your **payment screenshot image**:")
            return

        elif step == "awaiting_screenshot" and update.message.photo:
            method = context.user_data.get("dep_method")
            txid = context.user_data.get("txid")
            photo_id = update.message.photo[-1].file_id

            req_id = f"dep_{user.id}_{int(asyncio.get_event_loop().time())}"
            pending_deposits[req_id] = {
                "user_id": user.id,
                "username": user.username or user.first_name,
                "method": method,
                "txid": txid,
                "photo": photo_id,
            }

            admin_msg = (
                f"📥 **NEW DEPOSIT PROOF SUBMITTED!**\n\n"
                f"👤 User: @{user.username} (`{user.id}`)\n"
                f"💳 Method: {method}\n"
                f"🔖 Ref ID / UTR: `{txid}`"
            )
            keyboard = [[
                InlineKeyboardButton("🟢 Approve", callback_data=f"app_yes_{req_id}"),
                InlineKeyboardButton("🔴 Reject", callback_data=f"app_no_{req_id}")
            ]]
            for adm in ADMIN_IDS:
                try:
                    await context.bot.send_photo(
                        chat_id=adm,
                        photo=photo_id,
                        caption=admin_msg,
                        reply_markup=InlineKeyboardMarkup(keyboard),
                        parse_mode="Markdown"
                    )
                except Exception:
                    pass

            context.user_data.clear()
            await update.message.reply_text("⏳ **Deposit submitted successfully! Please wait for admin approval.**", parse_mode="Markdown")
            await send_log(context, f"📥 **DEPOSIT SUBMITTED:** User @{user.username} submitted {method} deposit ref `{txid}`")
            return

# -------------------------------------------------------------------------
# ADMIN APPROVAL & CALLBACK ROUTER
# -------------------------------------------------------------------------
async def admin_approval_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    data = query.data
    user_id = update.effective_user.id

    if not is_admin(user_id):
        await query.answer("Unauthorized!", show_alert=True)
        return

    parts = data.split("_")
    action = parts[1] # yes or no
    req_id = parts[2] + "_" + parts[3] + "_" + parts[4] if len(parts) > 4 else parts[2] + "_" + parts[3]

    if data.startswith("app_"):
        dep = pending_deposits.get(req_id)
        if not dep:
            await query.edit_message_caption("⚠️ Request already processed or expired.")
            return

        target_user = dep["user_id"]
        if action == "yes":
            credited = 50.00
            user_balances[target_user] = user_balances.get(target_user, 0.0) + credited
            user_wager[target_user] = user_wager.get(target_user, 0.0) + credited

            success_msg = (
                f"🏆 **Deposit Approved!**\n\n"
                f"💵 Credited: ₹{credited:.2f}\n"
                f"🏦 Balance: ₹{user_balances[target_user]:.2f}\n\n"
                f"⚠️ Wager ₹{credited:.2f} before withdrawing (1× deposit rule)"
            )
            try:
                await context.bot.send_message(chat_id=target_user, text=success_msg, parse_mode="Markdown")
            except Exception:
                pass
            await query.edit_message_caption(f"{query.message.caption}\n\n✅ **APPROVED by Admin**", parse_mode="Markdown")
            await send_log(context, f"✅ **DEPOSIT APPROVED:** Credited ₹{credited:.2f} to user ID `{target_user}`")
        else:
            try:
                await context.bot.send_message(chat_id=target_user, text="❌ **Your deposit request was rejected by admin.**", parse_mode="Markdown")
            except Exception:
                pass
            await query.edit_message_caption(f"{query.message.caption}\n\n❌ **REJECTED by Admin**", parse_mode="Markdown")
            await send_log(context, f"❌ **DEPOSIT REJECTED:** For user ID `{target_user}`")

        del pending_deposits[req_id]

    elif data.startswith("wd_"):
        if action == "yes":
            await query.edit_message_text(f"{query.message.text}\n\n✅ **WITHDRAWAL PAID & CLOSED BY ADMIN**", parse_mode="Markdown")
            await send_log(context, f"💸 **WITHDRAWAL PAID:** Processed by Admin @{update.effective_user.username}")
        else:
            await query.edit_message_text(f"{query.message.text}\n\n❌ **WITHDRAWAL REJECTED & REFUNDED BY ADMIN**", parse_mode="Markdown")
            await send_log(context, f"❌ **WITHDRAWAL REJECTED:** Refunded by Admin @{update.effective_user.username}")

async def deposit_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    data = query.data

    if data == "menu_deposit":
        await deposit_command(update, context)
        return
    if data == "menu_withdraw":
        await query.message.reply_text("💸 Send `/withdraw` in chat to process payouts.", parse_mode="Markdown")
        return
    if data == "menu_mystats":
        await mystats_command(update, context)
        return
    if data == "admin_toggle_maint":
        await maintenance_toggle(update, context)
        return

    if data.startswith("dep_"):
        method = data.replace("dep_", "")
        context.user_data["dep_method"] = method

        if method == "upi":
            msg = (
                f"🇮🇳 **UPI Deposit Details**\n\n"
                f"UPI ID: `{UPI_ADDRESS}`\n"
                f"Limits: Min ₹70 — Max ₹5,000\n\n"
                f"Please pay to the UPI ID above, then click the button below once paid."
            )
        else:
            wallet = CRYPTO_WALLETS.get(method, "N/A")
            msg = (
                f"🪙 **{method} Deposit Details**\n\n"
                f"Address:\n`{wallet}`\n"
                f"Limits: Min $1 — Max $50\n\n"
                f"Transfer exact amount, then click below once paid."
            )

        keyboard = [[InlineKeyboardButton("🟢 I've Paid", callback_data="dep_paid")]]
        await query.message.edit_text(msg, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")
        context.user_data["step"] = "awaiting_txid"

    elif data == "dep_paid":
        method = context.user_data.get("dep_method", "upi")
        if method == "upi":
            prompt = "📝 Please enter your **12-digit numeric UTR number**:"
        else:
            prompt = "📝 Please enter your **Crypto Transaction Hash** (64-66 characters):"

        context.user_data["step"] = "awaiting_txid"
        await query.message.edit_text(prompt, parse_mode="Markdown")

# -------------------------------------------------------------------------
# MAIN INITIALIZATION & ROUTING
# -------------------------------------------------------------------------
def main():
    application = Application.builder().token(TOKEN).build()

    # Core Command Handlers
    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("help", help_command))
    application.add_handler(CommandHandler("support", support_command))
    
    # Wallet & Financial Handlers
    application.add_handler(CommandHandler("wallet", wallet_command))
    application.add_handler(CommandHandler("deposit", deposit_command))
    application.add_handler(CommandHandler("withdraw", withdraw_command))
    application.add_handler(CommandHandler("setwallet", setwallet_command))
    application.add_handler(CommandHandler("changecurrency", changecurrency_command))
    application.add_handler(CommandHandler("wagerstatus", wagerstatus_command))
    application.add_handler(CommandHandler("refer", refer_command))
    application.add_handler(CommandHandler("mystats", mystats_command))
    application.add_handler(CommandHandler("rank", rank_command))
    application.add_handler(CommandHandler("tip", tip_command))

    # Escrow & Admin Handlers
    application.add_handler(CommandHandler("escrow", escrow_command))
    application.add_handler(CommandHandler("cancel", cancel_room_command))
    application.add_handler(CommandHandler("maintenance", maintenance_toggle))
    application.add_handler(CommandHandler("panel", admin_panel))

    # PvP Game Room Handlers
    application.add_handler(CommandHandler("dice", pvp_game_command))
    application.add_handler(CommandHandler("darts", pvp_game_command))
    application.add_handler(CommandHandler("bowling", pvp_game_command))
    application.add_handler(CommandHandler("basket", pvp_game_command))
    application.add_handler(CommandHandler("football", pvp_game_command))
    application.add_handler(CommandHandler("slots", pvp_game_command))
    application.add_handler(CommandHandler("coin", coin_game_command))
    application.add_handler(CommandHandler("battle", pvp_game_command))

    # Callback & Message Handlers
    application.add_handler(CallbackQueryHandler(deposit_callback, pattern="^(menu_|dep_|admin_)"))
    application.add_handler(CallbackQueryHandler(escrow_callback, pattern="^esc_"))
    application.add_handler(CallbackQueryHandler(pvp_callback_handler, pattern="^pvp_"))
    application.add_handler(CallbackQueryHandler(admin_approval_callback, pattern="^(app_|wd_)"))

    application.add_handler(MessageHandler(filters.ALL & ~filters.COMMAND, handle_message))

    print(f"{BOT_NAME} is fully up and running with all PVP features, maintenance lock, and color buttons...")
    application.run_polling()

if __name__ == "__main__":
    main()
