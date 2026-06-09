# Multi-Topic Orchestration Mode

An upgrade to [multi-bot collaboration](/en/multi-bot): hand a big task to a main bot, and it automatically breaks the task into multiple sub-projects, opens several topics in the group, assigns a group of bots to each topic to work in parallel (commonly "one writes, one reviews"), uses a single Lark task checklist as a shared progress board, and finally collects the results and summarizes them for you. An ordinary group turns into a parallel workbench.

## How to use

Just tell the main bot, for example:

> "Use multi-topic orchestration mode to split ×× into a few sub-projects and run them in parallel."
>
> "You be the orchestrator and coordinate a few bots to push this requirement forward in parallel."

The main bot will then automatically:

1. Split the task into a few sub-projects and first give you **a draft assignment plan** (which bots are assigned to each sub-project), then wait for your confirmation;
2. Once you approve, open several topics in the group, pull the corresponding bots in, and start working in parallel;
3. Create a **Lark task checklist** as a progress board — so you can see each sub-project's progress at a glance in Lark tasks;
4. After each group finishes, the main bot collects everything and summarizes the results for you.

Throughout the whole process, all you need to do is: **state the requirement → confirm the assignment → watch progress / collect results**. Opening topics, dividing the work, collaborating, and reporting back to each other all happen automatically among the bots — you don't have to worry about it.

## Prerequisites

For whichever bots you want to take part in the collaboration, first add them to this group and make sure they can be @-mentioned (see [multi-bot collaboration](/en/multi-bot)). Everything else — which repository to work in, how to open topics and assign tasks — is handled automatically by the main bot, so you don't need to configure anything in advance (no need to enable On-Call or anything like that).

## Result

![Multi-topic orchestration · Lark task board as a shared progress board](https://magic-builder.tos-cn-beijing.volces.com/uploads/1780419243796_multitopic-board.png)

> Related: [multi-bot collaboration](/en/multi-bot) is its infrastructure; use [roles and teams](/en/roles) to give bots roles (who writes, who reviews).
