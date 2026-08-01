/**
 * THE 2D PLAN — an SVG floor the visitor arranges pieces on.
 *
 * SVG rather than canvas on purpose: every piece is a real DOM node, so it gets
 * focus, a keyboard, an accessible name and a hit area for free — the plan is
 * operable with Tab/arrows/R/Delete, which a canvas would have to reimplement.
 *
 * The component owns POINTERS and PIXELS only. Where a piece may land is
 * `@veta/layout`'s answer, routed through the editor reducer: a pointer-move
 * dispatches `drag` (gentle magnet, no history), a pointer-up dispatches `drop`
 * (generous dock magnet, one history entry). Nothing about snapping or collision
 * is decided in this file.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { t, type Locale } from '@veta/i18n';
import type { EditorContext, EditorState, PlacedPiece } from '../vm/editor.ts';
import { boxOf, planBounds } from '../vm/editor.ts';
import type { EditorAction } from '../vm/editor.ts';
import type { ResolvedModel } from '../vm/catalog.ts';

export interface PlanEditorProps {
  state: EditorState;
  ctx: EditorContext;
  modelById: Record<string, ResolvedModel | undefined>;
  locale: Locale;
  flagged: ReadonlySet<string>;
  dispatch: (action: EditorAction) => void;
}

/** Padding around the build, in plan cm, so a piece is never flush to the edge. */
const PAD_CM = 90;

