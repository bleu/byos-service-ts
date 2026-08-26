---
name: linear-review
description: Review Linear issues for autonomous implementation readiness. Identify well-specified engineering tasks, mark them as ready-for-agent or needs-requirements, implement ready tasks, run tests, and open pull requests.
---

# Linear Review

Address Linear tasks within agents scope, for a certain project.

# Prerequisites

Before start answering the user, make sure the following inputs are given:

1 - What is the Linear client + project?
2 - The tasks to be scanned should have some other filter? (i.e. only backlog tasks, only tasks with a certain label)

If this input was not given by the user, specifically ask before continuing.

## Objective

Find Linear tasks that suit agentic scope. The ultimate goal is:
- Open PRs for already specified tasks
- Update labels and add missed spec when the task is not specified

For each candidate issue:

1. Understand the issue and its requirements.
2. Inspect the repository and relevant code.
3. Decide whether the issue is within agentic scope (doesn't involve external communication, investigative issues, or any task that can be made just by humans). If the issue is not within agentic scope and is marked with "ready-for-agent", please add a "needs-requirements" label and a comment with the situation. Don't remove the previous flag.
4. If the issue is agent-related and is not well-specified, add a label "needs-requirements" and add a comment in the task regarding what requirements are needed
5. For all the issues that you consider agentic-related and well specified, but are not with the `ready-for-agent` label, explicitly ask the user if you can add that task in the `ready-for-agent` category before proceeding. For the tasks the user allower, add it into your current list of well-specified tasks. 
6. With a list of well-specified tasks in hand, you will confirm with the user in the prompt what are the tasks you intend to work, with a short summary for each one. Before spawning any implementation subagents, present the user with the list of selected tasks and ask for explicit confirmation. Do not spawn implementation or reviewer subagents before confirmation.
7. With a list of specified tasks to work on, you will create a plan to implement them. You will understand what tasks depend on each other, which ones need to be done first, or last, and which one can be done independent of the others.
8. For each agentic task well-specified, you will:
  a. spawn a subagent to work on it. This agent will be responsabile for checkouting to a new branch, addressing the issue, ensure the CI will pass and open a draft PR against the branch that make more sense in that situation (given step 6) 
  b. spawn a reviewer subagent. The reviewer will be responsible to (i) create tests to check if the new work is correctly implemented: it needs to be skeptical, and it will be critical against the step (a) agent implementation. If the tests dont pass, it will criticially think if they are not passing because of a bad implementation or because the test is wrong. If the implementation is wrong, it will fix the implementation and ensure again CI pass. (ii) review the code implementation: review the code in terms of potential security breach being created, operational bottlenecks (in terms of optimization, execution efficiency) that are being created, and potential simplifications on the code. Classify each of them in high, medium, or low criticity. Only address the ones with high and medium criticity, and discard the others. (iii) update PR description and make it ready to review. If something was addressed in step (ii), ensure CI pass again.
  
Note: this spawning of agents will be sequential, and not in parallel

## Issue selection

Prioritize issues that:

- Are in the backlog or otherwise unassigned.
- Represent a concrete engineering task.
- Have a clear expected outcome.
- Have a reasonably bounded scope.
- Can be validated through code or tests.

Avoid issues that primarily require:

- Product decisions.
- UX/design decisions.
- Architectural decisions that are not already established.
- Clarification from a human.
- Coordination across multiple teams.
- Changes to production infrastructure or sensitive systems unless explicitly authorized.

Do not modify issues that are already being actively worked on by a human unless explicitly asked.

## Readiness

An issue is `ready-for-agent` when the agent can reasonably answer:

- What needs to change?
- Where does the change belong?
- What behavior is expected?
- How can the result be validated?
- Is the scope sufficiently bounded?

If any important answer requires guessing, the issue is not ready.

### If the issue is not ready

Apply the `needs-requirements` label.

Add a concise Linear comment explaining exactly what is missing.

Do not attempt implementation just to resolve ambiguity.

### If the issue is ready

Apply the `ready-for-agent` label if it is not already present.

Proceed with implementation.

## Implementation

Before making changes:

1. Read the relevant repository instructions, including `AGENTS.md` if present.
2. Inspect the existing implementation.
3. Identify the smallest reasonable change that satisfies the issue.
4. Do not expand the scope based on unrelated improvements discovered during implementation.

While implementing:

- Follow existing project conventions.
- Add or update tests where appropriate.
- Do not make product decisions.
- Do not refactor unrelated code.

## Validation

Before opening a PR:

- Run the relevant tests.
- Run type checking/linting when applicable.
- Verify that the resulting changes satisfy the Linear issue.

If tests fail:

1. Attempt to diagnose and fix failures that are directly related to the implementation.
2. Do not endlessly iterate.
3. If the failure reveals an ambiguity or missing requirement, stop and update the Linear issue instead.

## Pull request

When implementation is complete and validation passes:

1. Create a branch associated with the Linear issue.
2. Commit the changes.
3. Push the branch.
4. Open a PR.
5. Reference the Linear issue in the PR.
6. Add a concise summary of the implementation and validation performed.

Do not merge the PR.

## Scope discipline

The Linear issue is the source of truth.

If you discover unrelated work that should be done:

- Do not include it in the current implementation.
- If appropriate, create a separate Linear issue.
- Leave the current PR focused on the original task.

## Safety

Never:

- Merge a PR.
- Close an issue because the implementation is complete.
- Invent requirements.
- Make irreversible changes without explicit authorization.
- Modify secrets, credentials, or production infrastructure unless explicitly required by the issue and permitted by repository instructions.

When uncertain between making a decision and asking for clarification, prefer updating the Linear issue with `needs-requirements`.