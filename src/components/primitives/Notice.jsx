import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';

/**
 * A sentence the page needs you to read before you act on what is under it.
 *
 * One recipe, four valences — the recipe itself lives in `index.css` as
 * `.notice` + `.notice-*` (a measured tint + foreground pair, the same
 * category `.status-pill-*` belongs to), so a band built by hand and a band
 * built here cannot drift apart.
 *
 * WHY A COMPONENT AND NOT JUST THE CLASSES. Two things a call site kept
 * getting wrong on its own, both invisible until they matter:
 *
 *   • **the icon**. §6: meaning never rides on hue alone. Roughly 8% of men
 *     cannot separate the amber band from the red one, and a sunlit showroom
 *     tablet drops the distinction for everybody. The icon is the second cue
 *     and it is not optional, so the component picks it from the tone rather
 *     than trusting each site to remember one.
 *   • **the role**. `danger` is `role="alert"` — a screen reader interrupts
 *     for it — and the other three are `role="status"`, which waits its turn.
 *     Of the 126 hand-built bands, most carried no role at all and a few
 *     carried `alert` for a success message.
 *
 * ```jsx
 * <Notice tone="warn">Solo se pudo leer parte del catálogo.</Notice>
 * <Notice tone="danger">{err}</Notice>
 * <Notice tone="info" icon={History} action={<button className="btn-ghost">Descartar</button>}>
 *   Borrador restaurado.
 * </Notice>
 * <Notice tone="warn" dense>Falta el RNC para el 606.</Notice>
 * ```
 *
 * `icon` overrides the default when a more specific glyph says more than the
 * valence does (a `WifiOff` for a lost connection, a `History` for a restored
 * draft). Pass `icon={null}` for a band that is pure text — legal, because a
 * band with no icon is still distinguishable by its border and its copy; what
 * is illegal is a band whose ONLY difference from its neighbour is hue.
 */
const TONES = {
  info:    { cls: 'notice-info',    Icon: Info,          role: 'status' },
  success: { cls: 'notice-success', Icon: CheckCircle2,  role: 'status' },
  warn:    { cls: 'notice-warn',    Icon: AlertTriangle, role: 'status' },
  danger:  { cls: 'notice-danger',  Icon: XCircle,       role: 'alert' },
};

export default function Notice({
  // `icon = undefined` is a no-op at runtime and deliberate in the signature:
  // it is what tells a `.tsx` call site the prop is OPTIONAL. Bare `icon` reads
  // as required to TS (`checkJs:false` still infers this file's props), so the
  // first typed caller had to pass `icon={undefined}` to say "use the tone's
  // glyph" — which is the default this component has always documented.
  tone = 'info', icon = undefined, action = null, dense = false, className = '', children, ...rest
}) {
  const { cls, Icon: Default, role } = TONES[tone] || TONES.info;
  // `undefined` means "use the tone's glyph"; an explicit `null` means none.
  const Icon = icon === undefined ? Default : icon;
  const size = dense ? 13 : 15;
  return (
    <div role={role} className={`notice ${dense ? 'notice-sm' : ''} ${cls} ${className}`} {...rest}>
      {Icon && <Icon size={size} className="shrink-0 mt-px" aria-hidden />}
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  );
}
