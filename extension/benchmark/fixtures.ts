/**
 * fixtures.ts — Labeled test cases for the DOM/regex/autocomplete PII
 * detection benchmark.
 *
 * Each fixture simulates one realistic page's DOM scan (the same shape
 * background.ts's scanner produces) with a hand-labeled ground truth: which
 * elements SHOULD be flagged as PII, which SHOULD be flagged as a
 * face/photo image, and which should NOT be flagged at all (true
 * negatives — without these, recall would look artificially perfect since
 * nothing would ever penalize over-flagging).
 *
 * Two fixtures are deliberately adversarial (see `note`) — cases we expect
 * the current implementation to get wrong. Keeping them in is the point:
 * a benchmark that only contains cases the code already handles isn't
 * measuring anything.
 */

import { DomElement } from "../src/types/contracts";

let y = 0;
function nextY(): number {
  const current = y;
  y += 60;
  return current;
}

function el(partial: Partial<DomElement> & { id: string; tag: string }): DomElement {
  return {
    tag: partial.tag,
    id: partial.id,
    name: partial.name,
    selector: `#${partial.id}`,
    role: partial.role,
    type: partial.type,
    autocomplete: partial.autocomplete,
    text: partial.text,
    boundingBox: partial.boundingBox ?? { x: 100, y: nextY(), width: 300, height: 40 },
  };
}

export interface Fixture {
  name: string;
  category: string;
  elements: DomElement[];
  /** ids of elements that SHOULD be flagged as PII by extractPIIRegionsFromDOM */
  piiPositiveIds: string[];
  /** ids of <img> elements that SHOULD be flagged by extractImageRegionsFromDOM */
  imagePositiveIds: string[];
  note?: string;
}

