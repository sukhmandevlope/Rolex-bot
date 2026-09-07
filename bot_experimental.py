"""
RolexCasino standalone Python bot.

This file is intentionally independent from the existing TypeScript service.
It uses the existing PostgreSQL casino tables for players, wallets, ledgers,
escrows, and cash requests, and adds small tables for payment verification and
house-fee accounting.

Telegram limitations:
* Bots can use HTML bold and premium-emoji tags, but cannot force a serif font.
* Telegram does not expose a button-background color API. Green action labels
  and green-circle icons are used instead.

Required environment:
  TELEGRAM_BOT_TOKEN
  DATABASE_URL

Optional environment:
  ADMIN_USER_IDS=123,456
  OFFICIAL_GROUP_ID=-1004458883943
  HOUSE_CURRENCY=INR
  DEPOSIT_UPI_ADDRESS=...
  DEPOSIT_BTC_ADDRESS=...
  DEPOSIT_BSC_ADDRESS=...
  DEPOSIT_SOLANA_ADDRESS=...
  DEPOSIT_ETHEREUM_ADDRESS=...
"""

from __future__ import annotations

import asyncio
import html
import logging
import os
import re
import secrets
import subprocess
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, ROUND_CEILING, ROUND_HALF_UP
from io import BytesIO
from typing import Any, Optional

