import { useEffect, useState } from 'react';
import {
  Code2, Link2, Inbox, ExternalLink, QrCode, Check, Copy, Loader2, RefreshCw,
} from 'lucide-react';
import {
  togoEmbedSnippet, togoShareUrl, dealerInboxUrl, togoQrDataUrl,
} from '../../lib/togoEmbed.js';

/**
 * KIT DE INSTALACIÓN — everything Alcover hands a dealer the day they go live,
 * copy-ready and in one place:
 *
 *   • Código embed  — the self-sizing iframe snippet for their own website.
 *   • Enlace público — the shareable configurator URL (WhatsApp / social), with
 *                      "abrir vista previa" so you can SEE their widget as their
 *                      visitor does before sending it.
 *   • Enlace bandeja — their private, login-less lead inbox (the token IS the
 *                      authorization, so this one is not for social).
 *   • QR             — the public link as a code for print / showroom, encoded
 *                      through the same code-split `qrcode` path the desktop AR
 *                      handoff rides (lib/togoEmbed → togoQrDataUrl).
 *
 * All four are derived from just `slug` + `inboxToken`; nothing here writes.
 */

/** Copy-to-clipboard with a brief inline confirmation. */
function CopyButton({ value, label, icon: Icon = Copy, className = 'chip-action' }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard denied — the value is on screen to select by hand */ }
  };
  return (
    <button type="button" onClick={copy} className={className} title={value}>
      {copied ? <Check size={12} className="text-emerald-600" /> : <Icon size={12} />}
      {copied ? 'Copiado' : label}
    </button>
  );
}

/** One kit row: what it is, the value, and its actions. */
function KitRow({ icon: Icon, title, blurb, value, mono = true, children }) {
  return (
    <div className="px-4 py-3 space-y-2">
      <div className="flex items-start gap-2.5">
        <Icon size={14} className="text-ink-400 mt-0.5 shrink-0" />
        <div className="min-w-0">
          <h4 className="text-[12px] font-semibold text-ink-800 leading-tight">{title}</h4>
          <p className="text-[11px] text-ink-500 leading-snug">{blurb}</p>
        </div>
      </div>
      {value != null && (
        <div className={`rounded-lg border border-ink-200 bg-ink-50/50 px-2.5 py-2 text-[11px] text-ink-600 break-all ${mono ? 'font-mono' : ''} max-h-28 overflow-y-auto`}>
          {value}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

export default function DealerKit({ slug, inboxToken, name }) {
  const shareUrl = slug ? togoShareUrl(slug) : '';
  const inboxUrl = inboxToken ? dealerInboxUrl(inboxToken) : '';
  const snippet = slug ? togoEmbedSnippet(slug) : '';

  // The QR encodes the PUBLIC link (never the inbox one — that URL carries the
  // token, and a QR is made to be pointed at in a showroom). Loaded lazily and
  // best-effort: '' just means no code, next to a link that is already copyable.
  const [qr, setQr] = useState('');
  useEffect(() => {
    let alive = true;
    setQr('');
    if (!shareUrl) return undefined;
    togoQrDataUrl(shareUrl).then((url) => { if (alive) setQr(url); });
    return () => { alive = false; };
  }, [shareUrl]);

  if (!slug) {
    return (
      <p className="text-[11px] text-ink-400 px-4 py-3">
        El kit aparece cuando el distribuidor tiene un slug.
      </p>
    );
  }

  return (
    <div className="divide-y divide-ink-100">
      <KitRow
        icon={Code2}
        title="Código embed"
        blurb="Lo pega en su web. Se ajusta solo al ancho de la columna y abre el configurador en una pestaña nueva."
        value={snippet}
      >
        <CopyButton value={snippet} label="Copiar código" icon={Code2} />
      </KitRow>

      <KitRow
        icon={Link2}
        title="Enlace público"
        blurb="Para WhatsApp, redes o su firma de correo. Abre su configurador, con su catálogo y sus precios."
        value={shareUrl}
      >
        <CopyButton value={shareUrl} label="Copiar enlace" icon={Link2} />
        <a href={shareUrl} target="_blank" rel="noreferrer" className="chip-action" title="Abrir el configurador de este distribuidor">
          <ExternalLink size={12} /> Abrir vista previa
        </a>
      </KitRow>

      <KitRow
        icon={Inbox}
        title="Enlace de bandeja"
        blurb="Privado: el token es la única llave. Se lo envías solo a él — no lo publiques."
        value={inboxUrl || 'Sin token de bandeja.'}
      >
        {inboxUrl && (
          <>
            <CopyButton value={inboxUrl} label="Copiar bandeja" icon={Inbox} />
            <a href={inboxUrl} target="_blank" rel="noreferrer" className="chip-action" title="Abrir la bandeja del distribuidor">
              <ExternalLink size={12} /> Abrir bandeja
            </a>
          </>
        )}
      </KitRow>

      <KitRow
        icon={QrCode}
        title="Código QR"
        blurb="El enlace público impreso: en su showroom, en una ficha o en una tarjeta."
        value={null}
      >
        <div className="flex items-center gap-3">
          <div className="rounded-lg border border-ink-200 bg-white p-2 shrink-0">
            {qr ? (
              <img
                src={qr}
                alt={`Código QR del configurador de ${name || slug}`}
                width={112}
                height={112}
                className="block h-[112px] w-[112px]"
              />
            ) : (
              <div className="grid h-[112px] w-[112px] place-items-center">
                <Loader2 size={16} className="animate-spin text-ink-300" />
              </div>
            )}
          </div>
          {qr && (
            <a href={qr} download={`configurador-${slug}.png`} className="chip-action">
              <QrCode size={12} /> Descargar PNG
            </a>
          )}
        </div>
      </KitRow>
    </div>
  );
}

/** The token rotation control — its own export so the ficha can place it where
 *  it belongs (next to the inbox link) without the kit owning a write. */
export function RegenerateTokenButton({ onRegenerate, busy }) {
  return (
    <button type="button" onClick={onRegenerate} disabled={busy} className="chip-action text-ink-500 disabled:opacity-50" title="Genera un token nuevo; el enlace de bandeja anterior deja de funcionar">
      {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Regenerar token
    </button>
  );
}
