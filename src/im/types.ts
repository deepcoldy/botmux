/**
 * Compatibility barrel for the platform boundary.
 *
 * The former all-in-one ImAdapter draft was never used and competed with the
 * capability-based runtime model. New code should prefer importing directly
 * from `im/platform` or `im/ports`.
 */
export * from './platform.js';
export * from './ports.js';
