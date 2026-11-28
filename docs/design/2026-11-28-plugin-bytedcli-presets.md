# Plugin-provided ByteCLI operation presets

Business policy templates belong to external plugins. Botmux owns the audited operation catalog, validation, host restrictions, authenticated configuration writes and the generic Dashboard controls.

## Plugin contribution

A plugin may publish `dist/bytedcli/operation-presets.json`. The installer scans it without executing plugin code and stores its validated contribution in the installed registry. The document has `schema: "botmux.bytedcli-operation-presets.v1"` and `presets`, each containing a unique `id`, `title`, optional `description`, and a complete versioned `policy`. Maximum file size is 256 KiB, maximum eight presets per plugin, maximum title/description lengths are 128/512 UTF-8 bytes. Policy validation reuses the audited parser: unknown IDs, credentials, extra fields and invalid versions are rejected. An invalid contribution fails installation before the previous runtime/registry is replaced.

## Discovery and application

The existing trigger-user-auth status response includes `bytedcliOperationPresets`, with validated presets from installed plugins in the current bot's effective plugin set, plus bounded credential-free issues. A preset is namespaced by `(pluginId, presetId)` and carries a SHA-256 revision of the installed source version and normalized definition. Machine-write exceptions are derived from the host catalog and policy, never supplied by the plugin. Runtime registry corruption excludes only the affected plugin's templates; manual policy editing remains available. The response is limited to 64 presets.

The existing authenticated trigger-user-auth PUT additionally accepts an exclusive `{bytedcliOperationPreset: {pluginId, presetId, revision}}` form. The server checks the current plugin binding and installed contribution under the plugin lifecycle lock, rejects unavailable or changed templates, and saves the selected policy through the existing configuration store. All other current trigger-user-auth fields are preserved. Applying a template replaces the complete command policy. Enabling a plugin does not apply it. Disabling/uninstalling removes the available template, leaving saved bot rules intact. Host actor/deny restrictions and unknown-command actor behavior remain unchanged.

## Dashboard

Replace the built-in business button with generic plugin preset controls using the status response. Show the plugin source, title, description and derived machine-write exceptions. Apply by reference and update state from the server response. Stale/failed applications refresh discovery without retrying the write. Existing row editing and policy clearing remain unchanged, and unavailable/invalid host policy disables template application.

## Business migration and compatibility

Move the current complete 40-machine/37-actor template to devbox-mix's `plugins/mix/bytedcli/operation-presets.json`, copied into its published dist. Remove the business preset module, business UI strings, example configuration and business-template tests from Botmux; retain generic executor/floor coverage. MIX documentation and template maintenance belong to the business plugin. Existing persisted policies need no migration and must remain byte-equivalent in rule content. The audited CLI remains 0.199.0 and catalog 2026-11-27.2; plugins cannot extend executable operations through this capability.

## Verification and deployment

Test install discovery and atomic failure, registry corruption, effective binding, duplicate/unknown IDs, limits, source revisions, unavailable/stale application, field preservation, host floors, Dashboard controls and business package contents. Use private test HOME/tmux fences and isolated build dependencies. Build both projects, review the change, push the existing feature branches, install the updated MIX package and deploy a verified Botmux binary using the established local deployment procedure. Read back the current 40/37 saved policy and confirm plugin discovery, fleet health and startup entry.
