# Plugin-owned management layout

An installed Dashboard module may optionally export a versioned management-body component:

```js
export const managementLayout = {
  version: 1,
  placement: 'dialog-body',
  Component({ api, management, onReadinessChange }) {
    const h = api.react.createElement;
    return h('button', {
      onClick: () => management.scope.onToggle('global', !management.scope.globalEnabled),
      disabled: management.scope.busy,
    }, 'Toggle this plugin');
  },
};
```

The host supplies presentation metadata, the current global/per-Bot scope snapshot, in-flight flags and the existing scope mutation callback. The component owns the management dialog **body**, not the modal close action, uninstall confirmation or backend authority.

Only explicit version 1 / `dialog-body` exports with a function component are accepted. The Dashboard entry must resolve to the current origin. Invalid/missing exports retain the default management UI; plugins may retain the version 1 `management` / `before-scope-controls` export for older hosts.

The host loads this export only when the plugin has **exactly one Dashboard entry** (`dashboard.length === 1`). Zero or multiple entries leave the default management body in place; the host does not choose an entry on the plugin's behalf. While that module is loading, the default body may briefly appear before the plugin-owned body replaces it.

## Controls replaced by the layout

`dialog-body` replaces the entire default body, not only the readiness area. In particular, the host no longer renders its global/per-Bot switches, “Open settings” link, advanced metadata, sidebar Pin control, background-service controls, or `PluginTabs` inside that body. Plugins must render the controls they need:

- Use `management.scope.onToggle` and the supplied scope snapshot for this plugin's global/per-Bot bindings.
- Service actions can use the existing `api.startService`, `api.stopService` and `api.restartService` methods.
- There is no dedicated layout API for the host's sidebar Pin control or advanced-information row. Do not assume those host controls remain alongside the custom body.

The modal close action and uninstall confirmation remain host-owned. `onReadinessChange` only reports UI state; with a custom body, the plugin owns its own disabled/loading presentation. It does not replace the server's readiness check.

This opt-in is independent of prerequisites: ordinary plugins can use it too. A prerequisites plugin without a mountable entry still relies on the authoritative server-side readiness check, preserving the no-frontend-deadlock behavior.

Readiness reports are UI state, not permission grants. All scope writes continue through the same authenticated routes and server-side prerequisite checks. No generic privileged bridge or custom callback endpoint is introduced. Package changes can revise the body layout without another host patch; new authority or host capabilities still require explicit host support.
