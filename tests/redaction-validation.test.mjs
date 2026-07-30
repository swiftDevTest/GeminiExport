import test from "node:test";
import assert from "node:assert/strict";

await import("../src/modules/redaction.js");

const redactText = globalThis.CHATVAULT_REDACTION._test.redactText;

function redact(value) {
  const summary = { enabled: true, totalMatches: 0, byType: {} };
  return {
    value: redactText(value, {}, summary),
    summary
  };
}

test("credit-card redaction supports compact and non-16-digit card formats", () => {
  const visa = redact("Card: 4111111111111111");
  assert.equal(visa.value, "Card: [REDACTED: CREDIT_CARD]");
  assert.equal(visa.summary.byType.credit_card_like, 1);

  const amex = redact("Amex: 3782 822463 10005");
  assert.equal(amex.value, "Amex: [REDACTED: CREDIT_CARD]");
  assert.equal(amex.summary.byType.credit_card_like, 1);
});

test("credit-card redaction preserves timestamps and invalid numeric identifiers", () => {
  const timestamp = redact("Timestamp: 1712345678901");
  assert.equal(timestamp.value, "Timestamp: 1712345678901");
  assert.equal(timestamp.summary.totalMatches, 0);

  const invalidCard = redact("Order: 4111111111111112");
  assert.equal(invalidCard.value, "Order: 4111111111111112");
  assert.equal(invalidCard.summary.totalMatches, 0);
});

test("phone redaction supports international numbers without matching inside longer IDs", () => {
  const international = redact("Office: +49 30 901820");
  assert.equal(international.value, "Office: [REDACTED: PHONE]");
  assert.equal(international.summary.byType.phone, 1);

  const longIdentifier = redact("Reference: 99171234567890177");
  assert.equal(longIdentifier.value, "Reference: 99171234567890177");
  assert.equal(longIdentifier.summary.totalMatches, 0);
});