export default function PlanEditor({ state, ctx, modelById, locale, flagged, dispatch }: PlanEditorProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ uid: string; dx: number; dy: number } | null>(null);
  const [rotating, setRotating] = useState<string | null>(null);

  const bounds = useMemo(() => planBounds(state.placed, ctx), [state.placed, ctx]);
  const view = useMemo(() => {
    const b = bounds ?? { minX: 0, minY: 0, maxX: 300, maxY: 200 };
    return {
      x: b.minX - PAD_CM,
      y: b.minY - PAD_CM,
      w: Math.max(240, b.maxX - b.minX + PAD_CM * 2),
      h: Math.max(180, b.maxY - b.minY + PAD_CM * 2),
    };
  }, [bounds]);

  /** Client px → plan cm, through the SVG's own viewBox mapping. */
  const toPlan = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    const scale = view.w / (rect.width || 1);
    return {
      x: view.x + (clientX - rect.left) * scale,
      y: view.y + (clientY - rect.top) * (view.h / (rect.height || 1)),
    };
  }, [view]);

  const onPiecePointerDown = (piece: PlacedPiece) => (event: React.PointerEvent) => {
    event.preventDefault();
    (event.target as Element).setPointerCapture?.(event.pointerId);
    const at = toPlan(event.clientX, event.clientY);
    dragRef.current = { uid: piece.uid, dx: at.x - piece.x, dy: at.y - piece.y };
    dispatch({ type: 'select', uid: piece.uid });
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    const at = toPlan(event.clientX, event.clientY);
    if (drag) {
      dispatch({ type: 'drag', uid: drag.uid, x: at.x - drag.dx, y: at.y - drag.dy });
      return;
    }
    if (rotating) {
      const piece = state.placed.find((p) => p.uid === rotating);
      if (!piece) return;
      const box = boxOf(piece, ctx);
      const angle = Math.atan2(at.y - (box.y + box.h / 2), at.x - (box.x + box.w / 2));
      dispatch({ type: 'rotate', uid: rotating, deg: (angle * 180) / Math.PI + 90, commit: false });
    }
  };

  const endGesture = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (drag) {
      const at = toPlan(event.clientX, event.clientY);
      dispatch({ type: 'drop', uid: drag.uid, x: at.x - drag.dx, y: at.y - drag.dy });
      dragRef.current = null;
    }
    if (rotating) {
      const piece = state.placed.find((p) => p.uid === rotating);
      if (piece) dispatch({ type: 'rotate', uid: rotating, deg: piece.rot });
      setRotating(null);
    }
  };

  const onKeyDown = (piece: PlacedPiece) => (event: React.KeyboardEvent) => {
    const step = event.shiftKey ? 10 : 2;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
    };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      dispatch({ type: 'drop', uid: piece.uid, x: piece.x + move[0], y: piece.y + move[1] });
      return;
    }
    if (event.key === 'r' || event.key === 'R') {
      event.preventDefault();
      dispatch({ type: 'rotate', uid: piece.uid, deg: piece.rot + 90 });
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      dispatch({ type: 'remove', uid: piece.uid });
    } else if (event.key === 'Escape') {
      dispatch({ type: 'select', uid: null });
    }
  };

  return (
    <div className="plan">
      <svg
        ref={svgRef}
        className="plan__svg"
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        role="application"
        aria-roledescription={t(locale, 'canvas.roledescription')}
        aria-label={t(locale, 'canvas.label', { pieces: state.placed.length })}
        onPointerMove={onPointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        onPointerDown={(e) => { if (e.target === svgRef.current) dispatch({ type: 'select', uid: null }); }}
      >
        <defs>
          {/* A 50 cm lattice: the plan reads as a floor with scale, not a void. */}
          <pattern id="veta-grid" width="50" height="50" patternUnits="userSpaceOnUse">
            <circle cx="25" cy="25" r="1.4" className="plan__dot" />
          </pattern>
        </defs>
        <rect x={view.x} y={view.y} width={view.w} height={view.h} fill="url(#veta-grid)" />

        {state.room ? (
          <polygon
            className="plan__room"
            points={state.room.corners.map((c) => `${c.x},${c.y}`).join(' ')}
          />
        ) : null}

        {state.placed.map((piece) => {
          const box = boxOf(piece, ctx);
          const model = modelById[piece.pieceId];
          const selected = state.selectedUid === piece.uid;
          const cx = box.x + box.w / 2;
          const cy = box.y + box.h / 2;
          const w = Number(model?.widthCm) || box.w;
          const d = Number(model?.depthCm) || box.h;
          const fabric = (piece.material as { fabric?: string } | null)?.fabric ?? '';
          return (
            <g
              key={piece.uid}
              className={`plan__piece${selected ? ' is-selected' : ''}${flagged.has(piece.uid) ? ' is-flagged' : ''}`}
              transform={`translate(${cx} ${cy}) rotate(${piece.rot})`}
              tabIndex={0}
              role="button"
              aria-label={`${model?.name ?? t(locale, 'piece.generic')}${fabric ? ` — ${fabric}` : ''}`}
              onPointerDown={onPiecePointerDown(piece)}
              onKeyDown={onKeyDown(piece)}
              onFocus={() => dispatch({ type: 'select', uid: piece.uid })}
            >
              <rect x={-w / 2} y={-d / 2} width={w} height={d} rx={6} className="plan__body" />
              {/* The seat direction, so a rotated piece is readable at a glance. */}
              <line x1={-w / 2 + 8} y1={-d / 2 + 8} x2={w / 2 - 8} y2={-d / 2 + 8} className="plan__front" />
              <text y={4} className="plan__label">{model?.name ?? ''}</text>
            </g>
          );
        })}

        {(() => {
          const piece = state.placed.find((p) => p.uid === state.selectedUid);
          if (!piece) return null;
          const box = boxOf(piece, ctx);
          return (
            <circle
              className="plan__rotate"
              cx={box.x + box.w / 2}
              cy={box.y - 18}
              r={9}
              role="button"
              tabIndex={0}
              aria-label={t(locale, 'rotate.aria')}
              onPointerDown={(e) => { e.stopPropagation(); setRotating(piece.uid); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') dispatch({ type: 'rotate', uid: piece.uid, deg: piece.rot + 90 });
              }}
            />
          );
        })()}
      </svg>

      {bounds ? (
        <p className="plan__dims">{t(locale, 'dims.set', { w: bounds.widthCm, d: bounds.depthCm })}</p>
      ) : (
        <p className="plan__dims">{t(locale, 'start.subtitle')}</p>
      )}
    </div>
  );
}
