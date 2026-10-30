# Reply-card console entry

Final reply cards include a **Console** link next to the bot signature when
remote access is enabled and the host is bound to the central platform. The
link opens that machine's SSO dashboard and carries no dashboard token.

The host selects the URL in the reply render snapshot. Direct sends and daemon
fallback replies use that same presentation contract; delivery retries retain
the selected URL alongside the existing footer preferences and timing.

The existing footer and signature switches also hide the console entry. An
empty signature suppresses it, and a custom signature that already includes
the same console URL is rendered once. Progress replies suppress the signature
and its console link.

Local dashboards, self-hosted reverse proxies, and Devbox exports keep their
existing access flow because they require owner credentials. Their long-lived
dashboard token is never added to this permanent reply footer.
