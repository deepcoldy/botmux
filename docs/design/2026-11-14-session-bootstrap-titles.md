# Group bootstrap titles

A group-join bootstrap is setup context rather than a user question. New sessions use the known group name while awaiting meaningful user content. Configured and localized bootstraps are removed only from title input; task content stays intact. A persisted normalized fingerprint identifies a replay even if configuration changes.

On the first meaningful continuation, the canonical list title is updated for both native-title and other CLI adapters. Native semantic title results also update the canonical title. User, Dashboard and explicit agent renames remain protected by the existing manual flag and source metadata. Native and canonical changes are persisted as one session update at the accepted continuation path.

Existing truncated oncall bootstrap titles can display the known group name without rewriting old rows. List/table views show real attention reasons and use known activity timestamps, falling back to last message time when necessary. Unknown flags do not become blockers.

Validation should cover configuration changes and replay, manual intervention during title generation, failed persistence/restart, queued/rejected continuations, and late native results. UI output must use sample data in review screenshots.
