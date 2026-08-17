import { expect, test } from "bun:test";
import { SessionBudget } from "./budget.js";

test("session budget is a separate longer-window cap", () => {
  const budget = new SessionBudget(1, 1000);
  expect(budget.reserve("https://example.test", 1)).toBe(true);
  expect(budget.reserve("https://example.test", 2)).toBe(false);
});
