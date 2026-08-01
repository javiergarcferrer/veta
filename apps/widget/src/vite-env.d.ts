/// <reference types="vite/client" />

/**
 * Ambient declarations for the bundler's own affordances.
 *
 * `vite/client` supplies `import.meta.env`; the CSS declaration makes a
 * side-effect stylesheet import legal under `tsc`, which otherwise refuses an
 * import it cannot resolve to a module. Assets are declared the same way as
 * they are added — never by loosening the compiler.
 */
declare module '*.css' {
  const css: string;
  export default css;
}
