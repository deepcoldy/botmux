/**
 * Compatibility facade for the host-neutral gate wait store.
 *
 * Daemon and CLI callers retain the historical module path while embedders
 * can depend directly on gate-wait-store without importing a Botmux adapter.
 */

export * from './gate-wait-store.js';
