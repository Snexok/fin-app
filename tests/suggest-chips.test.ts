import { describe, it, expect } from "vitest";
import { chipQuery, showStarterChips } from "../app/suggest-chips";

describe("starter suggestion chips: only while the chat is empty", () => {
  it("empty chat → chips shown", () => {
    expect(showStarterChips([])).toBe(true);
  });
  it("bot-only messages (greeting, reminders) still count as an empty chat", () => {
    expect(showStarterChips([{ me: false }, { me: false }])).toBe(true);
  });
  it("after the first user message (typed or a tapped chip) → row hidden", () => {
    expect(showStarterChips([{ me: true }])).toBe(false);
    expect(showStarterChips([{ me: true }, { me: false }])).toBe(false);
  });
  it("tapped chip text sent to the chat", () => {
    expect(chipQuery("Можно купить кофе за 300?")).toBe("Можно купить кофе за 300?");
    expect(chipQuery("Сколько можно тратить в день?")).toBe("Сколько можно тратить в день?");
    expect(chipQuery("Наушники за 15 000?")).toBe("Можно купить наушники за 15 000?");
  });
});
