import assert from "node:assert/strict";
import test from "node:test";
import {
  ADMIN_RESTRICTED_MESSAGE,
  USER_INSPECTION_COMMANDS,
  formatAdminUserBalance,
  formatAdminUserStats,
  isAdminUser,
  normalizeUsername,
  parseAdminTarget,
  selectUniqueUsernameMatch,
} from "./rolex-casino-admin.ts";

test("all private inspection commands remain identified as admin-only", () => {
  for (const command of [
    "userstats",
    "checkstats",
    "userbalance",
    "checkbalance",
    "userinfo",
    "userdetails",
    "checkuser",
  ]) {
    assert.equal(USER_INSPECTION_COMMANDS.has(command), true);
  }
  assert.equal(ADMIN_RESTRICTED_MESSAGE.includes("administrators"), true);
});

test("only configured administrator IDs pass the admin check", () => {
  assert.equal(isAdminUser(123, "123,456"), true);
  assert.equal(isAdminUser(456, "123,456"), true);
  assert.equal(isAdminUser(789, "123,456"), false);
  assert.equal(isAdminUser(123, "123abc, 456"), false);
});

test("admin targets support replies, Telegram IDs, and usernames", () => {
  assert.deepEqual(parseAdminTarget({ replyFromId: 777, args: [] }), {
    kind: "reply",
    telegramUserId: 777,
  });
  assert.deepEqual(parseAdminTarget({ args: ["777"] }), {
    kind: "telegram_id",
    telegramUserId: 777,
  });
  assert.deepEqual(parseAdminTarget({ args: ["@CaseSensitive_Name"] }), {
    kind: "username",
    username: "casesensitive_name",
  });
  assert.equal(parseAdminTarget({ args: [] }), undefined);
  assert.equal(parseAdminTarget({ args: ["@"] }), undefined);
});

test("username matching is normalized and refuses ambiguous records", () => {
  assert.equal(normalizeUsername(" @CaseSensitive_Name "), "casesensitive_name");

  const player = { id: 1 };
  assert.equal(selectUniqueUsernameMatch([player]), player);
  assert.equal(selectUniqueUsernameMatch([]), undefined);
  assert.equal(
    selectUniqueUsernameMatch([player, { id: 2 }]),
    undefined,
  );
});

test("admin stats report completed games and battles without another player's rows", () => {
  const message = formatAdminUserStats(
    { displayName: "Target <User>", telegramUserId: 777 },
    {
      category: "NORMAL",
      wagerInrMinor: 1_200,
      currencies: [
        {
          currency: "INR",
          rounds: 3,
          wins: 2,
          wagerMinor: 1_000,
          profitMinor: 200,
        },
        {
          currency: "USD",
          rounds: 1,
          wins: 1,
          wagerMinor: 200,
          profitMinor: 100,
        },
      ],
    },
  );

  assert.match(message, /User: Target &lt;User&gt;/);
  assert.match(message, /Telegram ID: 777/);
  assert.match(message, /INR: 3 rounds · 2 wins/);
  assert.match(message, /USD: 1 rounds · 1 wins/);
  assert.doesNotMatch(message, /another|private/i);
});

test("admin balance report includes both currency wallets and sandbox status", () => {
  const message = formatAdminUserBalance(
    {
      displayName: "Target",
      telegramUserId: 777,
      payoutWallet: "UPI-PRIVATE-VALUE",
    },
    [
      { currency: "INR", balanceMinor: 12_345 },
      { currency: "USD", balanceMinor: 678 },
    ],
  );

  assert.match(message, /INR balance: ₹123\.45/);
  assert.match(message, /USD balance: \$6\.78/);
  assert.match(message, /Sandbox wallet: INR and USD balances shown above/);
  assert.match(message, /Cash movement: SANDBOX simulation only/);
  assert.doesNotMatch(message, /UPI-PRIVATE-VALUE/);
});