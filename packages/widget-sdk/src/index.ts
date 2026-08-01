/**
 * @veta/widget-sdk — the EMBED SURFACE of the configurator.
 *
 * Everything a brand's website touches lives here and nowhere else: the URLs
 * that address a widget, the paste-in snippet, the JS SDK that mounts it, and
 * the postMessage protocol both halves speak. The widget APP (apps/widget)
 * imports the same module for its side of the wire, which is what keeps the two
 * from drifting — the reference kept its height message as a bare string
 * literal in two files, and that is exactly the class of bug this package
 * exists to make impossible.
 *
 * Pure string + DOM-light logic: no React, no three.js, no fetch, and every DOM
 * touch is injectable, so the whole surface is unit-tested in `node --test`.
 */

export {
  EMBED_ALLOW,
  WIDGET_PARAMS,
  handoffUrl,
  modalUrl,
  shareUrl,
  widgetBase,
  widgetUrl,
  withQuery,
} from './urls.ts';
export type { WidgetContext, WidgetParamName, WidgetUrlOptions } from './urls.ts';

export { DEFAULT_SEED_HEIGHT_PX, EMBED_MARKER, embedSnippet } from './snippet.ts';
export type { EmbedSnippetOptions } from './snippet.ts';

export {
  HOST_COMMANDS,
  HOST_SOURCE,
  WIDGET_EVENTS,
  WIDGET_SOURCE,
  createWidgetBridge,
  hostMessage,
  isTrustedWidgetEvent,
  parseHostMessage,
  parseWidgetMessage,
  readHeight,
  widgetMessage,
} from './protocol.ts';
export type {
  ConfiguredPayload,
  HeightPayload,
  HostCommandType,
  HostMessage,
  MessageEventLike,
  PricedPayload,
  SubmittedPayload,
  TrustOptions,
  WidgetBridge,
  WidgetBridgeOptions,
  WidgetEventType,
  WidgetMessage,
  WindowLike,
} from './protocol.ts';

export { mount, originOf } from './mount.ts';
export type {
  DocumentLike,
  ElementLike,
  HostWindowLike,
  IframeLike,
  MountOptions,
  WidgetEventHandlers,
  WidgetHandle,
} from './mount.ts';

import { EMBED_ALLOW, handoffUrl, modalUrl, shareUrl, widgetUrl } from './urls.ts';
import { embedSnippet } from './snippet.ts';
import { mount } from './mount.ts';

/**
 * The default namespace a `<script>` tag exposes — `VetaWidget.mount(el, {…})`.
 * Named exports stay the API for bundler consumers; this is the global shape.
 */
export const VetaWidget = {
  mount,
  widgetUrl,
  modalUrl,
  shareUrl,
  handoffUrl,
  embedSnippet,
  EMBED_ALLOW,
} as const;

export default VetaWidget;