import asyncpg
from telegram import (
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    InputFile,
    InputMediaPhoto,
    Update,
)
from telegram.constants import ParseMode
from telegram.ext import (
    Application,
    ApplicationBuilder,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
LOGGER = logging.getLogger("rolexcasino-python")

TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN") or os.environ.get("BOT_TOKEN")
DATABASE_URL = os.environ.get("DATABASE_URL")
OFFICIAL_GROUP_ID = int(os.environ.get("OFFICIAL_GROUP_ID", "-1004458883943"))
GROUP_LINK = os.environ.get("GROUP_LINK", "https://t.me/RolexCasinos")
HOUSE_CURRENCY = os.environ.get("HOUSE_CURRENCY", "INR").upper()
SUPPORTED_CURRENCIES = {"INR", "USD"}
INR_PER_USD = Decimal("98")
ESCROW_FEE_RATE = Decimal("0.02")
TIP_CONFIRMATION_THRESHOLD_INR_MINOR = 5_000
MAX_GAME_STAKE = {"INR": 50_000, "USD": 500}

if HOUSE_CURRENCY not in SUPPORTED_CURRENCIES:
    HOUSE_CURRENCY = "INR"

ADMIN_USER_IDS = {
    int(value.strip())
    for value in os.environ.get("ADMIN_USER_IDS", "").split(",")
    if value.strip().lstrip("-").isdigit()
}

NETWORK_LABELS = {
    "upi": "UPI (INR)",
    "btc": "BTC",
    "bsc": "BSC (BEP20)",
    "solana": "Solana",
    "ethereum": "Ethereum",
}
NETWORK_ENV_KEYS = {
    "upi": "DEPOSIT_UPI_ADDRESS",
    "btc": "DEPOSIT_BTC_ADDRESS",
    "bsc": "DEPOSIT_BSC_ADDRESS",
    "solana": "DEPOSIT_SOLANA_ADDRESS",
    "ethereum": "DEPOSIT_ETHEREUM_ADDRESS",
}

# The supplied Emoji Unigram list. Telegram renders these only when the bot
# has access to the relevant premium emoji pack.
PREMIUM_EMOJIS = {
    "plane": ("5877700484453634587", "✈️"),
    "star": ("5870801633104891858", "⭐️"),
    "upload": ("5873225338984599714", "📤"),
    "ghost": ("5872695159631647090", "👾"),
    "settings": ("5870982283724328568", "⚙"),
    "plus": ("5870741379008698885", "➕"),
    "user": ("5870994129244131212", "👤"),
    "users": ("5870772616305839506", "👥"),
    "clock": ("5870496192210669260", "⏲"),
    "question": ("5872996816659681395", "❓"),
    "smile": ("5870944724235324724", "🙂"),
    "chart": ("5870930636742595124", "📊"),
    "trend": ("5870891312022032055", "📈"),
    "briefcase": ("5870896281299193767", "💼"),
    "globe": ("5870718740236079262", "🌐"),
    "cross": ("5870657884844462243", "❌"),
    "check": ("5870633910337015697", "✅"),
    "heart": ("5870601113966743414", "❤"),
    "pen": ("5870753782874246579", "✍"),
    "book": ("5870995890180722030", "📖"),
    "money": ("5870478797593120516", "💵"),
    "trophy": ("5870684638195748414", "🏆"),
    "hand": ("5870948572526022116", "✋"),
    "arrow": ("5870673952317116522", "➡️"),
    "lock": ("5870704313440932932", "🔒"),
    "image": ("5870782662234346251", "🖼"),
    "stop": ("5872988737826197458", "⛔️"),
    "info": ("5870609858520158157", "ℹ️"),
    "bell": ("5870687545888607770", "🔔"),
    "computer": ("5870748341150683538", "💻"),
    "search": ("5870974879200711167", "🔎"),
    "alarm": ("5870729937215819584", "⏰️"),
    "eye": ("5870542612217204751", "👁"),
    "trash": ("5870875489363438", "🗑"),
}


def pe(name: str) -> str:
    """Return a premium emoji tag with a safe Unicode fallback."""
    emoji_id, fallback = PREMIUM_EMOJIS.get(name, PREMIUM_EMOJIS["star"])
    return f'<tg-emoji emoji-id="{emoji_id}">{fallback}</tg-emoji>'


def esc(value: Any) -> str:
    return html.escape(str(value), quote=True)


def professional(*lines: str, icon: str = "star") -> str:
    """All bot text is bold; dynamic values must be escaped before calling."""
    return "<b>" + pe(icon) + " " + "\n".join(lines) + "</b>"


def money(minor: int, currency: str) -> str:
    amount = Decimal(minor) / Decimal(100)
    symbol = "₹" if currency == "INR" else "$"
    rendered = f"{amount:,.2f}"
    return f"{symbol}{rendered} {currency}"


def parse_money(raw: Optional[str]) -> Optional[int]:
    if not raw or not re.fullmatch(r"\d+(?:\.\d{1,2})?", raw):
        return None
    try:
        value = Decimal(raw)
    except Exception:
        return None
    if value <= 0 or value > Decimal("20000000"):
        return None
    return int((value * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def currency(raw: Optional[str], fallback: str = "USD") -> str:
    value = (raw or fallback).upper()
    return value if value in SUPPORTED_CURRENCIES else fallback


def convert_minor(value: int, source: str, target: str) -> int:
    if source == target:
        return value
    if source == "INR" and target == "USD":
        return int((Decimal(value) / INR_PER_USD).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    return int((Decimal(value) * INR_PER_USD).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def escrow_fee(amount_minor: int) -> int:
    return max(
        1,
        int(
            (Decimal(amount_minor) * ESCROW_FEE_RATE).quantize(
                Decimal("1"), rounding=ROUND_CEILING
            )
        ),
    )


def transaction_id() -> str:
    return str(uuid.uuid4())


def code() -> str:
    return "RX-" + secrets.token_hex(5).upper()


@dataclass
class PaymentIntent:
    id: int
    player_id: int
    amount_minor: int
    currency: str
    network: str
    status: str


class Database:
    def __init__(self, dsn: str):
        self.dsn = dsn
        self.pool: Optional[asyncpg.Pool] = None

    async def connect(self) -> None:
        self.pool = await asyncpg.create_pool(self.dsn, min_size=1, max_size=10)
        await self.ensure_schema()

    async def close(self) -> None:
        if self.pool:
            await self.pool.close()

    def require_pool(self) -> asyncpg.Pool:
        if not self.pool:
            raise RuntimeError("Database is not connected")
        return self.pool

    async def ensure_schema(self) -> None:
        pool = self.require_pool()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS casino_payment_intents (
                  id BIGSERIAL PRIMARY KEY,
                  player_id INTEGER NOT NULL REFERENCES casino_players(id),
                  amount_minor INTEGER NOT NULL,
                  currency VARCHAR(3) NOT NULL,
                  network VARCHAR(20) NOT NULL,
                  payment_address TEXT,
                  utr TEXT,
                  proof_file_id TEXT,
                  proof_type VARCHAR(20),
                  status VARCHAR(20) NOT NULL DEFAULT 'created',
                  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 minutes'),
                  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
                CREATE TABLE IF NOT EXISTS casino_house_ledger (
                  id BIGSERIAL PRIMARY KEY,
                  transaction_id TEXT NOT NULL,
                  entry_type VARCHAR(40) NOT NULL,
                  currency VARCHAR(3) NOT NULL,
                  amount_minor INTEGER NOT NULL,
                  description TEXT NOT NULL,
                  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
                CREATE TABLE IF NOT EXISTS casino_wager_requirements (
                  id BIGSERIAL PRIMARY KEY,
                  player_id INTEGER NOT NULL REFERENCES casino_players(id),
                  currency VARCHAR(3) NOT NULL,
                  required_minor INTEGER NOT NULL DEFAULT 0,
                  completed_minor INTEGER NOT NULL DEFAULT 0,
                  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                  UNIQUE (player_id, currency)
                );
                ALTER TABLE casino_payment_intents
                  ADD COLUMN IF NOT EXISTS proof_file_id TEXT;
                ALTER TABLE casino_payment_intents
                  ADD COLUMN IF NOT EXISTS proof_type VARCHAR(20);
                """
            )

    async def player(self, user) -> asyncpg.Record:
        pool = self.require_pool()
        display_name = " ".join(
            part for part in [user.first_name, user.last_name] if part
        ) or "Player"
        async with pool.acquire() as conn:
            return await conn.fetchrow(
                """
                INSERT INTO casino_players
                  (telegram_user_id, username, display_name)
                VALUES ($1, $2, $3)
                ON CONFLICT (telegram_user_id) DO UPDATE SET
                  username = EXCLUDED.username,
                  display_name = EXCLUDED.display_name,
                  updated_at = NOW()
                RETURNING *
                """,
                user.id,
                user.username,
                display_name,
            )

    async def player_by_username(self, username: str) -> Optional[asyncpg.Record]:
        async with self.require_pool().acquire() as conn:
            return await conn.fetchrow(
                "SELECT * FROM casino_players WHERE LOWER(username) = LOWER($1) LIMIT 1",
                username.lstrip("@"),
            )

    async def player_by_id(self, player_id: int) -> Optional[asyncpg.Record]:
        async with self.require_pool().acquire() as conn:
            return await conn.fetchrow(
                "SELECT * FROM casino_players WHERE id = $1 LIMIT 1",
                player_id,
            )

    async def wallet(self, player_id: int, curr: str) -> asyncpg.Record:
        async with self.require_pool().acquire() as conn:
            await conn.execute(
                """
                INSERT INTO casino_wallets (player_id, currency)
                VALUES ($1, $2)
                ON CONFLICT (player_id, currency) DO NOTHING
                """,
                player_id,
                curr,
            )
            return await conn.fetchrow(
                """
                SELECT * FROM casino_wallets
                WHERE player_id = $1 AND currency = $2
                """,
                player_id,
                curr,
            )

    async def balance_text(self, player_id: int, preferred: str) -> str:
        async with self.require_pool().acquire() as conn:
            rows = await conn.fetch(
                "SELECT currency, balance_minor FROM casino_wallets WHERE player_id = $1",
                player_id,
            )
            wager_rows = await conn.fetch(
                """
                SELECT currency, required_minor, completed_minor
                FROM casino_wager_requirements
                WHERE player_id = $1
                ORDER BY currency
                """,
                player_id,
            )
        balances = {row["currency"]: row["balance_minor"] for row in rows}
        inr = balances.get("INR", 0)
        usd = balances.get("USD", 0)
        total_inr = inr + convert_minor(usd, "USD", "INR")
        lines = [
            f"{pe('money')} {esc(preferred)} wallet: {esc(money(balances.get(preferred, 0), preferred))}",
            f"{pe('briefcase')} INR wallet: {esc(money(inr, 'INR'))}",
            f"{pe('briefcase')} USD wallet: {esc(money(usd, 'USD'))}",
            f"{pe('chart')} Total value: {esc(money(total_inr, 'INR'))}",
            f"{pe('trend')} Rate: 1 USD = ₹{INR_PER_USD}",
        ]
        for row in wager_rows:
            remaining = max(0, row["required_minor"] - row["completed_minor"])
            lines.append(
                f"{pe('lock')} {esc(row['currency'])} wager remaining: "
                f"{esc(money(remaining, row['currency']))}"
            )
        return "\n".join(lines)

    async def wager_status(self, player_id: int) -> list[asyncpg.Record]:
        async with self.require_pool().acquire() as conn:
            return await conn.fetch(
                """
                SELECT currency, required_minor, completed_minor
                FROM casino_wager_requirements
                WHERE player_id = $1
                ORDER BY currency
                """,
                player_id,
            )

    async def add_wager_requirement(
        self, conn, player_id: int, curr: str, amount_minor: int
    ) -> None:
        await conn.execute(
            """
            INSERT INTO casino_wager_requirements
              (player_id, currency, required_minor, completed_minor)
            VALUES ($1, $2, $3, 0)
            ON CONFLICT (player_id, currency)
            DO UPDATE SET
              required_minor = casino_wager_requirements.required_minor + EXCLUDED.required_minor,
              updated_at = NOW()
            """,
            player_id,
            curr,
            amount_minor,
        )

    async def record_wager(
        self, conn, player_id: int, curr: str, amount_minor: int
    ) -> None:
        await conn.execute(
            """
            INSERT INTO casino_wager_requirements
              (player_id, currency, required_minor, completed_minor)
            VALUES ($1, $2, 0, $3)
            ON CONFLICT (player_id, currency)
            DO UPDATE SET
              completed_minor = LEAST(
                casino_wager_requirements.required_minor,
                casino_wager_requirements.completed_minor + EXCLUDED.completed_minor
              ),
              updated_at = NOW()
            """,
            player_id,
            curr,
            amount_minor,
        )

    async def set_preferred_currency(self, player_id: int, curr: str) -> bool:
        async with self.require_pool().acquire() as conn:
            result = await conn.execute(
                """
                UPDATE casino_players
                SET preferred_currency = $2, updated_at = NOW()
                WHERE id = $1
                """,
                player_id,
                curr,
            )
        return result.endswith("1")

    async def get_challenge(self, challenge_id: int) -> Optional[asyncpg.Record]:
        async with self.require_pool().acquire() as conn:
            return await conn.fetchrow(
                "SELECT * FROM casino_challenges WHERE id = $1",
                challenge_id,
            )

    async def create_challenge(
        self,
        creator_id: int,
        opponent_id: Optional[int],
        mode: str,
        game_type: str,
        amount_minor: int,
        curr: str,
        chat_id: int,
    ) -> asyncpg.Record:
        async with self.require_pool().acquire() as conn:
            return await conn.fetchrow(
                """
                INSERT INTO casino_challenges
                  (creator_player_id, mode, player_two_id, chat_id, game_type, emoji,
                   currency, stake_minor, rounds, rolls_per_round, target_wins,
                   result_rule, status, turn_deadline_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, 1, 1, 'high',
                        'open', NOW() + INTERVAL '120 seconds')
                RETURNING *
                """,
                creator_id,
                mode,
                opponent_id,
                chat_id,
                game_type,
                "🎲" if game_type == "dice" else "🪙",
                curr,
                amount_minor,
            )

    async def expire_challenge(self, challenge_id: int) -> bool:
        async with self.require_pool().acquire() as conn:
            result = await conn.execute(
                """
                UPDATE casino_challenges
                SET status = 'cancelled', completed_at = NOW()
                WHERE id = $1
                  AND status IN ('open', 'accepted')
                  AND turn_deadline_at < NOW()
                """,
                challenge_id,
            )
        return result.endswith("1")

    async def accept_challenge(self, challenge_id: int, opponent_id: int) -> Optional[asyncpg.Record]:
        async with self.require_pool().acquire() as conn:
            return await conn.fetchrow(
                """
                UPDATE casino_challenges
                SET status = 'accepted'
                WHERE id = $1 AND player_two_id = $2
                  AND mode = 'pvp' AND status = 'open'
                  AND turn_deadline_at >= NOW()
                RETURNING *
                """,
                challenge_id,
                opponent_id,
            )

    async def decline_challenge(self, challenge_id: int, opponent_id: int) -> bool:
        async with self.require_pool().acquire() as conn:
            result = await conn.execute(
                """
                UPDATE casino_challenges
                SET status = 'cancelled', completed_at = NOW()
                WHERE id = $1 AND player_two_id = $2
                  AND mode = 'pvp' AND status = 'open'
                """,
                challenge_id,
                opponent_id,
            )
        return result.endswith("1")

    async def cancel_challenge(self, challenge_id: int, creator_id: int) -> bool:
        async with self.require_pool().acquire() as conn:
            result = await conn.execute(
                """
                UPDATE casino_challenges
                SET status = 'cancelled', completed_at = NOW()
                WHERE id = $1 AND creator_player_id = $2
                  AND mode = 'pvb' AND status = 'open'
                """,
                challenge_id,
                creator_id,
            )
        return result.endswith("1")

    async def settle_challenge(
        self,
        challenge_id: int,
        creator_roll: int,
        opponent_roll: int,
    ) -> dict[str, Any]:
        pool = self.require_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                challenge = await conn.fetchrow(
                    """
                    SELECT * FROM casino_challenges
                    WHERE id = $1 FOR UPDATE
                    """,
                    challenge_id,
                )
                if not challenge:
                    raise ValueError("GAME_NOT_FOUND")
                if challenge["status"] not in ("open", "accepted"):
                    raise ValueError("GAME_NOT_OPEN")
                if challenge["turn_deadline_at"] and challenge["turn_deadline_at"] < datetime.now(timezone.utc):
                    await conn.execute(
                        """
                        UPDATE casino_challenges
                        SET status = 'cancelled', completed_at = NOW()
                        WHERE id = $1
                        """,
                        challenge_id,
                    )
                    raise ValueError("GAME_EXPIRED")

                creator_id = challenge["creator_player_id"]
                opponent_id = challenge["player_two_id"]
                curr = challenge["currency"]
                stake = challenge["stake_minor"]
                creator_wallet = await self._wallet_conn(conn, creator_id, curr)
                creator_debit = await conn.fetchrow(
                    """
                    UPDATE casino_wallets
                    SET balance_minor = balance_minor - $2, updated_at = NOW()
                    WHERE id = $1 AND balance_minor >= $2
                    RETURNING balance_minor
                    """,
                    creator_wallet["id"],
                    stake,
                )
                if not creator_debit:
                    raise ValueError("GAME_INSUFFICIENT_BALANCE")

                winner_id: Optional[int]
                creator_payout = 0
                opponent_payout = 0
                if challenge["mode"] == "pvb":
                    if creator_roll > opponent_roll:
                        winner_id = creator_id
                        creator_payout = int(
                            (Decimal(stake) * Decimal("1.92")).quantize(
                                Decimal("1"), rounding=ROUND_HALF_UP
                            )
                        )
                    elif creator_roll == opponent_roll:
                        winner_id = None
                        creator_payout = stake
                    else:
                        winner_id = None
                else:
                    if not opponent_id:
                        raise ValueError("GAME_OPPONENT_MISSING")
                    opponent_wallet = await self._wallet_conn(conn, opponent_id, curr)
                    opponent_debit = await conn.fetchrow(
                        """
                        UPDATE casino_wallets
                        SET balance_minor = balance_minor - $2, updated_at = NOW()
                        WHERE id = $1 AND balance_minor >= $2
                        RETURNING balance_minor
                        """,
                        opponent_wallet["id"],
                        stake,
                    )
                    if not opponent_debit:
                        raise ValueError("GAME_OPPONENT_INSUFFICIENT_BALANCE")
                    if creator_roll > opponent_roll:
                        winner_id = creator_id
                        creator_payout = stake * 2
                    elif opponent_roll > creator_roll:
                        winner_id = opponent_id
                        opponent_payout = stake * 2
                    else:
                        winner_id = None
                        creator_payout = stake
                        opponent_payout = stake

                if creator_payout:
                    await conn.execute(
                        """
                        UPDATE casino_wallets
                        SET balance_minor = balance_minor + $2, updated_at = NOW()
                        WHERE id = $1
                        """,
                        creator_wallet["id"],
                        creator_payout,
                    )
                if opponent_id and opponent_payout:
                    opponent_wallet = await self._wallet_conn(conn, opponent_id, curr)
                    await conn.execute(
                        """
                        UPDATE casino_wallets
                        SET balance_minor = balance_minor + $2, updated_at = NOW()
                        WHERE id = $1
                        """,
                        opponent_wallet["id"],
                        opponent_payout,
                    )

                txid = transaction_id()
                await conn.execute(
                    """
                    INSERT INTO casino_ledger_entries
                      (wallet_id, transaction_id, entry_type, amount_minor, description)
                    VALUES ($1, $2, 'game_stake', $3, $4)
                    """,
                    creator_wallet["id"],
                    txid,
                    -stake,
                    f"{challenge['game_type']} challenge #{challenge_id} stake",
                )
                if creator_payout:
                    await conn.execute(
                        """
                        INSERT INTO casino_ledger_entries
                          (wallet_id, transaction_id, entry_type, amount_minor, description)
                        VALUES ($1, $2, 'game_payout', $3, $4)
                        """,
                        creator_wallet["id"],
                        txid,
                        creator_payout,
                        f"{challenge['game_type']} challenge #{challenge_id} payout",
                    )
                creator_outcome = (
                    "WIN" if winner_id == creator_id else "DRAW" if winner_id is None and creator_payout else "LOSS"
                )
                await conn.execute(
                    """
                    INSERT INTO casino_game_rounds
                      (player_id, helper_bot, game_type, currency, stake_minor,
                       roll_value, outcome, payout_minor)
                    VALUES ($1, 'python-bot', $2, $3, $4, $5, $6, $7)
                    """,
                    creator_id,
                    challenge["game_type"],
                    curr,
                    stake,
                    creator_roll,
                    creator_outcome,
                    creator_payout,
                )

                if opponent_id:
                    opponent_wallet = await self._wallet_conn(conn, opponent_id, curr)
                    await conn.execute(
                        """
                        INSERT INTO casino_ledger_entries
                          (wallet_id, transaction_id, entry_type, amount_minor, description)
                        VALUES ($1, $2, 'game_stake', $3, $4)
                        """,
                        opponent_wallet["id"],
                        txid,
                        -stake,
                        f"{challenge['game_type']} challenge #{challenge_id} stake",
                    )
                    if opponent_payout:
                        await conn.execute(
                            """
                            INSERT INTO casino_ledger_entries
                              (wallet_id, transaction_id, entry_type, amount_minor, description)
                            VALUES ($1, $2, 'game_payout', $3, $4)
                            """,
                            opponent_wallet["id"],
                            txid,
                            opponent_payout,
                            f"{challenge['game_type']} challenge #{challenge_id} payout",
                        )
                    opponent_outcome = (
                        "WIN" if winner_id == opponent_id else "DRAW" if winner_id is None else "LOSS"
                    )
                    await conn.execute(
                        """
                        INSERT INTO casino_game_rounds
                          (player_id, helper_bot, game_type, currency, stake_minor,
                           roll_value, outcome, payout_minor)
                        VALUES ($1, 'python-bot', $2, $3, $4, $5, $6, $7)
                        """,
                        opponent_id,
                        challenge["game_type"],
                        curr,
                        stake,
                        opponent_roll,
                        opponent_outcome,
                        opponent_payout,
                    )

                completed = await conn.fetchrow(
                    """
                    UPDATE casino_challenges
                    SET status = 'completed', winner_player_id = $2,
                        player_one_score = $3, player_two_score = $4,
                        completed_at = NOW()
                    WHERE id = $1 AND status IN ('open', 'accepted')
                    RETURNING *
                    """,
                    challenge_id,
                    winner_id,
                    1 if creator_roll > opponent_roll else 0,
                    1 if opponent_roll > creator_roll else 0,
                )
                return {
                    "challenge": completed,
                    "creator_roll": creator_roll,
                    "opponent_roll": opponent_roll,
                    "winner_id": winner_id,
                    "creator_payout": creator_payout,
                    "opponent_payout": opponent_payout,
                }

    async def create_payment_intent(
        self, player_id: int, amount_minor: int, curr: str
    ) -> int:
        async with self.require_pool().acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO casino_payment_intents
                  (player_id, amount_minor, currency, network, status)
                VALUES ($1, $2, $3, 'pending-network', 'created')
                RETURNING id
                """,
                player_id,
                amount_minor,
                curr,
            )
            return row["id"]

    async def choose_network(self, intent_id: int, player_id: int, network: str) -> Optional[PaymentIntent]:
        address = os.environ.get(NETWORK_ENV_KEYS[network], "").strip()
        if not address:
            return None
        async with self.require_pool().acquire() as conn:
            row = await conn.fetchrow(
                """
                UPDATE casino_payment_intents
                SET network = $3, payment_address = $4, status = 'awaiting-payment',
                    updated_at = NOW()
                WHERE id = $1 AND player_id = $2 AND status IN ('created', 'pending-network')
                RETURNING id, player_id, amount_minor, currency, network, status
                """,
                intent_id,
                player_id,
                network,
                address or None,
            )
        return PaymentIntent(**dict(row)) if row else None

    async def payment_intent(self, intent_id: int) -> Optional[asyncpg.Record]:
        async with self.require_pool().acquire() as conn:
            return await conn.fetchrow(
                "SELECT * FROM casino_payment_intents WHERE id = $1",
                intent_id,
            )

    async def cancel_payment_intent(self, intent_id: int, player_id: int) -> bool:
        async with self.require_pool().acquire() as conn:
            result = await conn.execute(
                """
                UPDATE casino_payment_intents
                SET status = 'cancelled', updated_at = NOW()
                WHERE id = $1
                  AND player_id = $2
                  AND status IN ('created', 'pending-network', 'awaiting-payment')
                """,
                intent_id,
                player_id,
            )
        return result.endswith("1")

    async def cash_request(self, request_id: int) -> Optional[asyncpg.Record]:
        async with self.require_pool().acquire() as conn:
            return await conn.fetchrow(
                "SELECT * FROM casino_cash_requests WHERE id = $1",
                request_id,
            )

    async def submit_utr(self, intent_id: int, player_id: int, utr: str) -> Optional[PaymentIntent]:
        async with self.require_pool().acquire() as conn:
            row = await conn.fetchrow(
                """
                UPDATE casino_payment_intents
                SET utr = $3, status = 'submitted', updated_at = NOW()
                WHERE id = $1 AND player_id = $2 AND status = 'awaiting-payment'
                RETURNING id, player_id, amount_minor, currency, network, status
                """,
                intent_id,
                player_id,
                utr,
            )
        return PaymentIntent(**dict(row)) if row else None

    async def approve_deposit(self, intent_id: int) -> Optional[asyncpg.Record]:
        pool = self.require_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                intent = await conn.fetchrow(
                    """
                    SELECT * FROM casino_payment_intents
                    WHERE id = $1 AND status = 'submitted'
                    FOR UPDATE
                    """,
                    intent_id,
                )
                if not intent:
                    return None
                wallet = await self._wallet_conn(conn, intent["player_id"], intent["currency"])
                updated = await conn.fetchrow(
                    """
                    UPDATE casino_wallets
                    SET balance_minor = balance_minor + $2, updated_at = NOW()
                    WHERE id = $1
                    RETURNING balance_minor
                    """,
                    wallet["id"],
                    intent["amount_minor"],
                )
                txid = transaction_id()
                await conn.execute(
                    """
                    INSERT INTO casino_ledger_entries
                      (wallet_id, transaction_id, entry_type, amount_minor, description)
                    VALUES ($1, $2, 'deposit_credit', $3, $4)
                    """,
                    wallet["id"],
                    txid,
                    intent["amount_minor"],
                    f"Verified deposit #{intent_id} via {intent['network']}",
                )
                await conn.execute(
                    """
                    UPDATE casino_payment_intents
                    SET status = 'approved', updated_at = NOW()
                    WHERE id = $1
                    """,
                    intent_id,
                )
                await conn.execute(
                    """
                    INSERT INTO casino_cash_requests
                      (player_id, request_type, currency, amount_minor, status, note, reviewed_at)
                    VALUES ($1, 'deposit', $2, $3, 'completed', $4, NOW())
                    """,
                    intent["player_id"],
                    intent["currency"],
                    intent["amount_minor"],
                    f"Verified UTR {intent['utr']} via {intent['network']}",
                )
                return updated

    async def reject_deposit(self, intent_id: int) -> bool:
        async with self.require_pool().acquire() as conn:
            result = await conn.execute(
                """
                UPDATE casino_payment_intents
                SET status = 'rejected', updated_at = NOW()
                WHERE id = $1 AND status = 'submitted'
                """,
                intent_id,
            )
        return result.endswith("1")

    async def create_withdrawal(
        self, player_id: int, amount_minor: int, curr: str, payout_type: str, payout: str
    ) -> Optional[int]:
        pool = self.require_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                wallet = await self._wallet_conn(conn, player_id, curr)
                updated = await conn.fetchrow(
                    """
                    UPDATE casino_wallets
                    SET balance_minor = balance_minor - $2, updated_at = NOW()
                    WHERE id = $1 AND balance_minor >= $2
                    RETURNING balance_minor
                    """,
                    wallet["id"],
                    amount_minor,
                )
                if not updated:
                    return None
                txid = transaction_id()
                await conn.execute(
                    """
                    INSERT INTO casino_ledger_entries
                      (wallet_id, transaction_id, entry_type, amount_minor, description)
                    VALUES ($1, $2, 'withdrawal_hold', $3, $4)
                    """,
                    wallet["id"],
                    txid,
                    -amount_minor,
                    f"Withdrawal hold via {payout_type}",
                )
                row = await conn.fetchrow(
                    """
                    INSERT INTO casino_cash_requests
                      (player_id, request_type, currency, amount_minor, status, note)
                    VALUES ($1, 'withdrawal', $2, $3, 'pending', $4)
                    RETURNING id
                    """,
                    player_id,
                    curr,
                    amount_minor,
                    f"{payout_type}: {payout}",
                )
                return row["id"]

    async def approve_withdrawal(self, request_id: int) -> bool:
        async with self.require_pool().acquire() as conn:
            result = await conn.execute(
                """
                UPDATE casino_cash_requests
                SET status = 'completed', reviewed_at = NOW(),
                    note = COALESCE(note, '') || ' | Admin approved'
                WHERE id = $1 AND request_type = 'withdrawal' AND status = 'pending'
                """,
                request_id,
            )
        return result.endswith("1")

    async def reject_withdrawal(self, request_id: int) -> bool:
        pool = self.require_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                request = await conn.fetchrow(
                    """
                    SELECT * FROM casino_cash_requests
                    WHERE id = $1 AND request_type = 'withdrawal' AND status = 'pending'
                    FOR UPDATE
                    """,
                    request_id,
                )
                if not request:
                    return False
                wallet = await self._wallet_conn(conn, request["player_id"], request["currency"])
                await conn.execute(
                    """
                    UPDATE casino_wallets
                    SET balance_minor = balance_minor + $2, updated_at = NOW()
                    WHERE id = $1
                    """,
                    wallet["id"],
                    request["amount_minor"],
                )
                await conn.execute(
                    """
                    INSERT INTO casino_ledger_entries
                      (wallet_id, transaction_id, entry_type, amount_minor, description)
                    VALUES ($1, $2, 'withdrawal_refund', $3, $4)
                    """,
                    wallet["id"],
                    transaction_id(),
                    request["amount_minor"],
                    f"Withdrawal #{request_id} rejected",
                )
                await conn.execute(
                    """
                    UPDATE casino_cash_requests
                    SET status = 'rejected', reviewed_at = NOW()
                    WHERE id = $1
                    """,
                    request_id,
                )
                return True

    async def create_escrow(
        self,
        seller_id: int,
        buyer_id: int,
        amount_minor: int,
        curr: str,
        chat_id: int,
    ) -> asyncpg.Record:
        if seller_id == buyer_id:
            raise ValueError("SELF_ESCROW")
        fee = escrow_fee(amount_minor)
        required = amount_minor + fee
        pool = self.require_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                wallet = await self._wallet_conn(conn, seller_id, curr)
                seller = await conn.fetchrow(
                    """
                    UPDATE casino_wallets
                    SET balance_minor = balance_minor - $2, updated_at = NOW()
                    WHERE id = $1 AND balance_minor >= $2
                    RETURNING balance_minor
                    """,
                    wallet["id"],
                    required,
                )
                if not seller:
                    raise ValueError(
                        f"INSUFFICIENT_BALANCE:{curr}:{wallet['balance_minor']}:{amount_minor}:{fee}"
                    )
                txid = transaction_id()
                await conn.execute(
                    """
                    INSERT INTO casino_ledger_entries
                      (wallet_id, transaction_id, entry_type, amount_minor, description)
                    VALUES
                      ($1, $2, 'escrow_hold', $3, $4),
                      ($1, $2, 'escrow_fee', $5, $6)
                    """,
                    wallet["id"],
                    txid,
                    -amount_minor,
                    "Escrow amount held",
                    -fee,
                    "Escrow service fee (2%)",
                )
                await conn.execute(
                    """
                    INSERT INTO casino_house_ledger
                      (transaction_id, entry_type, currency, amount_minor, description)
                    VALUES ($1, 'escrow_fee', $2, $3, 'Escrow fee credited to house')
                    """,
                    txid,
                    curr,
                    fee,
                )
                return await conn.fetchrow(
                    """
                    INSERT INTO casino_escrows
                      (code, sender_player_id, recipient_player_id, currency,
                       amount_minor, fee_minor, chat_id, status)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
                    RETURNING *
                    """,
                    code(),
                    seller_id,
                    buyer_id,
                    curr,
                    amount_minor,
                    fee,
                    chat_id,
                )

    async def accept_escrow(self, escrow_code: str, buyer_id: int) -> Optional[asyncpg.Record]:
        async with self.require_pool().acquire() as conn:
            return await conn.fetchrow(
                """
                UPDATE casino_escrows
                SET status = 'accepted', accepted_at = NOW(),
                    sender_cancel_requested_at = NULL,
                    recipient_cancel_requested_at = NULL
                WHERE code = $1 AND recipient_player_id = $2 AND status = 'pending'
                RETURNING *
                """,
                escrow_code.upper(),
                buyer_id,
            )

    async def release_escrow(self, escrow_code: str, seller_id: int) -> asyncpg.Record:
        pool = self.require_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                escrow = await conn.fetchrow(
                    """
                    SELECT * FROM casino_escrows
                    WHERE code = $1 AND sender_player_id = $2
                    FOR UPDATE
                    """,
                    escrow_code.upper(),
                    seller_id,
                )
                if not escrow:
                    raise ValueError("ESCROW_NOT_SELLER")
                if escrow["status"] != "accepted":
                    raise ValueError("ESCROW_NOT_ACCEPTED")
                wallet = await self._wallet_conn(conn, seller_id, escrow["currency"])
                updated = await conn.fetchrow(
                    """
                    UPDATE casino_escrows
                    SET status = 'released', completed_at = NOW()
                    WHERE id = $1 AND status = 'accepted'
                    RETURNING *
                    """,
                    escrow["id"],
                )
                if not updated:
                    raise ValueError("ESCROW_ALREADY_COMPLETED")
                await conn.execute(
                    """
                    UPDATE casino_wallets
                    SET balance_minor = balance_minor + $2, updated_at = NOW()
                    WHERE id = $1
                    """,
                    wallet["id"],
                    escrow["amount_minor"],
                )
                await conn.execute(
                    """
                    INSERT INTO casino_ledger_entries
                      (wallet_id, transaction_id, entry_type, amount_minor, description)
                    VALUES ($1, $2, 'escrow_release', $3, $4)
                    """,
                    wallet["id"],
                    transaction_id(),
                    escrow["amount_minor"],
                    f"Escrow {escrow['code']} released by seller",
                )
                return updated

    async def escrow_cancel(self, escrow_code: str, actor_id: int) -> tuple[asyncpg.Record, bool]:
        pool = self.require_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                escrow = await conn.fetchrow(
                    "SELECT * FROM casino_escrows WHERE code = $1 FOR UPDATE",
                    escrow_code.upper(),
                )
                if not escrow:
                    raise ValueError("ESCROW_NOT_FOUND")
                if escrow["status"] not in ("pending", "accepted"):
                    raise ValueError("ESCROW_ALREADY_COMPLETED")
                is_seller = escrow["sender_player_id"] == actor_id
                is_buyer = escrow["recipient_player_id"] == actor_id
                if not is_seller and not is_buyer:
                    raise ValueError("ESCROW_NOT_PARTICIPANT")

                # Before acceptance, only the buyer can reject the deal.
                if escrow["status"] == "pending":
                    if not is_buyer:
                        raise ValueError("ESCROW_BUYER_ONLY")
                    cancelled = await self._cancel_and_refund(conn, escrow)
                    return cancelled, True

                seller_requested = escrow["sender_cancel_requested_at"]
                buyer_requested = escrow["recipient_cancel_requested_at"]
                if is_seller:
                    seller_requested = seller_requested or datetime.now(timezone.utc)
                else:
                    buyer_requested = buyer_requested or datetime.now(timezone.utc)

                if not seller_requested or not buyer_requested:
                    updated = await conn.fetchrow(
                        """
                        UPDATE casino_escrows
                        SET sender_cancel_requested_at = $2,
                            recipient_cancel_requested_at = $3
                        WHERE id = $1 AND status = 'accepted'
                        RETURNING *
                        """,
                        escrow["id"],
                        seller_requested,
                        buyer_requested,
                    )
                    return updated, False

                cancelled = await self._cancel_and_refund(conn, escrow)
                return cancelled, True

    async def _cancel_and_refund(self, conn, escrow: asyncpg.Record) -> asyncpg.Record:
        cancelled = await conn.fetchrow(
            """
            UPDATE casino_escrows
            SET status = 'cancelled', completed_at = NOW()
            WHERE id = $1 AND status IN ('pending', 'accepted')
            RETURNING *
            """,
            escrow["id"],
        )
        wallet = await self._wallet_conn(conn, escrow["sender_player_id"], escrow["currency"])
        await conn.execute(
            """
            UPDATE casino_wallets
            SET balance_minor = balance_minor + $2, updated_at = NOW()
            WHERE id = $1
            """,
            wallet["id"],
            escrow["amount_minor"],
        )
        await conn.execute(
            """
            INSERT INTO casino_ledger_entries
              (wallet_id, transaction_id, entry_type, amount_minor, description)
            VALUES ($1, $2, 'escrow_refund', $3, $4)
            """,
            wallet["id"],
            transaction_id(),
            escrow["amount_minor"],
            f"Escrow {escrow['code']} cancelled; 2% fee retained",
        )
        return cancelled

    async def _wallet_conn(self, conn, player_id: int, curr: str) -> asyncpg.Record:
        await conn.execute(
            """
            INSERT INTO casino_wallets (player_id, currency)
            VALUES ($1, $2)
            ON CONFLICT (player_id, currency) DO NOTHING
            """,
            player_id,
            curr,
        )
        return await conn.fetchrow(
            "SELECT * FROM casino_wallets WHERE player_id = $1 AND currency = $2",
            player_id,
            curr,
        )


def payout_mask(value: Optional[str]) -> str:
    if not value:
        return "not configured"
    return value[:3] + "…" + value[-3:] if len(value) > 8 else "***"


def build_escrow_svg(
    escrow: asyncpg.Record,
    buyer: asyncpg.Record,
    seller: asyncpg.Record,
    status: str,
) -> str:
    buyer_name = esc(buyer["display_name"])
    seller_name = esc(seller["display_name"])
    amount = esc(money(escrow["amount_minor"], escrow["currency"]))
    fee = esc(money(escrow["fee_minor"], escrow["currency"]))
    code_value = esc(escrow["code"])
    status_value = esc(status.upper())
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="720">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#071b16"/><stop offset="1" stop-color="#123b2f"/>
  </linearGradient>
</defs>
<rect width="1200" height="720" rx="44" fill="url(#bg)"/>
<rect x="40" y="40" width="1120" height="640" rx="32" fill="none" stroke="#8ef0b9" stroke-opacity=".35"/>
<text x="85" y="112" fill="#8ef0b9" font-size="26" font-family="DejaVu Sans" font-weight="bold" letter-spacing="5">ROLEXCASINO ESCROW</text>
<text x="85" y="175" fill="#ffffff" font-size="44" font-family="DejaVu Sans" font-weight="bold">Secure payment card</text>
<rect x="85" y="215" width="410" height="70" rx="35" fill="#8ef0b9" fill-opacity=".15" stroke="#8ef0b9"/>
<text x="290" y="260" text-anchor="middle" fill="#d6ffe8" font-size="30" font-family="DejaVu Sans" font-weight="bold">{code_value}</text>
<text x="85" y="350" fill="#a9c5ba" font-size="20" font-family="DejaVu Sans">BUYER</text>
<text x="85" y="390" fill="#ffffff" font-size="28" font-family="DejaVu Sans">{buyer_name}</text>
<text x="650" y="350" fill="#a9c5ba" font-size="20" font-family="DejaVu Sans">SELLER</text>
<text x="650" y="390" fill="#ffffff" font-size="28" font-family="DejaVu Sans">{seller_name}</text>
<line x1="85" y1="430" x2="1115" y2="430" stroke="#ffffff" stroke-opacity=".18"/>
<text x="85" y="490" fill="#a9c5ba" font-size="20" font-family="DejaVu Sans">AMOUNT HELD</text>
<text x="85" y="540" fill="#d6ffe8" font-size="42" font-family="DejaVu Sans" font-weight="bold">{amount}</text>
<text x="650" y="490" fill="#a9c5ba" font-size="20" font-family="DejaVu Sans">HOUSE FEE · 2%</text>
<text x="650" y="540" fill="#ffffff" font-size="32" font-family="DejaVu Sans" font-weight="bold">{fee}</text>
<text x="85" y="620" fill="#8ef0b9" font-size="26" font-family="DejaVu Sans" font-weight="bold">STATUS: {status_value}</text>
<text x="85" y="657" fill="#a9c5ba" font-size="18" font-family="DejaVu Sans">Sandbox ledger · fee credited to house balance</text>
</svg>"""


def render_escrow_png(escrow: asyncpg.Record, buyer: asyncpg.Record, seller: asyncpg.Record, status: str) -> BytesIO:
    svg = build_escrow_svg(escrow, buyer, seller, status).encode()
    process = subprocess.run(
        ["convert", "svg:-", "png:-"],
        input=svg,
        capture_output=True,
        check=True,
    )
    stream = BytesIO(process.stdout)
    stream.name = "rolex-escrow.png"
    return stream


class RolexBot:
    def __init__(self, application: Application):
        self.application = application
        self.db = Database(DATABASE_URL or "")
        self.awaiting_utr: dict[int, int] = {}
        self.pending_tips: dict[str, dict[str, Any]] = {}

    async def startup(self, _: Application) -> None:
        if not TOKEN:
            raise RuntimeError("TELEGRAM_BOT_TOKEN is required")
        if not DATABASE_URL:
            raise RuntimeError("DATABASE_URL is required")
        await self.db.connect()
        LOGGER.info("Python RolexCasino bot database connected")

    async def shutdown(self, _: Application) -> None:
        await self.db.close()

    async def reply(self, update: Update, text: str, **kwargs) -> None:
        message = update.effective_message
        if message:
            await message.reply_text(
                text,
                parse_mode=ParseMode.HTML,
                disable_web_page_preview=True,
                **kwargs,
            )

    async def send(self, bot, chat_id: int, text: str, **kwargs) -> Any:
        return await bot.send_message(
            chat_id=chat_id,
            text=text,
            parse_mode=ParseMode.HTML,
            disable_web_page_preview=True,
            **kwargs,
        )

    async def notify_admins(self, text: str) -> None:
        for admin_id in ADMIN_USER_IDS:
            try:
                await self.send(self.application.bot, admin_id, text)
            except Exception as exc:
                LOGGER.warning("Could not notify admin %s: %s", admin_id, exc)

    @staticmethod
    def user_name(user) -> str:
        return " ".join(part for part in [user.first_name, user.last_name] if part) or "Player"

    @staticmethod
    def admin(user_id: int) -> bool:
        return user_id in ADMIN_USER_IDS

    async def start(self, update: Update, _: ContextTypes.DEFAULT_TYPE) -> None:
        player = await self.db.player(update.effective_user)
        balance = await self.db.balance_text(player["id"], player["preferred_currency"])
        await self.reply(
            update,
            professional(
                f"Welcome, {esc(player['display_name'])}.",
                "",
                f"{pe('check')} Your RolexCasino account is ready.",
                "",
                balance,
                "",
                f"{pe('info')} Use /help to see the secure wallet and escrow commands.",
                icon="trophy",
            ),
        )

    async def help(self, update: Update, _: ContextTypes.DEFAULT_TYPE) -> None:
        await self.reply(
            update,
            professional(
                "RolexCasino professional commands",
                "",
                "/wallet — view INR and USD wallet balances",
                "/currency — switch the live display currency",
                "/setwallet TYPE VALUE — save a payout destination",
                "/deposit AMOUNT INR|USD — choose a payment network and submit UTR",
                "/withdraw AMOUNT INR|USD — create a verified withdrawal request",
                "/game pvb AMOUNT INR — confirm a game against the bot",
                "/game pvp AMOUNT INR @opponent — send a 120-second PvP challenge",
                "/escrow @buyer AMOUNT INR|USD — create seller-funded escrow",
                "/escrow release CODE — seller releases held funds",
                "/escrow cancel CODE — request cancellation",
                "/tip @user AMOUNT INR|USD — confirm a secure tip",
                "",
                f"{pe('lock')} Deposits and withdrawals require admin verification.",
                f"{pe('info')} Escrow charges a 2% house fee at creation.",
                icon="book",
            ),
        )

    async def wallet(self, update: Update, _: ContextTypes.DEFAULT_TYPE) -> None:
        player = await self.db.player(update.effective_user)
        await self.reply(
            update,
            professional(
                "RolexCasino wallet",
                "",
                await self.db.balance_text(player["id"], player["preferred_currency"]),
                "",
                f"{pe('briefcase')} Payout destination: {esc(payout_mask(player['payout_wallet']))}",
                icon="money",
            ),
        )
        await self.notify_admins(
            professional(
                f"{pe('bell')} New withdrawal request #{request_id}",
                f"Player: {esc(player['display_name'])} ({player['telegram_user_id']})",
                f"Amount: {esc(money(amount, curr))}",
                f"Method: {esc(player['payout_wallet_type'])}",
                f"Destination: <code>{esc(player['payout_wallet'])}</code>",
                f"Approve: /approve_withdraw {request_id}",
                f"Reject: /reject_withdraw {request_id}",
                icon="money",
            )
        )

    @staticmethod
    def currency_markup(selected: str) -> InlineKeyboardMarkup:
        def label(value: str) -> str:
            return f"🟢 {value} ✓" if value == selected else f"⚪ {value}"

        return InlineKeyboardMarkup(
            [[
                InlineKeyboardButton(label("INR"), callback_data="currency:set:INR"),
                InlineKeyboardButton(label("USD"), callback_data="currency:set:USD"),
            ]]
        )

    async def currency_command(self, update: Update, _: ContextTypes.DEFAULT_TYPE) -> None:
        player = await self.db.player(update.effective_user)
        await self.reply(
            update,
            professional(
                f"{pe('globe')} Display Currency — {esc(player['preferred_currency'])}",
                "",
                "Choose the live display currency below.",
                "The selected button is marked green. Tap either button any time to switch.",
                icon="trend",
            ),
            reply_markup=self.currency_markup(player["preferred_currency"]),
        )

    async def currency_callback(self, query, selected: str) -> None:
        if selected not in SUPPORTED_CURRENCIES:
            return
        player = await self.db.player(query.from_user)
        await self.db.set_preferred_currency(player["id"], selected)
        await query.edit_message_text(
            professional(
                f"{pe('globe')} Display Currency — {esc(selected)}",
                "",
                f"{pe('check')} Live currency updated to {esc(selected)}.",
                "Choose again below whenever you want to switch.",
                icon="trend",
            ),
            parse_mode=ParseMode.HTML,
            reply_markup=self.currency_markup(selected),
        )

    async def setwallet(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if len(context.args) < 2:
            await self.reply(update, professional("Usage: /setwallet UPI VALUE", icon="info"))
            return
        payout_type = context.args[0].upper()
        value = " ".join(context.args[1:]).strip()
        if payout_type not in {"UPI", "BTC", "BSC", "SOLANA", "ETHEREUM"} or not value or " " in value:
            await self.reply(update, professional("Use a valid payout type and one wallet value.", icon="question"))
            return
        player = await self.db.player(update.effective_user)
        async with self.db.require_pool().acquire() as conn:
            await conn.execute(
                """
                UPDATE casino_players
                SET payout_wallet = $2, payout_wallet_type = $3, updated_at = NOW()
                WHERE id = $1
                """,
                player["id"],
                value,
                payout_type,
            )
        await self.reply(
            update,
            professional(
                f"{pe('check')} Payout destination saved.",
                f"Method: {esc(payout_type)}",
                f"Masked value: {esc(payout_mask(value))}",
                icon="briefcase",
            ),
        )

    async def deposit(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        amount = parse_money(context.args[0] if context.args else None)
        player = await self.db.player(update.effective_user)
        curr = currency(context.args[1] if len(context.args) > 1 else player["preferred_currency"], "USD")
        if not amount:
            await self.reply(update, professional("Usage: /deposit AMOUNT INR|USD", icon="info"))
            return
        intent_id = await self.db.create_payment_intent(player["id"], amount, curr)
        keyboard = [
            [
                InlineKeyboardButton("🟢 UPI", callback_data=f"deposit:network:{intent_id}:upi"),
                InlineKeyboardButton("🟢 BTC", callback_data=f"deposit:network:{intent_id}:btc"),
            ],
            [
                InlineKeyboardButton("🟢 BSC (BEP20)", callback_data=f"deposit:network:{intent_id}:bsc"),
                InlineKeyboardButton("🟢 Solana", callback_data=f"deposit:network:{intent_id}:solana"),
            ],
            [
                InlineKeyboardButton("🟢 Ethereum", callback_data=f"deposit:network:{intent_id}:ethereum"),
                InlineKeyboardButton("🟢 Help", callback_data=f"deposit:help:{intent_id}"),
            ],
            [
                InlineKeyboardButton("🟢 Cancel", callback_data=f"deposit:cancel:{intent_id}"),
            ],
        ]
        await self.reply(
            update,
            professional(
                "Deposit verification started",
                "",
                f"Amount: {esc(money(amount, curr))}",
                f"Request: #{intent_id}",
                "",
                f"{pe('globe')} Choose one payment network below.",
                f"{pe('info')} After payment, press I have paid and submit the required UTR or transaction ID.",
                icon="upload",
            ),
            reply_markup=InlineKeyboardMarkup(keyboard),
        )

    async def withdraw(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        amount = parse_money(context.args[0] if context.args else None)
        player = await self.db.player(update.effective_user)
        curr = currency(context.args[1] if len(context.args) > 1 else player["preferred_currency"], "USD")
        if not amount:
            await self.reply(update, professional("Usage: /withdraw AMOUNT INR|USD", icon="info"))
            return
        if not player["payout_wallet"] or not player["payout_wallet_type"]:
            await self.reply(
                update,
                professional(
                    "Save a payout destination first.",
                    "Example: /setwallet UPI your_id@bank",
                    icon="briefcase",
                ),
            )
            return
        request_id = await self.db.create_withdrawal(
            player["id"],
            amount,
            curr,
            player["payout_wallet_type"],
            player["payout_wallet"],
        )
        if not request_id:
            wallet = await self.db.wallet(player["id"], curr)
            await self.reply(
                update,
                professional(
                    "Withdrawal rejected.",
                    f"Available {esc(curr)} balance: {esc(money(wallet['balance_minor'], curr))}",
                    f"Requested: {esc(money(amount, curr))}",
                    icon="cross",
                ),
            )
            return
        await self.reply(
            update,
            professional(
                f"{pe('check')} Withdrawal request created.",
                f"Request: #{request_id}",
                f"Amount: {esc(money(amount, curr))}",
                f"Method: {esc(player['payout_wallet_type'])}",
                f"{pe('lock')} Funds are held until an administrator verifies the request.",
                icon="money",
            ),
        )

    async def handle_utr(self, update: Update, _: ContextTypes.DEFAULT_TYPE) -> None:
        user_id = update.effective_user.id
        intent_id = self.awaiting_utr.get(user_id)
        if not intent_id:
            return
        value = (update.effective_message.text or "").strip()
        async with self.db.require_pool().acquire() as conn:
            intent = await conn.fetchrow(
                "SELECT * FROM casino_payment_intents WHERE id = $1 AND player_id = $2",
                intent_id,
                (await self.db.player(update.effective_user))["id"],
            )
        if not intent:
            self.awaiting_utr.pop(user_id, None)
            await self.reply(update, professional("That payment request is no longer available.", icon="cross"))
            return
        network = intent["network"]
        if network == "upi":
            valid = bool(re.fullmatch(r"\d{12}", value))
            requirement = "UPI UTR must contain exactly 12 digits."
        else:
            valid = bool(re.fullmatch(r"[A-Za-z0-9._:-]{60,}", value))
            requirement = "A crypto transaction ID must contain at least 60 letters, digits, or common symbols (., _, :, -)."
        if not valid:
            await self.reply(update, professional(requirement, icon="question"))
            return
        submitted = await self.db.submit_utr(intent_id, intent["player_id"], value)
        self.awaiting_utr.pop(user_id, None)
        if not submitted:
            await self.reply(update, professional("This payment request is expired or already submitted.", icon="cross"))
            return
        await self.reply(
            update,
            professional(
                f"{pe('check')} Payment proof submitted for admin review.",
                f"Request: #{intent_id}",
                f"Network: {esc(NETWORK_LABELS[network])}",
                f"Reference: <code>{esc(value)}</code>",
                "Your wallet will be credited only after verification.",
                icon="upload",
            ),
        )
        await self.notify_admins(
            professional(
                f"{pe('bell')} New deposit proof #{intent_id}",
                f"Player: {esc((await self.db.player(update.effective_user))['display_name'])} ({update.effective_user.id})",
                f"Amount: {esc(money(intent['amount_minor'], intent['currency']))}",
                f"Network: {esc(NETWORK_LABELS[network])}",
                f"UTR / transaction ID: <code>{esc(value)}</code>",
                f"Approve: /approve_deposit {intent_id}",
                f"Reject: /reject_deposit {intent_id}",
                icon="upload",
            )
        )

    async def escrow(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        player = await self.db.player(update.effective_user)
        reply_user = update.effective_message.reply_to_message.from_user if update.effective_message.reply_to_message else None
        mention = context.args[0] if context.args and context.args[0].startswith("@") else None
        amount_arg = context.args[0] if reply_user and context.args else (context.args[1] if len(context.args) > 1 else None)
        curr_arg = context.args[1] if reply_user and len(context.args) > 1 else (context.args[2] if len(context.args) > 2 else None)
        amount = parse_money(amount_arg)
        if not amount or (not reply_user and not mention):
            await self.reply(
                update,
                professional(
                    "Usage: /escrow @buyer AMOUNT INR|USD",
                    "Or reply to a buyer with: /escrow AMOUNT INR|USD",
                    icon="info",
                ),
            )
            return
        buyer = (
            await self.db.player(reply_user)
            if reply_user
            else await self.db.player_by_username(mention or "")
        )
        if not buyer:
            await self.reply(update, professional("The buyer must open the bot with /start first.", icon="user"))
            return
        curr = currency(curr_arg, player["preferred_currency"])
        try:
            escrow = await self.db.create_escrow(player["id"], buyer["id"], amount, curr, update.effective_chat.id)
        except ValueError as exc:
            reason = str(exc).split(":")
            if reason[0] == "INSUFFICIENT_BALANCE" and len(reason) == 5:
                _, cur, available, requested, fee = reason
                await self.reply(
                    update,
                    professional(
                        "Escrow rejected because the seller balance is too low.",
                        f"Currency: {esc(cur)}",
                        f"Current balance: {esc(money(int(available), cur))}",
                        f"Escrow amount: {esc(money(int(requested), cur))}",
                        f"House fee (2%): {esc(money(int(fee), cur))}",
                        f"Total required: {esc(money(int(requested) + int(fee), cur))}",
                        icon="cross",
                    ),
                )
            else:
                await self.reply(update, professional("This escrow could not be created.", icon="cross"))
            return

        await self.send_escrow_card(update, escrow, buyer, player)

    async def send_escrow_card(
        self, update: Update, escrow: asyncpg.Record, buyer: asyncpg.Record, seller: asyncpg.Record
    ) -> None:
        image = render_escrow_png(escrow, buyer, seller, "PENDING BUYER ACCEPTANCE")
        caption = professional(
            f"{pe('lock')} ESCROW {esc(escrow['code'])}",
            f"Buyer: {esc(buyer['display_name'])} @{esc(buyer['username'] or 'not-set')}",
            f"Seller: {esc(seller['display_name'])} @{esc(seller['username'] or 'not-set')}",
            f"Amount held: {esc(money(escrow['amount_minor'], escrow['currency']))}",
            f"House fee: {esc(money(escrow['fee_minor'], escrow['currency']))} · 2%",
            "The seller funds the deal. The buyer accepts. The seller releases after acceptance.",
            icon="lock",
        )
        markup = self.escrow_markup(escrow)
        sent = await update.effective_message.reply_photo(
            photo=InputFile(image, filename="rolex-escrow.png"),
            caption=caption,
            parse_mode=ParseMode.HTML,
            reply_markup=markup,
        )
        async with self.db.require_pool().acquire() as conn:
            await conn.execute(
                "UPDATE casino_escrows SET message_id = $2 WHERE id = $1",
                escrow["id"],
                sent.message_id,
            )
        try:
            await update.effective_chat.pin_message(sent.message_id)
        except Exception:
            LOGGER.info("Escrow pin was not available in chat %s", update.effective_chat.id)

    @staticmethod
    def escrow_markup(escrow: asyncpg.Record) -> InlineKeyboardMarkup:
        if escrow["status"] == "pending":
            rows = [
                [
                    InlineKeyboardButton("🟢 Accept deal", callback_data=f"escrow:accept:{escrow['code']}"),
                    InlineKeyboardButton("🟢 Reject deal", callback_data=f"escrow:reject:{escrow['code']}"),
                ],
                [InlineKeyboardButton("🟢 Help", callback_data=f"escrow:help:{escrow['code']}")],
            ]
        elif escrow["status"] == "accepted":
            rows = [
                [
                    InlineKeyboardButton("🟢 Release funds (seller)", callback_data=f"escrow:release:{escrow['code']}"),
                    InlineKeyboardButton("🟢 Cancel escrow", callback_data=f"escrow:cancel:{escrow['code']}"),
                ],
                [InlineKeyboardButton("🟢 Help", callback_data=f"escrow:help:{escrow['code']}")],
            ]
        else:
            rows = []
        return InlineKeyboardMarkup(rows)

    async def refresh_escrow(self, query, escrow: asyncpg.Record) -> None:
        async with self.db.require_pool().acquire() as conn:
            buyer = await conn.fetchrow("SELECT * FROM casino_players WHERE id = $1", escrow["recipient_player_id"])
            seller = await conn.fetchrow("SELECT * FROM casino_players WHERE id = $1", escrow["sender_player_id"])
        status = {
            "pending": "PENDING BUYER ACCEPTANCE",
            "accepted": "ACCEPTED · WAITING FOR SELLER",
            "cancelled": "ESCROW CANCELLED · FUNDS REFUNDED",
            "released": "ESCROW COMPLETED · FUNDS RELEASED",
        }.get(escrow["status"], escrow["status"])
        caption = professional(
            f"{pe('lock')} ESCROW {esc(escrow['code'])}",
            f"Buyer: {esc(buyer['display_name'])} @{esc(buyer['username'] or 'not-set')}",
            f"Seller: {esc(seller['display_name'])} @{esc(seller['username'] or 'not-set')}",
            f"Amount: {esc(money(escrow['amount_minor'], escrow['currency']))}",
            f"House fee: {esc(money(escrow['fee_minor'], escrow['currency']))} · 2%",
            f"{pe('check')} {esc(status)}",
            icon="check" if escrow["status"] == "released" else "lock",
        )
        try:
            image = render_escrow_png(escrow, buyer, seller, status)
            await query.edit_message_media(
                media=InputMediaPhoto(media=InputFile(image, filename="rolex-escrow.png"), caption=caption, parse_mode=ParseMode.HTML),
                reply_markup=self.escrow_markup(escrow),
            )
        except Exception:
            await query.edit_message_caption(
                caption=caption,
                parse_mode=ParseMode.HTML,
                reply_markup=self.escrow_markup(escrow),
            )
        if escrow["status"] in {"released", "cancelled"}:
            try:
                await query.message.chat.pin_message(query.message.message_id)
            except Exception:
                pass

    async def tip(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        player = await self.db.player(update.effective_user)
        if len(context.args) < 2 or not context.args[0].startswith("@"):
            await self.reply(update, professional("Usage: /tip @username AMOUNT INR|USD", icon="info"))
            return
        target = await self.db.player_by_username(context.args[0])
        amount = parse_money(context.args[1])
        curr = currency(context.args[2] if len(context.args) > 2 else player["preferred_currency"], player["preferred_currency"])
        if not target or not amount or target["id"] == player["id"]:
            await self.reply(update, professional("The tip details are invalid.", icon="cross"))
            return
        token = secrets.token_urlsafe(12)
        self.pending_tips[token] = {
            "tipper_id": player["id"],
            "tipper_telegram_id": update.effective_user.id,
            "target_id": target["id"],
            "target_name": target["display_name"],
            "amount": amount,
            "currency": curr,
        }
        await self.reply(
            update,
            professional(
                "Confirm secure tip",
                f"Recipient: {esc(target['display_name'])}",
                f"Amount: {esc(money(amount, curr))}",
                "",
                "Only the tipper can confirm or cancel this request.",
                icon="heart",
            ),
            reply_markup=InlineKeyboardMarkup(
                [[
                    InlineKeyboardButton("🟢 Confirm tip", callback_data=f"tip:confirm:{token}"),
                    InlineKeyboardButton("🟢 Cancel tip", callback_data=f"tip:cancel:{token}"),
                ]]
            ),
        )

    async def callback(self, update: Update, _: ContextTypes.DEFAULT_TYPE) -> None:
        query = update.callback_query
        if not query or not query.data:
            return
        await query.answer()
        parts = query.data.split(":")
        if parts[0] == "currency" and len(parts) == 3 and parts[1] == "set":
            await self.currency_callback(query, parts[2])
        elif parts[0] == "deposit":
            await self.deposit_callback(query, parts)
        elif parts[0] == "escrow":
            await self.escrow_callback(query, parts)
        elif parts[0] == "tip":
            await self.tip_callback(query, parts)
        elif parts[0] == "game" and len(parts) == 3:
            try:
                await self.game_callback(query, parts[1], int(parts[2]))
            except ValueError:
                await query.answer("This game button is invalid.", show_alert=True)

    async def deposit_callback(self, query, parts: list[str]) -> None:
        if len(parts) < 3:
            return
        user = query.from_user
        player = await self.db.player(user)
        action = parts[1]
        intent_id = int(parts[2])
        if action == "help":
            await query.answer("Choose a network, pay the shown address, press I have paid, then submit your proof.", show_alert=True)
            return
        if action == "cancel":
            cancelled = await self.db.cancel_payment_intent(intent_id, player["id"])
            if not cancelled:
                await query.answer("This deposit request is already submitted, completed, or cancelled.", show_alert=True)
                return
            await query.edit_message_text(
                professional(
                    "Deposit request cancelled",
                    f"Order ID: #{intent_id}",
                    "No wallet balance was changed.",
                    icon="cross",
                ),
                parse_mode=ParseMode.HTML,
            )
            return
        if action == "network" and len(parts) == 4:
            network = parts[3]
            if network not in NETWORK_LABELS:
                return
            address = os.environ.get(NETWORK_ENV_KEYS[network], "").strip()
            if not address:
                await query.answer(
                    f"{NETWORK_LABELS[network]} deposits are not configured yet. Please choose another network.",
                    show_alert=True,
                )
                return
            intent = await self.db.choose_network(intent_id, player["id"], network)
            if not intent:
                await query.answer("This deposit request is expired or not yours.", show_alert=True)
                return
            keyboard = InlineKeyboardMarkup(
                [
                    [InlineKeyboardButton("🟢 I have paid", callback_data=f"deposit:paid:{intent_id}")],
                    [
                        InlineKeyboardButton("🟢 Help", callback_data=f"deposit:help:{intent_id}"),
                        InlineKeyboardButton("🟢 Cancel", callback_data=f"deposit:cancel:{intent_id}"),
                    ],
                ]
            )
            await query.edit_message_text(
                text=professional(
                    "Payment instructions",
                    f"Order ID: #{intent_id}",
                    f"Network: {esc(NETWORK_LABELS[network])}",
                    f"Amount: {esc(money(intent.amount_minor, intent.currency))}",
                    f"Payment address: <code>{esc(address)}</code>",
                    "",
                    f"{pe('info')} Send the exact amount, then press I have paid.",
                    icon="upload",
                ),
                parse_mode=ParseMode.HTML,
                reply_markup=keyboard,
            )
        elif action == "paid":
            async with self.db.require_pool().acquire() as conn:
                intent = await conn.fetchrow(
                    "SELECT * FROM casino_payment_intents WHERE id = $1 AND player_id = $2 AND status = 'awaiting-payment'",
                    intent_id,
                    player["id"],
                )
            if not intent:
                await query.answer("This request is expired or already submitted.", show_alert=True)
                return
            self.awaiting_utr[user.id] = intent_id
            await query.message.reply_text(
                professional(
                    "Payment proof required",
                    f"Order ID: #{intent_id}",
                    f"Network: {esc(NETWORK_LABELS[intent['network']])}",
                    "Send the UTR or transaction ID as your next message.",
                    "UPI: exactly 12 digits. Crypto: at least 60 letters, digits, or common symbols.",
                    icon="pen",
                ),
                parse_mode=ParseMode.HTML,
            )

    async def escrow_callback(self, query, parts: list[str]) -> None:
        if len(parts) != 3:
            return
        action, escrow_code = parts[1], parts[2].upper()
        player = await self.db.player(query.from_user)
        if action == "help":
            await query.answer(
                "Buyer accepts or rejects. After acceptance, only the seller releases. Cancellation requires both users.",
                show_alert=True,
            )
            return
        try:
            if action == "accept":
                escrow = await self.db.accept_escrow(escrow_code, player["id"])
                if not escrow:
                    return
                await self.refresh_escrow(query, escrow)
            elif action == "release":
                escrow = await self.db.release_escrow(escrow_code, player["id"])
                await self.refresh_escrow(query, escrow)
            elif action in {"reject", "cancel"}:
                escrow, completed = await self.db.escrow_cancel(escrow_code, player["id"])
                await self.refresh_escrow(query, escrow)
                if not completed:
                    await query.answer("Your cancellation request is recorded. The other participant must also cancel.", show_alert=True)
        except ValueError as exc:
            reason = str(exc)
            if reason in {"ESCROW_NOT_SELLER", "ESCROW_BUYER_ONLY", "ESCROW_NOT_PARTICIPANT"}:
                return
            await query.answer("This escrow action is no longer available.", show_alert=True)

    async def tip_callback(self, query, parts: list[str]) -> None:
        if len(parts) != 3:
            return
        token = parts[2]
        pending = self.pending_tips.get(token)
        if not pending or pending["tipper_telegram_id"] != query.from_user.id:
            return
        if parts[1] == "cancel":
            self.pending_tips.pop(token, None)
            await query.edit_message_text(professional("Tip cancelled. No balance was changed.", icon="cross"), parse_mode=ParseMode.HTML)
            return
        if parts[1] != "confirm":
            return
        pool = self.db.require_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                source = await self.db._wallet_conn(conn, pending["tipper_id"], pending["currency"])
                target = await self.db._wallet_conn(conn, pending["target_id"], pending["currency"])
                updated = await conn.fetchrow(
                    """
                    UPDATE casino_wallets SET balance_minor = balance_minor - $2, updated_at = NOW()
                    WHERE id = $1 AND balance_minor >= $2 RETURNING balance_minor
                    """,
                    source["id"],
                    pending["amount"],
                )
                if not updated:
                    self.pending_tips.pop(token, None)
                    await query.edit_message_text(professional("Tip rejected because your balance is too low.", icon="cross"), parse_mode=ParseMode.HTML)
                    return
                await conn.execute(
                    "UPDATE casino_wallets SET balance_minor = balance_minor + $2, updated_at = NOW() WHERE id = $1",
                    target["id"],
                    pending["amount"],
                )
                txid = transaction_id()
                await conn.execute(
                    """
                    INSERT INTO casino_ledger_entries
                      (wallet_id, transaction_id, entry_type, amount_minor, description)
                    VALUES ($1, $2, 'tip_sent', $3, 'Tip sent'),
                         ($4, $2, 'tip_received', $5, 'Tip received')
                    """,
                    source["id"],
                    txid,
                    -pending["amount"],
                    target["id"],
                    pending["amount"],
                )
        self.pending_tips.pop(token, None)
        await query.edit_message_text(
            professional(
                f"{pe('check')} Tip completed.",
                f"Recipient: {esc(pending['target_name'])}",
                f"Amount: {esc(money(pending['amount'], pending['currency']))}",
                icon="heart",
            ),
            parse_mode=ParseMode.HTML,
        )

    async def game(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        """Create a confirmed PvB/PvP dice proposal."""
        player = await self.db.player(update.effective_user)
        args = list(context.args)
        mode = "pvb"
        if args and args[0].lower() in {"pvb", "pvp"}:
            mode = args.pop(0).lower()
        amount_arg = next((value for value in args if parse_money(value)), None)
        amount = parse_money(amount_arg)
        if not amount:
            await self.reply(
                update,
                professional(
                    "Usage: /game pvb AMOUNT INR",
                    "For PvP: /game pvp AMOUNT INR @opponent",
                    icon="info",
                ),
            )
            return
        curr_arg = next((value for value in args if value.upper() in SUPPORTED_CURRENCIES), None)
        curr = currency(curr_arg, player["preferred_currency"])
        opponent_username = next((value for value in args if value.startswith("@")), None)
        opponent = await self.db.player_by_username(opponent_username) if opponent_username else None
        if mode == "pvp":
            if not opponent:
                await self.reply(update, professional("PvP requires an opponent who has opened the bot with /start.", icon="user"))
                return
            if opponent["id"] == player["id"]:
                await self.reply(update, professional("You cannot challenge yourself.", icon="cross"))
                return
        challenge = await self.db.create_challenge(
            player["id"],
            opponent["id"] if opponent else None,
            mode,
            "dice",
            amount,
            curr,
            update.effective_chat.id,
        )
        potential = int(
            (Decimal(amount) * (Decimal("1.92") if mode == "pvb" else Decimal("2")))
            .quantize(Decimal("1"), rounding=ROUND_HALF_UP)
        )
        if mode == "pvp":
            text = professional(
                f"{pe('clock')} PvP challenge #{challenge['id']}",
                f"Stake: {esc(money(amount, curr))}",
                f"Winner payout: {esc(money(potential, curr))}",
                f"Opponent: {esc(opponent['display_name'])} @{esc(opponent['username'] or 'not-set')}",
                "The opponent must accept or decline within 120 seconds.",
                icon="trophy",
            )
            markup = InlineKeyboardMarkup(
                [[
                    InlineKeyboardButton("🟢 Accept challenge", callback_data=f"game:accept:{challenge['id']}"),
                    InlineKeyboardButton("🟢 Decline", callback_data=f"game:decline:{challenge['id']}"),
                ]]
            )
        else:
            text = professional(
                f"{pe('clock')} PvB challenge #{challenge['id']}",
                f"Stake: {esc(money(amount, curr))}",
                f"Potential win: {esc(money(potential, curr))}",
                "Versus: RolexCasino bot",
                "Confirm or cancel this game before it starts.",
                icon="trophy",
            )
            markup = InlineKeyboardMarkup(
                [[
                    InlineKeyboardButton("🟢 Confirm game", callback_data=f"game:confirm:{challenge['id']}"),
                    InlineKeyboardButton("🟢 Cancel", callback_data=f"game:cancel:{challenge['id']}"),
                ]]
            )
        await self.reply(update, text, reply_markup=markup)

    async def game_callback(self, query, action: str, challenge_id: int) -> None:
        player = await self.db.player(query.from_user)
        challenge = await self.db.get_challenge(challenge_id)
        if not challenge:
            await query.answer("This game was not found.", show_alert=True)
            return
        deadline = challenge["turn_deadline_at"]
        if deadline and deadline < datetime.now(timezone.utc):
            await self.db.expire_challenge(challenge_id)
            await query.answer("This game expired after 120 seconds.", show_alert=True)
            return

        if action == "cancel":
            if challenge["mode"] != "pvb" or challenge["creator_player_id"] != player["id"]:
                return
            if not await self.db.cancel_challenge(challenge_id, player["id"]):
                await query.answer("This game is no longer open.", show_alert=True)
                return
            await query.edit_message_text(
                professional(f"Game #{challenge_id} cancelled. No balance was changed.", icon="cross"),
                parse_mode=ParseMode.HTML,
            )
            return

        if action == "decline":
            if challenge["mode"] != "pvp" or challenge["player_two_id"] != player["id"]:
                return
            if not await self.db.decline_challenge(challenge_id, player["id"]):
                await query.answer("This challenge is no longer open.", show_alert=True)
                return
            await query.edit_message_text(
                professional(f"PvP challenge #{challenge_id} declined. No balance was changed.", icon="cross"),
                parse_mode=ParseMode.HTML,
            )
            return

        if action == "accept":
            if challenge["mode"] != "pvp" or challenge["player_two_id"] != player["id"]:
                return
            challenge = await self.db.accept_challenge(challenge_id, player["id"])
            if not challenge:
                await query.answer("This challenge expired or is not assigned to you.", show_alert=True)
                return
        elif action == "confirm":
            if challenge["mode"] != "pvb" or challenge["creator_player_id"] != player["id"]:
                return
            if challenge["status"] != "open":
                await query.answer("This game is no longer open.", show_alert=True)
                return
        else:
            return

        try:
            result = await self.db.settle_challenge(
                challenge_id,
                secrets.randbelow(6) + 1,
                secrets.randbelow(6) + 1,
            )
        except ValueError as exc:
            messages = {
                "GAME_EXPIRED": "This game expired before it started.",
                "GAME_INSUFFICIENT_BALANCE": "The challenger does not have enough balance for this stake.",
                "GAME_OPPONENT_INSUFFICIENT_BALANCE": "The opponent does not have enough balance for this stake.",
                "GAME_NOT_OPEN": "This game has already been completed.",
            }
            await query.edit_message_text(
                professional(messages.get(str(exc), "The game could not be started.",), icon="cross"),
                parse_mode=ParseMode.HTML,
            )
            return

        completed = result["challenge"]
        winner_id = result["winner_id"]
        creator = await self.db.player_by_id(completed["creator_player_id"])
        opponent = (
            await self.db.player_by_id(completed["player_two_id"])
            if completed["player_two_id"]
            else None
        )
        creator_name = creator["display_name"] if creator else "Challenger"
        opponent_name = opponent["display_name"] if opponent else "RolexCasino bot"
        score = (
            "1-0"
            if result["creator_roll"] > result["opponent_roll"]
            else "0-1"
            if result["opponent_roll"] > result["creator_roll"]
            else "1-1"
        )
        if winner_id is None:
            winner_name = "Draw"
            round_result = "Draw · stakes refunded"
            credited_minor = result["creator_payout"]
        elif winner_id == completed["creator_player_id"]:
            winner_name = creator_name
            round_result = "Challenger wins"
            credited_minor = result["creator_payout"]
        else:
            winner_name = opponent_name
            round_result = "Opponent wins"
            credited_minor = result["opponent_payout"]
        credited_label = (
            f"{money(credited_minor, completed['currency'])} credited."
            if winner_id is not None
            else f"{money(credited_minor, completed['currency'])} refunded."
        )
        await query.edit_message_text(
            professional(
                f"{pe('trophy')} GAME #{challenge_id} COMPLETED",
                f"{pe('trophy')} Round 1: {esc(winner_name)} ({score})",
                "",
                f"{pe('trophy')} {esc(winner_name)} wins ({esc(round_result)})!"
                if winner_id is not None
                else f"{pe('trophy')} Round result: {esc(round_result)}.",
                esc(credited_label),
                icon="trophy",
            ),
            parse_mode=ParseMode.HTML,
        )

    async def admin_action(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not self.admin(update.effective_user.id):
            return
        if len(context.args) != 1 or not context.args[0].isdigit():
            await self.reply(update, professional("Usage: /approve_deposit ID", icon="info"))
            return
        action = update.effective_message.text.split()[0].split("@")[0].lower()
        request_id = int(context.args[0])
        if action == "/approve_deposit":
            result = await self.db.approve_deposit(request_id)
        elif action == "/reject_deposit":
            result = await self.db.reject_deposit(request_id)
        elif action == "/approve_withdraw":
            result = await self.db.approve_withdrawal(request_id)
        else:
            result = await self.db.reject_withdrawal(request_id)
        target_id = None
        amount_text = ""
        if action in {"/approve_deposit", "/reject_deposit"}:
            intent = await self.db.payment_intent(request_id)
            if intent:
                target_id = intent["player_id"]
                amount_text = money(intent["amount_minor"], intent["currency"])
        else:
            request = await self.db.cash_request(request_id)
            if request:
                target_id = request["player_id"]
                amount_text = money(request["amount_minor"], request["currency"])
        await self.reply(
            update,
            professional(
                f"{pe('check') if result else pe('cross')} Admin action {'completed' if result else 'could not be completed'}.",
                f"Request: #{request_id}",
                icon="settings",
            ),
        )
        if result and target_id:
            if action == "/approve_deposit":
                player_message = professional(
                    f"{pe('check')} Deposit approved.",
                    f"Request: #{request_id}",
                    f"Amount credited: {esc(amount_text)}",
                    "Your wallet balance has been updated.",
                    icon="upload",
                )
            elif action == "/reject_deposit":
                player_message = professional(
                    f"{pe('cross')} Deposit rejected.",
                    f"Request: #{request_id}",
                    f"Amount: {esc(amount_text)}",
                    "No wallet credit was added. Contact support if you believe this is incorrect.",
                    icon="upload",
                )
            elif action == "/approve_withdraw":
                player_message = professional(
                    f"{pe('check')} Withdrawal approved for payout.",
                    f"Request: #{request_id}",
                    f"Amount: {esc(amount_text)}",
                    "The administrator has approved the request for payout processing.",
                    icon="money",
                )
            else:
                player_message = professional(
                    f"{pe('cross')} Withdrawal rejected.",
                    f"Request: #{request_id}",
                    f"Refunded: {esc(amount_text)}",
                    "The held amount has been returned to your wallet.",
                    icon="money",
                )
            try:
                await self.send(self.application.bot, target_id, player_message)
            except Exception as exc:
                LOGGER.warning("Could not notify player %s about request %s: %s", target_id, request_id, exc)


def build_application() -> Application:
    if not TOKEN:
        raise RuntimeError("TELEGRAM_BOT_TOKEN is required")
    bot_app = ApplicationBuilder().token(TOKEN).build()
    controller = RolexBot(bot_app)
    bot_app.post_init = controller.startup
    bot_app.post_shutdown = controller.shutdown
    bot_app.add_handler(CommandHandler("start", controller.start))
    bot_app.add_handler(CommandHandler("help", controller.help))
    bot_app.add_handler(CommandHandler(["wallet", "balance", "bal"], controller.wallet))
    bot_app.add_handler(CommandHandler(["currency", "changecurrency"], controller.currency_command))
    bot_app.add_handler(CommandHandler("setwallet", controller.setwallet))
    bot_app.add_handler(CommandHandler("deposit", controller.deposit))
    bot_app.add_handler(CommandHandler("withdraw", controller.withdraw))
    bot_app.add_handler(CommandHandler(["game", "dice"], controller.game))
    bot_app.add_handler(CommandHandler("escrow", controller.escrow))
    bot_app.add_handler(CommandHandler("tip", controller.tip))
    bot_app.add_handler(CommandHandler("approve_deposit", controller.admin_action))
    bot_app.add_handler(CommandHandler("reject_deposit", controller.admin_action))
    bot_app.add_handler(CommandHandler("approve_withdraw", controller.admin_action))
    bot_app.add_handler(CommandHandler("reject_withdraw", controller.admin_action))
    bot_app.add_handler(CallbackQueryHandler(controller.callback))
    bot_app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, controller.handle_utr))
    return bot_app


def main() -> None:
    application = build_application()
    LOGGER.info("Starting standalone RolexCasino Python bot")
    application.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()