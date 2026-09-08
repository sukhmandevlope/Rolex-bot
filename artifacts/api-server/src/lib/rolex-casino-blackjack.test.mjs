import assert from "node:assert/strict";
import test from "node:test";
import {
  blackjackHandValue,
  blackjackHit,
  blackjackMultiplier,
  blackjackStand,
  createBlackjackGame,
} from "./rolex-casino-blackjack.ts";

test("Blackjack deals a complete shuffled round with a 48-card remainder", () => {
  const game = createBlackjackGame(() => 0.42);
  assert.equal(game.playerCards.length, 2);
  assert.equal(game.dealerCards.length, 2);
  assert.equal(game.deck.length, 48);
  assert.equal(new Set(game.deck.map((card) => `${card.rank}${card.suit}`)).size, 48);
});

test("aces count as eleven when possible and one when needed", () => {
  assert.equal(blackjackHandValue([
    { rank: "A", suit: "♠" },
    { rank: "7", suit: "♥" },
  ]), 18);
  assert.equal(blackjackHandValue([
    { rank: "A", suit: "♠" },
    { rank: "K", suit: "♥" },
    { rank: "5", suit: "♦" },
  ]), 16);
});

test("a hit ends the round when the player busts", () => {
  const game = {
    playerCards: [
      { rank: "K", suit: "♠" },
      { rank: "9", suit: "♥" },
    ],
    dealerCards: [
      { rank: "8", suit: "♣" },
      { rank: "7", suit: "♦" },
    ],
    deck: [{ rank: "5", suit: "♠" }],
    status: "active",
  };
  blackjackHit(game);
  assert.equal(game.status, "lost");
  assert.equal(blackjackMultiplier(game.status), 0);
});

test("stand draws the dealer to seventeen and resolves a win", () => {
  const game = {
    playerCards: [
      { rank: "10", suit: "♠" },
      { rank: "9", suit: "♥" },
    ],
    dealerCards: [
      { rank: "6", suit: "♣" },
      { rank: "5", suit: "♦" },
    ],
    deck: [{ rank: "6", suit: "♠" }],
    status: "active",
  };
  blackjackStand(game);
  assert.equal(game.status, "won");
  assert.equal(blackjackMultiplier(game.status), 1.92);
  assert.equal(game.dealerCards.length, 3);
});