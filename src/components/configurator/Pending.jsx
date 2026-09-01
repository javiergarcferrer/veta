/**
 * THE ONE WAY THE ESTUDIO SAYS «TODAVÍA NO».
 *
 * The same fact — this link has not been made yet — was spelled four different
 * ways inside one screenful: a filled amber pill (SKU base), grey running text
 * beside a button (telas), a whole sentence (portada), and a hollow dot
 * (borrador). Four idioms for one state means a dealer cannot answer «what does
 * this piece still owe?» by scanning; they have to READ every card on the
 * screen and translate each one into the same word.
 *
 * So there is one mark, and it is deliberately small: a dot and the word.
 *
 *  • BOTH, because meaning never rides on hue alone (§6) — the word is the
 *    second cue, and it is the one that survives a colour-blind reader, a
 *    greyscale screenshot and a photocopy.
 *  • `status-warning-ink`, not the `status-warning` mark tone: this is TEXT and
 *    owes 4.5:1 (SC 1.4.3), where the mark tones are built to the 3:1 a dot
 *    owes (SC 1.4.11). The dot rides `bg-current` off the same ink, so it is
 *    darker than a mark needs to be and nothing is lost by it.
 *  • NOT a `<Notice>`. A tinted band is the recipe for a sentence you must read
 *    before you act (§5b); an empty field is not that. Spending the band on
 *    «unfinished» is what made a normal, expected, half-filled piece look
 *    broken — and left nothing louder for the pieces that really are.
 */
export default function Pending({ children }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-status-warning-ink">
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}
