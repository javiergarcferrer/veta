/**
 * NODE DOUBLES for the injected pixel capability.
 *
 * `ImageOps` is browser work (canvas, getImageData, toBlob), so the appearance
 * pipeline is tested against a scripted stand-in instead: an "image" is a plain
 * bag carrying the numbers the real ops would have MEASURED (its tone, its
 * colourfulness), and every op records that it ran. That is what makes the
 * ordering assertions possible — "the neutral check never runs on a family
 * fallback" is only checkable if you can see the call that did not happen.
 */
import type { ImageLike, ImageOps } from '../src/index.ts';

/** A scripted image: what the real pixel ops would have measured from it. */
export interface FakeImage extends ImageLike {
  tag: string;
  /** What `sampleAverageColor` reports for this image (a swatch photo). */
  tone?: number | null;
  /** What `colorfulness` reports (a neutral detail map measures ~3–6). */
  colorful?: number | null;
  /** True when the scan already IS its swatch tone: `correctScanToTone`
   *  answers null and the caller must keep the RAW scan. */
  matchesSwatch?: boolean;
  /** True when no relief can be derived (the real op returns null under Node). */
  noRelief?: boolean;
}

export const img = (tag: string, extra: Partial<FakeImage> = {}): FakeImage => (
  { tag, width: 64, height: 64, ...extra }
);

/** A baked/derived result, so a test can assert WHICH image was fed to WHICH op. */
export interface FakeResult extends ImageLike {
  tag: string;
  from: string;
  rgb?: number;
  fromTone?: number;
  toTone?: number;
}

/** Read the scripted result a map/normal choice carries — the pipeline sees
 *  those images as opaque `ImageLike`, the test knows what the double put there. */
export const resultOf = (choice: unknown): FakeResult => (choice as { image: FakeResult }).image;

export interface OpsDouble extends ImageOps {
  /** Op names in call order — the ordering assertions read this. */
  calls: string[];
}

const tagOf = (image: ImageLike): string => (image as FakeImage)?.tag ?? '?';

/**
 * A full ImageOps stand-in. `throwing` makes every op throw, which pins the
 * "every failure degrades to the flat colour; nothing throws" contract.
 */
export function fakeImageOps({ throwing = false }: { throwing?: boolean } = {}): OpsDouble {
  const calls: string[] = [];
  const enter = (name: string): void => {
    calls.push(name);
    if (throwing) throw new Error(`boom: ${name}`);
  };
  return {
    calls,
    sampleAverageColor(image: ImageLike): number | null {
      enter('sampleAverageColor');
      return (image as FakeImage)?.tone ?? null;
    },
    colorfulness(image: ImageLike): number | null {
      enter('colorfulness');
      const c = (image as FakeImage)?.colorful;
      return c == null ? null : c;
    },
    tintWeave(image: ImageLike, rgb: number): FakeResult | null {
      enter('tintWeave');
      return { tag: 'tinted', from: tagOf(image), rgb, width: 64, height: 64 };
    },
    correctScanToTone(image: ImageLike, fromRgb: number, toRgb: number): FakeResult | null {
      enter('correctScanToTone');
      // The measured behaviour of the real op: a negligible gain answers null,
      // and the caller keeps the raw scan (pCon fidelity preserved).
      if ((image as FakeImage)?.matchesSwatch) return null;
      return { tag: 'corrected', from: tagOf(image), fromTone: fromRgb, toTone: toRgb, width: 64, height: 64 };
    },
    deriveWeaveNormal(image: ImageLike): FakeResult | null {
      enter('deriveWeaveNormal');
      if ((image as FakeImage)?.noRelief) return null;
      return { tag: 'derived', from: tagOf(image), width: 64, height: 64 };
    },
  };
}
