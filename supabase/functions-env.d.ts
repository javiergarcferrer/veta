/* Ambient shims so tsc can walk the Edge Functions.
   Deno resolves these specifiers at deploy; tsc cannot, and does not need to —
   this pass exists to catch UNBOUND NAMES, not to type third-party surfaces. */
declare module 'https://*';
declare module 'npm:*';
declare module 'jsr:*';
declare module 'node:*';

declare const Deno: {
  env: { get(key: string): string | undefined };
  serve(handler: (req: Request) => Response | Promise<Response>): unknown;
  [k: string]: unknown;
};
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;
