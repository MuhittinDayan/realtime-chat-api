import { describe, expect, it } from "vitest";

import { createDirectConversationKey } from "./direct-key.js";

const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";

describe("direct conversation key", () => {
  it("normalizes and sorts both UUIDs deterministically", () => {
    const expected = `${FIRST}:${SECOND.toLowerCase()}`;

    expect(createDirectConversationKey(SECOND, FIRST)).toBe(expected);
    expect(createDirectConversationKey(FIRST, SECOND)).toBe(expected);
  });
});
