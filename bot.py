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
import sys
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
INR_PER_USD = Decimal("94.47")
ESCROW_FEE_RATE = Decimal("0.02")
WITHDRAWAL_FEE_RATE = Decimal("0.04")
TIP_CONFIRMATION_THRESHOLD_INR_MINOR = 5_000
MAX_GAME_STAKE = {"INR": 50_000, "USD": 500}
MIN_GAME_STAKE = {"INR": 1_000, "USD": 10}
MIN_WITHDRAWAL_MINOR = {"INR": 10_000, "USD": 100}
MIN_DEPOSIT_MINOR = {"INR": 5_000, "USD": 50}
MAX_DEPOSIT_MINOR = {"INR": 500_000, "USD": 5_000}

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


def withdrawal_fee(amount_minor: int) -> int:
    return max(
        1,
        int(
            (Decimal(amount_minor) * WITHDRAWAL_FEE_RATE).quantize(
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
                ALTER TABLE casino_cash_requests
                  ADD COLUMN IF NOT EXISTS fee_minor INTEGER NOT NULL DEFAULT 0;
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
                CREATE TABLE IF NOT EXISTS casino_bans (
                  player_id INTEGER PRIMARY KEY REFERENCES casino_players(id) ON DELETE CASCADE,
                  reason TEXT NOT NULL DEFAULT 'Administrative action',
                  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
                CREATE TABLE IF NOT EXISTS casino_gifts (
                  code VARCHAR(40) PRIMARY KEY,
                  creator_id INTEGER NOT NULL REFERENCES casino_players(id),
                  currency VARCHAR(3) NOT NULL,
                  amount_minor INTEGER NOT NULL,
                  max_claims INTEGER NOT NULL,
                  claimed_count INTEGER NOT NULL DEFAULT 0,
                  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
                CREATE TABLE IF NOT EXISTS casino_gift_claims (
                  code VARCHAR(40) NOT NULL REFERENCES casino_gifts(code) ON DELETE CASCADE,
                  player_id INTEGER NOT NULL REFERENCES casino_players(id) ON DELETE CASCADE,
                  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                  PRIMARY KEY (code, player_id)
                );
                CREATE TABLE IF NOT EXISTS casino_app_settings (
                  setting_key VARCHAR(80) PRIMARY KEY,
                  setting_value TEXT NOT NULL,
                  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
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

    async def create_gift(
        self, creator_id: int, code_value: str, amount_minor: int, curr: str, max_claims: int
    ) -> bool:
        async with self.require_pool().acquire() as conn:
            result = await conn.execute(
                """
                INSERT INTO casino_gifts
                  (code, creator_id, currency, amount_minor, max_claims)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (code) DO NOTHING
                """,
                code_value,
                creator_id,
                curr,
                amount_minor,
                max_claims,
            )
        return result.endswith("1")

    async def claim_gift(self, player_id: int, code_value: str) -> Optional[asyncpg.Record]:
        async with self.require_pool().acquire() as conn:
            async with conn.transaction():
                gift = await conn.fetchrow(
                    "SELECT * FROM casino_gifts WHERE code = $1 FOR UPDATE",
                    code_value.upper(),
                )
                if not gift or gift["claimed_count"] >= gift["max_claims"]:
                    return None
                claim = await conn.fetchrow(
                    """
                    INSERT INTO casino_gift_claims (code, player_id)
                    VALUES ($1, $2)
                    ON CONFLICT (code, player_id) DO NOTHING
                    RETURNING code
                    """,
                    gift["code"],
                    player_id,
                )
                if not claim:
                    return None
                wallet = await self._wallet_conn(conn, player_id, gift["currency"])
                txid = transaction_id()
                await conn.execute(
                    """
                    UPDATE casino_wallets
                    SET balance_minor = balance_minor + $2, updated_at = NOW()
                    WHERE id = $1
                    """,
                    wallet["id"],
                    gift["amount_minor"],
                )
                await conn.execute(
                    """
                    INSERT INTO casino_ledger_entries
                      (wallet_id, transaction_id, entry_type, amount_minor, description)
                    VALUES ($1, $2, 'gift_claim', $3, $4)
                    """,
                    wallet["id"],
                    txid,
                    gift["amount_minor"],
                    f"Gift {gift['code']} claimed",
                )
                return await conn.fetchrow(
                    """
                    UPDATE casino_gifts
                    SET claimed_count = claimed_count + 1
                    WHERE code = $1
                    RETURNING *
                    """,
                    gift["code"],
                )

    async def set_setting(self, key: str, value: str) -> None:
        async with self.require_pool().acquire() as conn:
            await conn.execute(
                """
                INSERT INTO casino_app_settings (setting_key, setting_value)
                VALUES ($1, $2)
                ON CONFLICT (setting_key) DO UPDATE
                SET setting_value = EXCLUDED.setting_value, updated_at = NOW()
                """,
                key,
                value,
            )

    async def get_setting(self, key: str, default: str = "") -> str:
        async with self.require_pool().acquire() as conn:
            value = await conn.fetchval(
                "SELECT setting_value FROM casino_app_settings WHERE setting_key = $1",
                key,
            )
        return value if value is not None else default

    async def set_ban(self, player_id: int, reason: str) -> None:
        async with self.require_pool().acquire() as conn:
            await conn.execute(
                """
                INSERT INTO casino_bans (player_id, reason)
                VALUES ($1, $2)
                ON CONFLICT (player_id) DO UPDATE SET reason = EXCLUDED.reason
                """,
                player_id,
                reason,
            )

    async def remove_ban(self, player_id: int) -> bool:
        async with self.require_pool().acquire() as conn:
            result = await conn.execute(
                "DELETE FROM casino_bans WHERE player_id = $1",
                player_id,
            )
        return result.endswith("1")

    async def is_banned(self, player_id: int) -> bool:
        async with self.require_pool().acquire() as conn:
            return bool(
                await conn.fetchval(
                    "SELECT 1 FROM casino_bans WHERE player_id = $1",
                    player_id,
                )
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

                await self.record_wager(conn, creator_id, curr, stake)
                if opponent_id:
                    await self.record_wager(conn, opponent_id, curr, stake)

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

    async def submit_payment_proof(
        self,
        intent_id: int,
        player_id: int,
        utr: Optional[str],
        proof_file_id: Optional[str] = None,
        proof_type: Optional[str] = None,
    ) -> Optional[PaymentIntent]:
        async with self.require_pool().acquire() as conn:
            row = await conn.fetchrow(
                """
                UPDATE casino_payment_intents
                SET utr = $3, proof_file_id = $4, proof_type = $5,
                    status = 'submitted', updated_at = NOW()
                WHERE id = $1 AND player_id = $2 AND status = 'awaiting-payment'
                RETURNING id, player_id, amount_minor, currency, network, status
                """,
                intent_id,
                player_id,
                utr,
                proof_file_id,
                proof_type,
            )
        return PaymentIntent(**dict(row)) if row else None

    async def save_deposit_utr(
        self, intent_id: int, player_id: int, utr: str
    ) -> Optional[asyncpg.Record]:
        async with self.require_pool().acquire() as conn:
            return await conn.fetchrow(
                """
                UPDATE casino_payment_intents
                SET utr = $3, updated_at = NOW()
                WHERE id = $1 AND player_id = $2 AND status = 'awaiting-payment'
                RETURNING *
                """,
                intent_id,
                player_id,
                utr,
            )

    async def submit_utr(
        self, intent_id: int, player_id: int, utr: str
    ) -> Optional[PaymentIntent]:
        return await self.submit_payment_proof(
            intent_id,
            player_id,
            utr,
            proof_type="text",
        )

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
                await self.add_wager_requirement(
                    conn,
                    intent["player_id"],
                    intent["currency"],
                    intent["amount_minor"],
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
        fee_minor = withdrawal_fee(amount_minor)
        payout_minor = amount_minor - fee_minor
        if payout_minor <= 0:
            return None
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
                    -payout_minor,
                    f"Withdrawal hold via {payout_type}",
                )
                await conn.execute(
                    """
                    INSERT INTO casino_ledger_entries
                      (wallet_id, transaction_id, entry_type, amount_minor, description)
                    VALUES ($1, $2, 'withdrawal_fee', $3, $4)
                    """,
                    wallet["id"],
                    txid,
                    -fee_minor,
                    "Withdrawal processing fee (4%)",
                )
                await conn.execute(
                    """
                    INSERT INTO casino_house_ledger
                      (transaction_id, entry_type, currency, amount_minor, description)
                    VALUES ($1, 'withdrawal_fee', $2, $3, 'Withdrawal fee credited to house')
                    """,
                    txid,
                    curr,
                    fee_minor,
                )
                row = await conn.fetchrow(
                    """
                    INSERT INTO casino_cash_requests
                      (player_id, request_type, currency, amount_minor, fee_minor, status, note)
                    VALUES ($1, 'withdrawal', $2, $3, $4, 'pending', $5)
                    RETURNING id
                    """,
                    player_id,
                    curr,
                    payout_minor,
                    fee_minor,
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
                refund_minor = request["amount_minor"] + request["fee_minor"]
                await conn.execute(
                    """
                    UPDATE casino_wallets
                    SET balance_minor = balance_minor + $2, updated_at = NOW()
                    WHERE id = $1
                    """,
                    wallet["id"],
                    refund_minor,
                )
                await conn.execute(
                    """
                    INSERT INTO casino_ledger_entries
                      (wallet_id, transaction_id, entry_type, amount_minor, description)
                    VALUES ($1, $2, 'withdrawal_refund', $3, $4)
                    """,
                    wallet["id"],
                    transaction_id(),
                    refund_minor,
                    f"Withdrawal #{request_id} rejected",
                )
                if request["fee_minor"]:
                    await conn.execute(
                        """
                        INSERT INTO casino_house_ledger
                          (transaction_id, entry_type, currency, amount_minor, description)
                        VALUES ($1, 'withdrawal_fee_refund', $2, $3, $4)
                        """,
                        transaction_id(),
                        request["currency"],
                        -request["fee_minor"],
                        f"Withdrawal #{request_id} fee refunded",
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

    async def adjust_balance(
        self,
        player_id: int,
        curr: str,
        amount_minor: int,
        entry_type: str,
        description: str,
    ) -> Optional[int]:
        if amount_minor == 0:
            return None
        pool = self.require_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                wallet = await self._wallet_conn(conn, player_id, curr)
                updated = await conn.fetchrow(
                    """
                    UPDATE casino_wallets
                    SET balance_minor = balance_minor + $2, updated_at = NOW()
                    WHERE id = $1 AND balance_minor + $2 >= 0
                    RETURNING balance_minor
                    """,
                    wallet["id"],
                    amount_minor,
                )
                if not updated:
                    return None
                await conn.execute(
                    """
                    INSERT INTO casino_ledger_entries
                      (wallet_id, transaction_id, entry_type, amount_minor, description)
                    VALUES ($1, $2, $3, $4, $5)
                    """,
                    wallet["id"],
                    transaction_id(),
                    entry_type,
                    amount_minor,
                    description,
                )
                return updated["balance_minor"]

    async def distribute_rain(
        self,
        total_minor: int,
        curr: str,
        player_ids: Optional[list[int]] = None,
        count: Optional[int] = None,
    ) -> tuple[list[int], int]:
        if total_minor <= 0:
            return [], 0
        pool = self.require_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                if player_ids:
                    rows = await conn.fetch(
                        """
                        SELECT id FROM casino_players
                        WHERE id = ANY($1::int[])
                        ORDER BY id
                        """,
                        player_ids,
                    )
                elif count:
                    rows = await conn.fetch(
                        """
                        SELECT id FROM casino_players
                        ORDER BY id DESC
                        LIMIT $1
                        """,
                        count,
                    )
                else:
                    rows = await conn.fetch(
                        "SELECT id FROM casino_players ORDER BY id"
                    )
                ids = [row["id"] for row in rows]
                if not ids:
                    return [], 0
                base, remainder = divmod(total_minor, len(ids))
                txid = transaction_id()
                for index, player_id in enumerate(ids):
                    share = base + (1 if index < remainder else 0)
                    wallet = await self._wallet_conn(conn, player_id, curr)
                    await conn.execute(
                        """
                        UPDATE casino_wallets
                        SET balance_minor = balance_minor + $2, updated_at = NOW()
                        WHERE id = $1
                        """,
                        wallet["id"],
                        share,
                    )
                    await conn.execute(
                        """
                        INSERT INTO casino_ledger_entries
                          (wallet_id, transaction_id, entry_type, amount_minor, description)
                        VALUES ($1, $2, 'rain_credit', $3, $4)
                        """,
                        wallet["id"],
                        txid,
                        share,
                        f"Admin rain distribution in {curr}",
                    )
                return ids, base

    async def fund_house_wallet(
        self, admin_player_id: int, amount_minor: int, curr: str
    ) -> Optional[int]:
        if amount_minor <= 0:
            return None
        async with self.require_pool().acquire() as conn:
            async with conn.transaction():
                wallet = await self._wallet_conn(conn, admin_player_id, curr)
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
                    VALUES ($1, $2, 'house_funding', $3, $4)
                    """,
                    wallet["id"],
                    txid,
                    -amount_minor,
                    "Admin funded house wallet",
                )
                await conn.execute(
                    """
                    INSERT INTO casino_house_ledger
                      (transaction_id, entry_type, currency, amount_minor, description)
                    VALUES ($1, 'house_funding', $2, $3, $4)
                    """,
                    txid,
                    curr,
                    amount_minor,
                    "Admin funded house wallet",
                )
                return updated["balance_minor"]

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
        self.awaiting_deposit_amount: dict[int, str] = {}
        self.awaiting_deposit_utr: dict[int, int] = {}
        self.awaiting_deposit_screenshot: dict[int, int] = {}
        self.awaiting_withdraw_amount: dict[int, str] = {}
        self.awaiting_wallet_setup: dict[int, str] = {}
        self.pending_withdrawal_setup: dict[int, dict[str, Any]] = {}
        self.pending_withdrawals: dict[str, dict[str, Any]] = {}
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

    async def ensure_private(self, update: Update, command: str) -> bool:
        chat = update.effective_chat
        if not chat or chat.type == "private":
            player = await self.db.player(update.effective_user)
            if await self.db.is_banned(player["id"]) and not self.admin(update.effective_user.id):
                await self.reply(
                    update,
                    professional(
                        "Your account is restricted.",
                        "Contact support for assistance.",
                        icon="lock",
                    ),
                )
                return False
            return True
        bot_url = os.environ.get("BOT_URL", "https://t.me/Rolex_C_BOT")
        await self.reply(
            update,
            professional(
                "Private cashier required.",
                "Deposits and withdrawals are handled securely in the bot's private chat.",
                "Tap below to continue.",
                icon="lock",
            ),
            reply_markup=InlineKeyboardMarkup(
                [[InlineKeyboardButton(f"🟢 Open /{command}", url=f"{bot_url}?start={command}")]]
            ),
        )
        return False

    @staticmethod
    def parse_amount_input(raw: str, fallback_currency: str) -> tuple[Optional[int], str]:
        parts = raw.replace(",", "").replace("₹", "").replace("$", "").split()
        amount = parse_money(parts[0] if parts else None)
        selected = currency(parts[1] if len(parts) > 1 else fallback_currency, fallback_currency)
        return amount, selected

    @staticmethod
    def wallet_destination_is_valid(payout_type: str, value: str) -> bool:
        normalized = payout_type.upper()
        if normalized == "UPI":
            return bool(re.fullmatch(r"[A-Za-z0-9._-]{2,}@[A-Za-z]{2,}", value))
        if normalized == "BTC":
            return bool(re.fullmatch(r"(bc1|[13])[A-Za-z0-9]{20,89}", value))
        if normalized in {"BSC", "ETHEREUM"}:
            return bool(re.fullmatch(r"0x[a-fA-F0-9]{40}", value))
        if normalized == "SOLANA":
            return bool(re.fullmatch(r"[1-9A-HJ-NP-Za-km-z]{32,44}", value))
        return False

    @staticmethod
    def wallet_setup_markup(user_id: int, currency_code: Optional[str] = None) -> InlineKeyboardMarkup:
        if currency_code == "INR":
            rows = [[InlineKeyboardButton("🟢 UPI (INR)", callback_data=f"walletsetup:{user_id}:upi")]]
        else:
            rows = [
                [
                    InlineKeyboardButton("🟢 UPI", callback_data=f"walletsetup:{user_id}:upi"),
                    InlineKeyboardButton("🟢 BTC", callback_data=f"walletsetup:{user_id}:btc"),
                ],
                [
                    InlineKeyboardButton("🟢 BSC", callback_data=f"walletsetup:{user_id}:bsc"),
                    InlineKeyboardButton("🟢 Solana", callback_data=f"walletsetup:{user_id}:solana"),
                ],
                [InlineKeyboardButton("🟢 Ethereum", callback_data=f"walletsetup:{user_id}:ethereum")],
            ]
        return InlineKeyboardMarkup(rows)

    async def save_wallet_destination(
        self, update: Update, payout_type: str, value: str
    ) -> None:
        if not self.wallet_destination_is_valid(payout_type, value):
            label = "UPI ID" if payout_type.upper() == "UPI" else f"{payout_type.upper()} address"
            await self.reply(
                update,
                professional(f"That {label} is not valid.", "Please send the complete destination and try again.", icon="question"),
            )
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
        self.awaiting_wallet_setup.pop(update.effective_user.id, None)
        await self.reply(
            update,
            professional(
                f"{pe('check')} Wallet destination saved.",
                f"Network: {esc(payout_type)}",
                f"Address: <code>{esc(payout_mask(value))}</code>",
                "You can update it any time with /setwallet.",
                icon="briefcase",
            ),
        )
        pending = self.pending_withdrawal_setup.pop(update.effective_user.id, None)
        if pending:
            await self.show_withdrawal_summary(
                update,
                pending["amount_minor"],
                pending["currency"],
            )

    async def saveupi(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not await self.ensure_private(update, "saveupi"):
            return
        if not context.args:
            await self.setwallet(update, context)
            return
        value = " ".join(context.args).strip()
        if not value or " " in value:
            await self.reply(
                update,
                professional("Send one valid UPI ID without spaces.", icon="question"),
            )
            return
        await self.save_wallet_destination(update, "UPI", value)

    async def show_deposit_networks(
        self, update: Update, amount_minor: int, curr: str
    ) -> None:
        player = await self.db.player(update.effective_user)
        intent_id = await self.db.create_payment_intent(player["id"], amount_minor, curr)
        keyboard = [
            [
                InlineKeyboardButton("🟢 UPI (INR)", callback_data=f"deposit:network:{intent_id}:upi"),
                InlineKeyboardButton("🟢 BTC", callback_data=f"deposit:network:{intent_id}:btc"),
            ],
            [
                InlineKeyboardButton("🟢 BSC (BEP20)", callback_data=f"deposit:network:{intent_id}:bsc"),
                InlineKeyboardButton("🟢 Solana", callback_data=f"deposit:network:{intent_id}:solana"),
            ],
            [
                InlineKeyboardButton("🟢 Ethereum", callback_data=f"deposit:network:{intent_id}:ethereum"),
                InlineKeyboardButton("🟢 Cancel", callback_data=f"deposit:cancel:{intent_id}"),
            ],
        ]
        await self.reply(
            update,
            professional(
                f"{pe('upload')} Deposit {esc(money(amount_minor, curr))}",
                "Choose your payment method:",
                "UPI is for INR. Crypto networks are for USD/USDT deposits.",
                "After payment, press I have paid and complete both proof steps.",
                icon="upload",
            ),
            reply_markup=InlineKeyboardMarkup(keyboard),
        )

    async def show_withdrawal_summary(
        self, update: Update, amount_minor: int, curr: str
    ) -> None:
        player = await self.db.player(update.effective_user)
        wallet_type = (player["payout_wallet_type"] or "").upper()
        compatible = (
            curr == "INR" and wallet_type == "UPI"
        ) or (
            curr == "USD" and wallet_type in {"BTC", "BSC", "SOLANA", "ETHEREUM"}
        )
        if not player["payout_wallet"] or not compatible:
            self.pending_withdrawal_setup[update.effective_user.id] = {
                "amount_minor": amount_minor,
                "currency": curr,
            }
            await self.reply(
                update,
                professional(
                    "Save your withdrawal wallet first.",
                    "Choose a network below, then send the full wallet address.",
                    icon="briefcase",
                ),
                reply_markup=self.wallet_setup_markup(update.effective_user.id, curr),
            )
            return
        fee_minor = withdrawal_fee(amount_minor)
        receive_minor = amount_minor - fee_minor
        if receive_minor <= 0:
            await self.reply(update, professional("The withdrawal amount is too small after fees.", icon="cross"))
            return
        token = secrets.token_urlsafe(9)
        self.pending_withdrawals[token] = {
            "telegram_user_id": update.effective_user.id,
            "player_id": player["id"],
            "amount_minor": amount_minor,
            "currency": curr,
            "payout_type": player["payout_wallet_type"],
            "payout": player["payout_wallet"],
        }
        await self.reply(
            update,
            professional(
                f"{pe('money')} Withdrawal Summary",
                f"Currency: {esc(curr)}",
                f"Requested amount: {esc(money(amount_minor, curr))}",
                f"Fee: {esc(money(fee_minor, curr))} · 4%",
                f"You will receive: {esc(money(receive_minor, curr))}",
                f"To: <code>{esc(payout_mask(player['payout_wallet']))}</code>",
                "Confirm to hold the requested amount for admin payout review.",
                icon="money",
            ),
            reply_markup=InlineKeyboardMarkup(
                [[
                    InlineKeyboardButton("🟢 Confirm", callback_data=f"withdraw:confirm:{token}"),
                    InlineKeyboardButton("🟢 Cancel", callback_data=f"withdraw:cancel:{token}"),
                ]]
            ),
        )

    async def prepare_withdrawal(
        self, update: Update, amount_minor: int, curr: str
    ) -> None:
        if amount_minor < MIN_WITHDRAWAL_MINOR[curr]:
            await self.reply(
                update,
                professional(
                    "Withdrawal amount is below the minimum.",
                    f"Minimum: {esc(money(MIN_WITHDRAWAL_MINOR[curr], curr))}",
                    icon="info",
                ),
            )
            return
        player = await self.db.player(update.effective_user)
        wager_rows = await self.db.wager_status(player["id"])
        remaining_wager = next(
            (
                max(0, row["required_minor"] - row["completed_minor"])
                for row in wager_rows
                if row["currency"] == curr
            ),
            0,
        )
        if remaining_wager:
            await self.reply(
                update,
                professional(
                    "Withdrawal is locked until wagering is complete.",
                    f"Remaining {esc(curr)} wager: {esc(money(remaining_wager, curr))}",
                    "Play any game to clear it, then check /wagerstatus.",
                    icon="lock",
                ),
            )
            return
        await self.show_withdrawal_summary(update, amount_minor, curr)

    async def start(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if context.args and context.args[0].lower() in {"deposit", "withdraw"}:
            command = context.args[0].lower()
            context.args.clear()
            if command == "deposit":
                await self.deposit(update, context)
            else:
                await self.withdraw(update, context)
            return
        player = await self.db.player(update.effective_user)
        balance = await self.db.balance_text(player["id"], player["preferred_currency"])
        if update.effective_chat and update.effective_chat.type == "private":
            await self.reply(
                update,
                professional(
                    f"Welcome, {esc(player['display_name'])}.",
                    "",
                    f"{pe('info')} I'm RolexCasino Bot.",
                    "This bot works inside the official group.",
                    "Tap below to join and start playing.",
                    "",
                    balance,
                    icon="trophy",
                ),
                reply_markup=InlineKeyboardMarkup(
                    [[InlineKeyboardButton("🟢 Join Official Group", url=GROUP_LINK)]]
                ),
            )
            return
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
                "/saveupi UPI_ID — save a UPI payout destination",
                "/deposit AMOUNT INR|USD — choose a payment network and submit UTR",
                "/withdraw AMOUNT INR|USD — create a verified withdrawal request",
                "/wagerstatus — view your deposit wagering progress",
                "/game pvb AMOUNT INR — confirm a game against the bot",
                "/game pvp AMOUNT INR @opponent — send a 120-second PvP challenge",
                "/rain TOTAL [COUNT|@users] — admin-only equal distribution",
                "/mystats — view your gaming stats",
                "/pending and /admincommands — admin review tools",
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

    async def games(self, update: Update, _: ContextTypes.DEFAULT_TYPE) -> None:
        await self.reply(
            update,
            professional(
                "Available games",
                "",
                "🎲 Dice — /dice AMOUNT [INR|USD] [@opponent]",
                "🎯 Darts — /darts AMOUNT [INR|USD] [@opponent]",
                "🎳 Bowling — /bowling AMOUNT [INR|USD] [@opponent]",
                "🏀 Basketball — /basket AMOUNT [INR|USD] [@opponent]",
                "⚽ Football — /football AMOUNT [INR|USD] [@opponent]",
                "🎰 Slots — /slots AMOUNT [INR|USD] [@opponent]",
                "🪙 Coin — /coin AMOUNT [INR|USD] [@opponent]",
                "🎲 Dice Rush — /dr AMOUNT [INR|USD]",
                "7️⃣ 7UP — /7up AMOUNT [INR|USD]",
                "",
                "PvB starts against RolexCasino. Add @opponent for PvP.",
                "Each game is capped at ₹500 or $5 per round.",
                icon="trophy",
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

    async def wagerstatus(self, update: Update, _: ContextTypes.DEFAULT_TYPE) -> None:
        player = await self.db.player(update.effective_user)
        rows = await self.db.wager_status(player["id"])
        if not rows:
            await self.reply(
                update,
                professional(
                    "No active deposit wagering requirement.",
                    "Approved deposits will appear here.",
                    icon="check",
                ),
            )
            return
        lines = ["Deposit wagering progress"]
        for row in rows:
            completed = min(row["completed_minor"], row["required_minor"])
            remaining = max(0, row["required_minor"] - completed)
            lines.append(
                f"{esc(row['currency'])}: {esc(money(completed, row['currency']))} "
                f"of {esc(money(row['required_minor'], row['currency']))} completed"
            )
            lines.append(
                f"{pe('lock')} Remaining: {esc(money(remaining, row['currency']))}"
            )
        await self.reply(update, professional(*lines, icon="trend"))

    async def rain(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not self.admin(update.effective_user.id):
            return
        if not context.args:
            await self.reply(
                update,
                professional(
                    "Usage: /rain TOTAL [COUNT|@user1 @user2 ...] [INR|USD]",
                    icon="info",
                ),
            )
            return
        amount = parse_money(context.args[0])
        if not amount:
            await self.reply(update, professional("Enter a valid total rain amount.", icon="question"))
            return
        remaining = list(context.args[1:])
        curr = HOUSE_CURRENCY
        if remaining and remaining[0].upper() in SUPPORTED_CURRENCIES:
            curr = remaining.pop(0).upper()
        count = int(remaining[0]) if remaining and remaining[0].isdigit() else None
        mentions = remaining if count is None else []
        player_ids: list[int] = []
        for mention in mentions:
            player = await self.db.player_by_username(mention)
            if player and player["id"] not in player_ids:
                player_ids.append(player["id"])
        if mentions and not player_ids:
            await self.reply(update, professional("No registered users matched the selected usernames.", icon="user"))
            return
        ids, base_share = await self.db.distribute_rain(
            amount,
            curr,
            player_ids=player_ids or None,
            count=count,
        )
        if not ids:
            await self.reply(update, professional("No registered users are available for rain.", icon="cross"))
            return
        share_text = money(base_share, curr)
        await self.reply(
            update,
            professional(
                f"{pe('cloud')} Rain distributed successfully.",
                f"Total: {esc(money(amount, curr))}",
                f"Recipients: {len(ids)}",
                f"Each recipient receives approximately: {esc(share_text)}",
                "Any remainder cents were distributed one per recipient until exhausted.",
                icon="money",
            ),
        )
        for player_id in ids:
            try:
                await self.send(
                    self.application.bot,
                    (await self.db.player_by_id(player_id))["telegram_user_id"],
                    professional(
                        f"{pe('cloud')} You received rain.",
                        f"Amount: {esc(share_text)} {esc(curr)}",
                        "Use /wallet to view your balance.",
                        icon="money",
                    ),
                )
            except Exception as exc:
                LOGGER.warning("Could not notify rain recipient %s: %s", player_id, exc)

    async def balance_adjust(
        self, update: Update, context: ContextTypes.DEFAULT_TYPE, increase: bool
    ) -> None:
        if not self.admin(update.effective_user.id):
            return
        if len(context.args) < 2 or not context.args[0].isdigit():
            command = "/balanceadd" if increase else "/balancededuct"
            await self.reply(
                update,
                professional(
                    f"Usage: {command} PLAYER_ID AMOUNT [INR|USD]",
                    icon="info",
                ),
            )
            return
        player_id = int(context.args[0])
        amount = parse_money(context.args[1])
        curr = currency(
            context.args[2] if len(context.args) > 2 else HOUSE_CURRENCY,
            HOUSE_CURRENCY,
        )
        if not amount:
            await self.reply(update, professional("Enter a valid amount.", icon="question"))
            return
        if not await self.db.player_by_id(player_id):
            await self.reply(update, professional("User not found.", icon="cross"))
            return
        delta = amount if increase else -amount
        balance = await self.db.adjust_balance(
            player_id,
            curr,
            delta,
            "admin_credit" if increase else "admin_debit",
            "Admin balance adjustment",
        )
        if balance is None:
            await self.reply(
                update,
                professional(
                    "The adjustment failed. Check the player ID and available balance.",
                    icon="cross",
                ),
            )
            return
        await self.reply(
            update,
            professional(
                f"{pe('check')} Balance {'added' if increase else 'deducted'}.",
                f"Player ID: {player_id}",
                f"Amount: {esc(money(amount, curr))}",
                f"New balance: {esc(money(balance, curr))}",
                icon="settings",
            ),
        )

    async def balanceadd(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        await self.balance_adjust(update, context, True)

    async def balancededuct(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        await self.balance_adjust(update, context, False)

    async def users(self, update: Update, _: ContextTypes.DEFAULT_TYPE) -> None:
        if not self.admin(update.effective_user.id):
            return
        async with self.db.require_pool().acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT p.id, p.username, p.display_name,
                       COALESCE(SUM(w.balance_minor) FILTER (WHERE w.currency = 'INR'), 0) AS inr_balance,
                       COALESCE(SUM(w.balance_minor) FILTER (WHERE w.currency = 'USD'), 0) AS usd_balance
                FROM casino_players p
                LEFT JOIN casino_wallets w ON w.player_id = p.id
                GROUP BY p.id
                ORDER BY p.id DESC
                LIMIT 25
                """
            )
        lines = [f"Registered users: {len(rows)} shown (latest 25)"]
        for row in rows:
            lines.append(
                f"#{row['id']} @{esc(row['username'] or 'not-set')} · "
                f"INR {esc(money(row['inr_balance'], 'INR'))} · "
                f"USD {esc(money(row['usd_balance'], 'USD'))}"
            )
        await self.reply(update, professional(*lines, icon="users"))

    async def user_info(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not self.admin(update.effective_user.id):
            return
        if not context.args or not context.args[0].isdigit():
            await self.reply(update, professional("Usage: /user PLAYER_ID", icon="info"))
            return
        player = await self.db.player_by_id(int(context.args[0]))
        if not player:
            await self.reply(update, professional("User not found.", icon="cross"))
            return
        await self.reply(
            update,
            professional(
                f"{pe('user')} User #{player['id']}",
                f"Name: {esc(player['display_name'])}",
                f"Telegram ID: {player['telegram_user_id']}",
                f"Username: @{esc(player['username'] or 'not-set')}",
                f"Preferred currency: {esc(player['preferred_currency'])}",
                icon="user",
            ),
        )

    async def house_balance(self, update: Update, _: ContextTypes.DEFAULT_TYPE) -> None:
        if not self.admin(update.effective_user.id):
            return
        async with self.db.require_pool().acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT currency,
                       COALESCE(SUM(amount_minor), 0) AS amount_minor
                FROM casino_house_ledger
                GROUP BY currency
                ORDER BY currency
                """
            )
        lines = ["House ledger"]
        if not rows:
            lines.append("No house entries recorded yet.")
        else:
            lines.extend(
                f"{esc(row['currency'])}: {esc(money(row['amount_minor'], row['currency']))}"
                for row in rows
            )
        await self.reply(update, professional(*lines, icon="briefcase"))

    async def botadd(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not self.admin(update.effective_user.id):
            return
        if not context.args:
            await self.reply(update, professional("Usage: /botadd AMOUNT [INR|USD]", icon="info"))
            return
        admin_player = await self.db.player(update.effective_user)
        amount, curr = self.parse_amount_input(
            " ".join(context.args),
            admin_player["preferred_currency"],
        )
        if amount is None:
            await self.reply(update, professional("Enter a valid amount.", icon="question"))
            return
        balance = await self.db.fund_house_wallet(admin_player["id"], amount, curr)
        if balance is None:
            await self.reply(
                update,
                professional("House funding failed because the admin wallet is insufficient.", icon="cross"),
            )
            return
        await self.reply(
            update,
            professional(
                f"{pe('check')} House wallet funded.",
                f"Added: {esc(money(amount, curr))}",
                f"Your new admin balance: {esc(money(balance, curr))}",
                "Use /hb to view the house ledger.",
                icon="briefcase",
            ),
        )

    async def pending(self, update: Update, _: ContextTypes.DEFAULT_TYPE) -> None:
        if not self.admin(update.effective_user.id):
            return
        async with self.db.require_pool().acquire() as conn:
            deposits = await conn.fetch(
                """
                SELECT i.id, i.amount_minor, i.currency, i.network, p.username
                FROM casino_payment_intents i
                JOIN casino_players p ON p.id = i.player_id
                WHERE i.status = 'submitted'
                ORDER BY i.created_at
                LIMIT 20
                """
            )
            withdrawals = await conn.fetch(
                """
                SELECT r.id, r.amount_minor, r.fee_minor, r.currency, p.username
                FROM casino_cash_requests r
                JOIN casino_players p ON p.id = r.player_id
                WHERE r.request_type = 'withdrawal' AND r.status = 'pending'
                ORDER BY r.created_at
                LIMIT 20
                """
            )
        lines = ["Pending admin review"]
        lines.append("Deposits:")
        lines.extend(
            f"#{row['id']} @{esc(row['username'] or 'not-set')} · "
            f"{esc(money(row['amount_minor'], row['currency']))} · {esc(row['network'])} "
            f"(/approve_deposit {row['id']} /reject_deposit {row['id']})"
            for row in deposits
        )
        if not deposits:
            lines.append("None")
        lines.append("Withdrawals:")
        lines.extend(
            f"#{row['id']} @{esc(row['username'] or 'not-set')} · "
            f"Payout {esc(money(row['amount_minor'], row['currency']))} · "
            f"Fee {esc(money(row['fee_minor'], row['currency']))} "
            f"(/approve_withdraw {row['id']} /reject_withdraw {row['id']})"
            for row in withdrawals
        )
        if not withdrawals:
            lines.append("None")
        await self.reply(update, professional(*lines, icon="settings"))

    async def support(self, update: Update, _: ContextTypes.DEFAULT_TYPE) -> None:
        await self.reply(
            update,
            professional(
                "Customer support",
                "Need help? Our support team is here to assist you.",
                "Contact: @RolexCasinoMOD",
                "",
                "Support format:",
                "Username:",
                "User ID:",
                "Issue:",
                "Transaction ID:",
                "Screenshot / proof:",
                "",
                "For admin matters, inform the administrators directly.",
                icon="headset",
            ),
        )

    async def admincommands(self, update: Update, _: ContextTypes.DEFAULT_TYPE) -> None:
        if not self.admin(update.effective_user.id):
            return
        await self.reply(
            update,
            professional(
                "Admin command manual",
                "/pending — review deposits and withdrawals",
                "/approve_deposit ID and /reject_deposit ID",
                "/approve_withdraw ID and /reject_withdraw ID",
                "/rain TOTAL [COUNT|@users] [INR|USD]",
                "/balanceadd PLAYER_ID AMOUNT [INR|USD]",
                "/balancededuct PLAYER_ID AMOUNT [INR|USD]",
                "/botadd AMOUNT [INR|USD] — fund the house from your wallet",
                "/users and /user PLAYER_ID",
                "/hb — house ledger",
                icon="settings",
            ),
        )

    async def mystats(self, update: Update, _: ContextTypes.DEFAULT_TYPE) -> None:
        player = await self.db.player(update.effective_user)
        async with self.db.require_pool().acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT COUNT(*) AS games,
                       COUNT(*) FILTER (WHERE outcome = 'WIN') AS wins,
                       COUNT(*) FILTER (WHERE outcome = 'LOSS') AS losses,
                       COALESCE(SUM(stake_minor), 0) AS wagered,
                       COALESCE(SUM(payout_minor), 0) AS payouts
                FROM casino_game_rounds
                WHERE player_id = $1
                """,
                player["id"],
            )
        games = row["games"] or 0
        winrate = (Decimal(row["wins"] or 0) / Decimal(games) * 100) if games else Decimal("0")
        await self.reply(
            update,
            professional(
                "Your gaming statistics",
                f"Games: {games}",
                f"Wins: {row['wins'] or 0}",
                f"Losses: {row['losses'] or 0}",
                f"Win rate: {winrate.quantize(Decimal('0.1'))}%",
                f"Wagered: {esc(money(row['wagered'] or 0, player['preferred_currency']))}",
                f"Payouts: {esc(money(row['payouts'] or 0, player['preferred_currency']))}",
                icon="chart",
            ),
        )

    async def rank(self, update: Update, _: ContextTypes.DEFAULT_TYPE) -> None:
        async with self.db.require_pool().acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT p.username, p.display_name,
                       COUNT(*) AS games,
                       COALESCE(SUM(g.stake_minor), 0) AS wagered
                FROM casino_game_rounds g
                JOIN casino_players p ON p.id = g.player_id
                GROUP BY p.id
                ORDER BY wagered DESC
                LIMIT 10
                """
            )
        lines = ["Top 10 high rollers"]
        lines.extend(
            f"{index}. @{esc(row['username'] or row['display_name'])} · "
            f"{row['games']} games · {esc(money(row['wagered'], 'INR'))}"
            for index, row in enumerate(rows, start=1)
        )
        if not rows:
            lines.append("No completed games yet.")
        await self.reply(update, professional(*lines, icon="trophy"))

    async def refer(self, update: Update, _: ContextTypes.DEFAULT_TYPE) -> None:
        bot_url = os.environ.get("BOT_URL", "https://t.me/Rolex_C_BOT")
        link = f"{bot_url}?start=ref_{update.effective_user.id}"
        await self.reply(
            update,
            professional(
                "Your referral link",
                f"<code>{esc(link)}</code>",
                "Share this link with friends.",
                "Referral rewards are credited only after verified activity.",
                icon="users",
            ),
        )

    async def creategift(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not self.admin(update.effective_user.id):
            return
        if len(context.args) < 2:
            await self.reply(update, professional("Usage: /creategift AMOUNT CLAIMS [INR|USD]", icon="info"))
            return
        admin_player = await self.db.player(update.effective_user)
        amount, curr = self.parse_amount_input(
            f"{context.args[0]} {context.args[2] if len(context.args) > 2 else admin_player['preferred_currency']}",
            admin_player["preferred_currency"],
        )
        try:
            claims = int(context.args[1])
        except ValueError:
            claims = 0
        if not amount or claims < 1 or claims > 1000:
            await self.reply(update, professional("Gift amount or claim count is invalid.", icon="question"))
            return
        gift_code = f"GIFT-{secrets.token_hex(4).upper()}"
        created = await self.db.create_gift(admin_player["id"], gift_code, amount, curr, claims)
        if not created:
            await self.reply(update, professional("Could not create the gift code.", icon="cross"))
            return
        await self.reply(
            update,
            professional(
                f"{pe('gift')} Gift created",
                f"Code: <code>{gift_code}</code>",
                f"Value: {esc(money(amount, curr))} each",
                f"Claims: {claims}",
                "Players can redeem it with /claim CODE.",
                icon="gift",
            ),
        )

    async def claim(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not context.args:
            await self.reply(update, professional("Usage: /claim GIFT-CODE", icon="info"))
            return
        player = await self.db.player(update.effective_user)
        gift = await self.db.claim_gift(player["id"], context.args[0].strip())
        if not gift:
            await self.reply(update, professional("This gift code is invalid, full, or already claimed by you.", icon="cross"))
            return
        await self.reply(
            update,
            professional(
                f"{pe('gift')} Gift claimed!",
                f"Credited: {esc(money(gift['amount_minor'], gift['currency']))}",
                f"Claims remaining: {max(0, gift['max_claims'] - gift['claimed_count'])}",
                icon="gift",
            ),
        )

    async def broadcast(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not self.admin(update.effective_user.id):
            return
        text = " ".join(context.args).strip()
        if not text:
            await self.reply(update, professional("Usage: /broadcast MESSAGE", icon="info"))
            return
        async with self.db.require_pool().acquire() as conn:
            recipients = await conn.fetch(
                "SELECT telegram_user_id FROM casino_players WHERE telegram_user_id IS NOT NULL"
            )
        sent = 0
        for recipient in recipients:
            try:
                await self.send(
                    self.application.bot,
                    recipient["telegram_user_id"],
                    professional("Official announcement", text, icon="bell"),
                )
                sent += 1
            except Exception as exc:
                LOGGER.info("Broadcast skipped for %s: %s", recipient["telegram_user_id"], exc)
        await self.reply(update, professional(f"{pe('check')} Broadcast sent to {sent} players.", icon="bell"))

    async def announcement(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        await self.broadcast(update, context)

    async def maintenance(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not self.admin(update.effective_user.id):
            return
        mode = (context.args[0].lower() if context.args else "").strip()
        if mode not in {"on", "off", "status"}:
            await self.reply(update, professional("Usage: /maintenance on|off|status", icon="info"))
            return
        if mode != "status":
            await self.db.set_setting("maintenance", mode)
        current = await self.db.get_setting("maintenance", "off")
        await self.reply(
            update,
            professional(
                f"Maintenance mode: {'ON' if current == 'on' else 'OFF'}",
                "New games are blocked while maintenance is ON." if current == "on" else "Games are available.",
                icon="settings",
            ),
        )

    async def restart(self, update: Update, _: ContextTypes.DEFAULT_TYPE) -> None:
        if not self.admin(update.effective_user.id):
            return
        await self.reply(
            update,
            professional(
                "Restart requested.",
                "The bot process is restarting now.",
                icon="settings",
            ),
        )
        await asyncio.sleep(0.25)
        os.execv(sys.executable, [sys.executable, *sys.argv])

    async def ban(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not self.admin(update.effective_user.id) or not context.args:
            return
        target = await self.db.player_by_username(context.args[0])
        if not target:
            try:
                target = await self.db.player_by_id(int(context.args[0]))
            except ValueError:
                target = None
        if not target:
            await self.reply(update, professional("Player not found.", icon="cross"))
            return
        await self.db.set_ban(target["id"], " ".join(context.args[1:]) or "Administrative action")
        await self.reply(update, professional(f"{pe('lock')} Player #{target['id']} is banned.", icon="lock"))

    async def unban(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not self.admin(update.effective_user.id) or not context.args:
            return
        target = await self.db.player_by_username(context.args[0])
        if not target:
            try:
                target = await self.db.player_by_id(int(context.args[0]))
            except ValueError:
                target = None
        if not target:
            await self.reply(update, professional("Player not found.", icon="cross"))
            return
        removed = await self.db.remove_ban(target["id"])
        await self.reply(
            update,
            professional(
                f"{pe('check')} Player #{target['id']} {'unbanned' if removed else 'was not banned'}.",
                icon="check",
            ),
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
        if not await self.ensure_private(update, "setwallet"):
            return
        if not context.args:
            await self.reply(
                update,
                professional(
                    "Save your withdrawal wallet.",
                    "Choose UPI for INR or a crypto network for USD/USDT.",
                    icon="briefcase",
                ),
                reply_markup=self.wallet_setup_markup(update.effective_user.id),
            )
            return
        if len(context.args) < 2:
            await self.reply(update, professional("Usage: /setwallet UPI VALUE", icon="info"))
            return
        payout_type = context.args[0].upper()
        value = " ".join(context.args[1:]).strip()
        if payout_type not in {"UPI", "BTC", "BSC", "SOLANA", "ETHEREUM"} or not value or " " in value:
            await self.reply(update, professional("Use a valid payout type and one wallet value.", icon="question"))
            return
        await self.save_wallet_destination(update, payout_type, value)

    async def deposit(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not await self.ensure_private(update, "deposit"):
            return
        player = await self.db.player(update.effective_user)
        if not context.args:
            self.awaiting_deposit_amount[update.effective_user.id] = player["preferred_currency"]
            await self.reply(
                update,
                professional(
                    f"{pe('upload')} Deposit",
                    "How much do you want to deposit?",
                    "Minimum: ₹50 or $0.50.",
                    "Maximum: ₹5,000 or $50.",
                    "Reply with an amount, optionally followed by INR or USD.",
                    icon="upload",
                ),
            )
            return
        amount, curr = self.parse_amount_input(
            " ".join(context.args),
            player["preferred_currency"],
        )
        if amount is None:
            await self.reply(update, professional("Enter a valid deposit amount.", icon="question"))
            return
        if amount < MIN_DEPOSIT_MINOR[curr] or amount > MAX_DEPOSIT_MINOR[curr]:
            await self.reply(
                update,
                professional(
                    "Deposit amount is outside the allowed range.",
                    f"Minimum: {esc(money(MIN_DEPOSIT_MINOR[curr], curr))}",
                    f"Maximum: {esc(money(MAX_DEPOSIT_MINOR[curr], curr))}",
                    icon="info",
                ),
            )
            return
        await self.show_deposit_networks(update, amount, curr)

    async def withdraw(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not await self.ensure_private(update, "withdraw"):
            return
        player = await self.db.player(update.effective_user)
        if not context.args:
            self.awaiting_withdraw_amount[update.effective_user.id] = player["preferred_currency"]
            await self.reply(
                update,
                professional(
                    f"{pe('money')} Withdraw",
                    "Your current balance:",
                    await self.db.balance_text(player["id"], player["preferred_currency"]),
                    "Enter the amount to withdraw, optionally followed by INR or USD.",
                    f"Minimum: {esc(money(MIN_WITHDRAWAL_MINOR[player['preferred_currency']], player['preferred_currency']))}",
                    icon="money",
                ),
            )
            return
        amount, curr = self.parse_amount_input(
            " ".join(context.args),
            player["preferred_currency"],
        )
        if amount is None:
            await self.reply(update, professional("Enter a valid withdrawal amount.", icon="question"))
            return
        self.awaiting_withdraw_amount.pop(update.effective_user.id, None)
        await self.prepare_withdrawal(update, amount, curr)

    @staticmethod
    def proof_is_valid(network: str, value: str) -> bool:
        if network == "upi":
            return bool(re.fullmatch(r"\d{12}", value))
        return bool(re.fullmatch(r"[A-Za-z0-9._:-]{60,}", value))

    async def notify_deposit_review(
        self, intent: asyncpg.Record, player: asyncpg.Record
    ) -> None:
        reference = intent["utr"] or "Screenshot attached; UTR not provided"
        caption = professional(
            f"{pe('bell')} New deposit proof #{intent['id']}",
            f"Player: {esc(player['display_name'])} ({player['telegram_user_id']})",
            f"Amount: {esc(money(intent['amount_minor'], intent['currency']))}",
            f"Network: {esc(NETWORK_LABELS[intent['network']])}",
            f"UTR / transaction ID: <code>{esc(reference)}</code>",
            f"Order ID: #{intent['id']}",
            icon="upload",
        )
        markup = InlineKeyboardMarkup(
            [[
                InlineKeyboardButton(
                    "🟢 Approve",
                    callback_data=f"deposit_admin:approve:{intent['id']}",
                ),
                InlineKeyboardButton(
                    "🟢 Reject",
                    callback_data=f"deposit_admin:reject:{intent['id']}",
                ),
            ]]
        )
        for admin_id in ADMIN_USER_IDS:
            try:
                if intent["proof_file_id"] and intent["proof_type"] == "photo":
                    await self.application.bot.send_photo(
                        chat_id=admin_id,
                        photo=intent["proof_file_id"],
                        caption=caption,
                        parse_mode=ParseMode.HTML,
                        reply_markup=markup,
                    )
                else:
                    await self.send(
                        self.application.bot,
                        admin_id,
                        caption,
                        reply_markup=markup,
                    )
            except Exception as exc:
                LOGGER.warning(
                    "Could not send deposit review %s to admin %s: %s",
                    intent["id"],
                    admin_id,
                    exc,
                )

    async def submit_deposit_proof(
        self,
        update: Update,
        intent: asyncpg.Record,
        utr: Optional[str],
        proof_file_id: Optional[str] = None,
        proof_type: Optional[str] = None,
    ) -> None:
        submitted = await self.db.submit_payment_proof(
            intent["id"],
            intent["player_id"],
            utr,
            proof_file_id,
            proof_type,
        )
        user_id = update.effective_user.id
        self.awaiting_utr.pop(user_id, None)
        self.awaiting_deposit_utr.pop(user_id, None)
        self.awaiting_deposit_screenshot.pop(user_id, None)
        if not submitted:
            await self.reply(
                update,
                professional(
                    "This payment request is expired or already submitted.",
                    icon="cross",
                ),
            )
            return
        stored = await self.db.payment_intent(intent["id"])
        player = await self.db.player(update.effective_user)
        reference = utr or "Screenshot attached"
        await self.reply(
            update,
            professional(
                f"{pe('check')} Deposit proof submitted!",
                f"{pe('money')} Amount: {esc(money(intent['amount_minor'], intent['currency']))}",
                f"{pe('search')} UTR: <code>{esc(reference)}</code>",
                "",
                f"{pe('clock')} Deposit will be credited automatically. It may take 3-5 minutes.",
                f"Request: #{intent['id']}",
                icon="upload",
            ),
        )
        if stored:
            await self.notify_deposit_review(stored, player)

    async def handle_utr(
        self, update: Update, _: ContextTypes.DEFAULT_TYPE
    ) -> None:
        user_id = update.effective_user.id
        if user_id in self.awaiting_deposit_amount:
            player = await self.db.player(update.effective_user)
            amount, curr = self.parse_amount_input(
                (update.effective_message.text or "").strip(),
                self.awaiting_deposit_amount[user_id],
            )
            if amount is None:
                await self.reply(update, professional("Enter a valid deposit amount.", icon="question"))
                return
            if amount < MIN_DEPOSIT_MINOR[curr] or amount > MAX_DEPOSIT_MINOR[curr]:
                await self.reply(
                    update,
                    professional(
                        "Deposit amount is outside the allowed range.",
                        f"Minimum: {esc(money(MIN_DEPOSIT_MINOR[curr], curr))}",
                        f"Maximum: {esc(money(MAX_DEPOSIT_MINOR[curr], curr))}",
                        icon="info",
                    ),
                )
                return
            self.awaiting_deposit_amount.pop(user_id, None)
            await self.show_deposit_networks(update, amount, curr)
            return

        if user_id in self.awaiting_withdraw_amount:
            amount, curr = self.parse_amount_input(
                (update.effective_message.text or "").strip(),
                self.awaiting_withdraw_amount[user_id],
            )
            if amount is None:
                await self.reply(update, professional("Enter a valid withdrawal amount.", icon="question"))
                return
            self.awaiting_withdraw_amount.pop(user_id, None)
            await self.prepare_withdrawal(update, amount, curr)
            return

        if user_id in self.awaiting_wallet_setup:
            value = (update.effective_message.text or "").strip()
            payout_type = self.awaiting_wallet_setup[user_id]
            if not value or " " in value:
                await self.reply(
                    update,
                    professional("Send one valid wallet address or UPI ID without spaces.", icon="question"),
                )
                return
            await self.save_wallet_destination(update, payout_type, value)
            return

        intent_id = self.awaiting_deposit_utr.get(user_id) or self.awaiting_utr.get(user_id)
        if not intent_id:
            return
        value = (update.effective_message.text or "").strip()
        player = await self.db.player(update.effective_user)
        async with self.db.require_pool().acquire() as conn:
            intent = await conn.fetchrow(
                """
                SELECT * FROM casino_payment_intents
                WHERE id = $1 AND player_id = $2 AND status = 'awaiting-payment'
                """,
                intent_id,
                player["id"],
            )
        if not intent:
            self.awaiting_utr.pop(user_id, None)
            self.awaiting_deposit_utr.pop(user_id, None)
            self.awaiting_deposit_screenshot.pop(user_id, None)
            await self.reply(
                update,
                professional(
                    "That payment request is no longer available.",
                    icon="cross",
                ),
            )
            return
        network = intent["network"]
        if not self.proof_is_valid(network, value):
            requirement = (
                "UPI UTR must contain exactly 12 digits."
                if network == "upi"
                else "A crypto transaction ID must contain at least 60 letters, digits, or common symbols (., _, :, -)."
            )
            await self.reply(update, professional(requirement, icon="question"))
            return
        if user_id in self.awaiting_deposit_utr:
            saved = await self.db.save_deposit_utr(intent_id, intent["player_id"], value)
            if not saved:
                await self.reply(
                    update,
                    professional("This deposit request is expired or already submitted.", icon="cross"),
                )
                return
            self.awaiting_deposit_utr.pop(user_id, None)
            self.awaiting_deposit_screenshot[user_id] = intent_id
            await self.reply(
                update,
                professional(
                    f"{pe('check')} UTR saved: <code>{esc(value)}</code>",
                    "",
                    f"{pe('upload')} Step 2/2 — Payment Screenshot",
                    "Now send the screenshot of your payment.",
                    icon="upload",
                ),
            )
            return
        await self.submit_deposit_proof(update, intent, value, proof_type="text")

    async def handle_screenshot(
        self, update: Update, _: ContextTypes.DEFAULT_TYPE
    ) -> None:
        user_id = update.effective_user.id
        intent_id = self.awaiting_deposit_screenshot.get(user_id) or self.awaiting_utr.get(user_id)
        if not intent_id or not update.effective_message.photo:
            return
        player = await self.db.player(update.effective_user)
        async with self.db.require_pool().acquire() as conn:
            intent = await conn.fetchrow(
                """
                SELECT * FROM casino_payment_intents
                WHERE id = $1 AND player_id = $2 AND status = 'awaiting-payment'
                """,
                intent_id,
                player["id"],
            )
        if not intent:
            self.awaiting_utr.pop(user_id, None)
            await self.reply(
                update,
                professional(
                    "That payment request is no longer available.",
                    icon="cross",
                ),
            )
            return
        caption = (update.effective_message.caption or "").strip()
        utr = caption if self.proof_is_valid(intent["network"], caption) else intent["utr"]
        photo = update.effective_message.photo[-1]
        await self.submit_deposit_proof(
            update,
            intent,
            utr,
            proof_file_id=photo.file_id,
            proof_type="photo",
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
        elif parts[0] == "walletsetup":
            await self.walletsetup_callback(query, parts)
        elif parts[0] == "withdraw":
            await self.withdraw_callback(query, parts)
        elif parts[0] == "deposit":
            await self.deposit_callback(query, parts)
        elif parts[0] == "deposit_admin":
            await self.deposit_admin_callback(query, parts)
        elif parts[0] == "escrow":
            await self.escrow_callback(query, parts)
        elif parts[0] == "tip":
            await self.tip_callback(query, parts)
        elif parts[0] == "game" and len(parts) == 3:
            try:
                await self.game_callback(query, parts[1], int(parts[2]))
            except ValueError:
                await query.answer("This game button is invalid.", show_alert=True)

    async def walletsetup_callback(self, query, parts: list[str]) -> None:
        if len(parts) != 3:
            return
        try:
            owner_id = int(parts[1])
        except ValueError:
            await query.answer("This wallet setup button is invalid.", show_alert=True)
            return
        if query.from_user.id != owner_id:
            await query.answer("Only the player who opened this wallet setup can use it.", show_alert=True)
            return
        payout_type = parts[2].lower()
        if payout_type not in {"upi", "btc", "bsc", "solana", "ethereum"}:
            await query.answer("This wallet network is not supported.", show_alert=True)
            return
        self.awaiting_wallet_setup[owner_id] = payout_type.upper()
        label = "UPI ID" if payout_type == "upi" else f"{payout_type.upper()} address"
        await query.edit_message_text(
            professional(
                f"{pe('briefcase')} Save Your {esc(label)}",
                f"Enter your {esc(label)}:",
                "Send one value without spaces.",
                icon="briefcase",
            ),
            parse_mode=ParseMode.HTML,
        )

    async def withdraw_callback(self, query, parts: list[str]) -> None:
        if len(parts) != 3:
            return
        token = parts[2]
        pending = self.pending_withdrawals.get(token)
        if not pending or pending["telegram_user_id"] != query.from_user.id:
            await query.answer("Only the player who created this withdrawal can use it.", show_alert=True)
            return
        if parts[1] == "cancel":
            self.pending_withdrawals.pop(token, None)
            await query.edit_message_text(
                professional(
                    "Withdrawal cancelled.",
                    "No wallet balance was changed.",
                    icon="cross",
                ),
                parse_mode=ParseMode.HTML,
            )
            return
        if parts[1] != "confirm":
            await query.answer("This withdrawal action is invalid.", show_alert=True)
            return
        request_id = await self.db.create_withdrawal(
            pending["player_id"],
            pending["amount_minor"],
            pending["currency"],
            pending["payout_type"],
            pending["payout"],
        )
        if not request_id:
            self.pending_withdrawals.pop(token, None)
            await query.edit_message_text(
                professional(
                    "Withdrawal could not be submitted.",
                    "Check your available balance and wagering status.",
                    icon="cross",
                ),
                parse_mode=ParseMode.HTML,
            )
            return
        self.pending_withdrawals.pop(token, None)
        fee_minor = withdrawal_fee(pending["amount_minor"])
        receive_minor = pending["amount_minor"] - fee_minor
        await query.edit_message_text(
            professional(
                f"{pe('check')} Withdrawal #{request_id} submitted.",
                f"Amount: {esc(money(pending['amount_minor'], pending['currency']))}",
                f"Fee: {esc(money(fee_minor, pending['currency']))} · 4%",
                f"You'll receive: {esc(money(receive_minor, pending['currency']))}",
                f"Network: {esc(pending['payout_type'])}",
                f"To: <code>{esc(payout_mask(pending['payout']))}</code>",
                "Your withdrawal request is being processed.",
                icon="money",
            ),
            parse_mode=ParseMode.HTML,
        )
        await self.notify_admins(
            professional(
                f"{pe('bell')} New withdrawal request #{request_id}",
                f"Player ID: {pending['player_id']}",
                f"Requested: {esc(money(pending['amount_minor'], pending['currency']))}",
                f"Fee: {esc(money(fee_minor, pending['currency']))} · 4%",
                f"Payout: {esc(money(receive_minor, pending['currency']))}",
                f"Network: {esc(pending['payout_type'])}",
                f"Destination: <code>{esc(pending['payout'])}</code>",
                f"Approve: /approve_withdraw {request_id}",
                f"Reject: /reject_withdraw {request_id}",
                icon="money",
            )
        )

    async def send_deposit_result(
        self,
        intent: asyncpg.Record,
        approved: bool,
        balance_minor: Optional[int] = None,
    ) -> None:
        target = await self.db.player_by_id(intent["player_id"])
        if not target:
            return
        amount_text = money(intent["amount_minor"], intent["currency"])
        if approved:
            balance_text = money(
                balance_minor if balance_minor is not None else 0,
                intent["currency"],
            )
            message = professional(
                f"{pe('trophy')} Deposit Approved!",
                f"{pe('money')} Credited: {esc(amount_text)}",
                f"{pe('briefcase')} Balance: {esc(balance_text)}",
                "",
                f"{pe('lock')} Wager {esc(amount_text)} before withdrawing (1× deposit rule).",
                "Play any game to clear it — /wagerstatus to track.",
                icon="trophy",
            )
        else:
            message = professional(
                f"{pe('cross')} Deposit rejected.",
                f"Request: #{intent['id']}",
                f"Amount: {esc(amount_text)}",
                "Contact support with /support if you believe this is incorrect.",
                icon="cross",
            )
        try:
            await self.send(self.application.bot, target["telegram_user_id"], message)
        except Exception as exc:
            LOGGER.warning(
                "Could not notify player %s about deposit %s: %s",
                target["telegram_user_id"],
                intent["id"],
                exc,
            )

    async def deposit_admin_callback(
        self, query, parts: list[str]
    ) -> None:
        if len(parts) != 3 or not self.admin(query.from_user.id):
            await query.answer("This admin action is not available to you.", show_alert=True)
            return
        action = parts[1]
        try:
            intent_id = int(parts[2])
        except ValueError:
            await query.answer("This deposit action is invalid.", show_alert=True)
            return
        intent = await self.db.payment_intent(intent_id)
        if not intent or intent["status"] != "submitted":
            await query.answer(
                "This deposit is already processed or unavailable.",
                show_alert=True,
            )
            return
        if action == "approve":
            result = await self.db.approve_deposit(intent_id)
            approved = bool(result)
            balance_minor = result["balance_minor"] if result else None
        elif action == "reject":
            approved = False
            balance_minor = None
            result = await self.db.reject_deposit(intent_id)
        else:
            await query.answer("Unknown deposit action.", show_alert=True)
            return
        if not result:
            await query.answer(
                "This deposit could not be updated.",
                show_alert=True,
            )
            return
        await self.send_deposit_result(intent, approved, balance_minor)
        status_text = (
            f"{pe('check')} Deposit #{intent_id} approved."
            if approved
            else f"{pe('cross')} Deposit #{intent_id} rejected."
        )
        try:
            if query.message and query.message.photo:
                await query.edit_message_caption(
                    caption=professional(status_text, icon="settings"),
                    parse_mode=ParseMode.HTML,
                    reply_markup=None,
                )
            else:
                await query.edit_message_text(
                    professional(status_text, icon="settings"),
                    parse_mode=ParseMode.HTML,
                    reply_markup=None,
                )
        except Exception:
            pass

    async def deposit_callback(self, query, parts: list[str]) -> None:
        if len(parts) < 3:
            return
        user = query.from_user
        player = await self.db.player(user)
        action = parts[1]
        intent_id = int(parts[2])
        intent_record = await self.db.payment_intent(intent_id)
        if not intent_record or intent_record["player_id"] != player["id"]:
            await query.answer(
                "Only the player who created this deposit can use its buttons.",
                show_alert=True,
            )
            return
        if action == "help":
            await query.answer("Choose a network, pay the shown address, press I have paid, then submit your proof.", show_alert=True)
            return
        if action == "cancel":
            cancelled = await self.db.cancel_payment_intent(intent_id, player["id"])
            if not cancelled:
                await query.answer("This deposit request is already submitted, completed, or cancelled.", show_alert=True)
                return
            self.awaiting_utr.pop(user.id, None)
            self.awaiting_deposit_amount.pop(user.id, None)
            self.awaiting_deposit_utr.pop(user.id, None)
            self.awaiting_deposit_screenshot.pop(user.id, None)
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
            if intent_record["currency"] == "INR" and network != "upi":
                await query.answer("INR deposits use UPI. Choose UPI (INR).", show_alert=True)
                return
            if intent_record["currency"] == "USD" and network == "upi":
                await query.answer("USD deposits use a crypto network. Choose BTC, BSC, Solana, or Ethereum.", show_alert=True)
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
            self.awaiting_deposit_utr[user.id] = intent_id
            await query.message.reply_text(
                professional(
                    f"{pe('upload')} Step 1/2 — UTR Number",
                    f"Order ID: #{intent_id}",
                    f"Network: {esc(NETWORK_LABELS[intent['network']])}",
                    "Send your UTR or transaction ID as your next message.",
                    "UPI: exactly 12 digits. Crypto: at least 60 valid characters.",
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

    async def game_alias(
        self, update: Update, context: ContextTypes.DEFAULT_TYPE
    ) -> None:
        command = (update.effective_message.text or "").split()[0]
        command = command.split("@", 1)[0].lstrip("/").lower()
        aliases = {
            "dice": "dice",
            "darts": "darts",
            "bowling": "bowling",
            "basket": "basket",
            "football": "football",
            "slots": "slots",
            "coin": "coin",
            "dr": "dr",
            "7up": "7up",
        }
        await self.game(update, context, aliases.get(command, "dice"))

    async def game(
        self,
        update: Update,
        context: ContextTypes.DEFAULT_TYPE,
        game_type: str = "dice",
    ) -> None:
        """Create a confirmed PvB/PvP proposal for the selected game type."""
        player = await self.db.player(update.effective_user)
        if await self.db.is_banned(player["id"]):
            await self.reply(update, professional("Your account is restricted. Contact support for assistance.", icon="lock"))
            return
        if await self.db.get_setting("maintenance", "off") == "on" and not self.admin(update.effective_user.id):
            await self.reply(
                update,
                professional(
                    "Games are temporarily paused for maintenance.",
                    "Wallet deposits, withdrawals, and support remain available.",
                    icon="settings",
                ),
            )
            return
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
        if amount < MIN_GAME_STAKE[curr]:
            await self.reply(
                update,
                professional(
                    "Game stake is below the minimum.",
                    f"Minimum: {esc(money(MIN_GAME_STAKE[curr], curr))}",
                    icon="info",
                ),
            )
            return
        if amount > MAX_GAME_STAKE[curr]:
            await self.reply(
                update,
                professional(
                    "Game stake is above the per-game limit.",
                    f"Maximum: {esc(money(MAX_GAME_STAKE[curr], curr))}",
                    icon="lock",
                ),
            )
            return
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
            game_type,
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
                f"Versus: RolexCasino bot · {esc(game_type.upper())}",
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
        original_intent = (
            await self.db.payment_intent(request_id)
            if action in {"/approve_deposit", "/reject_deposit"}
            else None
        )
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
            intent = original_intent or await self.db.payment_intent(request_id)
            if intent:
                target_id = intent["player_id"]
                amount_text = money(intent["amount_minor"], intent["currency"])
        else:
            request = await self.db.cash_request(request_id)
            if request:
                target_id = request["player_id"]
                refund_minor = request["amount_minor"] + request["fee_minor"]
                amount_text = money(refund_minor, request["currency"])
        await self.reply(
            update,
            professional(
                f"{pe('check') if result else pe('cross')} Admin action {'completed' if result else 'could not be completed'}.",
                f"Request: #{request_id}",
                icon="settings",
            ),
        )
        if result and target_id:
            if action in {"/approve_deposit", "/reject_deposit"} and intent:
                balance_minor = (
                    result["balance_minor"]
                    if action == "/approve_deposit" and isinstance(result, asyncpg.Record)
                    else None
                )
                await self.send_deposit_result(
                    intent,
                    action == "/approve_deposit",
                    balance_minor,
                )
                return
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


HELPER_BOT_CONFIG = (
    ("TELEGRAM_HELPER_BOT_1_TOKEN", "slots-helper", ("slots",)),
    ("TELEGRAM_HELPER_BOT_2_TOKEN", "dice-helper", ("dice", "bowling", "basket", "football")),
    ("TELEGRAM_HELPER_BOT_3_TOKEN", "darts-helper", ("darts",)),
)


def build_application(
    token: Optional[str] = None,
    *,
    helper_name: Optional[str] = None,
    helper_commands: tuple[str, ...] = (),
) -> Application:
    token_value = token or TOKEN
    if not token_value:
        raise RuntimeError("TELEGRAM_BOT_TOKEN is required")
    bot_app = ApplicationBuilder().token(token_value).build()
    controller = RolexBot(bot_app)
    bot_app.post_init = controller.startup
    bot_app.post_shutdown = controller.shutdown

    if helper_name:
        bot_app.add_handler(
            CommandHandler(
                list(helper_commands),
                controller.game_alias,
            )
        )
        bot_app.add_handler(CallbackQueryHandler(controller.callback))
        LOGGER.info(
            "Configured helper bot %s for %s",
            helper_name,
            ", ".join(helper_commands),
        )
        return bot_app

    bot_app.add_handler(CommandHandler("start", controller.start))
    bot_app.add_handler(CommandHandler("help", controller.help))
    bot_app.add_handler(CommandHandler("games", controller.games))
    bot_app.add_handler(CommandHandler(["wallet", "balance", "bal", "wal"], controller.wallet))
    bot_app.add_handler(CommandHandler(["currency", "changecurrency"], controller.currency_command))
    bot_app.add_handler(CommandHandler("setwallet", controller.setwallet))
    bot_app.add_handler(CommandHandler("saveupi", controller.saveupi))
    bot_app.add_handler(CommandHandler("deposit", controller.deposit))
    bot_app.add_handler(CommandHandler("withdraw", controller.withdraw))
    bot_app.add_handler(CommandHandler("game", controller.game))
    bot_app.add_handler(
        CommandHandler(
            ["dice", "darts", "bowling", "basket", "football", "slots", "coin", "dr", "7up"],
            controller.game_alias,
        )
    )
    bot_app.add_handler(CommandHandler("wagerstatus", controller.wagerstatus))
    bot_app.add_handler(CommandHandler("rain", controller.rain))
    bot_app.add_handler(CommandHandler("balanceadd", controller.balanceadd))
    bot_app.add_handler(CommandHandler("balancededuct", controller.balancededuct))
    bot_app.add_handler(CommandHandler("users", controller.users))
    bot_app.add_handler(CommandHandler("user", controller.user_info))
    bot_app.add_handler(CommandHandler("hb", controller.house_balance))
    bot_app.add_handler(CommandHandler("botadd", controller.botadd))
    bot_app.add_handler(CommandHandler("pending", controller.pending))
    bot_app.add_handler(CommandHandler("admincommands", controller.admincommands))
    bot_app.add_handler(CommandHandler("mystats", controller.mystats))
    bot_app.add_handler(CommandHandler("rank", controller.rank))
    bot_app.add_handler(CommandHandler("refer", controller.refer))
    bot_app.add_handler(CommandHandler("creategift", controller.creategift))
    bot_app.add_handler(CommandHandler("claim", controller.claim))
    bot_app.add_handler(CommandHandler(["announcement", "broadcast"], controller.announcement))
    bot_app.add_handler(CommandHandler("maintenance", controller.maintenance))
    bot_app.add_handler(CommandHandler("restart", controller.restart))
    bot_app.add_handler(CommandHandler("ban", controller.ban))
    bot_app.add_handler(CommandHandler("unban", controller.unban))
    bot_app.add_handler(CommandHandler("support", controller.support))
    bot_app.add_handler(CommandHandler("escrow", controller.escrow))
    bot_app.add_handler(CommandHandler("tip", controller.tip))
    bot_app.add_handler(CommandHandler("approve_deposit", controller.admin_action))
    bot_app.add_handler(CommandHandler("reject_deposit", controller.admin_action))
    bot_app.add_handler(CommandHandler("approve_withdraw", controller.admin_action))
    bot_app.add_handler(CommandHandler("reject_withdraw", controller.admin_action))
    bot_app.add_handler(CallbackQueryHandler(controller.callback))
    bot_app.add_handler(MessageHandler(filters.PHOTO, controller.handle_screenshot))
    bot_app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, controller.handle_utr))
    return bot_app


async def run_all_applications(applications: list[tuple[str, Application]]) -> None:
    initialized: list[Application] = []
    try:
        for label, application in applications:
            await application.initialize()
            if application.post_init:
                await application.post_init(application)
            initialized.append(application)
            LOGGER.info("%s initialized", label)

        for label, application in applications:
            await application.start()
            if application.updater:
                await application.updater.start_polling(allowed_updates=Update.ALL_TYPES)
            LOGGER.info("%s polling started", label)

        await asyncio.Event().wait()
    finally:
        for _, application in reversed(applications):
            if application.updater and application.updater.running:
                await application.updater.stop()
            if application.running:
                await application.stop()
            if application in initialized:
                if application.post_shutdown:
                    await application.post_shutdown(application)
                await application.shutdown()


def main() -> None:
    if not TOKEN:
        raise RuntimeError("TELEGRAM_BOT_TOKEN is required")

    applications: list[tuple[str, Application]] = [
        ("main-bot", build_application(TOKEN)),
    ]
    for environment_key, helper_name, helper_commands in HELPER_BOT_CONFIG:
        helper_token = os.environ.get(environment_key)
        if not helper_token:
            LOGGER.warning(
                "%s is not configured; %s will not start",
                environment_key,
                helper_name,
            )
            continue
        applications.append(
            (
                helper_name,
                build_application(
                    helper_token,
                    helper_name=helper_name,
                    helper_commands=helper_commands,
                ),
            )
        )

    LOGGER.info(
        "Starting standalone RolexCasino Python bundle: %s",
        ", ".join(label for label, _ in applications),
    )
    asyncio.run(run_all_applications(applications))


if __name__ == "__main__":
    main()