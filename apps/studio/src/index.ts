/**
 * @veta/studio — the brand authoring app (member plane).
 *
 * The public surface is the WORKFLOW, not the shell: every ViewModel and the
 * store seam. Deliberately no React and no worker imports here — this module is
 * loaded by node tests, and a barrel that dragged in the DOM would make the
 * pure layer untestable in exactly the way the reference monolith was.
 */
export * from './vm/index.ts';
export * from './store/index.ts';
