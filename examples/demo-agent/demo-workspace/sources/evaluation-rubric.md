# Coding Agent Evaluation Rubric

Use this rubric when comparing coding agents for a technical leadership audience.

## Evaluation dimensions

1. Local developer workflow
   - How naturally the agent fits into a developer's daily terminal, editor, and repository workflow.
   - Quality of iterative edit/test/debug loops.

2. Cloud task execution
   - Whether the agent can run asynchronously on larger tasks such as issue resolution, branch creation, and pull request preparation.
   - Ability to operate away from the local workstation.

3. Codebase context handling
   - Ability to inspect, reason about, and modify multi-file repositories.
   - Ability to maintain task context over several steps.

4. Tooling and extensibility
   - Ability to add tools, custom workflows, providers, model routing, and enterprise integrations.
   - Suitability for platform teams building internal developer tooling.

5. Enterprise governance
   - Permission boundaries, auditability, secret handling, identity integration, logging, and policy enforcement.
   - Ability to separate user intent from tool execution authority.

6. Deployment and ownership model
   - SaaS, local, hosted, self-hosted, or hybrid.
   - Operational burden and ability to run in controlled environments.

7. Ecosystem maturity
   - Documentation, integrations, community adoption, reliability, and vendor support.

8. Cost and risk profile
   - Predictability of model and infrastructure cost.
   - Data exposure, vendor lock-in, operational risk, and maintenance requirements.

## Suggested scoring scale

Use 1-5 scores:

- 1 = weak or immature for this dimension
- 2 = usable but limited
- 3 = adequate for pilots
- 4 = strong for production with some caveats
- 5 = best-in-class or strategically differentiated

## Recommended output format

For each agent, provide:

- One-line positioning
- Top strengths
- Key limitations
- Best-fit use cases
- Risks and mitigations
- Overall recommendation

For leadership summary, avoid over-indexing on feature lists. Emphasize:

- Where each option fits in the software delivery lifecycle
- Which teams benefit first
- What governance is needed before broad rollout
- Whether the organization should buy, adopt, or build platform capabilities
