/**
 * LIGNE ROSET — el catálogo OFICIAL del fabricante, en su propia página.
 *
 * La misma razón por la que Kvadrat y Anthom tienen la suya: la FUENTE la elige
 * la página, no la marca. Ligne Roset entrega a sus distribuidores el «Logiciel
 * Étiquette» (el software de etiquetas) y dentro va el catálogo US como CSV —
 * los mismos datos de los que se compone la lista de precios impresa, lo que lo
 * hace la autoridad para la marca `ligne-roset` donde el rastreo del sitio web
 * (lr-catalog) era una aproximación.
 *
 * La página es una envoltura fina: el trabajo vive en LrEtiquetteBar (el botón
 * único que sincroniza catálogo → telas → cambios → dibujos en orden) y en la
 * Edge Function `lr-etiquette`, portada de RosetSoft con su misma máquina de
 * fases (una invocación = una fase, por el límite de 2 s de CPU).
 */
import LrEtiquetteBar from '../../components/catalog/LrEtiquetteBar.jsx';

export default function LigneRosetImport() {
  return (
    <div className="max-w-3xl space-y-4">
      <header>
        <h2 className="font-display text-lg font-semibold">Ligne Roset · Étiquette</h2>
        <p className="text-sm text-ink-500 mt-1 max-w-prose">
          El feed oficial del fabricante: artículos con su precio por grado, el libro de telas,
          las bajas del cambio de temporada y los dibujos técnicos. Una sincronización lo trae
          todo en orden y deja programada la nocturna.
        </p>
      </header>
      <LrEtiquetteBar />
    </div>
  );
}
