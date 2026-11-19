/**
 * Ambient module for side-effect CSS imports in the browser entry
 * (e.g. `import './plugin-market.css'`). esbuild bundles the actual stylesheet
 * at build time; TypeScript only needs the import to resolve. This is the first
 * static stylesheet import under src/, so no wildcard declaration existed.
 */
declare module '*.css';
