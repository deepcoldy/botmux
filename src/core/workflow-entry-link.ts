/**
 * The one place a card builder (daemon, worker pool, `botmux send`) turns
 * "this run's main bot + run id" into the「工作流 ›」link: the host's
 * Dashboard address, plus whether its Dashboard has a usable Feishu H5 login
 * (sidebar AppLink) or not (open the Dashboard run page in the browser). No
 * Dashboard address → undefined, and the card keeps its old shape.
 */

import type { Locale } from '../i18n/index.js';
import type { Brand } from '../im/lark/lark-hosts.js';
import { workflowSidebarEntryLink, type WorkflowSidebarEntryLink } from '../im/lark/workflow-sidebar-entry.js';
import { dashboardH5LoginAvailable } from './dashboard-h5-presence.js';
import { resolveDashboardOrigin } from './workbench-link.js';

export function resolveWorkflowEntryLink(
  input: { mainLarkAppId: string; runId: string; brand: Brand; locale?: Locale },
  host: { dashboardOrigin?: () => string | undefined; h5LoginAvailable?: () => boolean } = {},
): WorkflowSidebarEntryLink | undefined {
  return workflowSidebarEntryLink({
    ...input,
    dashboardOrigin: (host.dashboardOrigin ?? resolveDashboardOrigin)(),
    sidebar: (host.h5LoginAvailable ?? dashboardH5LoginAvailable)(),
  });
}
