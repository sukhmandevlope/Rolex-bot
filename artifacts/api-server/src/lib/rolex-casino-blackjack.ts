export type BlackjackSuit = "♠" | "♥" | "♦" | "♣";
export type BlackjackRank =
  | "A"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "10"
  | "J"
  | "Q"
  | "K";

export type BlackjackCard = {
  rank: BlackjackRank;
  suit: BlackjackSuit;
};

export type BlackjackStatus =
  | "active"
  | "won"
  | "lost"
  | "push"
  | "player_blackjack";

export type BlackjackGame = {
  playerCards: BlackjackCard[];
  dealerCards: BlackjackCard[];
  deck: BlackjackCard[];
  status: BlackjackStatus;
};

const suits: BlackjackSuit[] = ["♠", "♥", "♦", "♣"];
const ranks: BlackjackRank[] = [
  "A",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K",
];

function makeDeck(): BlackjackCard[] {
  return suits.flatMap((suit) => ranks.map((rank) => ({ rank, suit })));
}

export function blackjackCardLabel(card: BlackjackCard): string {
  return `${card.rank}${card.suit}`;
}

export function blackjackHandValue(cards: BlackjackCard[]): number {
  let value = 0;
  let aces = 0;
  for (const card of cards) {
    if (card.rank === "A") {
      value += 11;
      aces += 1;
    } else if (["K", "Q", "J"].includes(card.rank)) {
      value += 10;
    } else {
      value += Number(card.rank);
    }
  }
  while (value > 21 && aces > 0) {
    value -= 10;
    aces -= 1;
  }
  return value;
}

export function createBlackjackGame(random = Math.random): BlackjackGame {
  const deck = makeDeck();
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [deck[index], deck[swapIndex]] = [deck[swapIndex], deck[index]];
  }
  const playerCards = [deck.pop() as BlackjackCard, deck.pop() as BlackjackCard];
  const dealerCards = [deck.pop() as BlackjackCard, deck.pop() as BlackjackCard];
  const playerValue = blackjackHandValue(playerCards);
  const dealerValue = blackjackHandValue(dealerCards);
  const status: BlackjackStatus =
    playerValue === 21 && dealerValue === 21
      ? "push"
      : playerValue === 21
        ? "player_blackjack"
        : dealerValue === 21
          ? "lost"
          : "active";
  return { playerCards, dealerCards, deck, status };
}

export function blackjackHit(game: BlackjackGame): BlackjackGame {
  if (game.status !== "active") return game;
  const card = game.deck.pop();
  if (!card) return blackjackStand(game);
  game.playerCards.push(card);
  if (blackjackHandValue(game.playerCards) > 21) game.status = "lost";
  return game;
}

export function blackjackStand(game: BlackjackGame): BlackjackGame {
  if (game.status !== "active") return game;
  while (
    blackjackHandValue(game.dealerCards) < 17 &&
    game.deck.length > 0
  ) {
    game.dealerCards.push(game.deck.pop() as BlackjackCard);
  }
  const playerValue = blackjackHandValue(game.playerCards);
  const dealerValue = blackjackHandValue(game.dealerCards);
  if (playerValue > 21) game.status = "lost";
  else if (dealerValue > 21 || playerValue > dealerValue) game.status = "won";
  else if (playerValue < dealerValue) game.status = "lost";
  else game.status = "push";
  return game;
}

export function blackjackMultiplier(status: BlackjackStatus): number {
  if (status === "won" || status === "player_blackjack") return 1.92;
  if (status === "push") return 1;
  return 0;
}