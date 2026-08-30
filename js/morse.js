const MORSE_ALPHABET = {
  A: ".-",
  B: "-...",
  C: "-.-.",
  D: "-..",
  E: ".",
  F: "..-.",
  G: "--.",
  H: "....",
  I: "..",
  J: ".---",
  K: "-.-",
  L: ".-..",
  M: "--",
  N: "-.",
  O: "---",
  P: ".--.",
  Q: "--.-",
  R: ".-.",
  S: "...",
  T: "-",
  U: "..-",
  V: "...-",
  W: ".--",
  X: "-..-",
  Y: "-.--",
  Z: "--..",
  "0": "-----",
  "1": ".----",
  "2": "..---",
  "3": "...--",
  "4": "....-",
  "5": ".....",
  "6": "-....",
  "7": "--...",
  "8": "---..",
  "9": "----.",
  ".": ".-.-.-",
  ",": "--..--",
  "?": "..--..",
  "'": ".----.",
  "!": "-.-.--",
  "/": "-..-.",
  "(": "-.--.",
  ")": "-.--.-",
  "&": ".-...",
  ":": "---...",
  ";": "-.-.-.",
  "=": "-...-",
  "+": ".-.-.",
  "-": "-....-",
  "_": "..--.-",
  '"': ".-..-.",
  "$": "...-..-",
  "@": ".--.-."
};

const MORSE_REVERSE = Object.fromEntries(
  Object.entries(MORSE_ALPHABET).map(([symbol, code]) => [code, symbol])
);

function normalizeMorse(raw) {
  return String(raw == null ? "" : raw)
    .replace(/[_\u2013\u2014\u2212]/g, "-")
    .replace(/[\u00B7\u2022*]/g, ".")
    .replace(/[^.\-\s/]/g, "")
    .replace(/^\s+/, "")
    .replace(/\s+/g, (m) => (m.length > 1 ? " / " : " "));
}

function decodeMorse(raw) {
  const clean = normalizeMorse(raw);
  if (!clean) return "";
  return clean
    .split(" ")
    .filter(Boolean)
    .map((token) => (token === "/" ? " " : MORSE_REVERSE[token] || "?"))
    .join("")
    .replace(/ {2,}/g, " ")
    .trim();
}

function encodeMorse(text) {
  return String(text == null ? "" : text)
    .toUpperCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) =>
      word
        .split("")
        .map((ch) => MORSE_ALPHABET[ch])
        .filter(Boolean)
        .join(" ")
    )
    .filter(Boolean)
    .join(" / ");
}