export const fixtures: Fixture[] = [
  {
    name: "Basic signup form",
    category: "password",
    elements: [
      el({ id: "name", tag: "input", type: "text", text: "Enter your name" }),
      el({ id: "email", tag: "input", type: "email", text: "you@example.com" }),
      el({ id: "phone", tag: "input", type: "tel", text: "+91 98765 43210" }),
      el({ id: "password", tag: "input", type: "password" }),
      el({ id: "confirmPassword", tag: "input", type: "password" }),
      el({ id: "submit", tag: "button", type: "submit", text: "Create Account" }),
    ],
    piiPositiveIds: ["email", "phone", "password", "confirmPassword"],
    imagePositiveIds: [],
  },
  {
    name: "Login form only",
    category: "password",
    elements: [
      el({ id: "loginEmail", tag: "input", type: "email", text: "you@example.com" }),
      el({ id: "loginPassword", tag: "input", type: "password" }),
    ],
    piiPositiveIds: ["loginEmail", "loginPassword"],
    imagePositiveIds: [],
  },
  {
    name: "Checkout — card details",
    category: "card",
    elements: [
      el({ id: "cardNumber", tag: "input", autocomplete: "cc-number", text: "1234 5678 9012 3456" }),
      el({ id: "cardCsc", tag: "input", autocomplete: "cc-csc" }),
      el({ id: "cardExp", tag: "input", autocomplete: "cc-exp" }),
      el({ id: "cardName", tag: "input", autocomplete: "cc-name", text: "Name on card" }),
      el({ id: "billingEmail", tag: "input", type: "email", text: "billing@example.com" }),
    ],
    piiPositiveIds: ["cardNumber", "cardCsc", "cardExp", "cardName", "billingEmail"],
    imagePositiveIds: [],
    note: "cardName (autocomplete=cc-name) is deliberately treated as PII — a cardholder's name tied to a payment form is worth protecting alongside the card number itself.",
  },
  {
    name: "Government KYC form — Aadhaar",
    category: "aadhaar",
    elements: [
      el({ id: "fullName", tag: "input", type: "text", text: "Full legal name" }),
      el({ id: "aadhaarNumber", tag: "input", type: "text", text: "2345 6789 0124" }),
    ],
    piiPositiveIds: ["aadhaarNumber"],
    imagePositiveIds: [],
    note: "2345 6789 0124 is a Verhoeff-checksum-valid test number (real Aadhaar numbers always are) — see benchmark/README.md.",
  },
  {
    name: "Tax form — PAN",
    category: "pan",
    elements: [
      el({ id: "panField", tag: "input", type: "text", text: "ABCDE1234F" }),
      el({ id: "taxYear", tag: "input", type: "text", text: "2025-26" }),
    ],
    piiPositiveIds: ["panField"],
    imagePositiveIds: [],
  },
  {
    name: "Profile page with avatar",
    category: "image",
    elements: [
      el({ id: "avatarImg", tag: "img", text: "User profile photo" }),
      el({ id: "username", tag: "input", type: "text", text: "Choose a username" }),
      el({ id: "bio", tag: "textarea", text: "Tell us about yourself" }),
    ],
    piiPositiveIds: [],
    imagePositiveIds: ["avatarImg"],
  },
  {
    name: "Contact form",
    category: "phone",
    elements: [
      el({ id: "contactName", tag: "input", type: "text", text: "Your name" }),
      el({ id: "contactEmail", tag: "input", type: "email", text: "you@example.com" }),
      el({ id: "contactPhone", tag: "input", type: "tel", text: "555-123-4567" }),
      el({ id: "contactMessage", tag: "textarea", text: "How can we help?" }),
    ],
    piiPositiveIds: ["contactEmail", "contactPhone"],
    imagePositiveIds: [],
  },
  {
    name: "Search box only",
    category: "true-negative",
    elements: [
      el({ id: "searchBox", tag: "input", type: "text", text: "Search products…" }),
    ],
    piiPositiveIds: [],
    imagePositiveIds: [],
  },
  {
    name: "Product page — quantity and SKU",
    category: "true-negative",
    elements: [
      el({ id: "quantity", tag: "input", type: "number", text: "1" }),
      el({ id: "skuCode", tag: "input", type: "text", text: "SKU-88213" }),
      el({ id: "productPrice", tag: "input", type: "text", text: "$49.99" }),
    ],
    piiPositiveIds: [],
    imagePositiveIds: [],
    note: "Tests that generic numeric/alphanumeric fields (quantity, SKU) don't trigger card/phone/Aadhaar false positives.",
  },
  {
    name: "Newsletter signup",
    category: "email",
    elements: [
      el({ id: "newsletterEmail", tag: "input", type: "email", text: "Subscribe with your email" }),
    ],
    piiPositiveIds: ["newsletterEmail"],
    imagePositiveIds: [],
  },
  {
    name: "OTP verification",
    category: "otp",
    elements: [
      el({ id: "otpCode", tag: "input", autocomplete: "one-time-code", text: "Enter the 6-digit code" }),
    ],
    piiPositiveIds: ["otpCode"],
    imagePositiveIds: [],
  },
  {
    name: "Date of birth form",
    category: "bday",
    elements: [
      el({ id: "dobDay", tag: "input", autocomplete: "bday-day", text: "DD" }),
      el({ id: "dobMonth", tag: "input", autocomplete: "bday-month", text: "MM" }),
      el({ id: "dobYear", tag: "input", autocomplete: "bday-year", text: "YYYY" }),
    ],
    piiPositiveIds: ["dobDay", "dobMonth", "dobYear"],
    imagePositiveIds: [],
  },
  {
    name: "Job application form",
    category: "phone",
    elements: [
      el({ id: "applicantName", tag: "input", type: "text", text: "Full name" }),
      el({ id: "applicantEmail", tag: "input", type: "email", text: "you@example.com" }),
      el({ id: "applicantPhone", tag: "input", type: "tel", text: "+91 98765 43210" }),
      el({ id: "portfolioUrl", tag: "input", type: "url", text: "https://your-portfolio.com" }),
      el({ id: "resumeUpload", tag: "input", type: "file" }),
    ],
    piiPositiveIds: ["applicantEmail", "applicantPhone"],
    imagePositiveIds: [],
    note: "portfolioUrl and resumeUpload are true negatives — a URL or file-picker isn't itself sensitive text.",
  },
  {
    name: "Hotel booking — guest + payment",
    category: "card",
    elements: [
      el({ id: "guestName", tag: "input", type: "text", text: "Guest name" }),
      el({ id: "guestEmail", tag: "input", type: "email", text: "you@example.com" }),
      el({ id: "bookingCard", tag: "input", autocomplete: "cc-number" }),
      el({ id: "specialRequests", tag: "textarea", text: "Any special requests?" }),
    ],
    piiPositiveIds: ["guestEmail", "bookingCard"],
    imagePositiveIds: [],
  },
  {
    name: "Social media post composer",
    category: "true-negative",
    elements: [
      el({ id: "postContent", tag: "textarea", text: "What's on your mind?" }),
    ],
    piiPositiveIds: [],
    imagePositiveIds: [],
  },
  {
    name: "Forum reply",
    category: "true-negative",
    elements: [
      el({ id: "forumUsername", tag: "input", type: "text", text: "Display name" }),
      el({ id: "forumReply", tag: "textarea", text: "Write a reply…" }),
    ],
    piiPositiveIds: [],
    imagePositiveIds: [],
  },
  {
    name: "Medical intake form",
    category: "phone",
    elements: [
      el({ id: "patientName", tag: "input", type: "text", text: "Patient name" }),
      el({ id: "patientDob", tag: "input", autocomplete: "bday", text: "Date of birth" }),
      el({ id: "patientPhone", tag: "input", type: "tel", text: "555-987-6543" }),
      el({ id: "patientEmail", tag: "input", type: "email", text: "patient@example.com" }),
      el({ id: "visitReason", tag: "textarea", text: "Reason for visit" }),
    ],
    piiPositiveIds: ["patientDob", "patientPhone", "patientEmail"],
    imagePositiveIds: [],
  },
  {
    name: "Shipping address only",
    category: "address",
    elements: [
      el({ id: "streetAddress", tag: "input", autocomplete: "street-address", text: "123 Main St" }),
      el({ id: "postalCode", tag: "input", autocomplete: "postal-code", text: "560001" }),
      el({ id: "city", tag: "input", type: "text", text: "City" }),
    ],
    piiPositiveIds: ["streetAddress", "postalCode"],
    imagePositiveIds: [],
    note: "city is a true negative — a bare city name field carries far less identifying weight than street/postal code.",
  },
  {
    name: "Settings page — avatar + email together",
    category: "image",
    elements: [
      el({ id: "settingsAvatar", tag: "img", text: "Change profile picture" }),
      el({ id: "settingsEmail", tag: "input", type: "email", text: "you@example.com" }),
      el({ id: "settingsDisplayName", tag: "input", type: "text", text: "Display name" }),
    ],
    piiPositiveIds: ["settingsEmail"],
    imagePositiveIds: ["settingsAvatar"],
  },
  {
    name: "Phone number embedded in visible text",
    category: "phone",
    elements: [
      el({ id: "contactParagraph", tag: "label", text: "Contact us at 555-123-4567 for support" }),
    ],
    piiPositiveIds: ["contactParagraph"],
    imagePositiveIds: [],
    note: "Tests the text-pattern fallback on non-input elements, not just input type/autocomplete.",
  },
  {
    name: "Order reference number (card-regex false-positive risk)",
    category: "true-negative",
    elements: [
      el({ id: "orderRef", tag: "input", type: "text", text: "Order # 1234 5678 9012 3456" }),
    ],
    piiPositiveIds: [],
    imagePositiveIds: [],
    note: "ADVERSARIAL: a 16-digit grouped reference number that isn't actually a card, and correctly fails a Luhn checksum (unlike a real card number would).",
  },
  {
    name: "International phone format",
    category: "phone",
    elements: [
      el({ id: "intlPhone", tag: "input", type: "tel", text: "+44 20 7946 0958" }),
    ],
    piiPositiveIds: ["intlPhone"],
    imagePositiveIds: [],
    note: "ADVERSARIAL: type=tel still catches this (type-based signal doesn't care about format), but if type were missing this UK-format number would likely miss the US-style phone regex. Kept as a reminder of format coverage limits.",
  },
  {
    name: "Company / employer field",
    category: "true-negative",
    elements: [
      el({ id: "employerName", tag: "input", type: "text", text: "Current employer" }),
      el({ id: "jobTitle", tag: "input", type: "text", text: "Job title" }),
    ],
    piiPositiveIds: [],
    imagePositiveIds: [],
  },
  {
    name: "Credit + debit card together",
    category: "card",
    elements: [
      el({ id: "primaryCard", tag: "input", autocomplete: "cc-number" }),
      el({ id: "primaryCsc", tag: "input", autocomplete: "cc-csc" }),
    ],
    piiPositiveIds: ["primaryCard", "primaryCsc"],
    imagePositiveIds: [],
  },
  {
    name: "Decorative / icon image (non-photo)",
    category: "true-negative",
    elements: [
      el({ id: "logoImg", tag: "img", text: "Company logo" }),
    ],
    piiPositiveIds: [],
    imagePositiveIds: [],
    note: "Tests that non-face images (a logo) don't get swept up by the alt-text keyword fallback.",
  },
];
